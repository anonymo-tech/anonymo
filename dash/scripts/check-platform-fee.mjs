import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createDatabase, transaction } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  generateSessionToken,
  hashToken,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import {
  creditVerifiedDeposit,
  getBalance,
  reserveQuote,
  settleHold,
} from '../server/ledger/ledger.ts';
import {
  applyHoldBuffer,
  burnReserveStats,
  holdBufferConfig,
  platformFeeConfig,
  priceQuoteMaximum,
  priceWithPlatformFee,
  splitPlatformFee,
} from '../server/ledger/platform-fee.ts';
import { quoteMaximum } from '../server/routes/call-contract.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import {
  issueCallReceipt,
  receiptTrustFromValues,
} from '../server/receipts/service.ts';
import { receiptPublicKey } from '../server/receipts/index.ts';
import {
  parseQuoteResponse,
  quotePlatformFeeTotals,
} from '../lib/client/workspace.ts';

const connection = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href;
Object.assign(process.env, {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://conclave.test',
  CONCLAVE_DATABASE_URL: connection,
  CONCLAVE_DATA_KEYS: JSON.stringify({
    test: randomBytes(32).toString('base64'),
  }),
  CONCLAVE_ACTIVE_DATA_KEY: 'test',
  GATEWAY_API_KEY: 'synthetic-provider-fixture',
  GATEWAY_API_ORIGIN: 'https://api.inference.invalid',
  GATEWAY_EVIDENCE_ORIGINS: '["https://inference.invalid","https://www.inference.invalid"]',
  CONCLAVE_INFERENCE_ENABLED: 'true',
});
// Every suite starts fee-free and unbuffered; tests opt in explicitly.
delete process.env.CONCLAVE_PLATFORM_FEE_BPS;
delete process.env.CONCLAVE_BURN_SHARE_BPS;
delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
const pool = createDatabase(connection, 12);
before(() => migrate(pool));
after(() => pool.end());

const code = (value) => (error) => error.code === value;
const checkViolation = (error) => error.code === '23514';
const future = () => new Date(Date.now() + 7200000);

function feeEnvironment(platformFeeBps, burnShareBps) {
  if (platformFeeBps === null) {
    delete process.env.CONCLAVE_PLATFORM_FEE_BPS;
    delete process.env.CONCLAVE_BURN_SHARE_BPS;
  } else {
    process.env.CONCLAVE_PLATFORM_FEE_BPS = String(platformFeeBps);
    process.env.CONCLAVE_BURN_SHARE_BPS = String(burnShareBps);
  }
}
async function withFee(platformFeeBps, burnShareBps, work) {
  feeEnvironment(platformFeeBps, burnShareBps);
  try {
    return await work();
  } finally {
    feeEnvironment(null);
  }
}
function bufferEnvironment(holdBufferBps) {
  if (holdBufferBps === null) delete process.env.CONCLAVE_HOLD_BUFFER_BPS;
  else process.env.CONCLAVE_HOLD_BUFFER_BPS = String(holdBufferBps);
}
async function withBuffer(holdBufferBps, work) {
  bufferEnvironment(holdBufferBps);
  try {
    return await work();
  } finally {
    bufferEnvironment(null);
  }
}
// Independent restatement of the buffer: base + ceil(base x bps / 10000).
const buffered = (base, bps) => base + (base * BigInt(bps) + 9999n) / 10000n;

const profile = () => ({
  version: 1,
  tasks: ['general', 'code', 'reasoning', 'writing', 'long_context'],
  evidenceUrl: 'https://platform.openai.com/docs/models',
  reviewedAt: new Date().toISOString(),
});

async function owner(balance = '10000000', options = {}) {
  const id = randomUUID(),
    token = generateSessionToken(),
    projectId = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [await hashToken(token), id],
  );
  await pool.query(
    "INSERT INTO projects(id,account_id,title) VALUES($1,$2,'Platform fee fixture')",
    [projectId, id],
  );
  if (balance !== '0')
    await creditVerifiedDeposit(pool, {
      accountId: id,
      reference: `fixture_${randomUUID()}`,
      amountUsd6: balance,
    });
  const items = [];
  for (const [family, model, input] of [
    ['claude', 'claude-opus-5.5', '1000000'],
    ['gpt', 'gpt-6.1-sol', '2000000'],
  ]) {
    const routeVersionId = randomUUID();
    await pool.query(
      `INSERT INTO route_versions(id,route_id,version,model_id,family,modality,enabled,card,pricing,expires_at)
      VALUES($1,$2,1,$3,$4,'chat',true,$5,$6,now()+interval '1 hour')`,
      [
        routeVersionId,
        randomUUID(),
        model,
        family,
        {
          level: 'unverified',
          reviewed: true,
          retentionDisclosure: 'Synthetic reviewed route terms.',
          evidenceUrl: 'https://example.test/terms',
          evidenceDate: new Date().toISOString().slice(0, 10),
          ...(options.routing ? { routing: profile() } : {}),
        },
        {
          inputPerMillionUsd6: input,
          outputPerMillionUsd6: '1000000',
          markupBps: 0,
          maxInputBytes: 32768,
          maxOutputTokens: 2048,
        },
      ],
    );
    items.push({
      routeVersionId,
      messages: [{ role: 'user', content: 'Compare the tradeoffs.' }],
      maxOutputTokens: 128,
      privacy: 'standard',
    });
  }
  return { id, projectId, items, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

async function api(
  user,
  path,
  body,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await dispatch(
    new Request(`https://conclave.test/api/${path}`, {
      method,
      headers: {
        origin: 'https://conclave.test',
        cookie: user.cookie,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function baseMaximum(item) {
  const route = (
    await pool.query('SELECT pricing FROM route_versions WHERE id=$1', [
      item.routeVersionId,
    ])
  ).rows[0];
  return quoteMaximum(route, {
    messages: item.messages,
    maxOutputTokens: item.maxOutputTokens,
    privacy: 'standard',
  });
}

async function compare(user, blind = false) {
  const quoted = await api(user, 'comparison-quotes', {
    projectId: user.projectId,
    items: user.items,
    blind,
  });
  assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
  const body = {
    projectId: user.projectId,
    blind,
    idempotencyKey: randomUUID(),
    items: user.items.map((item, index) => ({
      ...item,
      quoteId: quoted.body.quotes[index].id,
    })),
  };
  const created = await api(user, 'comparisons', body);
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const calls = (
    await pool.query(
      `SELECT c.id,c.hold_id,h.quote_id,h.maximum_usd6::text FROM comparison_calls cc
      JOIN calls c ON c.id=cc.call_id JOIN holds h ON h.id=c.hold_id
      WHERE cc.comparison_id=$1 ORDER BY cc.position`,
      [created.body.comparison.id],
    )
  ).rows;
  return { quotes: quoted.body, comparison: created.body.comparison, calls };
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

async function reserveBalance() {
  return (
    await pool.query(
      "SELECT balance_usd6::text FROM ledger_accounts WHERE owner_id IS NULL AND kind='burn_reserve'",
    )
  ).rows[0].balance_usd6;
}

async function count(table) {
  return Number(
    (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,
  );
}

function signer() {
  const seed = new Uint8Array(randomBytes(32));
  const registered = {
    keyId: `test-${randomUUID()}`,
    epoch: 1,
    publicKey: receiptPublicKey(seed),
    validFrom: new Date(Date.now() - 60000).toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(),
    revoked: false,
  };
  return {
    keyId: registered.keyId,
    epoch: 1,
    seed,
    trust: receiptTrustFromValues([registered]),
  };
}

void test('fee math floors the fee and rounds the burn share up in integer micro-USD', () => {
  assert.deepEqual(platformFeeConfig({}), {
    platformFeeBps: 0,
    burnShareBps: 0,
  });
  assert.deepEqual(
    platformFeeConfig({
      CONCLAVE_PLATFORM_FEE_BPS: '500',
      CONCLAVE_BURN_SHARE_BPS: '5000',
    }),
    { platformFeeBps: 500, burnShareBps: 5000 },
  );
  for (const bad of ['-1', '5.5', '01', '2001', '1e3', ' 500', 'five'])
    assert.throws(
      () => platformFeeConfig({ CONCLAVE_PLATFORM_FEE_BPS: bad }),
      code('CONFIGURATION_REQUIRED'),
    );
  assert.throws(
    () => platformFeeConfig({ CONCLAVE_BURN_SHARE_BPS: '10001' }),
    code('CONFIGURATION_REQUIRED'),
  );
  for (const [base, feeBps, shareBps, fee, burn] of [
    [0n, 500, 5000, 0n, 0n],
    [1n, 500, 5000, 0n, 0n],
    [19n, 500, 5000, 0n, 0n],
    [20n, 500, 5000, 1n, 1n],
    [39n, 500, 5000, 1n, 1n],
    [40n, 500, 5000, 2n, 1n],
    [60n, 500, 5000, 3n, 2n],
    [1_000_000n, 500, 5000, 50_000n, 25_000n],
    [1_234_567n, 500, 5000, 61_728n, 30_864n],
    [1_234_567n, 500, 3333, 61_728n, 20_574n],
    [9_999_999n, 2000, 10000, 1_999_999n, 1_999_999n],
    [10_000_000n, 500, 0, 500_000n, 0n],
  ]) {
    const split = splitPlatformFee(base, feeBps, shareBps);
    assert.equal(split.platformFeeUsd6, fee, `fee for ${base}`);
    assert.equal(split.burnReserveUsd6, burn, `burn for ${base}`);
    assert.equal(split.retainedFeeUsd6, fee - burn);
    assert.equal(split.totalUsd6, base + fee);
  }
  // The fee is at most the stated rate and the burn at least its stated share.
  const samples = [
    ...Array.from({ length: 3000 }, (_, n) => BigInt(n)),
    ...Array.from(
      { length: 2000 },
      () => BigInt(`0x${randomBytes(6).toString('hex')}`) % 9_000_000_000_000n,
    ),
  ];
  for (const base of samples) {
    const split = splitPlatformFee(base, 500, 5000);
    assert.ok(split.platformFeeUsd6 * 10000n <= base * 500n);
    assert.ok(base * 500n < (split.platformFeeUsd6 + 1n) * 10000n);
    assert.ok(split.burnReserveUsd6 * 10000n >= split.platformFeeUsd6 * 5000n);
    assert.ok(split.burnReserveUsd6 <= split.platformFeeUsd6);
    // Monotonic: a smaller settled base never owes more than the quoted maximum.
    const smaller = splitPlatformFee(base / 3n, 500, 5000);
    assert.ok(smaller.totalUsd6 <= split.totalUsd6);
    assert.ok(smaller.burnReserveUsd6 <= split.burnReserveUsd6);
  }
  assert.deepEqual(priceWithPlatformFee('1428'), {
    maximumUsd6: '1428',
    platformFee: null,
  });
  assert.deepEqual(
    priceWithPlatformFee('1428', {
      config: { platformFeeBps: 500, burnShareBps: 5000 },
    }),
    {
      maximumUsd6: '1499',
      platformFee: {
        baseMaximumUsd6: '1428',
        platformFeeBps: 500,
        burnShareBps: 5000,
        platformFeeMaximumUsd6: '71',
        burnReserveMaximumUsd6: '36',
      },
    },
  );
  assert.throws(
    () =>
      priceWithPlatformFee('9600000', {
        limitUsd6: 10_000_000n,
        config: { platformFeeBps: 500, burnShareBps: 5000 },
      }),
    code('REQUEST_BUDGET_EXCEEDED'),
  );
  assert.equal(
    priceWithPlatformFee('9500000', {
      limitUsd6: 10_000_000n,
      config: { platformFeeBps: 500, burnShareBps: 5000 },
    }).maximumUsd6,
    '9975000',
  );
});

void test('default zero configuration prices settles and reports exactly as before', async () => {
  const user = await owner();
  const before = {
    reserve: await reserveBalance(),
    terms: await count('quote_platform_fees'),
    fees: await count('hold_platform_fees'),
  };
  const { quotes, comparison, calls } = await compare(user);
  for (const [index, quote] of quotes.quotes.entries()) {
    assert.deepEqual(Object.keys(quote).sort(), [
      'card',
      'expiresAt',
      'family',
      'id',
      'markupBps',
      'maximumUsd6',
      'modelId',
      'requestHash',
      'routeVersionId',
    ]);
    assert.equal(quote.maximumUsd6, await baseMaximum(user.items[index]));
  }
  assert.equal(
    quotePlatformFeeTotals(
      parseQuoteResponse(quotes, { ...user, blind: false }).quotes,
    ),
    null,
  );
  for (const call of comparison.calls)
    assert.deepEqual(Object.keys(call.billing).sort(), [
      'actualUsd6',
      'maximumUsd6',
      'state',
    ]);
  const settled = await settleHold(pool, {
    accountId: user.id,
    holdId: calls[0].hold_id,
    actualUsd6: '1234',
    providerReference: 'fixture-provider',
  });
  assert.equal(settled.hold.captured_usd6, '1234');
  assert.deepEqual(
    (await ledgerShape(`capture:${calls[0].hold_id}`)).map((e) => [
      e.kind,
      e.amount_usd6,
    ]),
    [
      ['reserved', '-1234'],
      ['revenue', '1234'],
    ],
  );
  assert.equal(
    (await ledgerShape(`burn-accrual:${calls[0].hold_id}`)).length,
    0,
  );
  await pool.query("UPDATE calls SET state='succeeded' WHERE id=$1", [
    calls[0].id,
  ]);
  const detail = await api(user, `calls/${calls[0].id}`);
  assert.deepEqual(Object.keys(detail.body.call.billing).sort(), [
    'actualUsd6',
    'maximumUsd6',
    'state',
  ]);
  const ledger = await api(user, 'ledger');
  assert.ok(ledger.body.entries.every((entry) => !('platformFee' in entry)));
  const { receipt } = await issueCallReceipt(
    pool,
    { accountId: user.id, callId: calls[0].id },
    signer(),
  );
  assert.equal(receipt.payload.actualUsd6, '1234');
  const listed = await api(user, 'receipts');
  assert.deepEqual(Object.keys(listed.body.receipts[0]).sort(), [
    'actualUsd6',
    'callId',
    'id',
    'issuedAt',
    'state',
  ]);
  assert.equal(await reserveBalance(), before.reserve);
  assert.equal(await count('quote_platform_fees'), before.terms);
  assert.equal(await count('hold_platform_fees'), before.fees);
  // An explicit zero buffer is the default: the same fields and amounts.
  const explicit = await withBuffer(0, async () => {
    const other = await owner();
    return { other, ...(await compare(other)) };
  });
  for (const [index, quote] of explicit.quotes.quotes.entries()) {
    assert.deepEqual(Object.keys(quote).sort(), [
      'card',
      'expiresAt',
      'family',
      'id',
      'markupBps',
      'maximumUsd6',
      'modelId',
      'requestHash',
      'routeVersionId',
    ]);
    assert.equal(
      quote.maximumUsd6,
      await baseMaximum(explicit.other.items[index]),
    );
    assert.equal(explicit.calls[index].maximum_usd6, quote.maximumUsd6);
  }
});

void test('hold buffer configuration and arithmetic are exact and fail closed', () => {
  assert.deepEqual(holdBufferConfig({}), { holdBufferBps: 0 });
  assert.deepEqual(holdBufferConfig({ CONCLAVE_HOLD_BUFFER_BPS: '' }), {
    holdBufferBps: 0,
  });
  assert.deepEqual(holdBufferConfig({ CONCLAVE_HOLD_BUFFER_BPS: '1000' }), {
    holdBufferBps: 1000,
  });
  assert.deepEqual(holdBufferConfig({ CONCLAVE_HOLD_BUFFER_BPS: '2000' }), {
    holdBufferBps: 2000,
  });
  for (const bad of ['-1', '5.5', '01', '2001', '1e3', ' 500', 'ten', '10%'])
    assert.throws(
      () => holdBufferConfig({ CONCLAVE_HOLD_BUFFER_BPS: bad }),
      code('CONFIGURATION_REQUIRED'),
    );
  // Zero: the base passes through and nothing is reported.
  assert.deepEqual(applyHoldBuffer('1428', { holdBufferBps: 0 }), {
    bufferedBaseMaximumUsd6: '1428',
    reservation: null,
  });
  for (const [base, bps, expected] of [
    [1n, 1, 2n],
    [1n, 1000, 2n],
    [9n, 1000, 10n],
    [10n, 1000, 11n],
    [1428n, 1000, 1571n],
    [1430n, 1000, 1573n],
    [1_000_000n, 1000, 1_100_000n],
    [1_234_567n, 500, 1_296_296n],
    [9_999_999n, 2000, 11_999_999n],
  ])
    assert.deepEqual(
      applyHoldBuffer(base.toString(), { holdBufferBps: bps }),
      {
        bufferedBaseMaximumUsd6: expected.toString(),
        reservation: {
          bufferBps: bps,
          baseMaximumUsd6: base.toString(),
          bufferedBaseMaximumUsd6: expected.toString(),
        },
      },
      `buffer for ${base} at ${bps}`,
    );
  // The buffer is never below its stated share, never a whole unit above it,
  // and monotonic in the base.
  const samples = [
    ...Array.from({ length: 3000 }, (_, n) => BigInt(n + 1)),
    ...Array.from(
      { length: 2000 },
      () =>
        (BigInt(`0x${randomBytes(6).toString('hex')}`) % 9_000_000_000_000n) +
        1n,
    ),
  ];
  for (const base of samples) {
    const widened = BigInt(
      applyHoldBuffer(base.toString(), { holdBufferBps: 1000 })
        .bufferedBaseMaximumUsd6,
    );
    assert.ok((widened - base) * 10000n >= base * 1000n);
    assert.ok((widened - base) * 10000n < base * 1000n + 10000n);
    const smaller = BigInt(
      applyHoldBuffer((base / 3n + 1n).toString(), { holdBufferBps: 1000 })
        .bufferedBaseMaximumUsd6,
    );
    assert.ok(smaller <= widened);
  }
  // Without a buffer the combined pricing is priceWithPlatformFee exactly.
  const free = { platformFeeBps: 0, burnShareBps: 0 },
    fee = { platformFeeBps: 500, burnShareBps: 5000 },
    none = { holdBufferBps: 0 },
    tenth = { holdBufferBps: 1000 };
  assert.deepEqual(priceQuoteMaximum('1428', { buffer: none, config: free }), {
    maximumUsd6: '1428',
    platformFee: null,
    reservation: null,
  });
  assert.deepEqual(priceQuoteMaximum('1428', { buffer: none, config: fee }), {
    ...priceWithPlatformFee('1428', { config: fee }),
    reservation: null,
  });
  // 1428 -> 1571 buffered; the fee is computed on the buffered base so the
  // stored terms keep base + fee = maximum: floor(78.55) = 78, burn ceil(39).
  assert.deepEqual(priceQuoteMaximum('1428', { buffer: tenth, config: fee }), {
    maximumUsd6: '1649',
    platformFee: {
      baseMaximumUsd6: '1571',
      platformFeeBps: 500,
      burnShareBps: 5000,
      platformFeeMaximumUsd6: '78',
      burnReserveMaximumUsd6: '39',
    },
    reservation: {
      bufferBps: 1000,
      baseMaximumUsd6: '1428',
      bufferedBaseMaximumUsd6: '1571',
    },
  });
  // The per-request cap binds on the buffered total, with or without a fee.
  assert.throws(
    () =>
      priceQuoteMaximum('9500000', {
        limitUsd6: 10_000_000n,
        buffer: tenth,
        config: free,
      }),
    code('REQUEST_BUDGET_EXCEEDED'),
  );
  // 9090909 + ceil(909090.9) is exactly the cap; one more micro-dollar is not.
  assert.equal(
    priceQuoteMaximum('9090909', {
      limitUsd6: 10_000_000n,
      buffer: tenth,
      config: free,
    }).maximumUsd6,
    '10000000',
  );
  assert.throws(
    () =>
      priceQuoteMaximum('9090910', {
        limitUsd6: 10_000_000n,
        buffer: tenth,
        config: free,
      }),
    code('REQUEST_BUDGET_EXCEEDED'),
  );
  // 9000000 fits with the fee alone (9450000) but not buffered (10395000).
  assert.equal(
    priceWithPlatformFee('9000000', { limitUsd6: 10_000_000n, config: fee })
      .maximumUsd6,
    '9450000',
  );
  assert.throws(
    () =>
      priceQuoteMaximum('9000000', {
        limitUsd6: 10_000_000n,
        buffer: tenth,
        config: fee,
      }),
    code('REQUEST_BUDGET_EXCEEDED'),
  );
});

void test('a configured hold buffer widens quotes and holds, absorbs a pricier upstream and is released at settlement', async () => {
  // Buffer without a fee: the hold is the buffered base and the response only
  // gains the reservation field.
  await withBuffer(1000, async () => {
    const user = await owner();
    const termsBefore = await count('quote_platform_fees');
    const { quotes, calls } = await compare(user);
    const bases = [];
    let total = 0n;
    for (const [index, quote] of quotes.quotes.entries()) {
      const base = BigInt(await baseMaximum(user.items[index]));
      bases.push(base);
      assert.deepEqual(Object.keys(quote).sort(), [
        'card',
        'expiresAt',
        'family',
        'id',
        'markupBps',
        'maximumUsd6',
        'modelId',
        'requestHash',
        'reservation',
        'routeVersionId',
      ]);
      assert.deepEqual(quote.reservation, {
        bufferBps: 1000,
        baseMaximumUsd6: base.toString(),
        bufferedBaseMaximumUsd6: buffered(base, 1000).toString(),
      });
      assert.equal(quote.maximumUsd6, buffered(base, 1000).toString());
      assert.equal(calls[index].maximum_usd6, quote.maximumUsd6);
      total += buffered(base, 1000);
    }
    assert.equal(quotes.maximumUsd6, total.toString());
    assert.equal(
      (await getBalance(pool, user.id)).reservedUsd6,
      total.toString(),
    );
    // The client parser accepts the extra field and records no fee.
    const parsed = parseQuoteResponse(quotes, { ...user, blind: false });
    assert.equal(parsed.quotes.length, 2);
    assert.equal(quotePlatformFeeTotals(parsed.quotes), null);
    assert.equal(await count('quote_platform_fees'), termsBefore);
    // A gateway bill above the listed price but within the buffer settles in
    // full; the unused part of the buffer is released and nothing is capped.
    const bill = bases[0] + 100n;
    assert.ok(bill <= buffered(bases[0], 1000));
    const settled = await settleHold(pool, {
      accountId: user.id,
      holdId: calls[0].hold_id,
      actualUsd6: bill.toString(),
      providerReference: 'fixture-provider',
    });
    assert.equal(settled.overageUsd6, 0n);
    assert.equal(settled.hold.state, 'captured');
    assert.equal(settled.hold.captured_usd6, bill.toString());
    assert.deepEqual(
      (await ledgerShape(`release:${calls[0].hold_id}`)).map((e) => [
        e.kind,
        e.amount_usd6,
      ]),
      [
        ['reserved', (-(buffered(bases[0], 1000) - bill)).toString()],
        ['available', (buffered(bases[0], 1000) - bill).toString()],
      ],
    );
    // Beyond the buffered maximum settlement still refuses, and a capped
    // settlement captures exactly the buffered hold and reports the excess.
    await assert.rejects(
      settleHold(pool, {
        accountId: user.id,
        holdId: calls[1].hold_id,
        actualUsd6: (buffered(bases[1], 1000) + 1n).toString(),
        providerReference: null,
      }),
      code('COST_EXCEEDS_RESERVATION'),
    );
    const capped = await settleHold(pool, {
      accountId: user.id,
      holdId: calls[1].hold_id,
      actualUsd6: (buffered(bases[1], 1000) + 7n).toString(),
      providerReference: 'fixture-provider',
      capAtReservation: true,
    });
    assert.equal(capped.overageUsd6, 7n);
    assert.equal(
      capped.hold.captured_usd6,
      buffered(bases[1], 1000).toString(),
    );
    assert.equal((await ledgerShape(`release:${calls[1].hold_id}`)).length, 0);
    assert.deepEqual(await getBalance(pool, user.id), {
      availableUsd6: (10_000_000n - bill - buffered(bases[1], 1000)).toString(),
      reservedUsd6: '0',
      currency: 'USD6',
    });
  });

  // Buffer and fee together: the fee is computed on the buffered base, so the
  // quote terms the database checks still satisfy base + fee = maximum.
  await withFee(500, 5000, () =>
    withBuffer(1000, async () => {
      const user = await owner();
      const { quotes, calls } = await compare(user);
      const bases = [];
      for (const [index, quote] of quotes.quotes.entries()) {
        const base = BigInt(await baseMaximum(user.items[index])),
          widened = buffered(base, 1000),
          split = splitPlatformFee(widened, 500, 5000);
        bases.push(base);
        assert.deepEqual(quote.reservation, {
          bufferBps: 1000,
          baseMaximumUsd6: base.toString(),
          bufferedBaseMaximumUsd6: widened.toString(),
        });
        assert.deepEqual(quote.platformFee, {
          baseMaximumUsd6: widened.toString(),
          platformFeeBps: 500,
          burnShareBps: 5000,
          platformFeeMaximumUsd6: split.platformFeeUsd6.toString(),
          burnReserveMaximumUsd6: split.burnReserveUsd6.toString(),
        });
        assert.equal(quote.maximumUsd6, split.totalUsd6.toString());
        assert.equal(calls[index].maximum_usd6, quote.maximumUsd6);
        assert.equal(
          (
            await pool.query(
              'SELECT base_maximum_usd6::text FROM quote_platform_fees WHERE quote_id=$1',
              [quote.id],
            )
          ).rows[0].base_maximum_usd6,
          widened.toString(),
        );
      }
      assert.ok(
        quotePlatformFeeTotals(
          parseQuoteResponse(quotes, { ...user, blind: false }).quotes,
        ),
      );
      // Within the buffer: charged bill + fee(bill), remainder released.
      const bill = bases[0] + 100n,
        charged = splitPlatformFee(bill, 500, 5000);
      assert.ok(bill <= buffered(bases[0], 1000));
      const settled = await settleHold(pool, {
        accountId: user.id,
        holdId: calls[0].hold_id,
        actualUsd6: bill.toString(),
        providerReference: 'fixture-provider',
      });
      assert.equal(settled.overageUsd6, 0n);
      assert.equal(settled.hold.captured_usd6, charged.totalUsd6.toString());
      assert.deepEqual(
        (
          await pool.query(
            'SELECT base_usd6::text,platform_fee_usd6::text FROM hold_platform_fees WHERE hold_id=$1',
            [calls[0].hold_id],
          )
        ).rows[0],
        {
          base_usd6: bill.toString(),
          platform_fee_usd6: charged.platformFeeUsd6.toString(),
        },
      );
      assert.equal(
        (await ledgerShape(`release:${calls[0].hold_id}`))[1].amount_usd6,
        (BigInt(calls[0].maximum_usd6) - charged.totalUsd6).toString(),
      );
      // Beyond the buffered base: refused, or capped at exactly the hold.
      await assert.rejects(
        settleHold(pool, {
          accountId: user.id,
          holdId: calls[1].hold_id,
          actualUsd6: (buffered(bases[1], 1000) + 1n).toString(),
          providerReference: null,
        }),
        code('COST_EXCEEDS_RESERVATION'),
      );
      const capped = await settleHold(pool, {
        accountId: user.id,
        holdId: calls[1].hold_id,
        actualUsd6: (buffered(bases[1], 1000) + 1n).toString(),
        providerReference: 'fixture-provider',
        capAtReservation: true,
      });
      assert.equal(capped.overageUsd6, 1n);
      assert.equal(capped.hold.captured_usd6, calls[1].maximum_usd6);
      assert.equal(
        (await ledgerShape(`release:${calls[1].hold_id}`)).length,
        0,
      );
    }),
  );

  // An invalid buffer fails closed before any quote exists.
  for (const bad of ['abc', '2001', '10%']) {
    await withBuffer(bad, async () => {
      const user = await owner();
      const quotesBefore = await count('quotes');
      const single = await api(user, 'quotes', {
        projectId: user.projectId,
        ...user.items[0],
      });
      assert.equal(single.status, 503);
      assert.equal(single.body.error.code, 'CONFIGURATION_REQUIRED');
      const many = await api(user, 'comparison-quotes', {
        projectId: user.projectId,
        items: user.items,
        blind: false,
      });
      assert.equal(many.status, 503);
      assert.equal(many.body.error.code, 'CONFIGURATION_REQUIRED');
      assert.equal(await count('quotes'), quotesBefore);
    });
  }
});

void test('quotes include the platform fee and capture splits base fee and burn reserve', async () => {
  await withFee(500, 5000, async () => {
    const user = await owner();
    const reserveBefore = BigInt(await reserveBalance());
    const statsBefore = await burnReserveStats(pool, undefined, future());
    const { quotes, comparison, calls } = await compare(user);
    let total = 0n;
    for (const [index, quote] of quotes.quotes.entries()) {
      const base = await baseMaximum(user.items[index]);
      const split = splitPlatformFee(BigInt(base), 500, 5000);
      assert.deepEqual(quote.platformFee, {
        baseMaximumUsd6: base,
        platformFeeBps: 500,
        burnShareBps: 5000,
        platformFeeMaximumUsd6: split.platformFeeUsd6.toString(),
        burnReserveMaximumUsd6: split.burnReserveUsd6.toString(),
      });
      assert.ok(split.platformFeeUsd6 > 0n);
      assert.equal(quote.maximumUsd6, split.totalUsd6.toString());
      assert.equal(calls[index].maximum_usd6, quote.maximumUsd6);
      total += split.totalUsd6;
    }
    assert.equal(quotes.maximumUsd6, total.toString());
    assert.equal(
      (await getBalance(pool, user.id)).reservedUsd6,
      total.toString(),
    );
    const parsed = parseQuoteResponse(quotes, { ...user, blind: false });
    assert.deepEqual(quotePlatformFeeTotals(parsed.quotes), {
      platformFeeMaximumUsd6: quotes.quotes
        .reduce((s, q) => s + BigInt(q.platformFee.platformFeeMaximumUsd6), 0n)
        .toString(),
      burnReserveMaximumUsd6: quotes.quotes
        .reduce((s, q) => s + BigInt(q.platformFee.burnReserveMaximumUsd6), 0n)
        .toString(),
    });
    const tampered = structuredClone(quotes);
    tampered.quotes[0].platformFee.burnReserveMaximumUsd6 = '0';
    assert.throws(() =>
      parseQuoteResponse(tampered, { ...user, blind: false }),
    );
    for (const call of comparison.calls)
      assert.equal(call.billing.platformFee.platformFeeBps, 500);

    // 1234 base: fee floor(61.7) = 61, burn ceil(30.5) = 31, retained 30.
    for (const call of calls) {
      const settled = await settleHold(pool, {
        accountId: user.id,
        holdId: call.hold_id,
        actualUsd6: '1234',
        providerReference: 'fixture-provider',
      });
      assert.equal(settled.replayed, false);
      assert.equal(settled.hold.state, 'captured');
      assert.equal(settled.hold.captured_usd6, '1295');
      assert.deepEqual(
        (await ledgerShape(`capture:${call.hold_id}`)).map((e) => [
          e.kind,
          e.amount_usd6,
        ]),
        [
          ['reserved', '-1295'],
          ['revenue', '1295'],
        ],
      );
      assert.deepEqual(
        (await ledgerShape(`burn-accrual:${call.hold_id}`)).map((e) => [
          e.transaction_kind,
          e.kind,
          e.owner_id,
          e.amount_usd6,
        ]),
        [
          ['burn_accrual', 'revenue', null, '-31'],
          ['burn_accrual', 'burn_reserve', null, '31'],
        ],
      );
      const row = (
        await pool.query(
          'SELECT base_usd6::text,platform_fee_usd6::text,burn_reserve_usd6::text FROM hold_platform_fees WHERE hold_id=$1',
          [call.hold_id],
        )
      ).rows[0];
      assert.deepEqual(row, {
        base_usd6: '1234',
        platform_fee_usd6: '61',
        burn_reserve_usd6: '31',
      });
      const replay = await settleHold(pool, {
        accountId: user.id,
        holdId: call.hold_id,
        actualUsd6: '1234',
        providerReference: 'fixture-provider',
      });
      assert.equal(replay.replayed, true);
      await assert.rejects(
        settleHold(pool, {
          accountId: user.id,
          holdId: call.hold_id,
          actualUsd6: '1295',
          providerReference: null,
        }),
        code('SETTLEMENT_CONFLICT'),
      );
    }
    assert.deepEqual(await getBalance(pool, user.id), {
      availableUsd6: (10_000_000n - 2n * 1295n).toString(),
      reservedUsd6: '0',
      currency: 'USD6',
    });
    assert.equal(BigInt(await reserveBalance()) - reserveBefore, 62n);
    const unbalanced = await pool.query(
      'SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(amount_usd6)<>0',
    );
    assert.equal(unbalanced.rowCount, 0);

    await pool.query("UPDATE calls SET state='succeeded' WHERE id=$1", [
      calls[0].id,
    ]);
    const { receipt } = await issueCallReceipt(
      pool,
      { accountId: user.id, callId: calls[0].id },
      signer(),
    );
    assert.equal(receipt.payload.version, 1);
    assert.equal(receipt.payload.actualUsd6, '1295');
    const listed = (await api(user, 'receipts')).body.receipts;
    assert.deepEqual(listed[0].platformFee, {
      baseUsd6: '1234',
      platformFeeUsd6: '61',
      burnReserveUsd6: '31',
    });
    const billing = (await api(user, `calls/${calls[0].id}`)).body.call.billing;
    assert.equal(billing.actualUsd6, '1295');
    assert.equal(billing.platformFee.baseUsd6, '1234');
    assert.equal(billing.platformFee.platformFeeUsd6, '61');
    assert.equal(billing.platformFee.burnReserveUsd6, '31');
    const read = (await api(user, `comparisons/${comparison.id}`)).body
      .comparison;
    assert.ok(
      read.calls.every(
        (call) => call.billing.platformFee.burnReserveUsd6 === '31',
      ),
    );
    const captures = (await api(user, 'ledger')).body.entries.filter(
      (entry) => entry.kind === 'capture',
    );
    assert.equal(captures.length, 2);
    for (const entry of captures) {
      assert.equal(entry.reservedDeltaUsd6, '-1295');
      assert.deepEqual(entry.platformFee, {
        baseUsd6: '1234',
        platformFeeUsd6: '61',
        burnReserveUsd6: '31',
      });
    }

    const statsAfter = await burnReserveStats(pool, undefined, future());
    assert.equal(
      BigInt(statsAfter.accruedUsd6) - BigInt(statsBefore.accruedUsd6),
      62n,
    );
    assert.equal(
      BigInt(statsAfter.pendingUsd6) - BigInt(statsBefore.pendingUsd6),
      62n,
    );
    assert.equal(statsAfter.executedUsd6, '0');
    assert.equal(statsAfter.burnsExecuted, 0);
    assert.equal(
      statsAfter.settlements.count - statsBefore.settlements.count,
      2,
    );
    assert.equal(
      BigInt(statsAfter.settlements.platformFeeUsd6) -
        BigInt(statsBefore.settlements.platformFeeUsd6),
      122n,
    );
    assert.equal(statsAfter.pendingUsd6, await reserveBalance());
    const endpoint = await api(user, 'token/burn-reserve');
    assert.equal(endpoint.status, 200);
    const published = endpoint.body.burnReserve;
    assert.deepEqual(published.terms, {
      platformFeeBps: 500,
      burnShareBps: 5000,
    });
    assert.equal(published.onChain.status, 'not_launched');
    assert.equal(published.executedUsd6, '0');
    assert.equal(new Date(published.asOf).getUTCMinutes(), 0);
    assert.ok(Date.parse(published.asOf) <= Date.now());
    assert.ok(BigInt(published.accruedUsd6) <= BigInt(statsAfter.accruedUsd6));
  });
});

void test('holds reserve the fee and a failed request releases everything and accrues nothing', async () => {
  await withFee(500, 5000, async () => {
    const probe = await owner('0');
    const base = BigInt(await baseMaximum(probe.items[0]));
    const fee = splitPlatformFee(base, 500, 5000).platformFeeUsd6;
    const short = await owner(base.toString());
    const quote = await api(short, 'quotes', {
      projectId: short.projectId,
      ...short.items[0],
    });
    assert.equal(quote.status, 201);
    assert.equal(quote.body.quote.maximumUsd6, (base + fee).toString());
    const denied = await api(short, 'calls', {
      projectId: short.projectId,
      ...short.items[0],
      quoteId: quote.body.quote.id,
      idempotencyKey: randomUUID(),
    });
    assert.equal(denied.status, 402);
    assert.equal(denied.body.error.code, 'INSUFFICIENT_BALANCE');

    const user = await owner((base + fee).toString());
    const reserveBefore = await reserveBalance();
    const accepted = await api(user, 'quotes', {
      projectId: user.projectId,
      ...user.items[0],
    });
    const created = await api(user, 'calls', {
      projectId: user.projectId,
      ...user.items[0],
      quoteId: accepted.body.quote.id,
      idempotencyKey: randomUUID(),
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const holdId = (
      await pool.query('SELECT hold_id FROM calls WHERE id=$1', [
        created.body.call.id,
      ])
    ).rows[0].hold_id;
    assert.deepEqual(await getBalance(pool, user.id), {
      availableUsd6: '0',
      reservedUsd6: (base + fee).toString(),
      currency: 'USD6',
    });
    // The fee headroom never absorbs a provider overrun.
    await assert.rejects(
      settleHold(pool, {
        accountId: user.id,
        holdId,
        actualUsd6: (base + 1n).toString(),
        providerReference: null,
      }),
      code('COST_EXCEEDS_RESERVATION'),
    );
    const released = await settleHold(pool, {
      accountId: user.id,
      holdId,
      actualUsd6: '0',
      providerReference: null,
    });
    assert.equal(released.hold.state, 'released');
    assert.equal(released.hold.captured_usd6, '0');
    assert.deepEqual(await getBalance(pool, user.id), {
      availableUsd6: (base + fee).toString(),
      reservedUsd6: '0',
      currency: 'USD6',
    });
    assert.equal((await ledgerShape(`capture:${holdId}`)).length, 0);
    assert.equal((await ledgerShape(`burn-accrual:${holdId}`)).length, 0);
    assert.equal(
      (
        await pool.query('SELECT 1 FROM hold_platform_fees WHERE hold_id=$1', [
          holdId,
        ])
      ).rowCount,
      0,
    );
    assert.equal(await reserveBalance(), reserveBefore);
    const billing = (await api(user, `calls/${created.body.call.id}`)).body.call
      .billing;
    assert.equal(billing.platformFee.baseUsd6, '0');
    assert.equal(billing.platformFee.burnReserveUsd6, '0');
    // A full-maximum capture still fits the hold exactly.
    const full = await owner((base + fee).toString());
    const fullQuote = await api(full, 'quotes', {
      projectId: full.projectId,
      ...full.items[0],
    });
    const fullCall = await api(full, 'calls', {
      projectId: full.projectId,
      ...full.items[0],
      quoteId: fullQuote.body.quote.id,
      idempotencyKey: randomUUID(),
    });
    const fullHold = (
      await pool.query('SELECT hold_id FROM calls WHERE id=$1', [
        fullCall.body.call.id,
      ])
    ).rows[0].hold_id;
    const captured = await settleHold(pool, {
      accountId: full.id,
      holdId: fullHold,
      actualUsd6: base.toString(),
      providerReference: 'fixture-provider',
    });
    assert.equal(captured.hold.captured_usd6, (base + fee).toString());
    assert.equal((await ledgerShape(`release:${fullHold}`)).length, 0);
  });
});

void test('settlement uses the terms fixed on the quote rather than the current configuration', async () => {
  const feeFree = await owner();
  const freeQuote = await api(feeFree, 'quotes', {
    projectId: feeFree.projectId,
    ...feeFree.items[0],
  });
  assert.equal(freeQuote.body.quote.platformFee, undefined);
  const freeHold = await reserveQuote(pool, {
    accountId: feeFree.id,
    quoteId: freeQuote.body.quote.id,
    idempotencyKey: randomUUID(),
    requestHash: freeQuote.body.quote.requestHash,
  });
  const quotedUnderFee = await withFee(500, 5000, async () => {
    const user = await owner();
    const quote = await api(user, 'quotes', {
      projectId: user.projectId,
      ...user.items[0],
    });
    const held = await reserveQuote(pool, {
      accountId: user.id,
      quoteId: quote.body.quote.id,
      idempotencyKey: randomUUID(),
      requestHash: quote.body.quote.requestHash,
    });
    return { user, holdId: held.hold.id };
  });
  await withFee(2000, 10000, async () => {
    const free = await settleHold(pool, {
      accountId: feeFree.id,
      holdId: freeHold.hold.id,
      actualUsd6: '1000',
      providerReference: null,
    });
    assert.equal(free.hold.captured_usd6, '1000');
    const fixed = await settleHold(pool, {
      accountId: quotedUnderFee.user.id,
      holdId: quotedUnderFee.holdId,
      actualUsd6: '1000',
      providerReference: null,
    });
    // 5% of 1000 = 50, half of it to the reserve.
    assert.equal(fixed.hold.captured_usd6, '1050');
    assert.deepEqual(
      (
        await pool.query(
          'SELECT platform_fee_usd6::text,burn_reserve_usd6::text FROM hold_platform_fees WHERE hold_id=$1',
          [quotedUnderFee.holdId],
        )
      ).rows[0],
      { platform_fee_usd6: '50', burn_reserve_usd6: '25' },
    );
  });
  await withFee(500, 0, async () => {
    const user = await owner();
    const quote = await api(user, 'quotes', {
      projectId: user.projectId,
      ...user.items[0],
    });
    assert.equal(quote.body.quote.platformFee.burnReserveMaximumUsd6, '0');
    const held = await reserveQuote(pool, {
      accountId: user.id,
      quoteId: quote.body.quote.id,
      idempotencyKey: randomUUID(),
      requestHash: quote.body.quote.requestHash,
    });
    const settled = await settleHold(pool, {
      accountId: user.id,
      holdId: held.hold.id,
      actualUsd6: '1000',
      providerReference: null,
    });
    assert.equal(settled.hold.captured_usd6, '1050');
    assert.equal((await ledgerShape(`burn-accrual:${held.hold.id}`)).length, 0);
    assert.equal(
      (
        await pool.query(
          'SELECT ledger_transaction_id FROM hold_platform_fees WHERE hold_id=$1',
          [held.hold.id],
        )
      ).rows[0].ledger_transaction_id,
      null,
    );
  });
});

void test('the database rejects fee terms or burn accruals outside settlement', async () => {
  const user = await withFee(500, 5000, () => owner());
  const quote = await withFee(500, 5000, () =>
    api(user, 'quotes', { projectId: user.projectId, ...user.items[0] }),
  );
  const insertQuote = (db, quoteId, maximum) =>
    db.query(
      `INSERT INTO quotes(id,account_id,project_id,route_version_id,request_hash,max_usd6,max_output_tokens,expires_at)
      VALUES($1,$2,$3,$4,'fixture-hash',$5,128,now()+interval '2 minutes')`,
      [quoteId, user.id, user.projectId, user.items[0].routeVersionId, maximum],
    );
  // 1430 base: floor(71.5) = 71 fee, so a consistent quote maximum is 1501.
  const attachTerms = (db, quoteId) =>
    db.query(
      `INSERT INTO quote_platform_fees(quote_id,base_maximum_usd6,platform_fee_bps,burn_share_bps,platform_fee_maximum_usd6)
      VALUES($1,1430,500,5000,71)`,
      [quoteId],
    );
  const together = randomUUID();
  await transaction(pool, async (client) => {
    await insertQuote(client, together, '1501');
    await attachTerms(client, together);
  });
  // Terms cannot be attached to a quote after its creating transaction, or
  // disagree with the quote's maximum.
  const late = randomUUID();
  await insertQuote(pool, late, '1501');
  await assert.rejects(attachTerms(pool, late), checkViolation);
  await assert.rejects(
    transaction(pool, async (client) => {
      const mismatched = randomUUID();
      await insertQuote(client, mismatched, '1500');
      await attachTerms(client, mismatched);
    }),
    checkViolation,
  );
  for (const sql of [
    'UPDATE quote_platform_fees SET burn_share_bps=0 WHERE quote_id=$1',
    'DELETE FROM quote_platform_fees WHERE quote_id=$1',
  ])
    await assert.rejects(
      pool.query(sql, [quote.body.quote.id]),
      checkViolation,
    );
  const held = await reserveQuote(pool, {
    accountId: user.id,
    quoteId: quote.body.quote.id,
    idempotencyKey: randomUUID(),
    requestHash: quote.body.quote.requestHash,
  });
  // A capture under fee terms cannot bypass its split record.
  await assert.rejects(
    transaction(pool, (client) =>
      client.query(
        "UPDATE holds SET state='captured',captured_usd6=1 WHERE id=$1",
        [held.hold.id],
      ),
    ),
    checkViolation,
  );
  await settleHold(pool, {
    accountId: user.id,
    holdId: held.hold.id,
    actualUsd6: '1000',
    providerReference: null,
  });
  for (const sql of [
    'UPDATE hold_platform_fees SET burn_reserve_usd6=0 WHERE hold_id=$1',
    'DELETE FROM hold_platform_fees WHERE hold_id=$1',
  ])
    await assert.rejects(pool.query(sql, [held.hold.id]), checkViolation);
  const accounts = Object.fromEntries(
    (
      await pool.query(
        "SELECT kind,id FROM ledger_accounts WHERE owner_id IS NULL AND kind IN ('revenue','burn_reserve','clearing')",
      )
    ).rows.map((row) => [row.kind, row.id]),
  );
  const raw = (kind, entries) =>
    transaction(pool, async (client) => {
      const id = randomUUID();
      await client.query(
        'INSERT INTO ledger_transactions(id,reference,kind) VALUES($1,$2,$3)',
        [id, `fixture:${id}`, kind],
      );
      for (const [account, amount] of entries)
        await client.query(
          'INSERT INTO ledger_entries(transaction_id,ledger_account_id,amount_usd6) VALUES($1,$2,$3)',
          [id, account, amount],
        );
    });
  const reserveBefore = await reserveBalance();
  // An accrual without a fee settlement record fails at commit.
  await assert.rejects(
    raw('burn_accrual', [
      [accounts.revenue, '-1'],
      [accounts.burn_reserve, '1'],
    ]),
    checkViolation,
  );
  // The reserve takes part in nothing else and cannot be debited yet.
  await assert.rejects(
    raw('refund', [
      [accounts.burn_reserve, '-1'],
      [accounts.revenue, '1'],
    ]),
    checkViolation,
  );
  await assert.rejects(
    raw('burn_accrual', [
      [accounts.clearing, '-1'],
      [accounts.burn_reserve, '1'],
    ]),
    checkViolation,
  );
  assert.equal(await reserveBalance(), reserveBefore);
  await assert.rejects(
    pool.query(
      "INSERT INTO ledger_accounts(id,owner_id,kind) VALUES($1,$2,'burn_reserve')",
      [randomUUID(), user.id],
    ),
    checkViolation,
  );
});

void test('blind comparisons hide the fee split until reveal', async () => {
  await withFee(500, 5000, async () => {
    const user = await owner();
    const { comparison, calls } = await compare(user, true);
    for (const call of comparison.calls)
      assert.equal(call.billing.platformFee, undefined);
    await settleHold(pool, {
      accountId: user.id,
      holdId: calls[0].hold_id,
      actualUsd6: '1234',
      providerReference: null,
    });
    const hidden = (await api(user, `comparisons/${comparison.id}`)).body
      .comparison;
    assert.ok(
      hidden.calls.every((call) => call.billing.platformFee === undefined),
    );
    const revealed = await api(user, `comparisons/${comparison.id}/reveal`, {});
    assert.equal(revealed.status, 200);
    const shown = revealed.body.comparison.calls.find(
      (call) => call.id === calls[0].id,
    );
    assert.equal(shown.billing.platformFee.platformFeeUsd6, '61');
  });
});

void test('auto routing compares the fee-inclusive maximum with the budget', async () => {
  await withFee(500, 5000, async () => {
    const user = await owner('10000000', { routing: true });
    const base = BigInt(await baseMaximum(user.items[0]));
    const total = splitPlatformFee(base, 500, 5000).totalUsd6;
    const request = (budgetUsd6) =>
      api(user, 'auto-route-quotes', {
        projectId: user.projectId,
        task: 'code',
        privacy: 'standard',
        budgetUsd6,
        candidates: user.items,
      });
    const over = await request(base.toString());
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'ROUTING_BUDGET_EXCEEDED');
    const fits = await request(total.toString());
    assert.equal(fits.status, 201, JSON.stringify(fits.body));
    assert.equal(
      fits.body.quotes[0].routeVersionId,
      user.items[0].routeVersionId,
    );
    assert.equal(fits.body.maximumUsd6, total.toString());
    assert.equal(fits.body.recommendation.maximumUsd6, total.toString());
    assert.equal(
      fits.body.quotes[0].platformFee.baseMaximumUsd6,
      base.toString(),
    );
    assert.equal(
      (
        await pool.query(
          'SELECT base_maximum_usd6::text FROM quote_platform_fees WHERE quote_id=$1',
          [fits.body.quotes[0].id],
        )
      ).rows[0].base_maximum_usd6,
      base.toString(),
    );
  });
});

void test('the quote reserves reasoning tokens at the output rate: the reviewed cap when present, otherwise the route output cap', () => {
  const pricing = {
    inputPerMillionUsd6: '1000000',
    outputPerMillionUsd6: '2000000',
    markupBps: 0,
    maxOutputTokens: 8192,
    maxInputBytes: 32768,
  };
  const route = (extra) => ({
    id: 'route',
    modelId: 'gpt-6.1-sol',
    family: 'gpt',
    enabled: true,
    fresh: true,
    modality: 'chat',
    card: { reviewed: true },
    pricing: { ...pricing, ...extra },
  });
  const input = {
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 100,
    privacy: 'standard',
  };
  // input allowance: 2 bytes + 256 + 1024 = 1282 tokens at 1 USD/M = 1282 USD6
  const inputUsd6 = 1282n;
  const outputUsd6 = (tokens) => BigInt(tokens) * 2n;
  assert.equal(
    quoteMaximum(route({ maxReasoningTokens: 0 }), input),
    (inputUsd6 + outputUsd6(100)).toString(),
  );
  assert.equal(
    quoteMaximum(route({}), input),
    // No reviewed cap: the route's whole output cap (8192) is reserved for reasoning.
    (inputUsd6 + outputUsd6(100 + 8192)).toString(),
  );
  assert.equal(
    quoteMaximum(route({ maxReasoningTokens: 8192 }), input),
    (inputUsd6 + outputUsd6(8292)).toString(),
  );
  for (const bad of [-1, 65537, 1.5, '8192'])
    assert.throws(
      () => quoteMaximum(route({ maxReasoningTokens: bad }), input),
      { code: 'ROUTE_PRICING_UNAVAILABLE' },
    );
});
