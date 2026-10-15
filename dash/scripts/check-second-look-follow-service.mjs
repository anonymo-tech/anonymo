import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from './migrate.mjs';
import bs58 from 'bs58';
import { normalizeFollowLedger } from '../server/second-look/follow-ledger.ts';
import {
  parseFollowGraph,
  calculateFollowGraph,
} from '../server/second-look/follow-graph.ts';
import { calculateWhyMoved } from '../server/second-look/why-metrics.ts';
import { paidOrderEvents } from '../server/second-look/why-routes.ts';
import {
  followQuietNow,
  addFollowTrader,
  listFollowTraders,
  getFollowCheck,
  editFollowTrader,
  deleteFollowTrader,
  getFollowTrader,
} from '../server/second-look/follow-store.ts';
import { runFollowIngestOnce } from '../server/second-look/follow-ingest.ts';
import { followRoutes } from '../server/second-look/follow-routes.ts';
import { createDatabase } from '../server/db/database.ts';
import {
  followCheck,
  followList,
  followTraderResponse,
} from '../lib/client/follow-contracts.ts';
import { whyMovedReport } from '../lib/client/why-contracts.ts';
import { DEFAULT_FOLLOW_PREFERENCES } from '../lib/second-look/follow.ts';
import { USDC_MINT } from '../server/second-look/trade-parser.ts';
import { TOKEN_PROGRAM } from '../server/solana/validation.ts';
import { listSecondLookAlerts } from '../server/second-look/alerts-store.ts';
import {
  configuredKeyring,
  sealWallet,
} from '../server/second-look/wallet-crypto.ts';
const key = (n) => bs58.encode(new Uint8Array(32).fill(n)),
  sig = (n) => bs58.encode(new Uint8Array(64).fill(n));
const wallet = key(1),
  mint = key(2),
  asOf = '2026-10-12T12:00:00.000Z',
  end = Date.parse(asOf),
  at = (n) => new Date(end - 3600000 + n * 1000).toISOString();
const price = (m, t) => ({
  mint: m,
  at: t,
  priceUsd: '1',
  estimated: false,
  lastTradeAt: t,
  liquidityUsd: '1000',
  source: 'reviewed-fixture',
});
function trade(n, side, usd = '100000000') {
  return {
    signature: sig(n),
    slot: String(n),
    transactionIndex: 0,
    timestamp: at(n),
    wallet,
    feePayer: wallet,
    signer: true,
    failed: false,
    deltas: [
      {
        mint,
        decimals: 0,
        amount: side === 'buy' ? '10' : '-10',
        kind: 'swap',
        counterparty: null,
      },
      {
        mint: USDC_MINT,
        decimals: 6,
        amount: side === 'buy' ? `-${usd}` : usd,
        kind: 'swap',
        counterparty: null,
      },
    ],
    fees: [
      { mint: USDC_MINT, decimals: 6, amount: '1000000', kind: 'platform' },
    ],
    rentLamports: '0',
    warnings: [],
  };
}
const coverage = {
  sourceId: 'archive-fixture',
  snapshotId: 'snapshot',
  wallet,
  genesisHash: 'fixture',
  asOf,
  asOfSlot: '999',
  startsAtGenesis: true,
  includesClosedTokenAccounts: true,
  includesDelegatedTransfers: true,
  holdingsIncludeRentReserves: true,
  feePolicyId: 'reviewed',
  transactionCount: 2,
  holdings: [],
};
test('ledger adapter prices the quote leg exactly and allocates fees once', () => {
  const trades = [trade(1, 'buy'), trade(2, 'sell', '120000000')],
    historical = Object.fromEntries(
      trades.map((t) => [
        `${USDC_MINT}:${t.timestamp}`,
        price(USDC_MINT, t.timestamp),
      ]),
    );
  const r = normalizeFollowLedger({
    wallet,
    asOf,
    trades,
    prices: { historical, current: {}, opening: {} },
    coverage,
  });
  assert.equal(r.metrics.realizedPnlUsd6.value, '18000000');
  assert.equal(r.events.length, 2);
  assert.equal(r.metrics.sample.complete, true);
});
test('inferred swaps and missing price history remain explicitly incomplete', () => {
  const t = trade(1, 'buy');
  t.warnings = ['BALANCE_DELTA_SWAP_INFERRED'];
  const r = normalizeFollowLedger({
    wallet,
    asOf,
    trades: [t],
    prices: { historical: {}, current: {}, opening: {} },
    coverage: null,
  });
  assert.equal(r.metrics.realizedPnlUsd6.status, 'unavailable');
  assert.equal(r.events[0].quoteUsd6, null);
  assert.ok(r.limitations.includes('BALANCE_DELTA_SWAP_INFERRED'));
});
test('archive proof must match wallet, closed-account coverage, transaction boundaries and ending inventory', () => {
  const trades = [trade(1, 'buy'), trade(2, 'sell', '120000000')];
  const prices = {
    historical: Object.fromEntries(
      trades.map((t) => [
        `${USDC_MINT}:${t.timestamp}`,
        price(USDC_MINT, t.timestamp),
      ]),
    ),
    opening: {},
    current: {},
  };
  for (const bad of [
    { wallet: key(9) },
    { includesClosedTokenAccounts: false },
    { includesDelegatedTransfers: false },
    { asOfSlot: '1' },
    { holdings: [{ mint, decimals: 0, amount: '5' }] },
  ]) {
    const r = normalizeFollowLedger({
      wallet,
      asOf,
      trades,
      prices,
      coverage: { ...coverage, ...bad },
    });
    assert.equal(r.metrics.sample.complete, false);
    assert.equal(r.metrics.realizedPnlUsd6.status, 'unavailable');
    assert.ok(r.limitations.includes('ARCHIVE_INVENTORY_NOT_RECONCILED'));
  }
});
test('pre-window history builds exact opening average cost and original first buy', () => {
  const buy = trade(1, 'buy');
  buy.timestamp = new Date(end - 100 * 86400000).toISOString();
  const sell = trade(2, 'sell', '120000000');
  const historical = Object.fromEntries(
    [buy, sell].map((t) => [
      `${USDC_MINT}:${t.timestamp}`,
      price(USDC_MINT, t.timestamp),
    ]),
  );
  const r = normalizeFollowLedger({
    wallet,
    asOf,
    trades: [buy, sell],
    prices: { historical, current: {}, opening: {} },
    coverage,
  });
  assert.equal(r.input.openingPositions[0].basisUsd6, '101000000');
  assert.equal(r.metrics.realizedPnlUsd6.value, '18000000');
  assert.equal(r.metrics.roundTrips[0].openedAt, buy.timestamp);
});
test('quiet hours honor timezone, overnight intervals and mute without changing money', () => {
  const p = {
    muted: false,
    quietHours: {
      enabled: true,
      start: '22:00',
      end: '08:00',
      timezone: 'America/New_York',
    },
  };
  assert.equal(followQuietNow(p, new Date('2026-10-12T03:00:00Z')), true);
  assert.equal(followQuietNow(p, new Date('2026-10-12T16:00:00Z')), false);
  assert.equal(followQuietNow({ ...p, muted: true }, new Date(asOf)), true);
});
const followers = [key(20), key(21), key(22)];
function graph() {
  return {
    sourceId: 'reviewed-index',
    evidenceId: 'evidence-1',
    wallet,
    from: new Date(end - 90 * 86400000).toISOString(),
    through: asOf,
    finalized: true,
    wholeChain: true,
    fundingComplete: true,
    funding: [],
    sameSlotCoBuys: [],
    candidates: followers.map((w) => ({
      wallet: w,
      classification: 'wallet',
      distinctMintsAfter: [key(30), key(31), key(32), key(33), key(34)],
      afterBuys: 5,
      beforeBuys: 1,
      opportunityWindows: 10,
      baseBuyWindows: 1,
      baseWindows: 20,
      agePopularityMatched: true,
      proofIds: ['cooccurrence-1'],
    })),
    bursts: [
      {
        id: 'burst-1',
        mint,
        from: new Date(end - 600000).toISOString(),
        through: asOf,
        newBuyers: [
          ...followers,
          ...Array.from({ length: 7 }, (_, i) => key(40 + i)),
        ],
        ageLiquidityMatched: true,
        baselineMedianNewBuyers: 3,
        peakPositionAtoms: '100',
        recipientWallets: [],
        recipientTransfersVerified: true,
        sells: [
          {
            id: 'sale-1',
            wallet,
            amountAtoms: '25',
            quoteUsd6: '25000000',
            signature: sig(10),
          },
        ],
        fomoBuyers: [followers[0]],
        proofIds: ['burst-proof'],
      },
    ],
    totalTraderSideSellUsd6: '100000000',
    firstActivityAt: new Date(end - 100 * 86400000).toISOString(),
  };
}
test('follower lift, directional co-buys and matched bursts produce exact exit share', () => {
  const e = parseFollowGraph(graph(), wallet, 'reviewed-index', asOf),
    r = calculateFollowGraph(e);
  assert.equal(r.followerCount, 3);
  assert.equal(r.exitIntoFollowersBps, 2500);
  assert.equal(r.bursts[0].qualifies, true);
  assert.equal(r.bursts[0].fomoBuyerShareBps, 1000);
});
test('popular-token coincidences and reverse-direction trading do not become followers', () => {
  const e = graph();
  e.candidates[0].baseBuyWindows = 10;
  e.candidates[1].beforeBuys = 2;
  e.candidates[2].classification = 'bot';
  const r = calculateFollowGraph(
    parseFollowGraph(e, wallet, 'reviewed-index', asOf),
  );
  assert.equal(r.followerCount, 0);
  assert.equal(r.exitIntoFollowersBps, 0);
});
test('funding graph stops at shared hubs and labels relationships without merging records', () => {
  const e = graph(),
    funder = key(80);
  e.funding = [wallet, followers[0]].map((target) => ({
    source: funder,
    target,
    at: at(1),
    firstInflow: true,
    sourceClass: 'wallet',
    sourceDailyRecipients: 2,
    signature: sig(20),
  }));
  let r = calculateFollowGraph(
    parseFollowGraph(e, wallet, 'reviewed-index', asOf),
  );
  assert.deepEqual(r.possiblyLinkedWallets, [followers[0]]);
  assert.equal(r.followerCount, 2);
  e.funding = e.funding.map((f) => ({ ...f, sourceDailyRecipients: 51 }));
  r = calculateFollowGraph(parseFollowGraph(e, wallet, 'reviewed-index', asOf));
  assert.deepEqual(r.possiblyLinkedWallets, []);
});
test('overlapping bursts do not double count the same sell and fake denominator conflicts fail closed', () => {
  const e = graph();
  e.bursts.push({ ...e.bursts[0], id: 'burst-2' });
  assert.equal(
    calculateFollowGraph(parseFollowGraph(e, wallet, 'reviewed-index', asOf))
      .exitIntoFollowersBps,
    2500,
  );
  e.totalTraderSideSellUsd6 = '1';
  assert.equal(
    calculateFollowGraph(parseFollowGraph(e, wallet, 'reviewed-index', asOf))
      .status,
    'unavailable',
  );
});
test('conflicting sell evidence and duplicated candidates cannot inflate follower or exit metrics', () => {
  const e = graph();
  e.bursts.push({
    ...e.bursts[0],
    id: 'burst-2',
    sells: [{ ...e.bursts[0].sells[0], amountAtoms: '50' }],
  });
  assert.equal(
    calculateFollowGraph(parseFollowGraph(e, wallet, 'reviewed-index', asOf))
      .status,
    'unavailable',
  );
  const duplicate = graph();
  duplicate.bursts[0].sells.push(duplicate.bursts[0].sells[0]);
  assert.equal(
    calculateFollowGraph(
      parseFollowGraph(duplicate, wallet, 'reviewed-index', asOf),
    ).status,
    'unavailable',
  );
  const c = graph();
  c.candidates.push(c.candidates[0]);
  assert.equal(
    calculateFollowGraph(parseFollowGraph(c, wallet, 'reviewed-index', asOf))
      .status,
    'unavailable',
  );
});
test('graph claims require full reviewed coverage, timestamps and source binding', () => {
  for (const patch of [
    { wholeChain: false },
    { fundingComplete: false },
    { sourceId: 'other' },
    { through: new Date(end - 600000).toISOString() },
  ])
    assert.throws(() =>
      parseFollowGraph(
        { ...graph(), ...patch },
        wallet,
        'reviewed-index',
        asOf,
      ),
    );
  const e = graph();
  e.candidates[0].afterBuys = 1;
  assert.throws(() => parseFollowGraph(e, wallet, 'reviewed-index', asOf));
});
function why() {
  return {
    mint,
    window: '1h',
    asOf,
    coverage: {
      sourceId: 'reviewed-index',
      snapshotId: 'flow-1',
      from: new Date(end - 3600000).toISOString(),
      through: asOf,
      wholeMarket: true,
      classificationsReviewed: true,
    },
    trades: [
      {
        id: 'buy-1',
        wallet,
        signature: sig(1),
        at: at(1),
        side: 'buy',
        quoteUsd6: '9007199254740993',
        classes: ['bundle_insider'],
        classificationProofIds: ['cluster-proof'],
      },
      {
        id: 'sell-1',
        wallet,
        signature: sig(2),
        at: at(2),
        side: 'sell',
        quoteUsd6: '9007199254740990',
        classes: ['bundle_insider'],
        classificationProofIds: ['cluster-proof'],
      },
      {
        id: 'buy-2',
        wallet: key(3),
        signature: sig(3),
        at: at(3),
        side: 'buy',
        quoteUsd6: '1',
        classes: [],
        classificationProofIds: [],
      },
    ],
    events: [],
  };
}
test('Why It Moved conserves exact signed net flows without double counting classes', () => {
  const r = calculateWhyMoved(why());
  assert.equal(r.status, 'ready');
  assert.equal(
    r.flows.reduce((n, f) => n + BigInt(f.netUsd6), 0n),
    4n,
  );
  assert.equal(r.largestDriver, 'bundle_insider');
  assert.equal(r.flows[0].shareOfPositiveNetBps, 7500);
  assert.ok(whyMovedReport(r));
});
test('partial wallet samples never receive whole-market driver labels or shares', () => {
  const r = calculateWhyMoved({ ...why(), coverage: null });
  assert.equal(r.status, 'partial');
  assert.equal(r.flows[0].kind, 'unclassified');
  assert.equal(r.largestDriver, null);
  assert.equal(r.flows[0].shareOfPositiveNetBps, null);
});
test('missing prices suppress causal ranking even for otherwise complete trade coverage', () => {
  const input = why();
  input.trades[0].quoteUsd6 = null;
  const r = calculateWhyMoved(input);
  assert.equal(r.largestDriver, null);
  assert.equal(r.status, 'partial');
  assert.ok(r.flows.every((f) => f.shareOfPositiveNetBps === null));
});
test('unpriced observed trades remain visible without invented zero flows or classification proof', () => {
  const input = { ...why(), coverage: null };
  input.trades.forEach((t) => (t.quoteUsd6 = null));
  let r = calculateWhyMoved(input);
  assert.equal(r.status, 'partial');
  assert.equal(r.flows.length, 0);
  assert.equal(r.evidence.observedTrades, 3);
  assert.equal(r.evidence.unpricedTrades, 3);
  assert.equal(r.evidence.buys, 2);
  assert.equal(r.evidence.scope, 'tracked_wallets');
  assert.ok(whyMovedReport(r));
  const incomplete = why();
  incomplete.trades[0].classificationProofIds = [];
  r = calculateWhyMoved(incomplete);
  assert.equal(r.largestDriver, null);
  assert.equal(r.status, 'partial');
});
test('auto windows detect an actual 50 percent move, not a fabricated chart window', () => {
  const input = {
    ...why(),
    window: 'auto',
    pricesComplete: true,
    prices: [
      { at: at(1), priceUsd: '0.00000001' },
      { at: at(2), priceUsd: '0.000000015' },
    ],
  };
  let r = calculateWhyMoved(input);
  assert.equal(r.window.autoDetected, true);
  assert.equal(r.window.from, at(1));
  r = calculateWhyMoved({ ...input, pricesComplete: false });
  assert.equal(r.window.autoDetected, false);
  assert.ok(r.limitations.includes('AUTO_MOVE_HISTORY_UNAVAILABLE'));
});
test('news requires an exact quote in stored source text and never re-labels orders as catalysts', () => {
  const input = why();
  input.events = [
    {
      id: 'news-1',
      kind: 'news',
      at: at(1),
      title: 'Listing announced',
      sourceUrl: 'https://example.test/news',
      signature: null,
      quote: 'listing date',
      sourceText: 'The listing date is today.',
      upstreamInternal: { credential: 'must-never-echo' },
    },
    {
      id: 'news-2',
      kind: 'news',
      at: at(2),
      title: 'Unverified claim',
      sourceUrl: 'https://example.test/other',
      signature: null,
      quote: 'invented quote',
      sourceText: 'Nothing of the kind.',
    },
  ];
  const r = calculateWhyMoved(input);
  assert.equal(r.events.length, 1);
  assert.equal(Object.hasOwn(r.events[0], 'sourceText'), false);
  assert.equal(Object.hasOwn(r.events[0], 'upstreamInternal'), false);
  assert.equal(JSON.stringify(r).includes('must-never-echo'), false);
  assert.deepEqual(Object.keys(r.events[0]).sort(), [
    'at',
    'id',
    'kind',
    'quote',
    'signature',
    'sourceUrl',
    'title',
  ]);
  assert.ok(r.limitations.includes('NEWS_QUOTE_UNVERIFIED'));
  const orders = paidOrderEvents(
    [
      {
        type: 'tokenProfile',
        status: 'approved',
        paymentTimestamp: Date.parse(at(1)),
      },
      {
        type: 'tokenAd',
        status: 'pending',
        paymentTimestamp: Date.parse(at(2)),
      },
    ],
    mint,
  );
  assert.equal(orders.length, 1);
  assert.match(orders[0].title, /order recorded/);
});
test('UI contracts reject negative rates, missing reason fields and unsafe source URLs', () => {
  const r = calculateWhyMoved(why());
  assert.equal(
    whyMovedReport({
      ...r,
      events: [
        {
          id: 'x',
          kind: 'news',
          at: asOf,
          title: 'x',
          sourceUrl: 'javascript:alert(1)',
          signature: null,
          quote: 'x',
        },
      ],
    }),
    false,
  );
  assert.equal(
    followList({ traders: [], limit: 99, plan: 'free', configured: true }),
    false,
  );
});
const databaseUrl = process.env.CONCLAVE_TEST_DATABASE_URL;
await test(
  'encrypted Follow CRUD, 3/25 limits, ownership, ingestion, deduplication and source-grounded APIs',
  { skip: !databaseUrl },
  async () => {
    const u = new URL(databaseUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
        u.pathname.endsWith('_test'),
    );
    process.env.CONCLAVE_ACTIVE_DATA_KEY = 'follow-fixture';
    process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
      'follow-fixture': Buffer.alloc(32, 61).toString('base64'),
    });
    const pool = createDatabase(databaseUrl, 6),
      account = randomUUID(),
      other = randomUUID();
    try {
      await migrate(pool);
      await pool.query('INSERT INTO accounts(id) VALUES($1),($2)', [
        account,
        other,
      ]);
      const trader = await addFollowTrader(
        pool,
        account,
        wallet,
        'Private test label',
      );
      assert.ok(followTraderResponse({ trader }));
      assert.equal(
        (await addFollowTrader(pool, account, wallet, 'Duplicate')).id,
        trader.id,
      );
      await Promise.all([
        addFollowTrader(pool, account, key(3), 'Two'),
        addFollowTrader(pool, account, key(4), 'Three'),
      ]);
      await assert.rejects(
        addFollowTrader(pool, account, key(5), 'Four'),
        (e) => e.code === 'FOLLOW_LIMIT',
      );
      await assert.rejects(
        getFollowTrader(pool, other, trader.id),
        (e) => e.code === 'TRADER_NOT_FOUND',
      );
      await assert.rejects(
        deleteFollowTrader(pool, other, trader.id),
        (e) => e.code === 'TRADER_NOT_FOUND',
      );
      assert.ok(followList(await listFollowTraders(pool, account)));
      assert.ok(followCheck(await getFollowCheck(pool, account, trader.id)));
      // A complete snapshot is useful between polls but never certifies later or future history.
      for (const cutoff of [
        asOf,
        new Date(end + 11000).toISOString(),
        new Date(end - 300000).toISOString(),
      ]) {
        await pool.query(
          'UPDATE second_look_follow_jobs SET coverage_ciphertext=$3 WHERE account_id=$1 AND trader_id=$2',
          [
            account,
            trader.id,
            await sealWallet(
              { ...coverage, asOf: cutoff, transactionCount: 0 },
              account,
              trader.id,
              'follow-coverage',
              configuredKeyring(),
            ),
          ],
        );
        const report = await getFollowCheck(
          pool,
          account,
          trader.id,
          new Date(end + 10000),
        );
        const fresh = cutoff === asOf;
        assert.equal(
          report.asOf,
          fresh ? asOf : new Date(end + 10000).toISOString(),
        );
        assert.equal(report.metrics.sample.complete, fresh);
        assert.equal(
          report.limitations.includes('COVERAGE_SNAPSHOT_STALE_OR_FUTURE'),
          !fresh,
        );
      }
      await pool.query(
        'UPDATE second_look_follow_jobs SET coverage_ciphertext=NULL WHERE account_id=$1 AND trader_id=$2',
        [account, trader.id],
      );
      const stored = await pool.query(
        'SELECT payload_ciphertext FROM second_look_follow_traders WHERE id=$1',
        [trader.id],
      );
      assert.equal(stored.rows[0].payload_ciphertext.includes(wallet), false);
      assert.equal(
        stored.rows[0].payload_ciphertext.includes('Private test label'),
        false,
      );
      await editFollowTrader(pool, account, trader.id, {
        preferences: { ...DEFAULT_FOLLOW_PREFERENCES, muted: true },
      });
      assert.equal(
        (await getFollowTrader(pool, account, trader.id)).preferences.muted,
        true,
      );
      await pool.query(
        "INSERT INTO second_look_steady(account_id,active_until) VALUES($1,now()+interval '1 day')",
        [account],
      );
      await addFollowTrader(pool, account, key(5), 'Four');
      assert.equal((await listFollowTraders(pool, account)).limit, 25);
      for (let n = 6; n <= 26; n++)
        await addFollowTrader(pool, account, key(n), `Trader ${n}`);
      await assert.rejects(
        addFollowTrader(pool, account, key(27), 'Too many'),
        (e) => e.code === 'FOLLOW_LIMIT',
      );
      // Only the selected trader is due. Fixtures use canonical Solana keys and real parser shapes.
      await pool.query(
        "UPDATE second_look_follow_jobs SET next_run_at=now()+interval '1 day' WHERE account_id=$1",
        [account],
      );
      await pool.query(
        'UPDATE second_look_follow_jobs SET next_run_at=now() WHERE trader_id=$1',
        [trader.id],
      );
      const timestamp = Math.floor(Date.now() / 1000),
        signature = sig(90);
      const raw = {
        version: 0,
        slot: 500,
        blockTime: timestamp,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: wallet, signer: true, writable: true },
              { pubkey: key(90), signer: false, writable: true },
              { pubkey: key(91), signer: false, writable: true },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [2000000000, 2039280, 0],
          postBalances: [999995000, 2039280, 0],
          preTokenBalances: [
            {
              accountIndex: 1,
              owner: wallet,
              mint,
              programId: TOKEN_PROGRAM,
              uiTokenAmount: { amount: '0', decimals: 0 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              owner: wallet,
              mint,
              programId: TOKEN_PROGRAM,
              uiTokenAmount: { amount: '10', decimals: 0 },
            },
          ],
          innerInstructions: [],
        },
      };
      const config = {
        enabled: true,
        rpcUrl: 'https://rpc.example.test',
        archiveUrl: null,
        archiveSourceId: null,
        priceUrl: null,
        feePolicyId: 'reviewed',
        jitoAccounts: [],
        platformAccounts: [],
      };
      let pages = 0;
      const source = {
        kind: 'rpc',
        async page() {
          pages++;
          return {
            entries:
              pages === 1
                ? [
                    {
                      signature,
                      slot: '500',
                      timestamp: new Date(timestamp * 1000).toISOString(),
                      confirmation: 'finalized',
                      transaction: raw,
                    },
                  ]
                : [],
            nextCursor: pages === 1 ? signature : null,
            exhausted: pages > 1,
            snapshotId: null,
            coverage: null,
          };
        },
        async transaction() {
          return raw;
        },
        async statuses() {
          return { finalizedSlot: '600', values: [] };
        },
      };
      let result = await runFollowIngestOnce(pool, { config, source });
      assert.equal(result.transactions, 1);
      await pool.query(
        'UPDATE second_look_follow_jobs SET next_run_at=now() WHERE trader_id=$1',
        [trader.id],
      );
      result = await runFollowIngestOnce(pool, { config, source });
      assert.equal(result.state, 'partial');
      const check = await getFollowCheck(pool, account, trader.id);
      assert.equal(check.trader.sync.transactions, 1);
      assert.equal(check.metrics.realizedPnlUsd6.status, 'unavailable');
      assert.ok(followCheck(check));
      const own = await pool.query(
        'SELECT count(*)::int AS n FROM second_look_wallets WHERE account_id=$1',
        [account],
      );
      assert.equal(own.rows[0].n, 0);
      // Rotating the active encryption key must not duplicate signature lookup identities.
      process.env.CONCLAVE_ACTIVE_DATA_KEY = 'follow-rotated';
      process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
        'follow-fixture': Buffer.alloc(32, 61).toString('base64'),
        'follow-rotated': Buffer.alloc(32, 62).toString('base64'),
      });
      pages = 0;
      await pool.query(
        'UPDATE second_look_follow_jobs SET next_run_at=now() WHERE trader_id=$1',
        [trader.id],
      );
      await runFollowIngestOnce(pool, { config, source });
      assert.equal(
        (await getFollowCheck(pool, account, trader.id)).trader.sync
          .transactions,
        1,
      );
      // A fresh finalized sell generates exactly one encrypted notification after unmuting.
      await editFollowTrader(pool, account, trader.id, {
        preferences: DEFAULT_FOLLOW_PREFERENCES,
      });
      const sale = structuredClone(raw);
      sale.slot = 501;
      sale.blockTime = timestamp + 1;
      sale.transaction.signatures = [sig(91)];
      sale.meta.preBalances = [999995000, 2039280, 0];
      sale.meta.postBalances = [1999990000, 2039280, 0];
      sale.meta.preTokenBalances[0].uiTokenAmount.amount = '10';
      sale.meta.postTokenBalances[0].uiTokenAmount.amount = '0';
      const selling = {
        ...source,
        async page() {
          return {
            entries: [
              {
                signature: sig(91),
                slot: '501',
                timestamp: new Date((timestamp + 1) * 1000).toISOString(),
                confirmation: 'finalized',
                transaction: sale,
              },
            ],
            nextCursor: null,
            exhausted: true,
            snapshotId: null,
            coverage: null,
          };
        },
      };
      for (let i = 0; i < 2; i++) {
        await pool.query(
          'UPDATE second_look_follow_jobs SET next_run_at=now() WHERE trader_id=$1',
          [trader.id],
        );
        await runFollowIngestOnce(pool, {
          config,
          source: selling,
          now: new Date((timestamp + 2) * 1000),
        });
      }
      const notices = await listSecondLookAlerts(pool, account);
      assert.equal(notices.alerts.length, 1);
      assert.equal(notices.alerts[0].kind, 'follow_sell');
      // On expiry, saved extra traders remain private but only the first three keep ingesting.
      await pool.query(
        "UPDATE second_look_steady SET active_until=now()-interval '1 second' WHERE account_id=$1",
        [account],
      );
      const expired = await listFollowTraders(pool, account);
      assert.equal(expired.limit, 3);
      assert.ok(
        expired.traders
          .slice(3)
          .every((t) => t.sync.errorCode === 'FOLLOW_PLAN_LIMIT'),
      );
      await pool.query(
        "UPDATE second_look_follow_jobs SET next_run_at=now()+interval '1 day' WHERE account_id=$1",
        [account],
      );
      await pool.query(
        'UPDATE second_look_follow_jobs SET next_run_at=now() WHERE trader_id=$1',
        [expired.traders[3].id],
      );
      assert.equal(
        (await runFollowIngestOnce(pool, { config, source })).state,
        'idle',
      );

      const response = await followRoutes(
        pool,
        new Request(
          `https://example.test/api/second-look/follow/traders/${trader.id}/check`,
        ),
        `second-look/follow/traders/${trader.id}/check`,
        account,
      );
      assert.equal(response.status, 200);
      assert.ok(followCheck(await response.json()));
      await deleteFollowTrader(pool, account, trader.id);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM second_look_follow_transactions WHERE trader_id=$1',
            [trader.id],
          )
        ).rows[0].n,
        0,
      );
      const rls = await pool.query(
        "SELECT bool_and(relrowsecurity) AS covered FROM pg_class WHERE relname LIKE 'second_look_follow_%' AND relkind='r'",
      );
      assert.equal(rls.rows[0].covered, true);
    } finally {
      await pool.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [
        [account, other],
      ]);
      await pool.end();
    }
  },
);

test('wallet categories stay mutually exclusive across trades and proven bot flows are not top individual wallets', () => {
  const input = why();
  input.trades[1].classes = [];
  input.trades[1].classificationProofIds = [];
  input.trades.push({
    id: 'bot-buy',
    wallet: key(9),
    signature: sig(9),
    at: at(9),
    side: 'buy',
    quoteUsd6: '100',
    classes: ['bot'],
    classificationProofIds: ['bot-proof'],
  });
  const r = calculateWhyMoved(input);
  assert.equal(r.flows.find((f) => f.kind === 'bundle_insider').netUsd6, '3');
  assert.equal(r.flows.find((f) => f.kind === 'bot').netUsd6, '100');
  assert.equal(
    r.flows.reduce((n, f) => n + f.wallets, 0),
    3,
  );
});
