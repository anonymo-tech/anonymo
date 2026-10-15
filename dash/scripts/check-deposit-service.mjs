import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after, beforeEach } from 'node:test';
import bs58 from 'bs58';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  creditDepositEvidence,
  createOwnedDeposit,
  getOwnedDeposit,
  listOwnedDeposits,
} from '../server/solana/deposit-store.ts';
import { depositCapability } from '../server/solana/deposit-config.ts';
import { solanaRoutes } from '../server/routes/solana.ts';
import { handleApi } from '../server/core/http.ts';
import { digestText } from '../server/core/digest.ts';
import { getBalance } from '../server/ledger/ledger.ts';
import { SOLANA_NETWORKS, TOKEN_PROGRAM } from '../server/solana/index.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error('An isolated CONCLAVE_TEST_DATABASE_URL is required.');
const url = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('Only loopback test databases are supported.');
const pool = createDatabase(connection, 8);
before(() => migrate(pool));
after(() => pool.end());
const key = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)));

async function fixture({ blockTime = Math.floor(Date.now() / 1000) } = {}) {
  const accountId = randomUUID(),
    intentId = randomUUID();
  const sourceWallet = key(),
    sourceAccount = key(),
    recipientWallet = key(),
    recipientAccount = key(),
    reference = key();
  const mint = SOLANA_NETWORKS.devnet.usdcMint;
  const signature = bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
  const policy = {
    cluster: 'devnet',
    recipientWallet,
    recipientTokenAccount: recipientAccount,
    usdcMint: mint,
  };
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    `INSERT INTO deposit_intents(id,account_id,source_wallet,reference,amount_usd6,policy,created_at,expires_at)
    VALUES($1,$2,$3,$4,1000000,$5,$6,$7)`,
    [
      intentId,
      accountId,
      sourceWallet,
      reference,
      policy,
      new Date((blockTime - 10) * 1000),
      new Date((blockTime + 300) * 1000),
    ],
  );
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, 1000000n, true);
  data[9] = 6;
  const balance = (accountIndex, owner, amount) => ({
    accountIndex,
    mint,
    owner,
    programId: TOKEN_PROGRAM,
    uiTokenAmount: {
      amount,
      decimals: 6,
      uiAmount: null,
      uiAmountString: 'ignored',
    },
  });
  const evidence = {
    cluster: 'devnet',
    genesisHash: SOLANA_NETWORKS.devnet.genesisHash,
    signature,
    status: {
      slot: 1000,
      confirmations: null,
      err: null,
      confirmationStatus: 'finalized',
    },
    transaction: {
      version: 'legacy',
      slot: 1000,
      blockTime,
      meta: {
        err: null,
        innerInstructions: [],
        loadedAddresses: { writable: [], readonly: [] },
        preTokenBalances: [
          balance(1, sourceWallet, '9000000'),
          balance(2, recipientWallet, '0'),
        ],
        postTokenBalances: [
          balance(1, sourceWallet, '8000000'),
          balance(2, recipientWallet, '1000000'),
        ],
      },
      transaction: {
        signatures: [signature],
        message: {
          header: {
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 3,
          },
          accountKeys: [
            sourceWallet,
            sourceAccount,
            recipientAccount,
            mint,
            reference,
            TOKEN_PROGRAM,
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
  return { accountId, intentId, evidence, policy, sourceWallet };
}

void test('concurrent notifications credit one finalized deposit exactly once with a balanced journal', async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      creditDepositEvidence(pool, f.accountId, f.intentId, f.evidence),
    ),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
  assert.deepEqual(await getBalance(pool, f.accountId), {
    availableUsd6: '1000000',
    reservedUsd6: '0',
    currency: 'USD6',
  });
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM deposit_events WHERE intent_id=$1',
        [f.intentId],
      )
    ).rows[0].count,
    '1',
  );
});

void test('forged references, wrong account ownership, wrong mint and incomplete finality never credit', async () => {
  const f = await fixture(),
    other = await fixture();
  await assert.rejects(
    creditDepositEvidence(pool, other.accountId, f.intentId, f.evidence),
    { code: 'DEPOSIT_NOT_FOUND' },
  );
  for (const mutate of [
    (value) => {
      value.status.confirmationStatus = 'confirmed';
    },
    (value) => {
      value.transaction.transaction.message.accountKeys[4] = key();
    },
    (value) => {
      value.transaction.transaction.message.accountKeys[3] = key();
    },
    (value) => {
      value.transaction.meta.err = { InstructionError: [0, 'InvalidArgument'] };
    },
  ]) {
    const altered = structuredClone(f.evidence);
    mutate(altered);
    await assert.rejects(
      creditDepositEvidence(pool, f.accountId, f.intentId, altered),
    );
  }
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '0');
  assert.equal(
    (
      await pool.query('SELECT state FROM deposit_intents WHERE id=$1', [
        f.intentId,
      ])
    ).rows[0].state,
    'awaiting_payment',
  );
});

void test('credited intents cannot be edited or credited from another signature', async () => {
  const f = await fixture();
  await creditDepositEvidence(pool, f.accountId, f.intentId, f.evidence);
  await assert.rejects(
    pool.query('UPDATE deposit_intents SET amount_usd6=2000000 WHERE id=$1', [
      f.intentId,
    ]),
    { code: '23514' },
  );
  await assert.rejects(
    pool.query('DELETE FROM deposit_events WHERE intent_id=$1', [f.intentId]),
    { code: '23514' },
  );
  const altered = structuredClone(f.evidence);
  altered.signature = bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
  altered.transaction.transaction.signatures = [altered.signature];
  await assert.rejects(
    creditDepositEvidence(pool, f.accountId, f.intentId, altered),
    { code: 'DEPOSIT_ALREADY_CREDITED' },
  );
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});

const originalFetch = globalThis.fetch;
const configKeys = [
  'CONCLAVE_MODE',
  'CONCLAVE_APP_ORIGIN',
  'CONCLAVE_DATABASE_URL',
  'CONCLAVE_SOLANA_CLUSTER',
  'CONCLAVE_SOLANA_RPC_URL',
  'CONCLAVE_TREASURY_WALLET',
  'CONCLAVE_TREASURY_TOKEN_ACCOUNT',
  'CONCLAVE_MAX_DEPOSIT_USD6',
  'CONCLAVE_DEPOSITS_ENABLED',
  'CONCLAVE_DEPOSIT_RECOVERY_ENABLED',
];
const previousEnv = Object.fromEntries(
  configKeys.map((name) => [name, process.env[name]]),
);
let rpcCalls;
function configuration(
  policy = {
    cluster: 'devnet',
    recipientWallet: key(),
    recipientTokenAccount: key(),
  },
) {
  Object.assign(process.env, {
    CONCLAVE_MODE: 'service',
    CONCLAVE_APP_ORIGIN: 'https://conclave.test',
    CONCLAVE_DATABASE_URL: connection,
    CONCLAVE_SOLANA_CLUSTER: policy.cluster,
    CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example/?key=fixture-marker',
    CONCLAVE_TREASURY_WALLET: policy.recipientWallet,
    CONCLAVE_TREASURY_TOKEN_ACCOUNT: policy.recipientTokenAccount,
    CONCLAVE_MAX_DEPOSIT_USD6: '100000000',
    CONCLAVE_DEPOSITS_ENABLED: 'true',
    CONCLAVE_DEPOSIT_RECOVERY_ENABLED: 'false',
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
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
async function walletOwner() {
  const accountId = randomUUID(),
    sourceWallet = key();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'solana',$3)",
    [randomUUID(), accountId, sourceWallet],
  );
  return {
    accountId,
    sourceWallet,
    amountUsd6: '1000000',
    idempotencyKey: randomUUID(),
  };
}
async function api(
  accountId,
  path,
  body,
  method = body === undefined ? 'GET' : 'POST',
) {
  const request = new Request(`https://conclave.test/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleApi(() =>
    solanaRoutes(pool, request, path.split('?')[0], accountId),
  );
}
function mockRpc(evidence, override) {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, process.env.CONCLAVE_SOLANA_RPC_URL);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    rpcCalls.push(body.method);
    assert.ok(
      ['getGenesisHash', 'getSignatureStatuses', 'getTransaction'].includes(
        body.method,
      ),
    );
    if (override) return override(body);
    const result =
      body.method === 'getGenesisHash'
        ? evidence.genesisHash
        : body.method === 'getSignatureStatuses'
          ? { value: [evidence.status] }
          : evidence.transaction;
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
}

void test('capabilities validate complete explicit configuration without requests or endpoint disclosure', () => {
  const enabled = depositCapability();
  assert.equal(enabled.configured, true);
  assert.equal(enabled.recoveryConfigured, true);
  assert.equal(enabled.networkVerified, false);
  assert.equal(enabled.walletSubmission, false);
  assert.equal(enabled.intentSeconds, 900);
  assert.ok(!JSON.stringify(enabled).includes('rpc.example'));
  assert.ok(!JSON.stringify(enabled).includes('fixture-marker'));
  assert.ok(!JSON.stringify(enabled).includes(connection));
  for (const [name, value] of [
    ['CONCLAVE_MODE', 'preview'],
    ['CONCLAVE_APP_ORIGIN', ''],
    ['CONCLAVE_DATABASE_URL', ''],
    ['CONCLAVE_SOLANA_CLUSTER', 'testnet'],
    ['CONCLAVE_SOLANA_RPC_URL', 'http://rpc.example'],
    ['CONCLAVE_TREASURY_WALLET', 'not-a-wallet'],
    ['CONCLAVE_TREASURY_TOKEN_ACCOUNT', process.env.CONCLAVE_TREASURY_WALLET],
    ['CONCLAVE_MAX_DEPOSIT_USD6', '0'],
    ['CONCLAVE_MAX_DEPOSIT_USD6', '1.25'],
  ]) {
    const capability = depositCapability({ ...process.env, [name]: value });
    assert.equal(capability.configured, false);
    assert.equal(capability.recoveryConfigured, false);
    assert.equal(capability.recipientWallet, null);
  }
  process.env.CONCLAVE_DEPOSITS_ENABLED = 'false';
  assert.equal(depositCapability().recoveryConfigured, false);
  process.env.CONCLAVE_DEPOSIT_RECOVERY_ENABLED = 'true';
  assert.equal(depositCapability().configured, false);
  assert.equal(depositCapability().recoveryConfigured, true);
  assert.deepEqual(rpcCalls, []);
});

void test('concurrent intent retries create one immutable reference and recover the same response', async () => {
  const input = await walletOwner();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => createOwnedDeposit(pool, input)),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.deposit.id)).size, 1);
  assert.equal(
    new Set(results.map((result) => result.deposit.reference)).size,
    1,
  );
  const deposit = results[0].deposit;
  assert.equal(
    Date.parse(deposit.expiresAt) - Date.parse(deposit.createdAt),
    900000,
  );
  assert.equal(deposit.paymentWindowOpen, true);
  assert.equal(deposit.status, 'awaiting_payment');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM deposit_intent_requests WHERE account_id=$1',
        [input.accountId],
      )
    ).rows[0].count,
    '1',
  );
  const response = await api(input.accountId, 'deposits', {
    amountUsd6: input.amountUsd6,
    sourceWallet: input.sourceWallet,
    idempotencyKey: input.idempotencyKey,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deposit.id, deposit.id);
  assert.deepEqual(rpcCalls, []);
});

void test('intent retry keys bind source and amount while replay survives new-payment shutdown', async () => {
  const input = await walletOwner(),
    original = await createOwnedDeposit(pool, input);
  for (const change of [{ amountUsd6: '2000000' }, { sourceWallet: key() }])
    await assert.rejects(createOwnedDeposit(pool, { ...input, ...change }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  process.env.CONCLAVE_DEPOSITS_ENABLED = 'false';
  process.env.CONCLAVE_SOLANA_RPC_URL = '';
  const replay = await createOwnedDeposit(pool, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.deposit.id, original.deposit.id);
  assert.equal(replay.deposit.paymentWindowOpen, false);
  assert.equal(replay.deposit.canReconcile, false);
  await assert.rejects(
    createOwnedDeposit(pool, { ...input, idempotencyKey: randomUUID() }),
    { code: 'DEPOSITS_UNAVAILABLE' },
  );
  await assert.rejects(
    pool.query(
      'UPDATE deposit_intent_requests SET request_hash=$1 WHERE intent_id=$2',
      ['0'.repeat(64), original.deposit.id],
    ),
    { code: '23514' },
  );
});

void test('creation rejects unknown fields, unverifiable wallets, unsafe money and excessive open intents', async () => {
  const input = await walletOwner();
  const body = {
    sourceWallet: input.sourceWallet,
    amountUsd6: input.amountUsd6,
    idempotencyKey: input.idempotencyKey,
  };
  for (const changed of [
    { ...body, rpcUrl: 'https://other.example' },
    { ...body, policy: {} },
    { sourceWallet: body.sourceWallet, amountUsd6: body.amountUsd6 },
  ])
    assert.equal((await api(input.accountId, 'deposits', changed)).status, 400);
  await assert.rejects(
    createOwnedDeposit(pool, { ...input, sourceWallet: key() }),
    { code: 'WALLET_NOT_VERIFIED' },
  );
  for (const amountUsd6 of ['0', '1.5', '90000000000000000000'])
    await assert.rejects(createOwnedDeposit(pool, { ...input, amountUsd6 }));
  await assert.rejects(
    createOwnedDeposit(pool, { ...input, amountUsd6: '100000001' }),
    { code: 'DEPOSIT_LIMIT' },
  );
  await Promise.all(
    Array.from({ length: 20 }, () =>
      createOwnedDeposit(pool, { ...input, idempotencyKey: randomUUID() }),
    ),
  );
  await assert.rejects(createOwnedDeposit(pool, input), {
    code: 'DEPOSIT_INTENT_LIMIT',
  });
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM deposit_intents WHERE account_id=$1',
        [input.accountId],
      )
    ).rows[0].count,
    '20',
  );
});

void test('owned history paginates tied timestamps and never crosses owners or cursor scope', async () => {
  const f = await fixture(),
    other = await fixture();
  await pool.query(
    `INSERT INTO deposit_intents(id,account_id,source_wallet,reference,amount_usd6,policy,created_at,expires_at)
    SELECT gen_random_uuid(),account_id,source_wallet,gen_random_uuid()::text,amount_usd6,policy,created_at,expires_at
    FROM deposit_intents CROSS JOIN generate_series(1,44) WHERE id=$1`,
    [f.intentId],
  );
  const ids = [];
  let cursor = null;
  do {
    const page = await listOwnedDeposits(pool, f.accountId, cursor);
    assert.ok(page.deposits.length <= 20);
    ids.push(...page.deposits.map((deposit) => deposit.id));
    cursor = page.nextCursor;
    if (cursor)
      await assert.rejects(listOwnedDeposits(pool, other.accountId, cursor), {
        code: 'INVALID_CURSOR',
      });
  } while (cursor);
  assert.equal(ids.length, 45);
  assert.equal(new Set(ids).size, 45);
  assert.ok(!ids.includes(other.intentId));
  assert.equal(
    (await api(other.accountId, `deposits/${f.intentId}`)).status,
    404,
  );
  assert.equal(
    (
      await api(other.accountId, `deposits/${f.intentId}/reconcile`, {
        signature: f.evidence.signature,
      })
    ).status,
    404,
  );
  assert.equal((await api(f.accountId, 'deposits?limit=1000')).status, 400);
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    f.accountId,
  ]);
  await assert.rejects(getOwnedDeposit(pool, f.accountId, f.intentId), {
    code: 'ACCOUNT_UNAVAILABLE',
  });
  await assert.rejects(listOwnedDeposits(pool, f.accountId, null), {
    code: 'ACCOUNT_UNAVAILABLE',
  });
  assert.deepEqual(rpcCalls, []);
});

void test('expired intents retain recovery and late finalized in-window evidence credits once', async () => {
  const f = await fixture({ blockTime: Math.floor(Date.now() / 1000) - 3600 });
  configuration(f.policy);
  process.env.CONCLAVE_DEPOSITS_ENABLED = 'false';
  process.env.CONCLAVE_DEPOSIT_RECOVERY_ENABLED = 'true';
  const old = await getOwnedDeposit(pool, f.accountId, f.intentId);
  assert.equal(old.status, 'expired');
  assert.equal(old.paymentWindowOpen, false);
  assert.equal(old.canReconcile, true);
  mockRpc(f.evidence);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      api(f.accountId, `deposits/${f.intentId}/reconcile`, {
        signature: f.evidence.signature,
      }),
    ),
  );
  const results = await Promise.all(
    responses.map(async (response) => {
      assert.equal(response.status, 200);
      return response.json();
    }),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
  assert.ok(
    results.every(
      (result) =>
        result.deposit.status === 'credited' &&
        result.deposit.settlement.signature === f.evidence.signature,
    ),
  );
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
  assert.ok(rpcCalls.includes('getTransaction'));
});

void test('expired-window, wrong amount, missing time and reference evidence cannot credit', async () => {
  const f = await fixture({ blockTime: Math.floor(Date.now() / 1000) - 3600 });
  configuration(f.policy);
  const intent = await getOwnedDeposit(pool, f.accountId, f.intentId);
  for (const mutate of [
    (e) => {
      e.transaction.blockTime = Math.floor(Date.parse(intent.expiresAt) / 1000);
    },
    (e) => {
      e.transaction.blockTime =
        Math.floor(Date.parse(intent.createdAt) / 1000) - 1;
    },
    (e) => {
      e.transaction.blockTime = null;
    },
    (e) => {
      const bytes = bs58.decode(
        e.transaction.transaction.message.instructions[0].data,
      );
      new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).setBigUint64(1, 999999n, true);
      e.transaction.transaction.message.instructions[0].data =
        bs58.encode(bytes);
    },
    (e) => {
      e.transaction.transaction.message.accountKeys[4] = key();
    },
  ]) {
    const evidence = structuredClone(f.evidence);
    mutate(evidence);
    mockRpc(evidence);
    assert.equal(
      (
        await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
          signature: evidence.signature,
        })
      ).status,
      422,
    );
  }
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '0');
  assert.equal(
    (await getOwnedDeposit(pool, f.accountId, f.intentId)).status,
    'expired',
  );
});

void test('non-final, failed and unavailable chain responses remain recoverable without credit', async () => {
  const f = await fixture();
  configuration(f.policy);
  for (const change of [
    (e) => {
      e.status.confirmationStatus = 'confirmed';
    },
    (e) => {
      e.status.err = { InstructionError: [0, 'InvalidArgument'] };
      e.transaction.meta.err = e.status.err;
    },
    (e) => {
      e.genesisHash = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
    },
  ]) {
    const evidence = structuredClone(f.evidence);
    change(evidence);
    mockRpc(evidence);
    const response = await api(
      f.accountId,
      `deposits/${f.intentId}/reconcile`,
      { signature: evidence.signature },
    );
    assert.equal(response.status, 422);
    assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '0');
  }
  mockRpc(f.evidence, () => new Response('', { status: 503 }));
  const failed = await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
    signature: f.evidence.signature,
  });
  assert.equal((await failed.json()).error.retryable, true);
  assert.equal(
    (await getOwnedDeposit(pool, f.accountId, f.intentId)).canReconcile,
    true,
  );
  mockRpc(f.evidence);
  assert.equal(
    (
      await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
        signature: f.evidence.signature,
      })
    ).status,
    200,
  );
});

void test('reconciliation checks explicit gates and immutable treasury policy before any RPC', async () => {
  const f = await fixture();
  configuration(f.policy);
  mockRpc(f.evidence);
  process.env.CONCLAVE_DEPOSITS_ENABLED = 'false';
  assert.equal(
    (
      await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
        signature: f.evidence.signature,
      })
    ).status,
    503,
  );
  process.env.CONCLAVE_DEPOSIT_RECOVERY_ENABLED = 'true';
  process.env.CONCLAVE_TREASURY_WALLET = key();
  assert.equal(
    (
      await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
        signature: f.evidence.signature,
      })
    ).status,
    503,
  );
  assert.equal(
    (await getOwnedDeposit(pool, f.accountId, f.intentId)).canReconcile,
    false,
  );
  assert.deepEqual(rpcCalls, []);
  configuration(f.policy);
  assert.equal(
    (
      await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
        signature: f.evidence.signature,
        transaction: f.evidence.transaction,
      })
    ).status,
    400,
  );
  assert.deepEqual(rpcCalls, []);
});

void test('credited replay survives disabled recovery and RPC failure without crediting a second signature', async () => {
  const f = await fixture();
  configuration(f.policy);
  mockRpc(f.evidence);
  const initial = await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
    signature: f.evidence.signature,
  });
  assert.equal(initial.status, 200);
  const result = await initial.json(),
    callsBefore = rpcCalls.length;
  process.env.CONCLAVE_DEPOSITS_ENABLED = 'false';
  process.env.CONCLAVE_SOLANA_RPC_URL = '';
  const retry = await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
    signature: f.evidence.signature,
  });
  const replay = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.transactionId, result.transactionId);
  assert.equal(rpcCalls.length, callsBefore);
  assert.equal(
    (
      await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
        signature: bs58.encode(crypto.getRandomValues(new Uint8Array(64))),
      })
    ).status,
    409,
  );
  assert.equal(rpcCalls.length, callsBefore);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});

void test('intent request records enforce owner binding and reject mutation', async () => {
  const a = await walletOwner(),
    b = await walletOwner(),
    result = await createOwnedDeposit(pool, a);
  await assert.rejects(
    pool.query(
      'INSERT INTO deposit_intent_requests(account_id,idempotency_key,intent_id,request_hash) VALUES($1,$2,$3,$4)',
      [b.accountId, randomUUID(), result.deposit.id, 'a'.repeat(64)],
    ),
    { code: '23514' },
  );
  await assert.rejects(
    pool.query('DELETE FROM deposit_intent_requests WHERE intent_id=$1', [
      result.deposit.id,
    ]),
    { code: '23514' },
  );
  const separate = await createOwnedDeposit(pool, {
    ...b,
    idempotencyKey: a.idempotencyKey,
  });
  assert.notEqual(separate.deposit.id, result.deposit.id);
});

void test('response recovery and settlement races preserve one intent and consistent credit state', async () => {
  const f = await fixture();
  configuration(f.policy);
  const input = {
    accountId: f.accountId,
    sourceWallet: f.sourceWallet,
    amountUsd6: '1000000',
    idempotencyKey: randomUUID(),
  };
  const hash = await digestText(
    'deposit-intent',
    JSON.stringify({
      sourceWallet: input.sourceWallet,
      amountUsd6: input.amountUsd6,
    }),
  );
  await pool.query(
    'INSERT INTO deposit_intent_requests(account_id,idempotency_key,intent_id,request_hash) VALUES($1,$2,$3,$4)',
    [f.accountId, input.idempotencyKey, f.intentId, hash],
  );
  const results = await Promise.all([
    createOwnedDeposit(pool, input),
    creditDepositEvidence(pool, f.accountId, f.intentId, f.evidence),
    getOwnedDeposit(pool, f.accountId, f.intentId),
    listOwnedDeposits(pool, f.accountId, null),
  ]);
  assert.equal(results[0].replayed, true);
  assert.equal(results[0].deposit.id, f.intentId);
  for (const deposit of [
    results[0].deposit,
    results[2],
    results[3].deposits[0],
  ])
    assert.equal(deposit.status === 'credited', deposit.settlement !== null);
  assert.equal(
    (await getOwnedDeposit(pool, f.accountId, f.intentId)).status,
    'credited',
  );
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});

void test('disabled accounts cannot recover through the owned API while trusted settlement preserves funds owed', async () => {
  const f = await fixture();
  configuration(f.policy);
  mockRpc(f.evidence);
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    f.accountId,
  ]);
  assert.equal(
    (
      await api(f.accountId, `deposits/${f.intentId}/reconcile`, {
        signature: f.evidence.signature,
      })
    ).status,
    404,
  );
  assert.deepEqual(rpcCalls, []);
  await creditDepositEvidence(pool, f.accountId, f.intentId, f.evidence);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});
