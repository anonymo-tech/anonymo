import {
  metadataAddress,
  decodeMetaplex,
} from '../server/second-look/token-metadata.ts';
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import bs58 from 'bs58';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  parseTokenInput,
  resolveTokenInput,
} from '../server/second-look/input.ts';
import {
  createTokenProviders,
  tokenProviderConfig,
  tokenCapability,
} from '../server/second-look/providers.ts';
import {
  decodeMintAccount,
  marketChecks,
  blankChecks,
  source,
  fact,
  collectTokenFacts,
  paidOrderFacts,
} from '../server/second-look/token-facts.ts';
import {
  evaluateTokenFacts,
  calibrationState,
  cacheSeconds,
} from '../server/second-look/token-rules.ts';
import { parseReviewedTokenEvidence } from '../server/second-look/deep.ts';
import {
  quoteTokenCheck,
  approveTokenCheck,
  readTokenReport,
  installTokenEvidence,
  consumeFreeTokenQuota,
  consumeAnonymousTokenBudget,
  listTokenReports,
} from '../server/second-look/token-store.ts';
import {
  createSourceSnapshot,
  prepareCrossCheck,
} from '../server/crosscheck/core.ts';
import {
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  SOLANA_NETWORKS,
} from '../server/solana/validation.ts';
import { createDatabase, transaction } from '../server/db/database.ts';
import { ledgerAccount, post } from '../server/ledger/ledger.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
const key = (n) => bs58.encode(new Uint8Array(32).fill(n)),
  mint = key(30),
  code = (c) => (e) => e.code === c;
const config = {
  enabled: true,
  rpcUrl: 'https://rpc.example/',
  dex: true,
  rug: true,
  evidence: false,
  simulation: false,
  claims: false,
  deep: false,
  freeDailyGlobalLimit: 100000,
};
function mintBytes(ext = []) {
  const b = Buffer.alloc(ext.length ? 166 : 82);
  b[45] = 1;
  b[44] = 6;
  b.writeBigUInt64LE(1000000000000n, 36);
  if (ext.length) b[165] = 1;
  return Buffer.concat([
    b,
    ...ext.map(([id, bytes]) => {
      const h = Buffer.alloc(4);
      h.writeUInt16LE(id);
      h.writeUInt16LE(bytes.length, 2);
      return Buffer.concat([h, bytes]);
    }),
  ]);
}
const account = (bytes, owner = TOKEN_PROGRAM) => ({
  context: { slot: 123 },
  value: {
    executable: false,
    owner,
    data: [bytes.toString('base64'), 'base64'],
  },
});
function facts(values = {}) {
  const now = Date.now();
  const checks = blankChecks().map((c) => ({
    ...c,
    status: 'complete',
    sources: [source('reviewed-index', now)],
    facts: [],
  }));
  for (const [id, entries] of Object.entries(values))
    checks[Number(id) - 1].facts = Object.entries(entries).map(([k, v]) =>
      fact(k, k, v),
    );
  return {
    mint,
    observedAt: new Date(now).toISOString(),
    ageSeconds: 100,
    checks,
  };
}
function calibration() {
  const now = Date.now();
  return {
    version: 'bfb-1',
    derivation: 'buy-time-v1',
    datasetHash: 'a'.repeat(64),
    evidenceUrl: 'https://research.example/backtest',
    reviewedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString(),
    observations: 20000,
    historicalDays: 60,
    liveDays: 30,
    redRecall: 0.7,
    bands: ['under-1h', '1h-24h', 'over-24h'].map((band) => ({
      band,
      baseRate: 0.45,
      greenCrashRate: 0.15,
      greenObservations: 100,
    })),
  };
}
function providers(options = {}) {
  const calls = [];
  const client = createTokenProviders(config, async (url, init) => {
    calls.push({ url, init });
    const rpc = init.method === 'POST' ? JSON.parse(init.body) : null;
    let result;
    if (rpc?.method === 'getGenesisHash')
      result = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
    else if (rpc?.method === 'getAccountInfo') result = account(mintBytes());
    else if (rpc?.method === 'getTokenLargestAccounts')
      result = {
        context: { slot: 124 },
        value: [{ address: key(50), amount: '100' }],
      };
    else if (url.includes('dexscreener'))
      return Response.json([
        {
          chainId: 'solana',
          pairAddress: key(31),
          baseToken: { address: mint, name: 'Fixture', symbol: 'FIX' },
          dexId: 'fixture',
          liquidity: { usd: 12000 },
          volume: { h1: 100, h24: 400 },
          txns: { h1: { buys: 2, sells: 1 }, h24: { buys: 4, sells: 2 } },
          boosts: { active: 0 },
        },
      ]);
    else return Response.json({ risks: [] });
    if (options.fail) throw new Error('private upstream detail');
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  return { client, calls };
}
void test('mint and known link resolution never treats a Dex pool as a mint', () => {
  assert.equal(parseTokenInput(mint).kind, 'mint');
  assert.deepEqual(
    parseTokenInput(`https://dexscreener.com/solana/${key(31)}`),
    { kind: 'pair', value: key(31) },
  );
  assert.equal(parseTokenInput(`https://pump.fun/coin/${mint}`).value, mint);
  for (const x of [
    'http://127.0.0.1/a',
    `https://pump.fun@evil.example/coin/${mint}`,
    `https://pump.fun/coin/${mint}?next=private`,
    `https://pump.fun/coin/%41${mint}`,
    `https://fomo.family/x/${mint}`,
  ])
    assert.throws(() => parseTokenInput(x));
});
void test('ticker candidates require choice even one exact symbol', async () => {
  const p = providers().client;
  p.search = async () => ({
    pairs: [
      {
        chainId: 'solana',
        pairAddress: key(31),
        baseToken: { address: mint, name: 'Fixture', symbol: 'FIX' },
        liquidity: { usd: 1 },
      },
    ],
  });
  const r = await resolveTokenInput('FIX', undefined, p);
  assert.equal(r.status, 'choose');
  assert.equal(r.mint, null);
  assert.equal(r.candidates[0].mint, mint);
});
void test('strict binary mint options, initialization, owner and encodings', () => {
  const c = decodeMintAccount(account(mintBytes()), mint);
  assert.equal(c[0].status, 'complete');
  assert.equal(c[1].status, 'complete');
  const b = mintBytes();
  b.writeUInt32LE(2);
  assert.throws(() => decodeMintAccount(account(b), mint));
  assert.throws(() => decodeMintAccount(account(mintBytes(), key(9)), mint));
  const r = account(mintBytes());
  r.value.data[0] += '=';
  assert.throws(() => decodeMintAccount(r, mint));
});
void test('Token2022 authority/frozen/fee extension values preserve full u64', () => {
  const fee = Buffer.alloc(108);
  Buffer.from(bs58.decode(key(8))).copy(fee);
  fee.writeUInt16LE(501, 88);
  fee.writeBigUInt64LE((1n << 64n) - 1n, 80);
  const c = decodeMintAccount(
    account(
      mintBytes([
        [1, fee],
        [6, Buffer.from([2])],
        [12, Buffer.from(bs58.decode(key(7)))],
      ]),
      TOKEN_2022_PROGRAM,
    ),
    mint,
  );
  const result = evaluateTokenFacts({ ...facts(), checks: c }, calibration());
  assert.equal(result.checks[1].risk, 'red');
  assert.equal(
    c[1].facts.find((f) => f.key === 'olderFeeMaximum').value,
    '18446744073709551615',
  );
});
void test('unknown extensions remain partial, duplicate/malformed TLV refuses', () => {
  assert.equal(
    decodeMintAccount(
      account(mintBytes([[999, Buffer.from([1])]]), TOKEN_2022_PROGRAM),
      mint,
    )[1].status,
    'partial',
  );
  assert.throws(() =>
    decodeMintAccount(
      account(
        mintBytes([
          [9, Buffer.alloc(0)],
          [9, Buffer.alloc(0)],
        ]),
        TOKEN_2022_PROGRAM,
      ),
      mint,
    ),
  );
  assert.throws(() =>
    decodeMintAccount(
      account(mintBytes([[26, Buffer.from([1])]]), TOKEN_2022_PROGRAM),
      mint,
    ),
  );
});
void test('required missing and expired simulation produce Checking even with red facts', () => {
  const f = facts({ 1: { freezeAuthority: key(4) } });
  f.checks[3].status = 'unavailable';
  assert.equal(evaluateTokenFacts(f, calibration()).verdict, 'checking');
  f.checks[3].status = 'complete';
  f.checks[3].sources[0].expiresAt = new Date(Date.now() - 1).toISOString();
  assert.equal(evaluateTokenFacts(f, calibration()).verdict, 'checking');
});
void test('calibration absent/failing/unknown age withholds verdict; exact passing gate works', () => {
  assert.equal(evaluateTokenFacts(facts()).verdict, 'withheld');
  const bad = calibration();
  bad.redRecall = 0.699;
  assert.equal(evaluateTokenFacts(facts(), bad).verdict, 'withheld');
  assert.equal(
    evaluateTokenFacts({ ...facts(), ageSeconds: null }, calibration()).verdict,
    'withheld',
  );
  assert.equal(
    evaluateTokenFacts(facts(), calibration()).verdict,
    'no_red_flags',
  );
  assert.equal(calibrationState(calibration(), 100).status, 'valid');
});
void test('top ten thresholds use classified owners only and exact 30/50 boundaries', () => {
  for (const [percent, risk] of [
    [29.99, 'none'],
    [30, 'caution'],
    [50, 'caution'],
    [50.01, 'red'],
  ])
    assert.equal(
      evaluateTokenFacts(
        facts({
          5: {
            nonPoolTop10Percent: percent,
            holderClassificationComplete: true,
          },
        }),
        calibration(),
      ).checks[4].risk,
      risk,
    );
  assert.equal(
    evaluateTokenFacts(
      facts({
        5: { nonPoolTop10Percent: 99, holderClassificationComplete: false },
      }),
      calibration(),
    ).checks[4].risk,
    'none',
  );
});
void test('early held supply and fee/simulation exact boundary comparisons', () => {
  for (const [percent, risk] of [
    [9.99, 'none'],
    [10, 'caution'],
    [20, 'caution'],
    [20.01, 'red'],
  ])
    assert.equal(
      evaluateTokenFacts(
        facts({ 7: { earlyStillHeldPercent: percent } }),
        calibration(),
      ).checks[6].risk,
      risk,
    );
  assert.equal(
    evaluateTokenFacts(
      facts({ 2: { feeBps: 500 }, 4: { roundtripCostPercent: 30 } }),
      calibration(),
    ).verdict,
    'no_red_flags',
  );
  assert.equal(
    evaluateTokenFacts(
      facts({ 4: { roundtripSucceeded: false } }),
      calibration(),
    ).verdict,
    'red_flags',
  );
});
void test('promotion without unique buyers is not inferred; pool age not mint age', () => {
  assert.equal(
    evaluateTokenFacts(
      facts({ 11: { paidPromotionActive: true } }),
      calibration(),
    ).checks[10].risk,
    'none',
  );
  assert.equal(
    evaluateTokenFacts(
      facts({ 11: { paidPromotionActive: true }, 12: { uniqueBuyers1h: 49 } }),
      calibration(),
    ).checks[10].risk,
    'caution',
  );
  const checks = marketChecks(
    [
      {
        chainId: 'solana',
        pairAddress: key(31),
        baseToken: { address: mint },
        dexId: 'fixture',
        pairCreatedAt: Date.now() - 50000,
      },
    ],
    mint,
  );
  assert.equal(checks[11].status, 'partial');
  assert.ok(checks[11].limitations.some((x) => x.includes('not mint age')));
});
void test('partial optional check prevents a no-red-flags result', () => {
  const f = facts();
  f.checks[5].status = 'partial';
  assert.equal(evaluateTokenFacts(f, calibration()).verdict, 'withheld');
  assert.deepEqual(
    [null, 1, 3600, 86400].map(cacheSeconds),
    [30, 30, 120, 600],
  );
});
void test('provider fixed origins, no redirects/credentials and bounded malformed responses', async () => {
  const p = providers();
  const f = await collectTokenFacts(mint, { providers: p.client });
  assert.equal(f.checks.length, 13);
  assert.equal(f.checks[0].status, 'complete');
  assert.equal(f.checks[4].status, 'partial');
  assert.equal(f.checks[3].status, 'unavailable');
  for (const { init } of p.calls) {
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
  }
  assert.ok(p.calls.every((c) => !c.url.includes('undefined')));
  const bad = createTokenProviders(
    config,
    async () =>
      new Response('[]', { headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(bad.mint(mint), code('TOKEN_SOURCE_UNAVAILABLE'));
  const huge = createTokenProviders(
    config,
    async () =>
      new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'content-length': '1048577',
        },
      }),
  );
  await assert.rejects(huge.mint(mint), code('TOKEN_SOURCE_UNAVAILABLE'));
});
void test('paid promotion parser handles current envelopes without treating boosts as approved orders', () => {
  const now = Date.now();
  const orders = [
    {
      chainId: 'solana',
      tokenAddress: mint,
      type: 'tokenProfile',
      status: 'approved',
      paymentTimestamp: now - 1000,
    },
    {
      chainId: 'solana',
      tokenAddress: mint,
      type: 'communityTakeover',
      status: 'cancelled',
      paymentTimestamp: now - 2000,
    },
  ];
  const actual = paidOrderFacts(
    { orders, boosts: [{ amount: 1000 }] },
    now,
    mint,
  );
  assert.deepEqual(actual, paidOrderFacts(orders, now, mint));
  assert.equal(actual.find((f) => f.key === 'paidOrdersObserved').value, 2);
  assert.equal(actual.find((f) => f.key === 'approvedPaidOrders').value, 1);
  assert.equal(
    actual.some((f) => f.key === 'paidPromotionActive'),
    false,
  );
  assert.equal(
    paidOrderFacts({ orders: [], boosts: [{ amount: 1000 }] }, now, mint)[0]
      .value,
    0,
  );
});
void test('paid promotion records reject wrong tokens, wrong chains, future timestamps and malformed envelopes', () => {
  const now = Date.now();
  const order = {
    chainId: 'solana',
    tokenAddress: mint,
    type: 'tokenProfile',
    status: 'approved',
    paymentTimestamp: now - 1000,
  };
  for (const raw of [
    { orders: [{ ...order, tokenAddress: key(29) }] },
    { orders: [{ ...order, chainId: 'ethereum' }] },
    { orders: [{ ...order, paymentTimestamp: now + 1 }] },
    { orders: [{ ...order, paymentTimestamp: 'today' }] },
    { boosts: [] },
    { orders: Array(101).fill(order) },
  ])
    assert.throws(() => paidOrderFacts(raw, now, mint));
});
void test('mint metadata and market facts publish while optional holder and promotion sources are pending', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let ready;
  const early = new Promise((resolve) => {
    ready = resolve;
  });
  const text = (value) => {
    const bytes = Buffer.from(value),
      length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const metadata = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(bs58.decode(key(11))),
    Buffer.from(bs58.decode(mint)),
    text('Fixture'),
    text('FIX'),
    text('https://metadata.example/token'),
    Buffer.from([0, 0, 0, 0, 1]),
  ]);
  const p = providers().client;
  const collection = collectTokenFacts(mint, {
    providers: {
      ...p,
      mint: async (target) =>
        target === mint
          ? account(mintBytes())
          : account(metadata, 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
      largest: async () => {
        await held;
        throw new Error('Unavailable optional source');
      },
      orders: async () => {
        await held;
        return { orders: [], boosts: [] };
      },
    },
    onProgress: async (snapshot) => {
      if (
        snapshot.checks[2].status === 'complete' &&
        snapshot.checks[8].status === 'partial'
      )
        ready(snapshot);
    },
  });
  let timer;
  try {
    const snapshot = await Promise.race([
      early,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Useful facts waited for optional providers')),
          1000,
        );
      }),
    ]);
    assert.equal(snapshot.checks[4].status, 'pending');
    assert.equal(
      snapshot.checks[10].facts.some((f) => f.key === 'paidOrdersObserved'),
      false,
    );
  } finally {
    clearTimeout(timer);
    release();
    await collection;
  }
});
void test('configuration gates never claim deep/calibration readiness from RPC alone', () => {
  const c = tokenCapability(config);
  assert.equal(c.deepConfigured, false);
  assert.equal(c.calibrationConfigured, false);
  assert.equal(
    tokenProviderConfig({
      CONCLAVE_SOLANA_RPC_URL: 'http://127.0.0.1',
      CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta',
    }).rpcUrl,
    null,
  );
});
async function evidence(withDeep = false, targetMint = mint) {
  const now = Date.now();
  const result = {
    version: 1,
    mint: targetMint,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    reference: 'https://index.example/evidence',
    ageSeconds: 100,
    checks: [
      {
        id: 4,
        status: 'complete',
        values: {
          roundtripSucceeded: true,
          roundtripCostPercent: 2,
          probeMethod: 'mainnet-fork',
          probeId: 'fixture-probe',
        },
      },
    ],
  };
  if (withDeep) {
    const scope = {
        accountId: 'reviewed-index',
        scopeId: targetMint,
        revision: '1',
      },
      text = 'The token has an immutable supply.';
    const source = await createSourceSnapshot(
      {
        id: 's1',
        title: 'Public fixture',
        uri: 'https://evidence.example/token',
        text,
        scope,
        visibility: 'public',
        capturedAtMs: now,
      },
      now,
    );
    const reviewers = ['a', 'b', 'c'].map((id, i) => ({
      id,
      family: id,
      modelId: id,
      version: '1',
      distribution: i === 2 ? 'open-weight' : 'proprietary',
    }));
    const plan = await prepareCrossCheck({
      scope,
      claims: [{ id: 'c1', text }],
      sources: [source],
      reviewers,
      now,
    });
    result.deep = {
      launch: {
        createSlot: 1,
        throughSlot: 100,
        coverageComplete: true,
        events: [
          {
            slot: 2,
            signature: bs58.encode(new Uint8Array(64).fill(9)),
            instructionIndex: 0,
            kind: 'buy',
            amount: '10',
          },
        ],
      },
      claimReview: {
        plan,
        submissions: reviewers.map((r) => ({
          claimId: 'c1',
          reviewerId: r.id,
          content: JSON.stringify({
            verdict: 'supported',
            rationale: 'The supplied source contains the claim.',
            quotes: [
              { sourceId: 's1', sourceHash: source.snapshotHash, quote: text },
            ],
          }),
        })),
        finishedAtMs: now,
      },
    };
  }
  return result;
}
void test('reviewed simulation rejects quote-only proof and expired evidence', async () => {
  const e = await evidence();
  assert.equal(
    (await parseReviewedTokenEvidence(e, mint)).checks[0].status,
    'complete',
  );
  e.checks[0].values.probeMethod = 'swap-quote';
  await assert.rejects(parseReviewedTokenEvidence(e, mint));
  e.expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(parseReviewedTokenEvidence(e, mint));
});
void test('deep launch + Concur evaluation preserves disagreement and rejects private sources', async () => {
  const e = await evidence(true);
  const parsed = await parseReviewedTokenEvidence(e, mint);
  assert.equal(parsed.deep.claims[0].outcome, 'HOLDS');
  e.deep.claimReview.submissions[0].content = JSON.stringify({
    verdict: 'insufficient_evidence',
    rationale: 'Not enough evidence.',
    quotes: [],
  });
  assert.equal(
    (await parseReviewedTokenEvidence(e, mint)).deep.claims[0].outcome,
    'NO_CONSENSUS',
  );
  const broken = await evidence(true);
  broken.deep.launch.events[0].slot = 101;
  await assert.rejects(parseReviewedTokenEvidence(broken, mint));
  const privateEvidence = structuredClone(await evidence(true));
  privateEvidence.deep.claimReview.plan.sources[0] = {
    ...privateEvidence.deep.claimReview.plan.sources[0],
    visibility: 'private',
  };
  await assert.rejects(parseReviewedTokenEvidence(privateEvidence, mint));
});
const dbUrl = process.env.CONCLAVE_TEST_DATABASE_URL;
const pool = dbUrl ? createDatabase(testEndpoint(dbUrl).href, 8) : null;
before(async () => {
  if (pool) await migrate(pool);
});
after(async () => {
  await pool?.end();
});
async function owner(used = 0) {
  const id = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  if (used)
    await pool.query(
      "INSERT INTO secondlook_token_usage(account_id,day,used) VALUES($1,(clock_timestamp() AT TIME ZONE 'UTC')::date,$2)",
      [id, used],
    );
  await transaction(pool, async (db) => {
    const a = await ledgerAccount(db, id, 'available'),
      c = await ledgerAccount(db, null, 'clearing');
    await post(db, `token-fixture:${id}`, 'deposit', [
      { id: a.id, amount: 1000000n },
      { id: c.id, amount: -1000000n },
    ]);
  });
  return id;
}
const dbtest = (name, fn) => test(name, { skip: !pool }, fn);
void dbtest(
  'free quote + explicit approval persists13 checks; concurrent replay does not reconsume quota',
  async () => {
    const id = await owner(),
      p = providers();
    const { quote } = await quoteTokenCheck(
      pool,
      id,
      { mint, mode: 'standard', idempotencyKey: randomUUID() },
      config,
    );
    assert.equal(quote.maximumUsd6, '0');
    const [a, b] = await Promise.all([
      approveTokenCheck(
        pool,
        id,
        { quoteId: quote.id, approvedMaximumUsd6: '0' },
        { config, providers: p.client },
      ),
      approveTokenCheck(
        pool,
        id,
        { quoteId: quote.id, approvedMaximumUsd6: '0' },
        { config, providers: p.client },
      ),
    ]);
    assert.equal(a.report.id, b.report.id);
    const saved = await readTokenReport(pool, id, a.report.id);
    assert.equal(saved.checks.length, 13);
    assert.equal(saved.verdict, 'checking');
    assert.equal(
      (
        await pool.query(
          'SELECT used FROM secondlook_token_usage WHERE account_id=$1',
          [id],
        )
      ).rows[0].used,
      1,
    );
    await assert.rejects(
      readTokenReport(pool, await owner(), saved.id),
      code('TOKEN_REPORT_NOT_FOUND'),
    );
  },
);
void dbtest(
  'eleventh card exact charge has balanced hold/capture and replay survives gate disabled',
  async () => {
    const id = await owner(10);
    const { quote } = await quoteTokenCheck(
      pool,
      id,
      { mint, mode: 'standard', idempotencyKey: randomUUID() },
      config,
    );
    assert.equal(quote.maximumUsd6, '20000');
    await assert.rejects(
      approveTokenCheck(
        pool,
        id,
        { quoteId: quote.id, approvedMaximumUsd6: '0' },
        { config },
      ),
      code('TOKEN_PRICE_MISMATCH'),
    );
    const result = await approveTokenCheck(
      pool,
      id,
      { quoteId: quote.id, approvedMaximumUsd6: '20000' },
      { config, providers: providers().client },
    );
    assert.equal(result.report.billing.state, 'captured');
    assert.equal(
      (
        await pool.query(
          "SELECT balance_usd6 FROM ledger_accounts WHERE owner_id=$1 AND kind='available'",
          [id],
        )
      ).rows[0].balance_usd6,
      '980000',
    );
    const replay = await approveTokenCheck(
      pool,
      id,
      { quoteId: quote.id, approvedMaximumUsd6: '20000' },
      { config: { ...config, enabled: false } },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.report.id, result.report.id);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM ledger_transactions WHERE reference LIKE $1',
          [`secondlook:${result.report.id}:%`],
        )
      ).rows[0].n,
      2,
    );
  },
);
void dbtest(
  'provider failure releases full paid reservation without exposing upstream details',
  async () => {
    const id = await owner(10),
      other = key(40);
    const { quote } = await quoteTokenCheck(
      pool,
      id,
      { mint: other, mode: 'standard', idempotencyKey: randomUUID() },
      config,
    );
    const result = await approveTokenCheck(
      pool,
      id,
      { quoteId: quote.id, approvedMaximumUsd6: '20000' },
      { config, providers: providers({ fail: true }).client },
    );
    assert.equal(result.report.billing.state, 'released');
    assert.equal(result.report.billing.actualUsd6, '0');
    assert.ok(!JSON.stringify(result).includes('private upstream'));
  },
);
void dbtest(
  'deep cannot quote without ready evidence; ready indexed/Concur artifact is bound and charged once',
  async () => {
    const id = await owner(),
      deepMint = bs58.encode(randomBytes(32)),
      deepConfig = {
        ...config,
        evidence: true,
        simulation: true,
        claims: true,
        deep: true,
      };
    await assert.rejects(
      quoteTokenCheck(
        pool,
        id,
        { mint: deepMint, mode: 'deep', idempotencyKey: randomUUID() },
        deepConfig,
      ),
      code('TOKEN_DEEP_UNAVAILABLE'),
    );
    const artifact = await evidence(true);
    artifact.mint = deepMint;
    await installTokenEvidence(pool, artifact, deepMint);
    const { quote } = await quoteTokenCheck(
      pool,
      id,
      { mint: deepMint, mode: 'deep', idempotencyKey: randomUUID() },
      deepConfig,
    );
    assert.equal(quote.maximumUsd6, '100000');
    const r = await approveTokenCheck(
      pool,
      id,
      { quoteId: quote.id, approvedMaximumUsd6: '100000' },
      { config: deepConfig, providers: providers().client },
    );
    assert.equal(r.report.deep.status, 'complete');
    assert.equal(r.report.deep.claims[0].outcome, 'HOLDS');
    assert.equal(r.report.verdict, 'withheld');
    assert.equal(r.report.billing.actualUsd6, '100000');
  },
);
void dbtest(
  'shared account free quota races and global budget are atomic',
  async () => {
    const id = await owner(9),
      day = new Date().toISOString().slice(0, 10);
    const consume = () =>
      transaction(pool, async (db) => {
        await db.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [id]);
        await consumeFreeTokenQuota(db, id, day, 100000);
      });
    const result = await Promise.allSettled([consume(), consume()]);
    assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
    await assert.rejects(
      transaction(pool, (db) => consumeAnonymousTokenBudget(db, day, 0)),
      code('TOKEN_FREE_BUDGET_EXHAUSTED'),
    );
  },
);
void dbtest(
  'quote idempotency rejects changed mint and expires at actual approval clock',
  async () => {
    const id = await owner(),
      idempotencyKey = randomUUID();
    await quoteTokenCheck(
      pool,
      id,
      { mint, mode: 'standard', idempotencyKey },
      config,
    );
    await assert.rejects(
      quoteTokenCheck(
        pool,
        id,
        { mint: key(41), mode: 'standard', idempotencyKey },
        config,
      ),
      code('IDEMPOTENCY_CONFLICT'),
    );
    const qid = randomUUID();
    await pool.query(
      "INSERT INTO secondlook_token_quotes(id,account_id,mint,mode,idempotency_key,maximum_usd6,quota_day,created_at,expires_at) VALUES($1,$2,$3,'standard',$4,0,current_date,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')",
      [qid, id, mint, randomUUID()],
    );
    await assert.rejects(
      approveTokenCheck(
        pool,
        id,
        { quoteId: qid, approvedMaximumUsd6: '0' },
        { config },
      ),
      code('TOKEN_QUOTE_EXPIRED'),
    );
  },
);

void test('Metaplex metadata binds canonical mint PDA and exact mutable flag', () => {
  const text = (s) => {
    const b = Buffer.from(s);
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length);
    return Buffer.concat([h, b]);
  };
  const bytes = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(bs58.decode(key(11))),
    Buffer.from(bs58.decode(mint)),
    text('Fixture'),
    text('FIX'),
    text('https://metadata.example/token'),
    Buffer.from([0, 0, 0, 0, 1]),
  ]);
  const row = account(bytes, 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
  const check = decodeMetaplex(row, mint);
  assert.equal(
    check.facts.find((f) => f.key === 'metadataMutable').value,
    true,
  );
  assert.equal(
    check.facts.find((f) => f.key === 'uriHost').value,
    'metadata.example',
  );
  assert.notEqual(metadataAddress(mint), mint);
  assert.throws(() => decodeMetaplex(row, key(29)));
  bytes[bytes.length - 1] = 3;
  assert.throws(() =>
    decodeMetaplex(
      account(bytes, 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
      mint,
    ),
  );
});
void test('provider cancellation bounds a stalled body and cancels its reader', async () => {
  let cancelled = false;
  const signal = new AbortController();
  const client = createTokenProviders(
    config,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const pending = client.mint(mint, signal.signal);
  setTimeout(() => signal.abort(), 5);
  await assert.rejects(pending, code('TOKEN_SOURCE_UNAVAILABLE'));
  assert.equal(cancelled, true);
});
void dbtest(
  'owned report history recovers lost report identifiers and does not return another account',
  async () => {
    const id = await owner(),
      other = await owner();
    const q = await quoteTokenCheck(
      pool,
      id,
      { mint, mode: 'standard', idempotencyKey: randomUUID() },
      config,
    );
    const saved = await approveTokenCheck(
      pool,
      id,
      { quoteId: q.quote.id, approvedMaximumUsd6: '0' },
      { config, providers: providers().client },
    );
    const list = await listTokenReports(pool, id);
    assert.equal(list.reports[0].id, saved.report.id);
    assert.equal((await listTokenReports(pool, other)).reports.length, 0);
    await assert.rejects(
      listTokenReports(pool, id, 'malformed'),
      code('TOKEN_CURSOR_INVALID'),
    );
  },
);
void dbtest(
  'expired pending reservation releases exactly once on read and remains recoverable',
  async () => {
    const id = await owner(10),
      qid = randomUUID(),
      rid = randomUUID(),
      lease = randomUUID();
    const at = new Date(Date.now() - 120000).toISOString();
    const doc = {
      id: rid,
      mint,
      cluster: 'mainnet-beta',
      ruleset: 'bfb-1',
      mode: 'standard',
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
      state: 'pending',
      checks: blankChecks(),
      verdict: 'checking',
      reasons: [],
      limitations: [],
      calibration: {
        status: 'missing',
        version: null,
        evidenceUrl: null,
        ageBand: 'unknown',
        baseRate: null,
      },
      deep: null,
      cached: false,
      billing: { maximumUsd6: '20000', actualUsd6: null, state: 'held' },
    };
    await transaction(pool, async (db) => {
      const available = await ledgerAccount(db, id, 'available'),
        reserved = await ledgerAccount(db, id, 'reserved');
      await post(db, `secondlook:${rid}:hold`, 'hold', [
        { id: available.id, amount: -20000n },
        { id: reserved.id, amount: 20000n },
      ]);
      await db.query(
        "INSERT INTO secondlook_token_quotes(id,account_id,mint,mode,idempotency_key,maximum_usd6,quota_day,created_at,expires_at) VALUES($1,$2,$3,'standard',$4,20000,current_date,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')",
        [qid, id, mint, randomUUID()],
      );
      await db.query(
        "INSERT INTO secondlook_token_reports(id,account_id,quote_id,state,billing_state,maximum_usd6,actual_usd6,document,lease_id,lease_expires_at) VALUES($1,$2,$3,'pending','held',20000,NULL,$4,$5,clock_timestamp()-interval '1 minute')",
        [rid, id, qid, JSON.stringify(doc), lease],
      );
    });
    assert.equal(
      (await readTokenReport(pool, id, rid)).billing.state,
      'released',
    );
    assert.equal(
      (await readTokenReport(pool, id, rid)).billing.actualUsd6,
      '0',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM ledger_transactions WHERE reference=$1',
          [`secondlook:${rid}:release`],
        )
      ).rows[0].n,
      1,
    );
  },
);

void dbtest(
  'fresh Deep lost response keeps hold, recovers by GET, and captures exactly once without resubmission',
  async () => {
    const id = await owner(),
      freshMint = bs58.encode(randomBytes(32));
    const deepConfig = {
      ...config,
      evidence: true,
      simulation: true,
      claims: true,
      deep: true,
    };
    const artifact = await evidence(true, freshMint);
    delete artifact.deep.claimReview;
    await installTokenEvidence(pool, artifact, freshMint);
    const endpoint = 'https://claims.example/v1/token-claims';
    const originalFlag = process.env.CONCLAVE_SECOND_LOOK_CLAIMS_ENABLED;
    const originalUrl = process.env.CONCLAVE_SECOND_LOOK_CLAIMS_PRODUCER_URL;
    let posts = 0,
      gets = 0,
      accepted;
    let terminal = false;
    const producer = {
      endpoint,
      fetch: async (url, init) => {
        if (init.method === 'POST') {
          posts++;
          accepted = JSON.parse(init.body);
          throw new Error('synthetic response loss');
        }
        gets++;
        assert.equal(url, `${endpoint}/${accepted.requestId}`);
        const binding = {
          version: 1,
          requestId: accepted.requestId,
          mint: freshMint,
          maximumUsd6: '100000',
          cluster: 'mainnet-beta',
        };
        if (!terminal) return Response.json({ ...binding, state: 'running' });
        const fresh = await evidence(true, freshMint);
        return Response.json({
          ...binding,
          state: 'completed',
          definitive: true,
          chargedUsd6: '80000',
          completedAt: new Date().toISOString(),
          claimReview: fresh.deep.claimReview,
        });
      },
    };
    try {
      process.env.CONCLAVE_SECOND_LOOK_CLAIMS_ENABLED = 'true';
      process.env.CONCLAVE_SECOND_LOOK_CLAIMS_PRODUCER_URL = endpoint;
      const { quote } = await quoteTokenCheck(
        pool,
        id,
        { mint: freshMint, mode: 'deep', idempotencyKey: randomUUID() },
        deepConfig,
      );
      const input = { quoteId: quote.id, approvedMaximumUsd6: '100000' };
      let budgetReads = 0;
      const result = await approveTokenCheck(pool, id, input, {
        config: deepConfig,
        providers: providers().client,
        producer,
        beforeRead: async () => {
          budgetReads++;
        },
      });
      assert.equal(result.report.state, 'pending');
      assert.equal(result.report.billing.state, 'held');
      assert.equal(result.report.billing.reconciliationPending, true);
      assert.equal(JSON.stringify(result).includes('_producer'), false);
      assert.equal(posts, 1);
      assert.equal(budgetReads, 1);
      const repeated = await approveTokenCheck(pool, id, input, {
        config: { ...deepConfig, enabled: false },
        producer,
        beforeRead: async () => {
          throw new Error('replay must not reserve new source budget');
        },
      });
      assert.equal(repeated.replayed, true);
      assert.equal(repeated.report.billing.state, 'held');
      assert.equal(posts, 1);
      assert.equal(gets, 1);
      terminal = true;
      const recovered = await readTokenReport(pool, id, result.report.id, {
        producer,
      });
      assert.equal(recovered.deep.status, 'complete');
      assert.equal(recovered.deep.claims[0].outcome, 'HOLDS');
      assert.equal(recovered.billing.state, 'captured');
      assert.equal(recovered.billing.actualUsd6, '100000');
      assert.equal(recovered.billing.reconciliationPending, undefined);
      await readTokenReport(pool, id, result.report.id, { producer });
      assert.equal(posts, 1);
      assert.equal(gets, 2);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM ledger_transactions WHERE reference=$1',
            [`secondlook:${result.report.id}:capture`],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      if (originalFlag === undefined)
        delete process.env.CONCLAVE_SECOND_LOOK_CLAIMS_ENABLED;
      else process.env.CONCLAVE_SECOND_LOOK_CLAIMS_ENABLED = originalFlag;
      if (originalUrl === undefined)
        delete process.env.CONCLAVE_SECOND_LOOK_CLAIMS_PRODUCER_URL;
      else process.env.CONCLAVE_SECOND_LOOK_CLAIMS_PRODUCER_URL = originalUrl;
    }
  },
);

void dbtest(
  'expired producer-marked reservation is never released by the read-only lease reconciler',
  async () => {
    const id = await owner(),
      qid = randomUUID(),
      rid = randomUUID(),
      lease = randomUUID();
    const at = new Date(Date.now() - 120000).toISOString();
    const doc = {
      id: rid,
      mint,
      cluster: 'mainnet-beta',
      ruleset: 'bfb-1',
      mode: 'deep',
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
      state: 'pending',
      checks: blankChecks(),
      verdict: 'checking',
      reasons: [],
      limitations: [],
      calibration: {
        status: 'missing',
        version: null,
        evidenceUrl: null,
        ageBand: 'unknown',
        baseRate: null,
      },
      deep: null,
      cached: false,
      billing: { maximumUsd6: '100000', actualUsd6: null, state: 'held' },
      _producer: {
        endpoint: 'https://claims.example/v1/token-claims',
        requestId: rid,
        mint,
        startedAt: at,
        evidenceId: randomUUID(),
        maximumUsd6: '100000',
      },
    };
    await transaction(pool, async (db) => {
      const available = await ledgerAccount(db, id, 'available'),
        reserved = await ledgerAccount(db, id, 'reserved');
      await post(db, `secondlook:${rid}:hold`, 'hold', [
        { id: available.id, amount: -100000n },
        { id: reserved.id, amount: 100000n },
      ]);
      await db.query(
        "INSERT INTO secondlook_token_quotes(id,account_id,mint,mode,idempotency_key,maximum_usd6,quota_day,created_at,expires_at) VALUES($1,$2,$3,'deep',$4,100000,current_date,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')",
        [qid, id, mint, randomUUID()],
      );
      await db.query(
        "INSERT INTO secondlook_token_reports(id,account_id,quote_id,state,billing_state,maximum_usd6,actual_usd6,document,lease_id,lease_expires_at) VALUES($1,$2,$3,'pending','held',100000,NULL,$4,$5,clock_timestamp()-interval '1 minute')",
        [rid, id, qid, JSON.stringify(doc), lease],
      );
    });
    for (let i = 0; i < 2; i++) {
      const report = await readTokenReport(pool, id, rid, { producer: null });
      assert.equal(report.billing.state, 'held');
      assert.equal(report.billing.reconciliationPending, true);
      assert.equal(report.state, 'pending');
    }
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM ledger_transactions WHERE reference=$1',
          [`secondlook:${rid}:release`],
        )
      ).rows[0].n,
      0,
    );
  },
);

void dbtest(
  'active Steady includes standard cards after the daily ten without consuming free quota',
  async () => {
    const id = await owner(10);
    await pool.query(
      "INSERT INTO second_look_steady(account_id,active_until) VALUES($1,now()+interval '1 day')",
      [id],
    );
    for (let n = 0; n < 12; n++) {
      const { quote } = await quoteTokenCheck(
        pool,
        id,
        { mint, mode: 'standard', idempotencyKey: randomUUID() },
        config,
      );
      assert.equal(quote.maximumUsd6, '0');
      const result = await approveTokenCheck(
        pool,
        id,
        { quoteId: quote.id, approvedMaximumUsd6: '0' },
        {
          config: { ...config, freeDailyGlobalLimit: 0 },
          providers: providers().client,
        },
      );
      assert.equal(result.report.billing.actualUsd6, '0');
      assert.equal(result.report.billing.state, 'free');
    }
    assert.equal(
      (
        await pool.query(
          'SELECT used FROM secondlook_token_usage WHERE account_id=$1',
          [id],
        )
      ).rows[0].used,
      10,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT balance_usd6 FROM ledger_accounts WHERE owner_id=$1 AND kind='available'",
          [id],
        )
      ).rows[0].balance_usd6,
      '1000000',
    );
  },
);

void dbtest(
  'Steady keeps Deep checks explicitly priced and charged at 0.10 USDC',
  async () => {
    const id = await owner(10),
      deepMint = bs58.encode(randomBytes(32));
    await pool.query(
      "INSERT INTO second_look_steady(account_id,active_until) VALUES($1,now()+interval '1 day')",
      [id],
    );
    const deepConfig = {
      ...config,
      evidence: true,
      simulation: true,
      claims: true,
      deep: true,
    };
    await installTokenEvidence(pool, await evidence(true, deepMint), deepMint);
    const { quote } = await quoteTokenCheck(
      pool,
      id,
      { mint: deepMint, mode: 'deep', idempotencyKey: randomUUID() },
      deepConfig,
    );
    assert.equal(quote.maximumUsd6, '100000');
    const result = await approveTokenCheck(
      pool,
      id,
      { quoteId: quote.id, approvedMaximumUsd6: '100000' },
      { config: deepConfig, providers: providers().client },
    );
    assert.equal(result.report.billing.actualUsd6, '100000');
    assert.equal(result.report.billing.state, 'captured');
  },
);

void dbtest(
  'included quotes expire with Steady and require newly priced terms after expiry',
  async () => {
    const id = await owner(10);
    const { rows } = await pool.query(
      "INSERT INTO second_look_steady(account_id,active_until) VALUES($1,clock_timestamp()+interval '2 seconds') RETURNING active_until",
      [id],
    );
    const { quote } = await quoteTokenCheck(
      pool,
      id,
      { mint, mode: 'standard', idempotencyKey: randomUUID() },
      config,
    );
    assert.equal(quote.maximumUsd6, '0');
    assert.equal(Date.parse(quote.expiresAt), rows[0].active_until.getTime());
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, rows[0].active_until.getTime() - Date.now() + 30),
      ),
    );
    await assert.rejects(
      approveTokenCheck(
        pool,
        id,
        { quoteId: quote.id, approvedMaximumUsd6: '0' },
        { config, providers: providers().client },
      ),
      code('TOKEN_QUOTE_EXPIRED'),
    );
    const fresh = await quoteTokenCheck(
      pool,
      id,
      { mint, mode: 'standard', idempotencyKey: randomUUID() },
      config,
    );
    assert.equal(fresh.quote.maximumUsd6, '20000');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM secondlook_token_reports WHERE account_id=$1',
          [id],
        )
      ).rows[0].n,
      0,
    );
  },
);

void dbtest(
  'a paid standard quote created before purchasing Steady cannot charge stale pricing',
  async () => {
    const id = await owner(10);
    await transaction(pool, async (db) => {
      const a = await ledgerAccount(db, id, 'available'),
        c = await ledgerAccount(db, null, 'clearing');
      await post(db, `steady-token-fixture:${id}`, 'deposit', [
        { id: a.id, amount: 12000000n },
        { id: c.id, amount: -12000000n },
      ]);
    });
    const { quote } = await quoteTokenCheck(
      pool,
      id,
      { mint, mode: 'standard', idempotencyKey: randomUUID() },
      config,
    );
    assert.equal(quote.maximumUsd6, '20000');
    const { purchaseSteady } =
      await import('../server/second-look/steady-store.ts');
    const purchased = await purchaseSteady(pool, id, randomUUID(), '12000000');
    assert.equal(purchased.entitlements.plan, 'steady');
    await assert.rejects(
      approveTokenCheck(
        pool,
        id,
        { quoteId: quote.id, approvedMaximumUsd6: '20000' },
        { config, providers: providers().client },
      ),
      code('TOKEN_PRICE_MISMATCH'),
    );
    const fresh = await quoteTokenCheck(
      pool,
      id,
      { mint, mode: 'standard', idempotencyKey: randomUUID() },
      config,
    );
    assert.equal(fresh.quote.maximumUsd6, '0');
    const result = await approveTokenCheck(
      pool,
      id,
      { quoteId: fresh.quote.id, approvedMaximumUsd6: '0' },
      { config, providers: providers().client },
    );
    assert.equal(result.report.billing.actualUsd6, '0');
    assert.equal(
      (
        await pool.query(
          "SELECT balance_usd6 FROM ledger_accounts WHERE owner_id=$1 AND kind='available'",
          [id],
        )
      ).rows[0].balance_usd6,
      '1000000',
    );
  },
);
