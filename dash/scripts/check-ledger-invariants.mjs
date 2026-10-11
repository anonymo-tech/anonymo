// Stateful invariant suite for the money paths. A seeded random sequence of
// deposits, internal test credit grants, quote + reservation, dispatch,
// reconciliation marking, settlement (within, above and at zero), replays and
// rejected requests runs through the real ledger service functions against a
// fresh database, next to an independent in-memory model of every balance and
// hold. After every operation the suite checks the operation's outcome against
// the model and then the ledger invariants:
//
//   - every ledger transaction balances to zero and has at least two entries
//   - every cached balance equals the sum of its entries
//   - user available and reserved balances are never negative
//   - reserved equals the sum of open hold maxima, per account
//   - captured <= maximum for every hold; captured is set exactly when settled
//   - quote maximum = base maximum + fee maximum for quotes with fee terms
//   - recorded fee = floor(base x fee bps), burn = ceil(fee x share bps)
//   - burn reserve = sum of recorded burns - executed token burns
//   - platform revenue = captured - burn accruals
//   - user funds + revenue + burn reserve + executed burns = deposits + grants
//   - an overage above the reservation is recorded, never charged
//   - every replay returns the original result and writes nothing
//
// Per-operation checks read only what the operation could have changed
// (new journal entries since a watermark, all ledger accounts, the touched
// holds); ledger entries and settlement records are immutable, so the global
// invariants follow by induction. A full from-scratch recomputation of every
// invariant also runs every CONCLAVE_INVARIANT_FULL_EVERY operations
// (default 500) and at the end, and compares every hold against the model.
//
// Run (fresh database; see scripts/check-database.mjs for the harness):
//   CONCLAVE_TEST_DATABASE_URL=postgresql://user@127.0.0.1:port/conclave_x_test \
//   CONCLAVE_DATABASE_URL=$CONCLAVE_TEST_DATABASE_URL \
//   CONCLAVE_INVARIANT_OPS=100000 \
//     node --experimental-strip-types scripts/check-ledger-invariants.mjs
//
// CONCLAVE_INVARIANT_OPS defaults to 5000 so the database harness stays fast;
// CONCLAVE_INVARIANT_SEED replays a different sequence (default below).
//
// Recorded long run (2026-10-10, local PostgreSQL 16, Node 26):
//   100000 operations, seed 20261010, 389 s wall time, 202 full audits,
//   37143 holds, 99866 journal transactions, 0 failures.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  creditVerifiedDeposit,
  markHoldRunning,
  markReconciliationPending,
  reserveQuote,
  settleHold,
  settleHoldInTransaction,
} from '../server/ledger/ledger.ts';
import {
  priceQuoteMaximum,
  recordQuotePlatformFee,
} from '../server/ledger/platform-fee.ts';
import { recordCappedSettlement } from '../server/ledger/reconciliation.ts';
import {
  INTERNAL_TEST_CREDIT_MAX_USD6,
  grantInternalTestCredit,
  internalTestingAllowed,
} from '../server/ledger/test-credits.ts';

const connection = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href;
// Internal test credit is granted only behind its loopback gate, exactly as
// check-test-credits.mjs satisfies it. Fee, buffer and overage settings come
// from each route's fixed terms below, never from the environment.
Object.assign(process.env, {
  CONCLAVE_INTERNAL_TESTING: 'true',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_APP_ORIGIN: 'http://localhost',
});
for (const key of [
  'NODE_ENV',
  'CONCLAVE_ENVIRONMENT',
  'CONCLAVE_SOLANA_CLUSTER',
  'CONCLAVE_DEPOSITS_ENABLED',
  'CONCLAVE_PLATFORM_FEE_BPS',
  'CONCLAVE_BURN_SHARE_BPS',
  'CONCLAVE_HOLD_BUFFER_BPS',
  'CONCLAVE_MAX_ACCOUNT_OVERAGE_USD6',
])
  delete process.env[key];

function setting(name, fallback, maximum) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]{0,8}$/.test(value) || Number(value) > maximum)
    throw new Error(`${name} must be a positive integer up to ${maximum}.`);
  return Number(value);
}
const OPS = setting('CONCLAVE_INVARIANT_OPS', 5000, 10_000_000);
const SEED = setting('CONCLAVE_INVARIANT_SEED', 20261010, 4_294_967_295);
const FULL_EVERY = setting('CONCLAVE_INVARIANT_FULL_EVERY', 500, 10_000_000);
const ACCOUNTS = 8;
const BPS = 10_000n;
const OPEN = new Set(['held', 'running', 'reconciliation_pending']);

/** Each route version fixes its fee and buffer terms; quotes inherit them. */
const ROUTE_TERMS = Object.freeze([
  { platformFeeBps: 0, burnShareBps: 0, holdBufferBps: 0 },
  { platformFeeBps: 0, burnShareBps: 0, holdBufferBps: 1000 },
  { platformFeeBps: 500, burnShareBps: 5000, holdBufferBps: 0 },
  { platformFeeBps: 2000, burnShareBps: 10000, holdBufferBps: 2000 },
  { platformFeeBps: 1, burnShareBps: 1, holdBufferBps: 0 },
  { platformFeeBps: 750, burnShareBps: 0, holdBufferBps: 500 },
  { platformFeeBps: 1999, burnShareBps: 3333, holdBufferBps: 1 },
]);

const pool = createDatabase(connection, 12);
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.end();
});

// ------------------------------------------------------------ seeded random

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const random = generator(SEED);
const chance = (p) => random() < p;
const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (items) => items[Math.floor(random() * items.length)];
/** Uniform-enough bigint in [min, max] from 52 random bits. */
function amount(min, max) {
  if (max <= min) return min;
  const bits =
    (BigInt(Math.floor(random() * 2 ** 26)) << 26n) |
    BigInt(Math.floor(random() * 2 ** 26));
  return min + (bits % (max - min + 1n));
}
/** Mostly small, sometimes at the edges. */
function spread(min, max) {
  const roll = random();
  if (roll < 0.05) return min;
  if (roll < 0.1) return max;
  if (roll < 0.7) return amount(min, min + (max - min) / 20n);
  return amount(min, max);
}
const ceil = (numerator, denominator) =>
  numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);

// ---------------------------------------------------------------- the model

const model = {
  accounts: [],
  routes: [],
  holds: new Map(),
  open: [],
  settled: [],
  deposits: [],
  grants: [],
  depositTotal: 0n,
  grantTotal: 0n,
  revenue: 0n,
  burnReserve: 0n,
  overage: 0n,
  sequence: 0,
};
// Database-derived running totals, built only from rows observed after each
// operation; compared against cached balances and the model.
const observed = {
  watermark: 0n,
  entrySums: new Map(),
  transactions: new Set(),
  deposits: 0n,
  grants: 0n,
  captured: 0n,
  burnAllocated: 0n,
};
const counts = {};
let fullAudits = 0;
/** Holds a replay or rejected request addressed; re-read after the operation to prove nothing changed. */
const replayed = new Set();

const nextId = (prefix) => `${prefix}-${SEED}-${++model.sequence}`;

function expectCode(error, code) {
  assert.ok(
    error && error.code === code,
    `expected ${code}, received ${error?.code ?? error?.message ?? error}`,
  );
}
async function rejects(promise, code) {
  try {
    await promise;
  } catch (error) {
    expectCode(error, code);
    return;
  }
  assert.fail(`expected ${code}, but the operation succeeded`);
}

function closeHold(hold) {
  const index = model.open.indexOf(hold);
  assert.ok(index >= 0);
  model.open[index] = model.open[model.open.length - 1];
  model.open.pop();
  model.settled.push(hold);
}

/** What settleHold must do for a hold in its current model state. */
function settlementOutcome(hold, requested, cap) {
  const reported =
    cap && requested > hold.baseMaximum ? hold.baseMaximum : requested;
  const fee = hold.terms
    ? (reported * BigInt(hold.terms.platformFeeBps)) / BPS
    : 0n;
  const burn = hold.terms
    ? ceil(fee * BigInt(hold.terms.burnShareBps), BPS)
    : 0n;
  const actual = reported + fee;
  if (!OPEN.has(hold.state))
    return actual === hold.captured
      ? { replay: true, overage: requested - reported }
      : { code: 'SETTLEMENT_CONFLICT' };
  if (reported > hold.baseMaximum || actual > hold.maximum)
    return { code: 'COST_EXCEEDS_RESERVATION' };
  return { reported, fee, burn, actual, overage: requested - reported };
}

function applySettlement(hold, outcome, expected) {
  const account = model.accounts[hold.account];
  account.reserved -= hold.maximum;
  account.available += hold.maximum - outcome.actual;
  model.revenue += outcome.actual - outcome.burn;
  model.burnReserve += outcome.burn;
  hold.state = outcome.actual === 0n ? 'released' : 'captured';
  hold.captured = outcome.actual;
  hold.feeRow = hold.terms && outcome.reported > 0n ? outcome : null;
  closeHold(hold);
  if (outcome.actual > 0n)
    expected.push({ kind: 'capture', reference: `capture:${hold.id}` });
  if (hold.maximum - outcome.actual > 0n)
    expected.push({ kind: 'release', reference: `release:${hold.id}` });
  if (outcome.burn > 0n)
    expected.push({
      kind: 'burn_accrual',
      reference: `burn-accrual:${hold.id}`,
    });
}

// --------------------------------------------------------------- fixtures

async function createAccount() {
  const id = randomUUID(),
    projectId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Invariant fixture')",
    [projectId, id],
  );
  return { id, projectId, available: 0n, reserved: 0n };
}

async function createRoute(terms) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
    VALUES($1,$2,1,'fixture','fixture','chat',true,'{}','{}',now()+interval '7 days')`,
    [id, `invariant-${id}`],
  );
  return { id, terms };
}

/** Prices and inserts a quote exactly as the quote route does: terms fixed in the same transaction. */
async function createQuote(accountIndex, route, base) {
  const account = model.accounts[accountIndex];
  const priced = priceQuoteMaximum(base.toString(), {
    config: {
      platformFeeBps: route.terms.platformFeeBps,
      burnShareBps: route.terms.burnShareBps,
    },
    buffer: { holdBufferBps: route.terms.holdBufferBps },
  });
  const quoteId = randomUUID(),
    requestHash = `invariant-hash-${model.sequence}`;
  await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,1000,now()+interval '1 day')`,
      [
        quoteId,
        account.id,
        account.projectId,
        route.id,
        requestHash,
        priced.maximumUsd6,
      ],
    );
    await recordQuotePlatformFee(client, quoteId, priced.platformFee);
  });
  // Independent restatement of the quote's terms.
  const buffered = base + ceil(base * BigInt(route.terms.holdBufferBps), BPS);
  const feeMaximum = (buffered * BigInt(route.terms.platformFeeBps)) / BPS;
  const maximum = buffered + feeMaximum;
  assert.equal(BigInt(priced.maximumUsd6), maximum);
  return {
    quoteId,
    requestHash,
    account: accountIndex,
    maximum,
    baseMaximum: buffered,
    terms: route.terms.platformFeeBps > 0 ? route.terms : null,
  };
}

function holdFromQuote(quote, idempotencyKey, row) {
  return {
    id: row.id,
    account: quote.account,
    quoteId: quote.quoteId,
    requestHash: quote.requestHash,
    idempotencyKey,
    maximum: quote.maximum,
    baseMaximum: quote.baseMaximum,
    terms: quote.terms,
    state: 'held',
    captured: null,
    feeRow: null,
    overage: null,
    settledRow: null,
    settledWith: null,
  };
}

function reserveInput(quote, idempotencyKey) {
  return {
    accountId: model.accounts[quote.account].id,
    quoteId: quote.quoteId,
    idempotencyKey,
    requestHash: quote.requestHash,
  };
}

function recordReservation(quote, idempotencyKey, row, expected) {
  const hold = holdFromQuote(quote, idempotencyKey, row);
  assert.equal(row.state, 'held');
  assert.equal(BigInt(row.maximum_usd6), quote.maximum);
  assert.equal(row.captured_usd6, null);
  model.accounts[quote.account].available -= quote.maximum;
  model.accounts[quote.account].reserved += quote.maximum;
  model.holds.set(hold.id, hold);
  model.open.push(hold);
  expected.push({ kind: 'hold', reference: `hold:${hold.id}` });
  return hold;
}

// ------------------------------------------------------------- operations

async function deposit(expected) {
  const index = integer(0, ACCOUNTS - 1);
  const value = spread(1n, 50_000_000n);
  const reference = nextId('inv_deposit');
  const result = await creditVerifiedDeposit(pool, {
    accountId: model.accounts[index].id,
    reference,
    amountUsd6: value.toString(),
  });
  assert.equal(result.replayed, false);
  model.accounts[index].available += value;
  model.depositTotal += value;
  model.deposits.push({
    account: index,
    reference,
    amount: value,
    transactionId: result.transactionId,
  });
  expected.push({ kind: 'deposit', reference: `deposit:${reference}` });
}

async function depositReplay(expected) {
  if (!model.deposits.length) return deposit(expected);
  const original = pick(model.deposits);
  const input = {
    accountId: model.accounts[original.account].id,
    reference: original.reference,
    amountUsd6: original.amount.toString(),
  };
  const replays = await Promise.all(
    Array.from({ length: integer(1, 4) }, () =>
      creditVerifiedDeposit(pool, input),
    ),
  );
  for (const replay of replays)
    assert.deepEqual(replay, {
      transactionId: original.transactionId,
      replayed: true,
    });
  const other = (original.account + integer(1, ACCOUNTS - 1)) % ACCOUNTS;
  await rejects(
    creditVerifiedDeposit(pool, {
      ...input,
      amountUsd6: (original.amount + 1n).toString(),
    }),
    'REFERENCE_CONFLICT',
  );
  await rejects(
    creditVerifiedDeposit(pool, {
      ...input,
      accountId: model.accounts[other].id,
    }),
    'REFERENCE_CONFLICT',
  );
}

async function grant(expected) {
  assert.equal(internalTestingAllowed(), true);
  const index = integer(0, ACCOUNTS - 1);
  const value = spread(1n, INTERNAL_TEST_CREDIT_MAX_USD6);
  const reference = nextId('inv-grant');
  // A fresh reference granted concurrently still credits exactly once.
  const results = await Promise.all(
    Array.from({ length: chance(0.3) ? integer(2, 5) : 1 }, () =>
      grantInternalTestCredit(
        pool,
        model.accounts[index].id,
        value.toString(),
        reference,
      ),
    ),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
  model.accounts[index].available += value;
  model.grantTotal += value;
  model.grants.push({
    account: index,
    reference,
    amount: value,
    transactionId: results[0].transactionId,
  });
  expected.push({
    kind: 'internal_test_credit',
    reference: `internal-test-credit:${model.accounts[index].id}:${reference}`,
  });
}

async function grantReplay(expected) {
  if (!model.grants.length) return grant(expected);
  const original = pick(model.grants);
  const accountId = model.accounts[original.account].id;
  const replay = await grantInternalTestCredit(
    pool,
    accountId,
    original.amount.toString(),
    original.reference,
  );
  assert.deepEqual(replay, {
    transactionId: original.transactionId,
    amountUsd6: original.amount.toString(),
    reference: original.reference,
    replayed: true,
  });
  const different =
    original.amount === INTERNAL_TEST_CREDIT_MAX_USD6
      ? original.amount - 1n
      : original.amount + 1n;
  await rejects(
    grantInternalTestCredit(
      pool,
      accountId,
      different.toString(),
      original.reference,
    ),
    'REFERENCE_CONFLICT',
  );
}

/** A base the account can probably afford, or anything when it cannot. */
function affordableBase(index) {
  const available = model.accounts[index].available;
  const ceiling = available / 2n > 1n ? available / 2n : 1n;
  return spread(1n, ceiling < 5_000_000n ? ceiling : 5_000_000n);
}

async function reserve(expected) {
  const index = integer(0, ACCOUNTS - 1);
  const quote = await createQuote(
    index,
    pick(model.routes),
    affordableBase(index),
  );
  const key = randomUUID();
  if (quote.maximum > model.accounts[index].available) {
    await rejects(
      reserveQuote(pool, reserveInput(quote, key)),
      'INSUFFICIENT_BALANCE',
    );
    return;
  }
  const result = await reserveQuote(pool, reserveInput(quote, key));
  assert.equal(result.replayed, false);
  recordReservation(quote, key, result.hold, expected);
}

async function reserveBeyond(expected) {
  void expected;
  const index = integer(0, ACCOUNTS - 1);
  const available = model.accounts[index].available;
  // Smallest over-the-balance bases included: the buffer and fee only add.
  const base = available + spread(1n, 2_000_000n);
  const quote = await createQuote(index, pick(model.routes), base);
  assert.ok(quote.maximum > available);
  await rejects(
    reserveQuote(pool, reserveInput(quote, randomUUID())),
    'INSUFFICIENT_BALANCE',
  );
}

async function reserveSameKey(expected) {
  const index = integer(0, ACCOUNTS - 1);
  const quote = await createQuote(
    index,
    pick(model.routes),
    affordableBase(index),
  );
  const key = randomUUID();
  const input = reserveInput(quote, key);
  const settled = await Promise.allSettled(
    Array.from({ length: integer(2, 6) }, () => reserveQuote(pool, input)),
  );
  if (quote.maximum > model.accounts[index].available) {
    for (const result of settled) {
      assert.equal(result.status, 'rejected');
      expectCode(result.reason, 'INSUFFICIENT_BALANCE');
    }
    return;
  }
  for (const result of settled) assert.equal(result.status, 'fulfilled');
  const results = settled.map((result) => result.value);
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.hold.id)).size, 1);
  recordReservation(
    quote,
    key,
    results.find((result) => !result.replayed).hold,
    expected,
  );
}

async function reserveRace(expected) {
  const index = integer(0, ACCOUNTS - 1);
  const route = pick(model.routes);
  const available = model.accounts[index].available;
  const contenders = integer(2, 8);
  // Sized so that only some contenders fit when the balance allows.
  const base = spread(1n, available / 3n > 1n ? available / 3n : 1n);
  const quotes = [];
  for (let i = 0; i < contenders; i++)
    quotes.push(await createQuote(index, route, base));
  const keys = quotes.map(() => randomUUID());
  const settled = await Promise.allSettled(
    quotes.map((quote, i) => reserveQuote(pool, reserveInput(quote, keys[i]))),
  );
  const maximum = quotes[0].maximum;
  const fits = Number(available / maximum);
  const winners = settled.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, Math.min(contenders, fits));
  settled.forEach((result, i) => {
    if (result.status === 'rejected')
      expectCode(result.reason, 'INSUFFICIENT_BALANCE');
    else {
      assert.equal(result.value.replayed, false);
      recordReservation(quotes[i], keys[i], result.value.hold, expected);
    }
  });
}

async function reserveReplay(expected) {
  const holds = model.open.length ? model.open : model.settled;
  if (!holds.length) return reserve(expected);
  const hold = pick(holds);
  replayed.add(hold.id);
  const quote = {
    quoteId: hold.quoteId,
    requestHash: hold.requestHash,
    account: hold.account,
  };
  const replay = await reserveQuote(
    pool,
    reserveInput(quote, hold.idempotencyKey),
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.hold.id, hold.id);
  assert.equal(BigInt(replay.hold.maximum_usd6), hold.maximum);
  assert.equal(replay.hold.state, hold.state);
  await rejects(
    reserveQuote(pool, {
      ...reserveInput(quote, hold.idempotencyKey),
      requestHash: `${hold.requestHash}-changed`,
    }),
    'IDEMPOTENCY_CONFLICT',
  );
  await rejects(
    reserveQuote(pool, reserveInput(quote, randomUUID())),
    'QUOTE_ALREADY_USED',
  );
}

async function markRunning() {
  const candidates = model.open.filter((hold) => hold.state === 'held');
  if (candidates.length && chance(0.85)) {
    const hold = pick(candidates);
    const row = await markHoldRunning(
      pool,
      model.accounts[hold.account].id,
      hold.id,
    );
    assert.equal(row.state, 'running');
    hold.state = 'running';
    return;
  }
  const others = [
    ...model.open.filter((hold) => hold.state !== 'held'),
    ...model.settled.slice(-50),
  ];
  if (!others.length) return;
  const hold = pick(others);
  replayed.add(hold.id);
  await rejects(
    markHoldRunning(pool, model.accounts[hold.account].id, hold.id),
    'HOLD_NOT_DISPATCHABLE',
  );
}

async function markPending() {
  const holds =
    model.open.length && chance(0.85) ? model.open : model.settled.slice(-50);
  if (!holds.length) return;
  const hold = pick(holds);
  replayed.add(hold.id);
  await markReconciliationPending(
    pool,
    model.accounts[hold.account].id,
    hold.id,
  );
  // A settled hold is never reopened.
  if (OPEN.has(hold.state)) hold.state = 'reconciliation_pending';
}

async function settle(hold, requested, cap, expected) {
  const outcome = settlementOutcome(hold, requested, cap);
  assert.ok(!outcome.replay && !outcome.code);
  const input = {
    accountId: model.accounts[hold.account].id,
    holdId: hold.id,
    actualUsd6: requested.toString(),
    providerReference: chance(0.5) ? `provider-${model.sequence}` : null,
    capAtReservation: cap,
  };
  // Concurrent identical settlements settle exactly once; the rest replay.
  const parallel = chance(0.2) ? integer(2, 6) : 1;
  const results = await Promise.all(
    Array.from({ length: parallel }, () => settleHold(pool, input)),
  );
  const first = results.find((result) => !result.replayed);
  assert.ok(first);
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  for (const result of results) {
    assert.deepEqual(result.hold, first.hold);
    assert.equal(result.overageUsd6, outcome.overage);
  }
  assert.equal(BigInt(first.hold.captured_usd6), outcome.actual);
  applySettlement(hold, outcome, expected);
  hold.settledRow = first.hold;
  hold.settledWith = { requested, cap };
}

async function settleWithin(expected) {
  if (!model.open.length) return reserve(expected);
  const hold = pick(model.open);
  const roll = random();
  const requested =
    roll < 0.1
      ? hold.baseMaximum
      : roll < 0.15
        ? 1n
        : amount(1n, hold.baseMaximum);
  await settle(hold, requested, chance(0.5), expected);
}

async function release(expected) {
  if (!model.open.length) return reserve(expected);
  await settle(pick(model.open), 0n, chance(0.5), expected);
}

async function settleAbove(expected) {
  if (!model.open.length) return reserve(expected);
  const hold = pick(model.open);
  const requested = hold.baseMaximum + spread(1n, 5_000_000n);
  const accountId = model.accounts[hold.account].id;
  // Without the cap an over-reservation cost is refused and nothing moves.
  await rejects(
    settleHold(pool, {
      accountId,
      holdId: hold.id,
      actualUsd6: requested.toString(),
      providerReference: null,
    }),
    'COST_EXCEEDS_RESERVATION',
  );
  // The worker path: capture exactly the hold and record the excess.
  const outcome = settlementOutcome(hold, requested, true);
  assert.equal(outcome.actual, hold.maximum);
  const settled = await transaction(pool, async (client) => {
    const result = await settleHoldInTransaction(client, {
      accountId,
      holdId: hold.id,
      actualUsd6: requested.toString(),
      providerReference: null,
      capAtReservation: true,
    });
    if (result.overageUsd6 > 0n && !result.replayed)
      await recordCappedSettlement(client, hold.id, {
        observedUsd6: requested.toString(),
        overageUsd6: result.overageUsd6,
        capturedUsd6: result.hold.captured_usd6 ?? '0',
      });
    return result;
  });
  assert.equal(settled.replayed, false);
  assert.equal(settled.overageUsd6, requested - hold.baseMaximum);
  applySettlement(hold, outcome, expected);
  hold.overage = settled.overageUsd6;
  hold.settledRow = settled.hold;
  hold.settledWith = { requested, cap: true };
  model.overage += settled.overageUsd6;
}

async function settleReplay(expected) {
  if (!model.settled.length) return settleWithin(expected);
  const hold = pick(model.settled);
  replayed.add(hold.id);
  const accountId = model.accounts[hold.account].id;
  const { requested, cap } = hold.settledWith;
  const outcome = settlementOutcome(hold, requested, cap);
  assert.equal(outcome.replay, true);
  const replays = await Promise.all(
    Array.from({ length: integer(1, 4) }, () =>
      settleHold(pool, {
        accountId,
        holdId: hold.id,
        actualUsd6: requested.toString(),
        providerReference: null,
        capAtReservation: cap,
      }),
    ),
  );
  for (const replay of replays) {
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.hold, hold.settledRow);
    assert.equal(replay.overageUsd6, outcome.overage);
  }
  // A different amount that would change the capture is a conflict.
  const reported =
    cap && requested > hold.baseMaximum ? hold.baseMaximum : requested;
  const different = reported > 0n ? reported - 1n : 1n;
  assert.equal(
    settlementOutcome(hold, different, false).code,
    'SETTLEMENT_CONFLICT',
  );
  await rejects(
    settleHold(pool, {
      accountId,
      holdId: hold.id,
      actualUsd6: different.toString(),
      providerReference: null,
    }),
    'SETTLEMENT_CONFLICT',
  );
}

async function settleUnknown() {
  const index = integer(0, ACCOUNTS - 1);
  await rejects(
    settleHold(pool, {
      accountId: model.accounts[index].id,
      holdId: randomUUID(),
      actualUsd6: '0',
      providerReference: null,
    }),
    'HOLD_NOT_FOUND',
  );
  const holds = model.open.length ? model.open : model.settled;
  if (!holds.length) return;
  // Another account's hold is invisible to this account.
  const hold = pick(holds);
  replayed.add(hold.id);
  const other = (hold.account + integer(1, ACCOUNTS - 1)) % ACCOUNTS;
  await rejects(
    settleHold(pool, {
      accountId: model.accounts[other].id,
      holdId: hold.id,
      actualUsd6: '0',
      providerReference: null,
    }),
    'HOLD_NOT_FOUND',
  );
}

const OPERATIONS = Object.freeze([
  [deposit, 10],
  [depositReplay, 4],
  [grant, 6],
  [grantReplay, 3],
  [reserve, 19],
  [reserveSameKey, 5],
  [reserveRace, 3],
  [reserveBeyond, 4],
  [reserveReplay, 4],
  [markRunning, 6],
  [markPending, 4],
  [settleWithin, 14],
  [settleAbove, 5],
  [release, 6],
  [settleReplay, 5],
  [settleUnknown, 2],
]);
const WEIGHT = OPERATIONS.reduce((sum, [, weight]) => sum + weight, 0);
function chooseOperation() {
  let roll = random() * WEIGHT;
  for (const [operation, weight] of OPERATIONS) {
    if (roll < weight) return operation;
    roll -= weight;
  }
  return OPERATIONS[0][0];
}

// ------------------------------------------------------------- invariants

/** New journal rows since the last check: balanced, new, and exactly what the operation should post. */
async function checkNewEntries(expected) {
  const rows = (
    await pool.query(
      `SELECT e.id::text,e.transaction_id,e.ledger_account_id,e.amount_usd6::text,t.kind,t.reference,a.kind AS account_kind
      FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id
      JOIN ledger_accounts a ON a.id=e.ledger_account_id
      WHERE e.id>$1 ORDER BY e.id`,
      [observed.watermark.toString()],
    )
  ).rows;
  const transactions = new Map();
  for (const row of rows) {
    const id = BigInt(row.id);
    if (id > observed.watermark) observed.watermark = id;
    const value = BigInt(row.amount_usd6);
    assert.notEqual(value, 0n);
    // No entry may be appended to a transaction from an earlier operation.
    assert.ok(!observed.transactions.has(row.transaction_id));
    const entry = transactions.get(row.transaction_id) ?? {
      kind: row.kind,
      reference: row.reference,
      sum: 0n,
      count: 0,
    };
    entry.sum += value;
    entry.count += 1;
    transactions.set(row.transaction_id, entry);
    observed.entrySums.set(
      row.ledger_account_id,
      (observed.entrySums.get(row.ledger_account_id) ?? 0n) + value,
    );
    if (row.kind === 'deposit' && row.account_kind === 'available')
      observed.deposits += value;
    if (row.kind === 'internal_test_credit' && row.account_kind === 'available')
      observed.grants += value;
  }
  for (const [id, entry] of transactions) {
    assert.equal(entry.sum, 0n, `transaction ${entry.reference} is unbalanced`);
    assert.ok(entry.count >= 2);
    observed.transactions.add(id);
  }
  const posted = [...transactions.values()]
    .map((entry) => `${entry.kind} ${entry.reference}`)
    .sort();
  assert.deepEqual(
    posted,
    expected.map((entry) => `${entry.kind} ${entry.reference}`).sort(),
  );
}

/** Every ledger account: cached balance = entry sum = model; system totals reconcile. */
async function checkBalances() {
  const rows = (
    await pool.query(
      `SELECT a.id,a.owner_id,a.kind,a.balance_usd6::text,
      (SELECT COALESCE(sum(spent_usd6),0) FROM token_burns)::text AS burned
      FROM ledger_accounts a`,
    )
  ).rows;
  const byOwner = new Map();
  const system = {};
  let userFunds = 0n,
    executed = 0n;
  for (const row of rows) {
    const balance = BigInt(row.balance_usd6);
    assert.equal(
      balance,
      observed.entrySums.get(row.id) ?? 0n,
      `cached ${row.kind} balance drifted from its entries`,
    );
    executed = BigInt(row.burned);
    if (row.owner_id) {
      assert.ok(balance >= 0n, `negative ${row.kind} balance`);
      byOwner.set(`${row.owner_id}:${row.kind}`, balance);
      userFunds += balance;
    } else system[row.kind] = (system[row.kind] ?? 0n) + balance;
  }
  for (const account of model.accounts) {
    assert.equal(
      byOwner.get(`${account.id}:available`) ?? 0n,
      account.available,
    );
    assert.equal(byOwner.get(`${account.id}:reserved`) ?? 0n, account.reserved);
  }
  const revenue = system.revenue ?? 0n,
    burnReserve = system.burn_reserve ?? 0n;
  assert.equal(revenue, model.revenue);
  assert.equal(burnReserve, model.burnReserve);
  assert.equal(burnReserve, observed.burnAllocated - executed);
  assert.equal(revenue, observed.captured - observed.burnAllocated);
  assert.equal(system.clearing ?? 0n, -observed.deposits);
  assert.equal(system.internal_test_funding ?? 0n, -observed.grants);
  assert.equal(observed.deposits, model.depositTotal);
  assert.equal(observed.grants, model.grantTotal);
  // Conservation: every micro-dollar that entered is held by a user, kept as
  // revenue, set aside for burns, or burned.
  assert.equal(
    userFunds + revenue + burnReserve + executed,
    observed.deposits + observed.grants,
  );
}

/** Touched holds against the model, their quote terms and settlement records. */
async function checkHolds(holdIds, accountIndexes) {
  if (holdIds.size) {
    const rows = (
      await pool.query(
        `SELECT h.id,h.state,h.maximum_usd6::text,h.captured_usd6::text,q.max_usd6::text AS quote_maximum,
        t.base_maximum_usd6::text AS terms_base,t.platform_fee_bps,t.burn_share_bps,t.platform_fee_maximum_usd6::text AS terms_fee,
        f.base_usd6::text AS fee_base,f.platform_fee_usd6::text AS fee,f.burn_reserve_usd6::text AS burn,
        r.overage_usd6::text AS overage,r.resolution,r.resolved_usd6::text AS resolved
        FROM holds h JOIN quotes q ON q.id=h.quote_id
        LEFT JOIN quote_platform_fees t ON t.quote_id=h.quote_id
        LEFT JOIN hold_platform_fees f ON f.hold_id=h.id
        LEFT JOIN hold_reconciliations r ON r.hold_id=h.id
        WHERE h.id=ANY($1::uuid[])`,
        [[...holdIds]],
      )
    ).rows;
    assert.equal(rows.length, holdIds.size);
    for (const row of rows) {
      const hold = model.holds.get(row.id);
      const maximum = BigInt(row.maximum_usd6);
      assert.equal(row.state, hold.state);
      assert.equal(maximum, hold.maximum);
      assert.equal(BigInt(row.quote_maximum), maximum);
      if (OPEN.has(row.state)) assert.equal(row.captured_usd6, null);
      else {
        const captured = BigInt(row.captured_usd6);
        assert.equal(captured, hold.captured);
        assert.ok(captured <= maximum);
      }
      if (hold.terms) {
        const base = BigInt(row.terms_base),
          feeMaximum = BigInt(row.terms_fee);
        assert.equal(row.platform_fee_bps, hold.terms.platformFeeBps);
        assert.equal(row.burn_share_bps, hold.terms.burnShareBps);
        assert.equal(base, hold.baseMaximum);
        assert.equal(feeMaximum, (base * BigInt(row.platform_fee_bps)) / BPS);
        assert.equal(maximum, base + feeMaximum);
      } else assert.equal(row.terms_base, null);
      assert.equal(row.fee_base !== null, !!hold.feeRow);
      if (row.fee_base !== null) {
        const base = BigInt(row.fee_base),
          fee = BigInt(row.fee),
          burn = BigInt(row.burn);
        assert.equal(fee, (base * BigInt(row.platform_fee_bps)) / BPS);
        assert.equal(burn, ceil(fee * BigInt(row.burn_share_bps), BPS));
        assert.equal(BigInt(row.captured_usd6), base + fee);
        assert.equal(base, hold.feeRow.reported);
        assert.equal(burn, hold.feeRow.burn);
      }
      if (hold.overage === null) assert.equal(row.overage, null);
      else {
        // The excess is recorded; the capture is exactly the hold, never more.
        assert.equal(BigInt(row.overage), hold.overage);
        assert.equal(row.resolution, 'capped');
        assert.equal(BigInt(row.resolved), maximum);
        assert.equal(BigInt(row.captured_usd6), maximum);
      }
      if (!OPEN.has(row.state) && !hold.counted) {
        hold.counted = true;
        observed.captured += BigInt(row.captured_usd6);
        if (row.burn !== null) observed.burnAllocated += BigInt(row.burn);
      }
    }
  }
  if (accountIndexes.size) {
    const ids = [...accountIndexes].map((index) => model.accounts[index].id);
    const sums = new Map(
      (
        await pool.query(
          `SELECT account_id,sum(maximum_usd6)::text AS reserved FROM holds
          WHERE account_id=ANY($1::uuid[]) AND state IN ('held','running','reconciliation_pending') GROUP BY account_id`,
          [ids],
        )
      ).rows.map((row) => [row.account_id, BigInt(row.reserved)]),
    );
    for (const index of accountIndexes) {
      const account = model.accounts[index];
      const open = model.open
        .filter((hold) => hold.account === index)
        .reduce((sum, hold) => sum + hold.maximum, 0n);
      assert.equal(account.reserved, open);
      assert.equal(sums.get(account.id) ?? 0n, account.reserved);
    }
  }
}

/** Every invariant recomputed from scratch, and every hold compared with the model. */
async function fullAudit() {
  fullAudits += 1;
  const row = (
    await pool.query(`SELECT
      (SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
        HAVING sum(amount_usd6)<>0 OR count(*)<2) x)::int AS imbalanced,
      (SELECT count(*) FROM ledger_transactions t WHERE NOT EXISTS
        (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=t.id))::int AS empty,
      (SELECT count(*) FROM ledger_accounts a WHERE a.balance_usd6<>COALESCE(
        (SELECT sum(e.amount_usd6) FROM ledger_entries e WHERE e.ledger_account_id=a.id),0))::int AS drift,
      (SELECT count(*) FROM ledger_accounts WHERE owner_id IS NOT NULL AND balance_usd6<0)::int AS negative,
      (SELECT count(*) FROM accounts c WHERE COALESCE((SELECT balance_usd6 FROM ledger_accounts
        WHERE owner_id=c.id AND kind='reserved'),0)<>COALESCE((SELECT sum(h.maximum_usd6) FROM holds h
        WHERE h.account_id=c.id AND h.state IN ('held','running','reconciliation_pending')),0))::int AS reserved_mismatch,
      (SELECT count(*) FROM holds WHERE captured_usd6>maximum_usd6 OR
        (captured_usd6 IS NULL)<>(state IN ('held','running','reconciliation_pending')))::int AS bad_holds,
      (SELECT count(*) FROM quotes q JOIN quote_platform_fees t ON t.quote_id=q.id
        WHERE q.max_usd6<>t.base_maximum_usd6+t.platform_fee_maximum_usd6
        OR t.platform_fee_maximum_usd6<>div(t.base_maximum_usd6::numeric*t.platform_fee_bps,10000))::int AS bad_terms,
      (SELECT count(*) FROM hold_platform_fees f JOIN quote_platform_fees t ON t.quote_id=f.quote_id
        JOIN holds h ON h.id=f.hold_id
        WHERE f.platform_fee_usd6<>div(f.base_usd6::numeric*t.platform_fee_bps,10000)
        OR f.burn_reserve_usd6<>div(f.platform_fee_usd6::numeric*t.burn_share_bps+9999,10000)
        OR h.captured_usd6<>f.base_usd6+f.platform_fee_usd6)::int AS bad_fees,
      (SELECT count(*) FROM holds h JOIN quote_platform_fees t ON t.quote_id=h.quote_id
        WHERE h.state='captured' AND NOT EXISTS (SELECT 1 FROM hold_platform_fees f WHERE f.hold_id=h.id))::int AS missing_fees,
      (SELECT count(*) FROM hold_reconciliations r JOIN holds h ON h.id=r.hold_id
        WHERE r.overage_usd6 IS NOT NULL AND h.captured_usd6<>h.maximum_usd6)::int AS overcharged,
      (SELECT count(*) FROM (SELECT reference FROM ledger_transactions GROUP BY reference HAVING count(*)>1) d)::int AS duplicate_references,
      (SELECT COALESCE(sum(balance_usd6),0) FROM ledger_accounts WHERE kind='burn_reserve')::text AS burn_reserve,
      (SELECT COALESCE(sum(burn_reserve_usd6),0) FROM hold_platform_fees)::text AS burn_allocated,
      (SELECT COALESCE(sum(spent_usd6),0) FROM token_burns)::text AS burn_spent,
      (SELECT COALESCE(-sum(e.amount_usd6),0) FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.ledger_account_id
        WHERE a.kind='burn_reserve' AND e.amount_usd6<0)::text AS burn_executed,
      (SELECT COALESCE(sum(balance_usd6),0) FROM ledger_accounts WHERE kind='revenue')::text AS revenue,
      (SELECT COALESCE(sum(captured_usd6),0) FROM holds)::text AS captured,
      (SELECT COALESCE(sum(balance_usd6),0) FROM ledger_accounts WHERE owner_id IS NOT NULL)::text AS user_funds,
      (SELECT COALESCE(sum(e.amount_usd6),0) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id
        JOIN ledger_accounts a ON a.id=e.ledger_account_id WHERE t.kind='deposit' AND a.kind='available')::text AS deposits,
      (SELECT COALESCE(sum(balance_usd6),0) FROM ledger_accounts WHERE kind='clearing')::text AS clearing,
      (SELECT COALESCE(sum(amount_usd6),0) FROM internal_test_credit_grants)::text AS grants,
      (SELECT COALESCE(sum(balance_usd6),0) FROM ledger_accounts WHERE kind='internal_test_funding')::text AS funding,
      (SELECT COALESCE(sum(overage_usd6),0) FROM hold_reconciliations)::text AS overage`)
  ).rows[0];
  for (const key of [
    'imbalanced',
    'empty',
    'drift',
    'negative',
    'reserved_mismatch',
    'bad_holds',
    'bad_terms',
    'bad_fees',
    'missing_fees',
    'overcharged',
    'duplicate_references',
  ])
    assert.equal(row[key], 0, `full audit: ${key}`);
  const n = (key) => BigInt(row[key]);
  assert.equal(n('burn_reserve'), n('burn_allocated') - n('burn_spent'));
  assert.equal(n('burn_spent'), n('burn_executed'));
  assert.equal(n('revenue'), n('captured') - n('burn_allocated'));
  assert.equal(n('clearing'), -n('deposits'));
  assert.equal(n('funding'), -n('grants'));
  assert.equal(
    n('user_funds') + n('revenue') + n('burn_reserve') + n('burn_executed'),
    n('deposits') + n('grants'),
  );
  assert.equal(n('deposits'), model.depositTotal);
  assert.equal(n('grants'), model.grantTotal);
  assert.equal(n('revenue'), model.revenue);
  assert.equal(n('burn_reserve'), model.burnReserve);
  assert.equal(n('overage'), model.overage);
  const holds = (
    await pool.query(
      'SELECT id,state,maximum_usd6::text,captured_usd6::text FROM holds',
    )
  ).rows;
  assert.equal(holds.length, model.holds.size);
  for (const hold of holds) {
    const expected = model.holds.get(hold.id);
    assert.ok(expected, 'a hold exists that the model never created');
    assert.equal(hold.state, expected.state);
    assert.equal(BigInt(hold.maximum_usd6), expected.maximum);
    assert.equal(
      hold.captured_usd6 === null ? null : BigInt(hold.captured_usd6),
      expected.captured,
    );
  }
}

// ------------------------------------------------------------------ tests

void test('internal test credit gate is open only for this loopback test database', () => {
  assert.equal(internalTestingAllowed(), true);
  assert.equal(
    internalTestingAllowed({ ...process.env, NODE_ENV: 'production' }),
    false,
  );
  assert.equal(
    internalTestingAllowed({
      ...process.env,
      CONCLAVE_INTERNAL_TESTING: undefined,
    }),
    false,
  );
});

void test('a deposit reference credits exactly once under concurrent replays', async () => {
  const account = await createAccount();
  const input = {
    accountId: account.id,
    reference: `inv_once_${SEED}_${randomUUID()}`,
    amountUsd6: '750000',
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => creditVerifiedDeposit(pool, input)),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
  const row = (
    await pool.query(
      `SELECT count(*)::int AS transactions,
      (SELECT balance_usd6::text FROM ledger_accounts WHERE owner_id=$2 AND kind='available') AS available
      FROM ledger_transactions WHERE reference=$1`,
      [`deposit:${input.reference}`, account.id],
    )
  ).rows[0];
  assert.deepEqual(row, { transactions: 1, available: '750000' });
  await rejects(
    creditVerifiedDeposit(pool, { ...input, amountUsd6: '750001' }),
    'REFERENCE_CONFLICT',
  );
});

void test('randomized money operations preserve every ledger invariant', async () => {
  const started = performance.now();
  // Start from what the earlier tests left: seed the observed totals from scratch.
  const baseline = (
    await pool.query(`SELECT COALESCE(max(id),0)::text AS watermark,
      (SELECT COALESCE(sum(e.amount_usd6),0) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id
        JOIN ledger_accounts a ON a.id=e.ledger_account_id WHERE t.kind='deposit' AND a.kind='available')::text AS deposits,
      (SELECT count(*) FROM holds)::int AS holds FROM ledger_entries`)
  ).rows[0];
  assert.equal(baseline.holds, 0);
  observed.watermark = BigInt(baseline.watermark);
  observed.deposits = BigInt(baseline.deposits);
  model.depositTotal = observed.deposits;
  for (const row of (
    await pool.query(
      'SELECT ledger_account_id,sum(amount_usd6)::text AS total FROM ledger_entries GROUP BY ledger_account_id',
    )
  ).rows)
    observed.entrySums.set(row.ledger_account_id, BigInt(row.total));
  for (const row of (
    await pool.query('SELECT DISTINCT transaction_id FROM ledger_entries')
  ).rows)
    observed.transactions.add(row.transaction_id);
  for (let i = 0; i < ACCOUNTS; i++) model.accounts.push(await createAccount());
  for (const terms of ROUTE_TERMS) model.routes.push(await createRoute(terms));
  await fullAudit();

  for (let index = 0; index < OPS; index++) {
    const operation = chooseOperation();
    const prior = {
      open: new Set(model.open.map((hold) => hold.id)),
      settled: model.settled.length,
    };
    const expected = [];
    try {
      await operation(expected);
      // Touched: every hold whose model state changed, plus the accounts they belong to.
      const touched = new Set(replayed);
      replayed.clear();
      for (const hold of model.open)
        if (!prior.open.has(hold.id) || hold.state !== hold.checkedState)
          touched.add(hold.id);
      for (const hold of model.settled.slice(prior.settled))
        touched.add(hold.id);
      for (const id of touched)
        model.holds.get(id).checkedState = model.holds.get(id).state;
      const accounts = new Set(
        [...touched].map((id) => model.holds.get(id).account),
      );
      if (accounts.size === 0) accounts.add(integer(0, ACCOUNTS - 1));
      await checkNewEntries(expected);
      await checkHolds(touched, accounts);
      await checkBalances();
      if ((index + 1) % FULL_EVERY === 0) await fullAudit();
    } catch (error) {
      error.message = `operation ${index + 1} of ${OPS} (${operation.name}), seed ${SEED}: ${error.message}`;
      throw error;
    }
    counts[operation.name] = (counts[operation.name] ?? 0) + 1;
  }
  await fullAudit();
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `ledger invariants: ${OPS} operations, seed ${SEED}, ${seconds} s, ${fullAudits} full audits, ` +
      `${model.holds.size} holds (${model.open.length} open), ${observed.transactions.size} journal transactions`,
  );
  console.log(`operation counts: ${JSON.stringify(counts)}`);
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    OPS,
  );
});
