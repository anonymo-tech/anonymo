import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after, beforeEach } from 'node:test';
import bs58 from 'bs58';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { getBalance } from '../server/ledger/ledger.ts';
import { handleApi } from '../server/core/http.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { tokenDepositRoutes } from '../server/routes/token-deposits.ts';
import { createSimulatedPriceSource } from '../server/token/price.ts';
import {
  tokenDepositCapability,
  tokenDepositConfiguration,
} from '../server/token/token-deposit-config.ts';
import {
  createOwnedTokenIntent,
  creditTokenDepositEvidence,
  expireTokenDepositIntents,
  getOwnedTokenDeposit,
  listOwnedTokenDeposits,
} from '../server/token/token-deposit-store.ts';
import {
  COMPUTE_BUDGET_PROGRAM,
  SOLANA_NETWORKS,
  TOKEN_PROGRAM,
} from '../server/solana/index.ts';

const connection = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href;
// The path must be inert unless an operator switches it on explicitly.
for (const name of Object.keys(process.env))
  if (name.startsWith('CONCLAVE_TOKEN_')) delete process.env[name];
const defaultCapability = tokenDepositCapability();

const pool = createDatabase(connection, 8);
before(() => migrate(pool));
after(() => pool.end());

const key = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
const txid = () => bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
const code = (value) => (error) => error.code === value;
const checkViolation = (error) => error.code === '23514';
const PRICE = '400000'; // 0.40 USD per whole token
const DECIMALS = 9;
const treasury = { wallet: key(), tokenAccount: key(), mint: key() };
const originalFetch = globalThis.fetch;
let rpcCalls = [];

function configuration(overrides = {}) {
  for (const name of Object.keys(process.env))
    if (name.startsWith('CONCLAVE_TOKEN_')) delete process.env[name];
  Object.assign(process.env, {
    CONCLAVE_MODE: 'service',
    CONCLAVE_APP_ORIGIN: 'https://conclave.test',
    CONCLAVE_DATABASE_URL: connection,
    CONCLAVE_TOKEN_MINT: treasury.mint,
    CONCLAVE_TOKEN_CLUSTER: 'devnet',
    CONCLAVE_TOKEN_RPC_URL: 'https://rpc.example/token?key=fixture-marker',
    CONCLAVE_TOKEN_DECIMALS: String(DECIMALS),
    CONCLAVE_TOKEN_PROGRAM: 'spl-token',
    CONCLAVE_TOKEN_PAYMENTS_ENABLED: 'true',
    CONCLAVE_TOKEN_TREASURY_WALLET: treasury.wallet,
    CONCLAVE_TOKEN_TREASURY_TOKEN_ACCOUNT: treasury.tokenAccount,
    CONCLAVE_TOKEN_MAX_DEPOSIT_USD6: '100000000',
    CONCLAVE_TOKEN_PRICE_SOURCE: 'simulated',
    CONCLAVE_TOKEN_SIMULATED_PRICE_USD6: PRICE,
    ...overrides,
  });
}
beforeEach(() => {
  configuration();
  rpcCalls = [];
  globalThis.fetch = async () => {
    throw new Error('Unmocked external request blocked.');
  };
});
after(() => {
  globalThis.fetch = originalFetch;
});

async function walletOwner() {
  const accountId = randomUUID(),
    sourceWallet = key(),
    token = generateSessionToken();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'solana',$3)",
    [randomUUID(), accountId, sourceWallet],
  );
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), accountId],
  );
  return {
    accountId,
    sourceWallet,
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    priceSource: createSimulatedPriceSource({
      priceUsd6PerToken: BigInt(PRICE),
    }),
  };
}

async function intentFor(owner, usd6 = '1000000', extra = {}) {
  const { deposit } = await createOwnedTokenIntent(pool, {
    accountId: owner.accountId,
    usd6,
    priceSource: owner.priceSource,
    ...extra,
  });
  return deposit;
}

/** Finalized TransferChecked evidence that pays exactly the intent's terms. */
function evidenceFor(deposit, owner, { blockTime, slot = 1000 } = {}) {
  const time =
    blockTime ?? Math.floor(Date.parse(deposit.createdAt) / 1000) + 1;
  const raw = BigInt(deposit.amountRaw);
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, raw, true);
  data[9] = DECIMALS;
  const sourceAccount = key();
  const signature = txid();
  const balance = (accountIndex, walletOwner, amount) => ({
    accountIndex,
    mint: deposit.mint,
    owner: walletOwner,
    programId: TOKEN_PROGRAM,
    uiTokenAmount: {
      amount,
      decimals: DECIMALS,
      uiAmount: null,
      uiAmountString: 'ignored',
    },
  });
  return {
    cluster: 'devnet',
    genesisHash: SOLANA_NETWORKS.devnet.genesisHash,
    signature,
    status: {
      slot,
      confirmations: null,
      err: null,
      confirmationStatus: 'finalized',
    },
    transaction: {
      version: 'legacy',
      slot,
      blockTime: time,
      meta: {
        err: null,
        innerInstructions: [],
        loadedAddresses: { writable: [], readonly: [] },
        preTokenBalances: [
          balance(1, owner.sourceWallet, (raw * 4n).toString()),
          balance(2, deposit.recipientWallet, '0'),
        ],
        postTokenBalances: [
          balance(1, owner.sourceWallet, (raw * 3n).toString()),
          balance(2, deposit.recipientWallet, raw.toString()),
        ],
      },
      transaction: {
        signatures: [signature],
        message: {
          header: {
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 4,
          },
          accountKeys: [
            owner.sourceWallet,
            sourceAccount,
            deposit.recipientTokenAccount,
            deposit.mint,
            deposit.reference,
            TOKEN_PROGRAM,
            COMPUTE_BUDGET_PROGRAM,
          ],
          instructions: [
            {
              programIdIndex: 5,
              accounts: [1, 3, 2, 0, 4],
              data: bs58.encode(data),
            },
          ],
        },
      },
    },
  };
}

async function api(
  owner,
  path,
  body,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method,
      headers: {
        origin: 'https://conclave.test',
        cookie: owner.cookie,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function routes(owner, path, body, options) {
  const request = new Request(`https://conclave.test/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await handleApi(() =>
    tokenDepositRoutes(
      pool,
      request,
      path.split('?')[0],
      owner.accountId,
      options,
    ),
  );
  return { status: response.status, body: await response.json() };
}

function mockRpc(evidence) {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, process.env.CONCLAVE_TOKEN_RPC_URL);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    rpcCalls.push(body.method);
    const result =
      body.method === 'getGenesisHash'
        ? evidence.genesisHash
        : body.method === 'getSignatureStatuses'
          ? { value: [evidence.status] }
          : evidence.transaction;
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  };
}

async function ledgerShape(reference) {
  return (
    await pool.query(
      `SELECT t.kind AS transaction_kind,a.kind,a.owner_id,e.amount_usd6::text FROM ledger_transactions t
      JOIN ledger_entries e ON e.transaction_id=t.id JOIN ledger_accounts a ON a.id=e.ledger_account_id
      WHERE t.reference=$1 ORDER BY e.amount_usd6`,
      [reference],
    )
  ).rows;
}

async function floatBalance() {
  return (
    await pool.query(
      "SELECT balance_usd6::text FROM ledger_accounts WHERE owner_id IS NULL AND kind='token_float'",
    )
  ).rows[0].balance_usd6;
}

void test('migrations apply on a fresh database and seed one token float account', async () => {
  const applied = (
    await pool.query(
      "SELECT name FROM schema_migrations WHERE name LIKE '022-%' ORDER BY name",
    )
  ).rows.map((row) => row.name);
  assert.deepEqual(applied, ['022-token-deposits.sql']);
  const floats = await pool.query(
    "SELECT owner_id,balance_usd6::text FROM ledger_accounts WHERE kind='token_float'",
  );
  assert.equal(floats.rows.length, 1);
  assert.equal(floats.rows[0].owner_id, null);
  assert.ok(BigInt(floats.rows[0].balance_usd6) <= 0n);
  // Earlier kinds are preserved by the (existing) OR (new) extension.
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM ledger_accounts WHERE kind='burn_reserve'",
      )
    ).rows[0].count,
    '1',
  );
  for (const kind of ['clearing', 'revenue'])
    await pool.query(
      'INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,NULL,$2) ON CONFLICT(owner_id,kind) DO NOTHING',
      [randomUUID(), kind],
    );
  await assert.rejects(
    pool.query(
      "INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,NULL,'token_float')",
      [randomUUID()],
    ),
    (error) => error.code === '23505',
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,$2,'token_float')",
      [randomUUID(), (await walletOwner()).accountId],
    ),
    checkViolation,
  );
});

void test('the pay-with-token capability is off by default and switches on only with complete terms', () => {
  assert.equal(defaultCapability.configured, false);
  assert.equal(defaultCapability.reason, 'TOKEN_NOT_CONFIGURED');
  const enabled = tokenDepositCapability();
  assert.equal(enabled.configured, true);
  assert.equal(enabled.reason, 'TOKEN_DEPOSITS_CONFIGURED');
  assert.equal(enabled.cluster, 'devnet');
  assert.equal(enabled.mint, treasury.mint);
  assert.equal(enabled.recipientWallet, treasury.wallet);
  assert.equal(enabled.recipientTokenAccount, treasury.tokenAccount);
  assert.equal(enabled.maximumUsd6, '100000000');
  assert.ok(!JSON.stringify(enabled).includes('fixture-marker'));
  configuration({ CONCLAVE_TOKEN_PAYMENTS_ENABLED: 'false' });
  assert.equal(tokenDepositCapability().configured, false);
  assert.equal(tokenDepositCapability().reason, 'TOKEN_PAYMENTS_DISABLED');
  configuration({ CONCLAVE_TOKEN_CLUSTER: 'mainnet-beta' });
  assert.equal(tokenDepositCapability().reason, 'TOKEN_MAINNET_LOCKED');
  assert.equal(tokenDepositConfiguration().policy, null);
});

void test('a quote fixes the exact raw token amount, the price and the window on the intent', async () => {
  const owner = await walletOwner();
  const before = Date.now();
  const deposit = await intentFor(owner, '1000000');
  assert.equal(deposit.usd6, '1000000');
  assert.equal(deposit.amountRaw, '2500000000');
  assert.equal(deposit.decimals, DECIMALS);
  assert.equal(deposit.price.usd6PerToken, PRICE);
  assert.equal(deposit.price.source, 'simulated');
  assert.equal(deposit.status, 'awaiting_payment');
  assert.equal(deposit.state, 'pending');
  assert.equal(deposit.paymentWindowOpen, true);
  assert.equal(deposit.canVerify, true);
  assert.equal(deposit.settlement, null);
  assert.equal(deposit.sourceWallet, owner.sourceWallet);
  assert.equal(deposit.recipientWallet, treasury.wallet);
  assert.equal(deposit.recipientTokenAccount, treasury.tokenAccount);
  assert.equal(deposit.mint, treasury.mint);
  assert.equal(deposit.cluster, 'devnet');
  assert.equal(deposit.label, 'platform token');
  assert.ok(Date.parse(deposit.createdAt) >= before);
  assert.equal(
    Date.parse(deposit.expiresAt) - Date.parse(deposit.createdAt),
    120000,
  );
  assert.ok(
    Date.parse(deposit.price.observedAt) <= Date.parse(deposit.createdAt),
  );
  assert.equal(bs58.decode(deposit.reference).length, 32);
  // 1 USD6 at 0.40 USD per token is exactly 2500 raw units at 9 decimals; 3 USD6 -> 7500.
  const dust = await intentFor(owner, '1');
  assert.equal(dust.amountRaw, '2500');
  // A price that does not divide evenly rounds the token amount up.
  const uneven = await intentFor(owner, '1000000', {
    priceSource: createSimulatedPriceSource({ priceUsd6PerToken: 7n }),
  });
  assert.equal(uneven.amountRaw, '142857142857143');
  const odd = await intentFor(owner, '1000001');
  assert.equal(odd.amountRaw, '2500002500');
  // A different injected source is used instead of the configured one.
  const dearer = await intentFor(owner, '1000000', {
    priceSource: createSimulatedPriceSource({ priceUsd6PerToken: 800000n }),
  });
  assert.equal(dearer.amountRaw, '1250000000');
  assert.equal(dearer.price.usd6PerToken, '800000');
  // The window is the shorter of the configured ttl and the price quote's own expiry.
  configuration({ CONCLAVE_TOKEN_QUOTE_TTL_MS: '30000' });
  const short = await intentFor(owner);
  assert.equal(
    Date.parse(short.expiresAt) - Date.parse(short.createdAt),
    30000,
  );
  const briefPrice = await intentFor(owner, '1000000', {
    priceSource: createSimulatedPriceSource({
      priceUsd6PerToken: 400000n,
      ttlMs: 5000,
    }),
  });
  assert.equal(
    Date.parse(briefPrice.expiresAt) - Date.parse(briefPrice.createdAt),
    5000,
  );
  const stored = (
    await pool.query('SELECT * FROM token_deposit_intents WHERE id=$1', [
      deposit.id,
    ])
  ).rows[0];
  assert.equal(stored.amount_raw, '2500000000');
  assert.equal(stored.token_program, 'spl-token');
  assert.equal(stored.credited_signature, null);
});

void test('creation enforces the limit, verified wallets, distinct treasury addresses and open-intent caps', async () => {
  const owner = await walletOwner();
  await assert.rejects(
    intentFor(owner, '100000001'),
    code('TOKEN_DEPOSIT_LIMIT'),
  );
  for (const usd6 of ['0', '1.5', '-1', '90000000000000000000'])
    await assert.rejects(intentFor(owner, usd6), code('INVALID_AMOUNT'));
  await assert.rejects(
    intentFor(owner, '1000000', { sourceWallet: key() }),
    code('WALLET_NOT_VERIFIED'),
  );
  const named = await intentFor(owner, '1000000', {
    sourceWallet: owner.sourceWallet,
  });
  assert.equal(named.sourceWallet, owner.sourceWallet);
  // Two verified wallets require an explicit choice.
  const second = key();
  await pool.query(
    "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'solana',$3)",
    [randomUUID(), owner.accountId, second],
  );
  await assert.rejects(intentFor(owner), code('WALLET_REQUIRED'));
  assert.equal(
    (await intentFor(owner, '1000000', { sourceWallet: second })).sourceWallet,
    second,
  );
  await pool.query('UPDATE identities SET revoked_at=now() WHERE subject=$1', [
    second,
  ]);
  await assert.rejects(
    intentFor(owner, '1000000', { sourceWallet: second }),
    code('WALLET_NOT_VERIFIED'),
  );
  // A wallet that is the treasury itself cannot be a source.
  const treasuryOwner = await walletOwner();
  await pool.query('UPDATE identities SET subject=$2 WHERE account_id=$1', [
    treasuryOwner.accountId,
    treasury.wallet,
  ]);
  await assert.rejects(
    intentFor(treasuryOwner),
    code('INVALID_DEPOSIT_SOURCE'),
  );
  // A stale price never produces an intent.
  await assert.rejects(
    intentFor(owner, '1000000', {
      priceSource: {
        kind: 'simulated',
        quote: async () => ({
          priceUsd6PerToken: 400000n,
          source: 'simulated',
          observedAtMs: Date.now() - 20 * 60_000,
          expiresAtMs: Date.now() + 60_000,
          confidenceBps: 0,
        }),
      },
    }),
    code('TOKEN_PRICE_STALE'),
  );
  configuration({ CONCLAVE_TOKEN_PAYMENTS_ENABLED: 'false' });
  await assert.rejects(intentFor(owner), code('TOKEN_PAYMENTS_DISABLED'));
  configuration();
  const capped = await walletOwner();
  await Promise.all(Array.from({ length: 20 }, () => intentFor(capped)));
  await assert.rejects(intentFor(capped), code('TOKEN_DEPOSIT_INTENT_LIMIT'));
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM token_deposit_intents WHERE account_id=$1',
        [capped.accountId],
      )
    ).rows[0].count,
    '20',
  );
});

void test('concurrent verifications credit exactly the quoted usd6 once from the token float', async () => {
  const owner = await walletOwner();
  const deposit = await intentFor(owner, '1000000');
  const evidence = evidenceFor(deposit, owner);
  const floatBefore = BigInt(await floatBalance());
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      creditTokenDepositEvidence(pool, owner.accountId, deposit.id, evidence),
    ),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
  assert.deepEqual(await getBalance(pool, owner.accountId), {
    availableUsd6: '1000000',
    reservedUsd6: '0',
    currency: 'USD6',
  });
  assert.equal(BigInt(await floatBalance()), floatBefore - 1000000n);
  const eventId = `token:devnet:${evidence.signature}:0`;
  const shape = await ledgerShape(`token-deposit:${eventId}`);
  assert.equal(shape.length, 2);
  assert.deepEqual(
    shape.map((entry) => [
      entry.transaction_kind,
      entry.kind,
      entry.owner_id,
      entry.amount_usd6,
    ]),
    [
      ['token_deposit', 'token_float', null, '-1000000'],
      ['token_deposit', 'available', owner.accountId, '1000000'],
    ],
  );
  const view = await getOwnedTokenDeposit(pool, owner.accountId, deposit.id);
  assert.equal(view.status, 'credited');
  assert.equal(view.state, 'credited');
  assert.equal(view.paymentWindowOpen, false);
  assert.equal(view.canVerify, false);
  assert.equal(view.settlement.signature, evidence.signature);
  assert.equal(view.settlement.transactionId, results[0].transactionId);
  assert.equal(view.settlement.slot, '1000');
  const stored = (
    await pool.query('SELECT * FROM token_deposit_intents WHERE id=$1', [
      deposit.id,
    ])
  ).rows[0];
  assert.equal(stored.credited_signature, evidence.signature);
  assert.equal(stored.credited_slot, '1000');
  assert.equal(stored.ledger_transaction_id, results[0].transactionId);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM token_deposit_events WHERE intent_id=$1',
        [deposit.id],
      )
    ).rows[0].count,
    '1',
  );
});

void test('replay is idempotent and a reused reference with a different payment is rejected, not credited', async () => {
  const owner = await walletOwner();
  const deposit = await intentFor(owner, '2000000');
  const evidence = evidenceFor(deposit, owner);
  const first = await creditTokenDepositEvidence(
    pool,
    owner.accountId,
    deposit.id,
    evidence,
  );
  assert.equal(first.replayed, false);
  const replay = await creditTokenDepositEvidence(
    pool,
    owner.accountId,
    deposit.id,
    evidence,
  );
  assert.deepEqual(replay, {
    credited: true,
    replayed: true,
    transactionId: first.transactionId,
  });
  // A second payment carrying the same reference is refused.
  const again = evidenceFor(deposit, owner);
  await assert.rejects(
    creditTokenDepositEvidence(pool, owner.accountId, deposit.id, again),
    code('TOKEN_DEPOSIT_ALREADY_CREDITED'),
  );
  // The credited transaction cannot be presented for a fresh intent.
  const other = await intentFor(owner, '2000000');
  await assert.rejects(
    creditTokenDepositEvidence(pool, owner.accountId, other.id, evidence),
    (error) => error.code === 'deposit_mismatch',
  );
  assert.equal(
    (await getBalance(pool, owner.accountId)).availableUsd6,
    '2000000',
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM token_deposit_events')).rows.length,
    1,
  );
  // Forged, underpaid or unfinalized evidence never credits a pending intent.
  for (const mutate of [
    (e) => {
      e.status.confirmationStatus = 'confirmed';
    },
    (e) => {
      e.transaction.meta.err = { InstructionError: [0, 'InvalidArgument'] };
      e.status.err = e.transaction.meta.err;
    },
    (e) => {
      e.transaction.transaction.message.accountKeys[3] = key();
    },
    (e) => {
      e.transaction.transaction.message.accountKeys[4] = key();
    },
    (e) => {
      e.transaction.transaction.message.accountKeys[0] = key();
    },
    (e) => {
      const bytes = bs58.decode(
        e.transaction.transaction.message.instructions[0].data,
      );
      new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).setBigUint64(1, BigInt(other.amountRaw) - 1n, true);
      e.transaction.transaction.message.instructions[0].data =
        bs58.encode(bytes);
    },
    (e) => {
      e.transaction.blockTime = Math.floor(Date.parse(other.expiresAt) / 1000);
    },
  ]) {
    const altered = evidenceFor(other, owner);
    mutate(altered);
    await assert.rejects(
      creditTokenDepositEvidence(pool, owner.accountId, other.id, altered),
    );
  }
  assert.equal(
    (await getBalance(pool, owner.accountId)).availableUsd6,
    '2000000',
  );
  assert.equal(
    (await getOwnedTokenDeposit(pool, owner.accountId, other.id)).status,
    'awaiting_payment',
  );
});

void test('intents expire, can be swept, and late in-window evidence still credits exactly once', async () => {
  const owner = await walletOwner();
  const past = Date.now() - 3_600_000;
  const old = await intentFor(owner, '1000000', { now: past });
  assert.equal(Date.parse(old.createdAt), past);
  assert.equal(old.status, 'expired');
  assert.equal(old.state, 'pending');
  assert.equal(old.paymentWindowOpen, false);
  assert.equal(old.canVerify, true);
  const fresh = await intentFor(owner);
  const swept = await expireTokenDepositIntents(pool);
  assert.ok(swept.expired >= 1);
  assert.equal(
    (await getOwnedTokenDeposit(pool, owner.accountId, old.id)).state,
    'expired',
  );
  assert.equal(
    (await getOwnedTokenDeposit(pool, owner.accountId, fresh.id)).state,
    'pending',
  );
  assert.deepEqual(await expireTokenDepositIntents(pool), { expired: 0 });
  // Payment made inside the window but verified after it closed.
  const late = evidenceFor(old, owner, {
    blockTime: Math.floor(Date.parse(old.createdAt) / 1000) + 30,
  });
  const credited = await creditTokenDepositEvidence(
    pool,
    owner.accountId,
    old.id,
    late,
  );
  assert.equal(credited.replayed, false);
  assert.equal(
    (await getOwnedTokenDeposit(pool, owner.accountId, old.id)).status,
    'credited',
  );
  assert.equal(
    (await getBalance(pool, owner.accountId)).availableUsd6,
    '1000000',
  );
  // Payment made after the window never credits, even against an expired intent.
  const another = await intentFor(owner, '1000000', { now: past });
  await expireTokenDepositIntents(pool);
  await assert.rejects(
    creditTokenDepositEvidence(
      pool,
      owner.accountId,
      another.id,
      evidenceFor(another, owner, { blockTime: Math.floor(Date.now() / 1000) }),
    ),
    (error) => error.code === 'deposit_mismatch',
  );
  assert.equal(
    (await getBalance(pool, owner.accountId)).availableUsd6,
    '1000000',
  );
});

void test('terms and events are immutable and the ledger cannot credit a token deposit without its event', async () => {
  const owner = await walletOwner();
  const deposit = await intentFor(owner, '1000000');
  for (const [sql, params] of [
    ['UPDATE token_deposit_intents SET usd6=2000000 WHERE id=$1', [deposit.id]],
    ['UPDATE token_deposit_intents SET amount_raw=1 WHERE id=$1', [deposit.id]],
    [
      'UPDATE token_deposit_intents SET price_usd6_per_token=1 WHERE id=$1',
      [deposit.id],
    ],
    [
      'UPDATE token_deposit_intents SET reference=$2 WHERE id=$1',
      [deposit.id, key()],
    ],
    [
      "UPDATE token_deposit_intents SET expires_at=now()+interval '1 day' WHERE id=$1",
      [deposit.id],
    ],
    [
      "UPDATE token_deposit_intents SET state='expired' WHERE id=$1",
      [deposit.id],
    ],
    [
      "UPDATE token_deposit_intents SET state='credited',credited_signature=$2,credited_slot=1,ledger_transaction_id=NULL WHERE id=$1",
      [deposit.id, txid()],
    ],
    ['DELETE FROM token_deposit_intents WHERE id=$1', [deposit.id]],
  ])
    await assert.rejects(pool.query(sql, params), checkViolation, sql);
  // A token_deposit ledger transaction with no verified event is refused at commit.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const available = (
      await client.query(
        "INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,$2,'available') ON CONFLICT(owner_id,kind) DO NOTHING RETURNING id",
        [randomUUID(), owner.accountId],
      )
    ).rows[0].id;
    const float = (
      await client.query(
        "SELECT id FROM ledger_accounts WHERE kind='token_float'",
      )
    ).rows[0].id;
    const id = randomUUID();
    await client.query(
      "INSERT INTO ledger_transactions(id,reference,kind) VALUES($1,$2,'token_deposit')",
      [id, `token-deposit:forged:${id}`],
    );
    await client.query(
      'INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,-1000000),($1,$3,1000000)',
      [id, float, available],
    );
    await assert.rejects(client.query('COMMIT'), checkViolation);
  } finally {
    client.release();
  }
  // The float may not receive credit and may not take part in other kinds.
  const direct = await pool.connect();
  try {
    await direct.query('BEGIN');
    const float = (
      await direct.query(
        "SELECT id FROM ledger_accounts WHERE kind='token_float'",
      )
    ).rows[0].id;
    const clearing = (
      await direct.query("SELECT id FROM ledger_accounts WHERE kind='clearing'")
    ).rows[0].id;
    const id = randomUUID();
    await direct.query(
      "INSERT INTO ledger_transactions(id,reference,kind) VALUES($1,$2,'deposit')",
      [id, `deposit:forged:${id}`],
    );
    await assert.rejects(
      direct.query(
        'INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,1000000),($1,$3,-1000000)',
        [id, float, clearing],
      ),
      checkViolation,
    );
    await direct.query('ROLLBACK');
  } finally {
    direct.release();
  }
  // An event row cannot be written without a matching same-transaction ledger credit.
  await assert.rejects(
    pool.query(
      `INSERT INTO token_deposit_events(event_id,intent_id,cluster,signature,instruction_index,amount_raw,ledger_transaction_id,slot,block_time)
      VALUES($1,$2,'devnet',$3,0,$4,$5,1,$6)`,
      [
        `token:devnet:${txid()}:0`,
        deposit.id,
        txid(),
        deposit.amountRaw,
        randomUUID(),
        Math.floor(Date.now() / 1000),
      ],
    ),
  );
  assert.equal((await getBalance(pool, owner.accountId)).availableUsd6, '0');
  // Credited rows stay frozen.
  const evidence = evidenceFor(deposit, owner);
  await creditTokenDepositEvidence(pool, owner.accountId, deposit.id, evidence);
  await assert.rejects(
    pool.query("UPDATE token_deposit_intents SET state='pending' WHERE id=$1", [
      deposit.id,
    ]),
    checkViolation,
  );
  await assert.rejects(
    pool.query('DELETE FROM token_deposit_events WHERE intent_id=$1', [
      deposit.id,
    ]),
    checkViolation,
  );
  await assert.rejects(
    pool.query(
      'UPDATE token_deposit_events SET amount_raw=1 WHERE intent_id=$1',
      [deposit.id],
    ),
    checkViolation,
  );
});

void test('owned reads never cross accounts and paginate within one cursor scope', async () => {
  const owner = await walletOwner(),
    other = await walletOwner();
  const deposit = await intentFor(owner);
  await assert.rejects(
    getOwnedTokenDeposit(pool, other.accountId, deposit.id),
    code('TOKEN_DEPOSIT_NOT_FOUND'),
  );
  await assert.rejects(
    creditTokenDepositEvidence(
      pool,
      other.accountId,
      deposit.id,
      evidenceFor(deposit, owner),
    ),
    code('TOKEN_DEPOSIT_NOT_FOUND'),
  );
  assert.equal(
    (await listOwnedTokenDeposits(pool, other.accountId, null)).deposits.length,
    0,
  );
  await Promise.all(Array.from({ length: 19 }, () => intentFor(owner)));
  await pool.query(
    `INSERT INTO token_deposit_intents(id,account_id,source_wallet,reference,cluster,token_mint,token_program,decimals,
      recipient_wallet,recipient_token_account,amount_raw,usd6,price_usd6_per_token,price_source,price_observed_at,created_at,expires_at)
    SELECT gen_random_uuid(),account_id,source_wallet,$2,cluster,token_mint,token_program,decimals,
      recipient_wallet,recipient_token_account,amount_raw,usd6,price_usd6_per_token,price_source,price_observed_at,created_at,expires_at
    FROM token_deposit_intents WHERE id=$1`,
    [deposit.id, key()],
  );
  const ids = [];
  let cursor = null;
  do {
    const page = await listOwnedTokenDeposits(pool, owner.accountId, cursor);
    assert.ok(page.deposits.length <= 20);
    ids.push(...page.deposits.map((entry) => entry.id));
    cursor = page.nextCursor;
    if (cursor)
      await assert.rejects(
        listOwnedTokenDeposits(pool, other.accountId, cursor),
        {
          code: 'INVALID_CURSOR',
        },
      );
  } while (cursor);
  assert.equal(ids.length, 21);
  assert.equal(new Set(ids).size, 21);
  assert.ok(ids.includes(deposit.id));
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    owner.accountId,
  ]);
  await assert.rejects(
    getOwnedTokenDeposit(pool, owner.accountId, deposit.id),
    {
      code: 'ACCOUNT_UNAVAILABLE',
    },
  );
  await assert.rejects(listOwnedTokenDeposits(pool, owner.accountId, null), {
    code: 'ACCOUNT_UNAVAILABLE',
  });
  // Trusted settlement still honours a received payment for a disabled account.
  await creditTokenDepositEvidence(
    pool,
    owner.accountId,
    deposit.id,
    evidenceFor(deposit, owner),
  );
  assert.equal(
    (await getBalance(pool, owner.accountId)).availableUsd6,
    '1000000',
  );
});

void test('signed-in API quotes, lists, reads and verifies through the configured reader', async () => {
  const owner = await walletOwner();
  const capabilities = await api(owner, 'token/deposits/capabilities');
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.configured, true);
  assert.equal(capabilities.body.label, 'platform token');
  const created = await api(owner, 'token/deposits', { usd6: '1000000' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const deposit = created.body.deposit;
  assert.equal(deposit.amountRaw, '2500000000');
  assert.equal(deposit.sourceWallet, owner.sourceWallet);
  const listed = await api(owner, 'token/deposits');
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.deposits.map((entry) => entry.id),
    [deposit.id],
  );
  assert.equal(listed.body.nextCursor, null);
  const read = await api(owner, `token/deposits/${deposit.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.deposit.reference, deposit.reference);
  for (const body of [{}, { usd6: '1000000', extra: true }, { usd6: 1000000 }])
    assert.equal((await api(owner, 'token/deposits', body)).status, 400);
  // A malformed wallet is typed Solana input, reported like the USDC path does.
  const malformed = await api(owner, 'token/deposits', {
    usd6: '1000000',
    sourceWallet: 'nope',
  });
  assert.equal(malformed.status, 422);
  assert.equal(malformed.body.error.code, 'SOLANA_INVALID_INPUT');
  assert.equal((await api(owner, 'token/deposits?limit=5')).status, 400);
  assert.equal((await api(owner, 'token/deposits/not-a-uuid')).status, 400);
  // Verification reads evidence from the configured https reader only.
  const evidence = evidenceFor(deposit, owner);
  mockRpc(evidence);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      api(owner, `token/deposits/${deposit.id}/verify`, {
        signature: evidence.signature,
      }),
    ),
  );
  for (const response of responses)
    assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(
    responses.filter((response) => !response.body.replayed).length,
    1,
  );
  assert.equal(
    new Set(responses.map((response) => response.body.transactionId)).size,
    1,
  );
  assert.ok(
    responses.every((response) => response.body.deposit.status === 'credited'),
  );
  assert.ok(
    rpcCalls.includes('getGenesisHash') && rpcCalls.includes('getTransaction'),
  );
  const balance = await api(owner, 'balance');
  assert.equal(balance.status, 200);
  assert.equal(balance.body.availableUsd6, '1000000');
  // Replay without RPC; another signature is refused.
  const callsBefore = rpcCalls.length;
  const replay = await api(owner, `token/deposits/${deposit.id}/verify`, {
    signature: evidence.signature,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(rpcCalls.length, callsBefore);
  const foreign = await api(owner, `token/deposits/${deposit.id}/verify`, {
    signature: txid(),
  });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.error.code, 'TOKEN_DEPOSIT_ALREADY_CREDITED');
  assert.equal(rpcCalls.length, callsBefore);
  assert.equal(
    (
      await api(owner, `token/deposits/${deposit.id}/verify`, {
        signature: 'short',
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await api(owner, `token/deposits/${deposit.id}/verify`, {
        signature: txid(),
        transaction: {},
      })
    ).status,
    400,
  );
});

void test('API refuses other accounts, missing sessions, cross-origin writes and a disabled capability', async () => {
  const owner = await walletOwner(),
    other = await walletOwner();
  const deposit = (await api(owner, 'token/deposits', { usd6: '1000000' })).body
    .deposit;
  assert.equal((await api(other, `token/deposits/${deposit.id}`)).status, 404);
  assert.equal(
    (
      await api(other, `token/deposits/${deposit.id}/verify`, {
        signature: txid(),
      })
    ).status,
    404,
  );
  assert.equal((await api(other, 'token/deposits')).body.deposits.length, 0);
  const anonymous = await dispatch(
    new Request('https://conclave.test/api/token/deposits', {
      headers: { origin: 'https://conclave.test' },
    }),
  );
  assert.equal(anonymous.status, 401);
  const crossSite = await dispatch(
    new Request('https://conclave.test/api/token/deposits', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        cookie: owner.cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ usd6: '1000000' }),
    }),
  );
  assert.equal(crossSite.status, 403);
  assert.deepEqual(rpcCalls, []);
  // Wrong-amount and unfinalized chain evidence fail with 422 and no credit.
  for (const mutate of [
    (e) => {
      e.status.confirmationStatus = 'confirmed';
    },
    (e) => {
      const bytes = bs58.decode(
        e.transaction.transaction.message.instructions[0].data,
      );
      new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).setBigUint64(1, 1n, true);
      e.transaction.transaction.message.instructions[0].data =
        bs58.encode(bytes);
    },
    (e) => {
      e.genesisHash = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
    },
  ]) {
    const evidence = evidenceFor(deposit, owner);
    mutate(evidence);
    mockRpc(evidence);
    const response = await api(owner, `token/deposits/${deposit.id}/verify`, {
      signature: evidence.signature,
    });
    assert.equal(response.status, 422);
    assert.ok(response.body.error.code.startsWith('SOLANA_'));
  }
  assert.equal((await api(owner, 'balance')).body.availableUsd6, '0');
  // Disabled payments: reads still work, quotes and verification stop before any RPC.
  configuration({ CONCLAVE_TOKEN_PAYMENTS_ENABLED: 'false' });
  rpcCalls = [];
  const capabilities = await api(owner, 'token/deposits/capabilities');
  assert.equal(capabilities.body.configured, false);
  assert.equal(capabilities.body.reason, 'TOKEN_PAYMENTS_DISABLED');
  const refused = await api(owner, 'token/deposits', { usd6: '1000000' });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'TOKEN_PAYMENTS_DISABLED');
  const verify = await api(owner, `token/deposits/${deposit.id}/verify`, {
    signature: txid(),
  });
  assert.equal(verify.status, 503);
  assert.equal(verify.body.error.code, 'TOKEN_PAYMENTS_DISABLED');
  const read = await api(owner, `token/deposits/${deposit.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.deposit.paymentWindowOpen, false);
  assert.equal(read.body.deposit.canVerify, false);
  // A changed treasury is a different policy; the intent's terms are not re-read from the environment.
  configuration({ CONCLAVE_TOKEN_TREASURY_WALLET: key() });
  const mismatch = await api(owner, `token/deposits/${deposit.id}/verify`, {
    signature: txid(),
  });
  assert.equal(mismatch.status, 503);
  assert.equal(mismatch.body.error.code, 'TOKEN_DEPOSIT_POLICY_UNAVAILABLE');
  assert.deepEqual(rpcCalls, []);
});

void test('route factory accepts an injected evidence reader and reports when none is available', async () => {
  const owner = await walletOwner();
  const deposit = (await routes(owner, 'token/deposits', { usd6: '3000000' }))
    .body.deposit;
  assert.equal(deposit.amountRaw, '7500000000');
  const evidence = evidenceFor(deposit, owner);
  const requested = [];
  const reader = {
    async readDepositEvidence(signature) {
      requested.push(signature);
      return evidence;
    },
  };
  const none = await routes(
    owner,
    `token/deposits/${deposit.id}/verify`,
    { signature: evidence.signature },
    { evidenceReader: null },
  );
  assert.equal(none.status, 503);
  assert.equal(none.body.error.code, 'TOKEN_EVIDENCE_UNAVAILABLE');
  const verified = await routes(
    owner,
    `token/deposits/${deposit.id}/verify`,
    { signature: evidence.signature },
    { evidenceReader: reader },
  );
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.credited, true);
  assert.deepEqual(requested, [evidence.signature]);
  assert.equal(
    (await getBalance(pool, owner.accountId)).availableUsd6,
    '3000000',
  );
  // Localnet has no default reader: the http validator endpoint is never contacted.
  configuration({
    CONCLAVE_TOKEN_CLUSTER: 'localnet',
    CONCLAVE_TOKEN_RPC_URL: 'http://127.0.0.1:8899',
  });
  const local = (await routes(owner, 'token/deposits', { usd6: '1000000' }))
    .body.deposit;
  assert.equal(local.cluster, 'localnet');
  const unavailable = await routes(owner, `token/deposits/${local.id}/verify`, {
    signature: txid(),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, 'TOKEN_EVIDENCE_UNAVAILABLE');
  // Injected localnet evidence with a private genesis credits at the quoted value.
  const localEvidence = {
    ...evidenceFor(local, owner),
    cluster: 'localnet',
    genesisHash: key(),
  };
  const credited = await routes(
    owner,
    `token/deposits/${local.id}/verify`,
    { signature: localEvidence.signature },
    { evidenceReader: { readDepositEvidence: async () => localEvidence } },
  );
  assert.equal(credited.status, 200, JSON.stringify(credited.body));
  assert.equal(
    (await getBalance(pool, owner.accountId)).availableUsd6,
    '4000000',
  );
  // An injected price source overrides the configured one for quotes.
  const priced = await routes(
    owner,
    'token/deposits',
    { usd6: '1000000' },
    {
      priceSource: createSimulatedPriceSource({ priceUsd6PerToken: 200000n }),
    },
  );
  assert.equal(priced.status, 201);
  assert.equal(priced.body.deposit.amountRaw, '5000000000');
  assert.deepEqual(rpcCalls, []);
});
