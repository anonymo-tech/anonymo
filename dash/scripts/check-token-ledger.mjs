import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import bs58 from 'bs58';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { post } from '../server/ledger/ledger.ts';
import {
  burnReserveStats,
  splitPlatformFee,
} from '../server/ledger/platform-fee.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { platformTokenConfig } from '../server/token/config.ts';
import {
  burnPeriodOverlaps,
  listTokenBurns,
  maturedBurnReserveUsd6,
  nextBurnPeriodStart,
  recordBurnExecution,
  tokenBurnSummary,
  verifyTokenBurnRecord,
} from '../server/token/burn-ledger.ts';
import { executeBurn } from '../server/token/burn.ts';
import { createSimulatedJupiter } from '../server/token/buyback.ts';
import { createSimulatedPriceSource } from '../server/token/price.ts';
import { keypairFromSeed } from '../server/token/transaction-builder.ts';
import { parseSerializedTransaction } from '../server/solana/serialized.ts';
import { TOKEN_2022_PROGRAM } from '../server/solana/validation.ts';

// Fresh-database suite for migration 021 and the burn ledger. Accruals are
// written through the 019 settlement shape with backdated timestamps so hour
// cutoffs can be tested deterministically; the chain is a fake RPC, so this
// proves the ledger and record invariants, not the validator path (see
// scripts/localnet-burn-rehearsal.mjs for that).

const connection = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href;
Object.assign(process.env, {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.test',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_DATA_KEYS: JSON.stringify({ test: randomBytes(32).toString('base64') }),
  CONCLAVE_ACTIVE_DATA_KEY: 'test',
});
delete process.env.CONCLAVE_PLATFORM_FEE_BPS;
delete process.env.CONCLAVE_BURN_SHARE_BPS;
const pool = createDatabase(connection, 12);
let user;
before(async () => {
  await migrate(pool);
  user = await owner();
});
after(() => pool.end());

const code = (value) => (error) => error.code === value;
const checkViolation = (error) => error.code === '23514';
const future = () => new Date(Date.now() + 7_200_000);
const HOUR = 3_600_000;
const key = (n) => bs58.encode(Buffer.alloc(32, n));
const mint = key(5);
const burnTokenAccount = key(6);
const makerTokenAccount = key(7);
const burnWallet = keypairFromSeed(Uint8Array.from(Buffer.alloc(32, 1)));
const maker = keypairFromSeed(Uint8Array.from(Buffer.alloc(32, 2)));
const localnet = platformTokenConfig({
  CONCLAVE_TOKEN_MINT: mint,
  CONCLAVE_TOKEN_CLUSTER: 'localnet',
  CONCLAVE_TOKEN_RPC_URL: 'http://127.0.0.1:8999',
  CONCLAVE_TOKEN_DECIMALS: '6',
  CONCLAVE_TOKEN_PROGRAM: 'token-2022',
  CONCLAVE_TOKEN_BURN_ENABLED: 'true',
});
const disabled = { ...localnet, burnEnabled: false };
const priceSource = createSimulatedPriceSource({ priceUsd6PerToken: 250_000n });

// The current whole UTC hour; every fixture timestamp is relative to it so a
// suite that straddles an hour boundary still sees the same cutoffs.
const T = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const hoursAgo = (hours, extraMinutes = 0) =>
  new Date(T.getTime() - hours * HOUR + extraMinutes * 60_000);

async function owner() {
  const id = randomUUID(),
    token = generateSessionToken(),
    projectId = randomUUID(),
    routeVersionId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), id],
  );
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Token ledger fixture')",
    [projectId, id],
  );
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,'fixture','fixture','chat',true,'{}','{}',now()+interval '1 hour')`,
    [routeVersionId, randomUUID()],
  );
  return { id, projectId, routeVersionId, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

async function platformAccounts() {
  // The live path creates these lazily; a fresh database has only the seeded burn accounts.
  for (const kind of ['revenue', 'clearing'])
    await pool.query(
      'INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,NULL,$2) ON CONFLICT (owner_id,kind) DO NOTHING',
      [randomUUID(), kind],
    );
  return Object.fromEntries(
    (
      await pool.query(
        "SELECT kind,id FROM ledger_accounts WHERE owner_id IS NULL AND kind IN ('revenue','burn_reserve','burn_executed','clearing')",
      )
    ).rows.map((row) => [row.kind, row.id]),
  );
}
async function balance(kind) {
  return BigInt(
    (
      await pool.query(
        'SELECT balance_usd6::text FROM ledger_accounts WHERE owner_id IS NULL AND kind=$1',
        [kind],
      )
    ).rows[0].balance_usd6,
  );
}

/**
 * A captured settlement under 500/5000 terms (quote base maximum 1430, fee
 * maximum 71) whose accrual is stamped at `createdAt`. Writes the same rows the
 * live fee path writes, so every 019 trigger still runs.
 */
async function accrual(user, baseUsd6, createdAt) {
  const split = splitPlatformFee(BigInt(baseUsd6), 500, 5000);
  assert.ok(split.burnReserveUsd6 > 0n && BigInt(baseUsd6) <= 1430n);
  const accounts = await platformAccounts();
  const quoteId = randomUUID(),
    holdId = randomUUID(),
    transactionId = randomUUID();
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
      VALUES($1,$2,$3,$4,'fixture-hash',1501,128,now()+interval '2 minutes')`,
      [quoteId, user.id, user.projectId, user.routeVersionId],
    );
    await client.query(
      `INSERT INTO quote_platform_fees(quote_id,base_maximum_usd6,platform_fee_bps,burn_share_bps,platform_fee_maximum_usd6)
      VALUES($1,1430,500,5000,71)`,
      [quoteId],
    );
    await client.query(
      `INSERT INTO holds(id,account_id,quote_id,idempotency_key,request_hash,maximum_usd6,captured_usd6,state)
      VALUES($1,$2,$3,$4,'fixture-hash',1501,$5,'captured')`,
      [holdId, user.id, quoteId, randomUUID(), split.totalUsd6.toString()],
    );
    await client.query(
      'INSERT INTO ledger_transactions(id,reference,kind,created_at) VALUES($1,$2,$3,$4)',
      [transactionId, `burn-accrual:${holdId}`, 'burn_accrual', createdAt],
    );
    for (const [account, amount] of [
      [accounts.revenue, -split.burnReserveUsd6],
      [accounts.burn_reserve, split.burnReserveUsd6],
    ])
      await client.query(
        'INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6,created_at) VALUES($1,$2,$3,$4)',
        [transactionId, account, amount.toString(), createdAt],
      );
    await client.query(
      `INSERT INTO hold_platform_fees(hold_id,quote_id,base_usd6,platform_fee_usd6,burn_reserve_usd6,ledger_transaction_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        holdId,
        quoteId,
        split.baseUsd6.toString(),
        split.platformFeeUsd6.toString(),
        split.burnReserveUsd6.toString(),
        transactionId,
        createdAt,
      ],
    );
  });
  return split.burnReserveUsd6;
}

function fakeRpc() {
  const sent = [];
  return {
    sent,
    rpc: {
      cluster: 'localnet',
      async getGenesisHash() {
        return key(11);
      },
      async getLatestBlockhash() {
        return { blockhash: key(9), lastValidBlockHeight: 1_000 };
      },
      async sendTransaction(base64) {
        sent.push(base64);
        return parseSerializedTransaction(base64).signatures[0].value;
      },
      async getSignatureStatuses(signatures) {
        return signatures.map(() => ({ state: 'finalized', slot: 77 }));
      },
      async getTokenAccountBalance() {
        return { amountRaw: 1_000_000_000n, decimals: 6 };
      },
      async getTokenSupply() {
        return { amountRaw: 1_000_000_000_000n, decimals: 6 };
      },
      async getAccountInfo() {
        return null;
      },
      async getBlockHeight() {
        return 1;
      },
      async waitForFinalized() {
        return { slot: 77 + sent.length };
      },
    },
  };
}

function executor(rpc, overrides = {}) {
  return {
    pool,
    config: localnet,
    rpc,
    priceSource,
    keypair: burnWallet,
    burnTokenAccount,
    funding: 'buyback-simulation',
    buyback: createSimulatedJupiter({
      rpc,
      config: localnet,
      makerKeypair: maker,
      makerTokenAccount,
      burnTokenAccount,
    }),
    ...overrides,
  };
}

async function api(user, path) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method: 'GET',
      headers: { origin: 'https://conclave.test', ...(user ? { cookie: user.cookie } : {}) },
    }),
  );
  return { status: response.status, body: await response.json() };
}

function burnData(base64) {
  const parsed = parseSerializedTransaction(base64);
  const [instruction] = parsed.instructions;
  return {
    program: parsed.staticAccounts[instruction.programIdIndex].address,
    accounts: instruction.accountIndexes.map((index) => parsed.staticAccounts[index].address),
    tag: instruction.data[0],
    amount: Buffer.from(instruction.data.subarray(1, 9)).readBigUInt64LE(),
    decimals: instruction.data[9],
    signature: parsed.signatures[0].value,
  };
}

void test('migration 021 seeds the executed account and keeps the reserve non-negative', async () => {
  const accounts = await platformAccounts();
  assert.ok(accounts.burn_reserve && accounts.burn_executed);
  assert.equal(await balance('burn_executed'), 0n);
  assert.deepEqual(await listTokenBurns(pool), []);
  assert.deepEqual(await tokenBurnSummary(pool), {
    status: 'not_launched',
    burnsExecuted: 0,
    tokensBurnedRaw: '0',
    lastBurnSignature: null,
  });
  assert.equal(await nextBurnPeriodStart(pool), null);
  await assert.rejects(
    pool.query("INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,$2,'burn_executed')", [randomUUID(), user.id]),
    checkViolation,
  );
});

void test('matured reserve follows whole-hour cutoffs and never looks into the future', async () => {
  // 1234 -> burn 31 three hours ago; 1000 -> 25 at T-2h+10min; 200 -> 5 at T-30min.
  assert.equal(await accrual(user, 1234, hoursAgo(3)), 31n);
  assert.equal(await accrual(user, 1000, hoursAgo(2, 10)), 25n);
  assert.equal(await accrual(user, 200, hoursAgo(1, 30)), 5n);
  assert.equal(await balance('burn_reserve'), 61n);
  assert.equal(await maturedBurnReserveUsd6(pool, hoursAgo(3)), 0n);
  assert.equal(await maturedBurnReserveUsd6(pool, hoursAgo(2)), 31n);
  assert.equal(await maturedBurnReserveUsd6(pool, hoursAgo(1)), 56n);
  assert.equal(await maturedBurnReserveUsd6(pool, T), 61n);
  await assert.rejects(maturedBurnReserveUsd6(pool, new Date(T.getTime() + HOUR)), code('TOKEN_BURN_PERIOD_INVALID'));
  await assert.rejects(maturedBurnReserveUsd6(pool, hoursAgo(1, 30)), code('TOKEN_BURN_PERIOD_INVALID'));
  assert.equal((await nextBurnPeriodStart(pool)).getTime(), hoursAgo(3).getTime());
  assert.equal(await burnPeriodOverlaps(pool, hoursAgo(3), T), false);
});

void test('a deposit-funded burn releases the token value, never more than matured', async () => {
  const { rpc, sent } = fakeRpc();
  // 100 raw at 0.25 USD per whole token (6 decimals) is 25 USD6 of the 31 matured.
  const result = await executeBurn(executor(rpc, { funding: 'token-deposits', tokensRaw: 100n, periodEnd: hoursAgo(2) }));
  assert.equal(result.periodStart, hoursAgo(3).toISOString());
  assert.equal(result.maturedUsd6, '31');
  assert.equal(result.spentUsd6, '25');
  assert.equal(result.tokensBoughtRaw, '0');
  assert.equal(result.tokensBurnedRaw, '100');
  assert.equal(result.swapSignature, null);
  assert.equal(sent.length, 1);
  const burn = burnData(sent[0]);
  assert.deepEqual(burn, {
    program: TOKEN_2022_PROGRAM,
    accounts: [burnTokenAccount, mint, burnWallet.address],
    tag: 15,
    amount: 100n,
    decimals: 6,
    signature: result.burnSignature,
  });
  assert.equal(await balance('burn_reserve'), 36n);
  assert.equal(await balance('burn_executed'), 25n);
  // The unspent 6 USD6 of that period stay matured for the next one.
  assert.equal(await maturedBurnReserveUsd6(pool, hoursAgo(1)), 31n);
  const [stored] = await listTokenBurns(pool);
  assert.equal(stored.id, result.id);
  assert.equal(stored.fundingSource, 'token-deposits');
  assert.ok(verifyTokenBurnRecord(stored));
  // Worthless dust cannot release anything.
  await assert.rejects(
    executeBurn(executor(rpc, { funding: 'token-deposits', tokensRaw: 1n, periodEnd: hoursAgo(1) })),
    code('TOKEN_BURN_AMOUNT_INVALID'),
  );
  assert.equal(sent.length, 1);
});

void test('a simulated buyback burns exactly the tokens it bought and records every fact', async () => {
  const { rpc, sent } = fakeRpc();
  const result = await executeBurn(executor(rpc, { periodEnd: hoursAgo(1) }));
  assert.equal(result.periodStart, hoursAgo(2).toISOString());
  assert.equal(result.periodEnd, hoursAgo(1).toISOString());
  assert.equal(result.maturedUsd6, '31');
  assert.equal(result.spentUsd6, '31');
  // 31 USD6 at 0.25 -> ceil(124.0) = 124 raw expected, 1 bp impact -> 123.
  assert.equal(result.tokensBoughtRaw, '123');
  assert.equal(result.tokensBurnedRaw, '123');
  assert.equal(result.priceUsd6PerToken, '250000');
  assert.equal(sent.length, 2);
  const transfer = burnData(sent[0]);
  assert.equal(transfer.tag, 12);
  assert.equal(transfer.amount, 123n);
  assert.deepEqual(transfer.accounts, [makerTokenAccount, mint, burnTokenAccount, maker.address]);
  assert.equal(transfer.signature, result.swapSignature);
  const burn = burnData(sent[1]);
  assert.equal(burn.tag, 15);
  assert.equal(burn.amount, 123n);
  assert.equal(burn.signature, result.burnSignature);
  assert.notEqual(result.swapSignature, result.burnSignature);
  assert.equal(await balance('burn_reserve'), 5n);
  assert.equal(await balance('burn_executed'), 56n);
  const row = (
    await pool.query(
      `SELECT ledger_transaction_id,matured_usd6::text,spent_usd6::text,funding_source,cluster,token_mint,token_program,token_decimals,
      price_usd6_per_token::text,price_source,tokens_bought_raw::text,tokens_burned_raw::text,swap_signature,burn_signature,finalized_slot::int,record_hash
      FROM token_burns WHERE id=$1`,
      [result.id],
    )
  ).rows[0];
  assert.deepEqual(row, {
    ledger_transaction_id: result.ledgerTransactionId,
    matured_usd6: '31',
    spent_usd6: '31',
    funding_source: 'buyback-simulation',
    cluster: 'localnet',
    token_mint: mint,
    token_program: 'token-2022',
    token_decimals: 6,
    price_usd6_per_token: '250000',
    price_source: 'simulated',
    tokens_bought_raw: '123',
    tokens_burned_raw: '123',
    swap_signature: result.swapSignature,
    burn_signature: result.burnSignature,
    finalized_slot: result.finalizedSlot,
    record_hash: result.recordHash,
  });
  const ledger = await pool.query(
    `SELECT t.kind,t.reference,a.kind AS account,e.amount_usd6::text AS amount FROM ledger_transactions t
    JOIN ledger_entries e ON e.transaction_id=t.id JOIN ledger_accounts a ON a.id=e.ledger_account_id
    WHERE t.id=$1 ORDER BY e.amount_usd6`,
    [result.ledgerTransactionId],
  );
  assert.deepEqual(
    ledger.rows.map((entry) => [entry.kind, entry.reference, entry.account, entry.amount]),
    [
      ['burn_execution', `burn-execution:${result.burnSignature}`, 'burn_reserve', '-31'],
      ['burn_execution', `burn-execution:${result.burnSignature}`, 'burn_executed', '31'],
    ],
  );
  const [latest, earlier] = await listTokenBurns(pool);
  assert.equal(latest.id, result.id);
  assert.equal(earlier.fundingSource, 'token-deposits');
  assert.ok(verifyTokenBurnRecord(latest));
  assert.deepEqual(await tokenBurnSummary(pool), {
    status: 'localnet-rehearsal',
    burnsExecuted: 2,
    tokensBurnedRaw: '223',
    lastBurnSignature: result.burnSignature,
  });
});

void test('executions refuse covered periods, nothing matured, the kill switch and missing executors', async () => {
  const { rpc, sent } = fakeRpc();
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: hoursAgo(1) })), code('TOKEN_BURN_PERIOD_COVERED'));
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: hoursAgo(2) })), code('TOKEN_BURN_PERIOD_COVERED'));
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: hoursAgo(4) })), code('TOKEN_BURN_NOTHING_MATURED'));
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: T, config: disabled })), code('TOKEN_BURN_DISABLED'));
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: T, buyback: undefined })), code('CONFIGURATION_REQUIRED'));
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: T, funding: 'jupiter' })), code('NOT_IMPLEMENTED'));
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: T, funding: 'token-deposits' })), code('TOKEN_BURN_AMOUNT_INVALID'));
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: new Date(T.getTime() + HOUR) })), code('TOKEN_BURN_PERIOD_INVALID'));
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: hoursAgo(0, 30) })), code('TOKEN_BURN_PERIOD_INVALID'));
  await assert.rejects(
    executeBurn(executor(rpc, { periodEnd: T, rpc: { ...rpc, cluster: 'devnet' } })),
    code('CONFIGURATION_REQUIRED'),
  );
  // An empty maker cannot fill the buyback; nothing is sent.
  const empty = { ...rpc, getTokenAccountBalance: async () => ({ amountRaw: 0n, decimals: 6 }) };
  await assert.rejects(executeBurn(executor(empty, { periodEnd: T })), code('TOKEN_SWAP_REJECTED'));
  const stale = {
    kind: 'simulated',
    quote: async () => ({ priceUsd6PerToken: 1n, source: 'simulated', observedAtMs: 0, expiresAtMs: 1, confidenceBps: 0 }),
  };
  await assert.rejects(executeBurn(executor(rpc, { periodEnd: T, priceSource: stale })), code('TOKEN_PRICE_STALE'));
  assert.equal(sent.length, 0);
  assert.equal(await balance('burn_reserve'), 5n);
  // Concurrent executions of the same period: exactly one records; the other is
  // refused before sending (covered, or nothing left to mature) or, if it raced
  // past the pre-checks, as an unrecorded burn that names its signatures.
  const racers = [fakeRpc(), fakeRpc()];
  const outcomes = await Promise.allSettled(racers.map(({ rpc: r }) => executeBurn(executor(r, { periodEnd: T }))));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const loser = outcomes.find((outcome) => outcome.status === 'rejected').reason;
  assert.ok(['TOKEN_BURN_PERIOD_COVERED', 'TOKEN_BURN_NOTHING_MATURED', 'TOKEN_BURN_UNRECORDED'].includes(loser.code), loser.code);
  if (loser.code === 'TOKEN_BURN_UNRECORDED') assert.match(loser.burnSignature, /^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
  assert.equal(await balance('burn_reserve'), 0n);
  assert.equal(await balance('burn_executed'), 61n);
  assert.equal((await listTokenBurns(pool)).length, 3);
  assert.equal(await maturedBurnReserveUsd6(pool, T), 0n);
});

void test('the database refuses reserve debits without a matching record and any mutation', async () => {
  const accounts = await platformAccounts();
  const reserveBefore = await balance('burn_reserve');
  const executedBefore = await balance('burn_executed');
  await accrual(user, 1234, hoursAgo(0, 1));
  assert.equal(await balance('burn_reserve'), reserveBefore + 31n);
  const raw = (kind, entries) =>
    transaction(pool, (client) =>
      post(client, `fixture:${randomUUID()}`, kind, entries.map(([id, amount]) => ({ id, amount }))),
    );
  // A burn_execution without its token_burns row fails at commit.
  await assert.rejects(raw('burn_execution', [[accounts.burn_reserve, -1n], [accounts.burn_executed, 1n]]), checkViolation);
  // Other kinds may not touch either account, in either direction.
  await assert.rejects(raw('refund', [[accounts.burn_reserve, -1n], [accounts.revenue, 1n]]), checkViolation);
  await assert.rejects(raw('refund', [[accounts.revenue, -1n], [accounts.burn_executed, 1n]]), checkViolation);
  await assert.rejects(raw('burn_execution', [[accounts.burn_reserve, -1n], [accounts.revenue, 1n]]), checkViolation);
  await assert.rejects(raw('burn_execution', [[accounts.clearing, -1n], [accounts.burn_executed, 1n]]), checkViolation);
  await assert.rejects(raw('burn_execution', [[accounts.burn_executed, -1n], [accounts.burn_reserve, 1n]]), checkViolation);
  await assert.rejects(raw('burn_accrual', [[accounts.revenue, -1n], [accounts.burn_reserve, 1n]]), checkViolation);
  assert.equal(await balance('burn_reserve'), reserveBefore + 31n);
  assert.equal(await balance('burn_executed'), executedBefore);
  const record = {
    periodStart: T,
    periodEnd: new Date(T.getTime() + HOUR),
    maturedUsd6: 31n,
    spentUsd6: 31n,
    funding: 'buyback-simulation',
    cluster: 'localnet',
    tokenMint: mint,
    tokenProgram: 'token-2022',
    tokenDecimals: 6,
    priceUsd6PerToken: 250_000n,
    priceSource: 'simulated',
    tokensBoughtRaw: 123n,
    tokensBurnedRaw: 123n,
    swapSignature: bs58.encode(randomBytes(64)),
    burnSignature: bs58.encode(randomBytes(64)),
    finalizedSlot: 99,
  };
  const attempt = (changes) => transaction(pool, (client) => recordBurnExecution(client, { ...record, ...changes }));
  // The period has not closed (JS and, below, the database agree).
  await assert.rejects(attempt({}), code('TOKEN_BURN_PERIOD_INVALID'));
  // Spending more than matured, or more than the reserve holds.
  await assert.rejects(attempt({ periodEnd: T, periodStart: hoursAgo(1), maturedUsd6: 5n, spentUsd6: 6n }), code('TOKEN_BURN_AMOUNT_INVALID'));
  await assert.rejects(attempt({ periodEnd: T, periodStart: hoursAgo(1), maturedUsd6: 1_000n, spentUsd6: 1_000n }), checkViolation);
  // Overstating maturity (the 31 accrued after T has not matured for a period ending at T).
  await assert.rejects(attempt({ periodEnd: T, periodStart: hoursAgo(1), maturedUsd6: 31n, spentUsd6: 31n }), code('TOKEN_BURN_RECORD_REJECTED'));
  // A period already covered is refused by the exclusion constraint.
  await assert.rejects(attempt({ periodEnd: T, periodStart: hoursAgo(1), maturedUsd6: 0n, spentUsd6: 0n }), code('TOKEN_BURN_AMOUNT_INVALID'));
  // Database-level checks independent of the JS guards: an open period, a
  // deposit record with a swap signature, and a mismatched spend.
  const direct = (columns) =>
    transaction(pool, async (client) => {
      const id = await post(client, `fixture:${randomUUID()}`, 'burn_execution', [
        { id: accounts.burn_reserve, amount: -1n },
        { id: accounts.burn_executed, amount: 1n },
      ]);
      await client.query(
        `INSERT INTO token_burns(id,ledger_transaction_id,period_start,period_end,matured_usd6,spent_usd6,funding_source,cluster,
          token_mint,token_program,token_decimals,price_usd6_per_token,price_source,tokens_bought_raw,tokens_burned_raw,
          swap_signature,burn_signature,finalized_slot,record_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,'localnet',$8,'token-2022',6,250000,'simulated',$9,$10,$11,$12,99,$13)`,
        [
          randomUUID(),
          id,
          columns.periodStart ?? hoursAgo(1),
          columns.periodEnd ?? T,
          columns.matured ?? '1',
          columns.spent ?? '1',
          columns.funding ?? 'token-deposits',
          mint,
          columns.bought ?? '0',
          columns.burned ?? '4',
          columns.swap ?? null,
          bs58.encode(randomBytes(64)),
          'a'.repeat(64),
        ],
      );
    });
  await assert.rejects(direct({ periodEnd: new Date(T.getTime() + HOUR), periodStart: T }), checkViolation);
  await assert.rejects(direct({ spent: '2', matured: '2' }), checkViolation);
  await assert.rejects(direct({ swap: bs58.encode(randomBytes(64)) }), checkViolation);
  await assert.rejects(direct({ funding: 'buyback-simulation', bought: '4' }), checkViolation);
  await assert.rejects(direct({ periodStart: hoursAgo(0, 30) }), checkViolation);
  // Even a well-formed direct insert fails: this period is covered and nothing matured.
  await assert.rejects(direct({}), (error) => error.code === '23P01' || error.code === '23514');
  // Stored records are immutable.
  const [stored] = await listTokenBurns(pool, { limit: 1 });
  for (const sql of [
    'UPDATE token_burns SET tokens_burned_raw=1 WHERE id=$1',
    'UPDATE token_burns SET record_hash=repeat(\'0\',64) WHERE id=$1',
    'DELETE FROM token_burns WHERE id=$1',
  ])
    await assert.rejects(pool.query(sql, [stored.id]), checkViolation);
  await assert.rejects(
    pool.query('DELETE FROM ledger_transactions WHERE id=$1', [stored.ledgerTransactionId]),
    checkViolation,
  );
  assert.equal(await balance('burn_reserve'), reserveBefore + 31n);
  assert.equal(await balance('burn_executed'), executedBefore);
});

void test('stats and burn log endpoints publish executions without account data', async () => {
  const stats = await burnReserveStats(pool, undefined, future());
  assert.equal(stats.accruedUsd6, '92');
  assert.equal(stats.executedUsd6, '61');
  assert.equal(stats.pendingUsd6, '31');
  assert.equal(stats.burnsExecuted, 3);
  assert.equal(stats.pendingUsd6, (await balance('burn_reserve')).toString());
  assert.deepEqual(stats.onChain, { status: 'not_launched' });
  const endpoint = await api(user, 'token/burn-reserve');
  assert.equal(endpoint.status, 200);
  const published = endpoint.body.burnReserve;
  // Hour-cutoff totals keep every existing field; the on-chain summary is added.
  for (const field of ['currency', 'asOf', 'accruedUsd6', 'executedUsd6', 'pendingUsd6', 'burnsExecuted', 'settlements', 'terms'])
    assert.ok(field in published, field);
  assert.equal(new Date(published.asOf).getUTCMinutes(), 0);
  const [latest] = await listTokenBurns(pool, { limit: 1 });
  assert.deepEqual(published.onChain, {
    status: 'localnet-rehearsal',
    burnsExecuted: 3,
    tokensBurnedRaw: (100n + 123n + 19n).toString(),
    lastBurnSignature: latest.burnSignature,
  });
  const burns = await api(user, 'token/burns');
  assert.equal(burns.status, 200);
  assert.equal(burns.body.burns.length, 3);
  assert.deepEqual(burns.body.burns[0], latest);
  assert.ok(Date.parse(burns.body.burns[0].createdAt) >= Date.parse(burns.body.burns[2].createdAt));
  assert.deepEqual(
    Object.keys(burns.body.burns[0]).sort(),
    [
      'burnSignature', 'cluster', 'createdAt', 'finalizedSlot', 'fundingSource', 'id', 'ledgerTransactionId',
      'maturedUsd6', 'periodEnd', 'periodStart', 'priceSource', 'priceUsd6PerToken', 'recordHash', 'spentUsd6',
      'swapSignature', 'tokenDecimals', 'tokenMint', 'tokenProgram', 'tokensBoughtRaw', 'tokensBurnedRaw',
    ],
  );
  assert.ok(burns.body.burns.every((burn) => verifyTokenBurnRecord(burn)));
  assert.ok(!JSON.stringify(burns.body).includes(user.id));
  assert.equal((await api(user, 'token/burns?limit=1')).body.burns.length, 1);
  assert.equal((await api(user, 'token/burns?limit=100')).body.burns.length, 3);
  for (const limit of ['0', '101', '-1', '1.5', 'ten', '007'])
    assert.equal((await api(user, `token/burns?limit=${limit}`)).status, 400);
  assert.equal((await api(null, 'token/burns')).status, 401);
  assert.equal((await api(null, 'token/burn-reserve')).status, 401);
  assert.equal(
    (await dispatch(new Request('https://conclave.test/api/token/burns', { method: 'POST', headers: { origin: 'https://conclave.test', cookie: user.cookie } }))).status,
    404,
  );
});
