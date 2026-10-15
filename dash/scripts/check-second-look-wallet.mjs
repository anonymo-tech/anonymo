import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import {
  parseWalletTrade,
  SOL_MINT,
  USDC_MINT,
} from '../server/second-look/trade-parser.ts';
import {
  calculateWalletPnl,
  valueUsd6,
  priceKey,
} from '../server/second-look/pnl.ts';
import {
  createWalletSource,
  parseCoverage,
  parseWalletPrice,
  readWalletJson,
} from '../server/second-look/ingest-source.ts';
import {
  walletCapability,
  walletIngestConfig,
} from '../server/second-look/wallet-config.ts';
import {
  finalizationDecision,
  runWalletIngestOnce,
} from '../server/second-look/ingest.ts';
import {
  linkWallet,
  getWallet,
  listWallets,
  unlinkWallet,
  walletPnl,
} from '../server/second-look/wallet-store.ts';
import {
  configuredKeyring,
  openWallet,
  sealWallet,
  walletDigest,
} from '../server/second-look/wallet-crypto.ts';
import { walletRoutes } from '../server/second-look/wallet-routes.ts';
import { createDatabase } from '../server/db/database.ts';
import { handleApi } from '../server/core/http.ts';
import {
  SOLANA_NETWORKS,
  TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
} from '../server/solana/validation.ts';
process.env.CONCLAVE_ACTIVE_DATA_KEY = 'wallet-fixture';
process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
  'wallet-fixture': Buffer.alloc(32, 71).toString('base64'),
});
const key = (n) => bs58.encode(new Uint8Array(32).fill(n)),
  sig = (n) => bs58.encode(new Uint8Array(64).fill(n));
const wallet = key(1),
  other = key(2),
  mint = key(3),
  tokenAccount = key(4),
  poolAccount = key(5);
const asOf = new Date('2026-10-12T12:00:00.000Z');
const at = '2026-10-10T12:00:00.000Z';
const config = {
  enabled: true,
  rpcUrl: 'https://rpc.example.test',
  archiveUrl: null,
  archiveSourceId: null,
  priceUrl: null,
  feePolicyId: 'review-v1',
  jitoAccounts: [],
  platformAccounts: [],
};
function token(index, owner, amount, m = mint, decimals = 6) {
  return {
    accountIndex: index,
    mint: m,
    owner,
    programId: TOKEN_PROGRAM,
    uiTokenAmount: {
      amount: String(amount),
      decimals,
      uiAmount: null,
      uiAmountString: 'ignored',
    },
  };
}
function transactionFixture({
  signature = sig(1),
  slot = 10,
  fee = 5000,
  solDelta = -1000000000,
  tokenDelta = 10000000,
  instructions = [],
  failed = false,
} = {}) {
  return {
    version: 0,
    slot,
    blockTime: Math.floor(Date.parse(at) / 1000),
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: wallet, signer: true, writable: true },
          { pubkey: tokenAccount, signer: false, writable: true },
          { pubkey: other, signer: false, writable: true },
          { pubkey: poolAccount, signer: false, writable: true },
        ],
        instructions,
      },
    },
    meta: {
      err: failed ? 'InstructionError' : null,
      fee,
      preBalances: [5000000000, 2039280, 0, 2039280],
      postBalances: [5000000000 + solDelta - fee, 2039280, 0, 2039280],
      preTokenBalances: [
        token(1, wallet, 10000000),
        token(3, other, 100000000),
      ],
      postTokenBalances: [
        token(1, wallet, 10000000 + tokenDelta),
        token(3, other, 100000000 - tokenDelta),
      ],
      innerInstructions: [],
    },
  };
}
function normalized(n, deltas, extra = {}) {
  return {
    signature: sig(n),
    slot: String(n),
    transactionIndex: 0,
    timestamp: at,
    wallet,
    feePayer: wallet,
    signer: true,
    failed: false,
    deltas,
    fees: [],
    rentLamports: '0',
    warnings: [],
    ...extra,
  };
}
const delta = (
  m,
  quantity,
  kind = 'swap',
  counterparty = null,
  decimals = 6,
) => ({ mint: m, decimals, amount: String(quantity), kind, counterparty });
function price(m, usd, time = at, extra = {}) {
  return {
    mint: m,
    priceUsd: usd,
    at: time,
    lastTradeAt: time,
    liquidityUsd: '10000',
    estimated: false,
    source: 'fixture',
    ...extra,
  };
}
function coverage(trades, holdings) {
  return {
    sourceId: 'fixture',
    snapshotId: 'snapshot',
    wallet,
    genesisHash: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
    asOf: asOf.toISOString(),
    asOfSlot: '1000',
    startsAtGenesis: true,
    includesClosedTokenAccounts: true,
    includesDelegatedTransfers: true,
    feePolicyId: 'review-v1',
    transactionCount: trades.filter((t) => t.wallet === wallet).length,
    holdings,
  };
}
function pnl(
  trades,
  prices = { historical: {}, current: {}, opening: {} },
  cov = null,
  extra = {},
) {
  return calculateWalletPnl({
    walletId: randomUUID(),
    wallet,
    trades,
    prices,
    coverage: cov,
    asOf,
    ...extra,
  });
}

await test('integer valuation preserves large quantities and submicro token prices', () => {
  assert.equal(
    valueUsd6(9007199254740993000000n, 9, '0.000000123456789123'),
    1111999898981n,
  );
  assert.throws(() => valueUsd6(1n, 6, '1e-5'));
  assert.throws(() => valueUsd6(1n, 6, '-1'));
});
await test('balance delta swap separates exact network fee without trusting uiAmount', () => {
  const result = parseWalletTrade(transactionFixture(), wallet, sig(1), {
    feePolicyReviewed: true,
  });
  assert.equal(
    result.deltas.find((d) => d.mint === SOL_MINT).amount,
    '-1000000000',
  );
  assert.equal(result.deltas.find((d) => d.mint === mint).kind, 'swap');
  assert.equal(result.fees[0].amount, '5000');
  assert.equal(result.fees[1].amount, '0');
});
await test('compute limit priority fee and known native tip are separate from trade principal', () => {
  const limit = Buffer.alloc(5);
  limit[0] = 2;
  limit.writeUInt32LE(200000, 1);
  const priceBytes = Buffer.alloc(9);
  priceBytes[0] = 3;
  priceBytes.writeBigUInt64LE(1000n, 1);
  const tx = transactionFixture({
    fee: 5200,
    solDelta: -1000010000,
    instructions: [
      { programId: COMPUTE_BUDGET_PROGRAM, data: bs58.encode(limit) },
      { programId: COMPUTE_BUDGET_PROGRAM, data: bs58.encode(priceBytes) },
      {
        programId: SYSTEM_PROGRAM,
        parsed: {
          type: 'transfer',
          info: { source: wallet, destination: other, lamports: 10000 },
        },
      },
    ],
  });
  const result = parseWalletTrade(tx, wallet, sig(1), {
    jitoAccounts: [other],
    feePolicyReviewed: true,
  });
  assert.deepEqual(
    result.fees.map((f) => [f.kind, f.amount]),
    [
      ['network', '5000'],
      ['priority', '200'],
      ['jito_tip', '10000'],
    ],
  );
  assert.equal(
    result.deltas.find((d) => d.mint === SOL_MINT).amount,
    '-1000000000',
  );
});
await test('rent funded ATA creation is excluded from swap economics', () => {
  const tx = transactionFixture({
    solDelta: -1002039280,
    instructions: [
      {
        programId: SYSTEM_PROGRAM,
        parsed: {
          type: 'createAccount',
          info: { source: wallet, newAccount: tokenAccount, lamports: 2039280 },
        },
      },
    ],
  });
  tx.meta.preBalances[1] = 0;
  const result = parseWalletTrade(tx, wallet, sig(1), {
    feePolicyReviewed: true,
  });
  assert.equal(result.rentLamports, '2039280');
  assert.equal(
    result.deltas.find((d) => d.mint === SOL_MINT).amount,
    '-1000000000',
  );
});
await test('failed transactions charge fees but never invent executed asset deltas', () => {
  const result = parseWalletTrade(
    transactionFixture({ failed: true }),
    wallet,
    sig(1),
  );
  assert.equal(result.deltas.length, 0);
  assert.equal(result.fees[0].amount, '5000');
});
await test('malformed identities unsafe numeric balances and absent owners fail closed', () => {
  assert.throws(() => parseWalletTrade(transactionFixture(), wallet, sig(2)));
  const tx = transactionFixture();
  tx.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => parseWalletTrade(tx, wallet, sig(1)));
  const missing = transactionFixture();
  delete missing.meta.preTokenBalances[0].owner;
  assert.throws(() => parseWalletTrade(missing, wallet, sig(1)));
});
await test('mint distribution requires reviewed classification before zero-basis airdrop', () => {
  const tx = transactionFixture({
    fee: 0,
    solDelta: 0,
    instructions: [
      {
        programId: TOKEN_PROGRAM,
        parsed: {
          type: 'mintTo',
          info: { account: tokenAccount, mint, amount: '10000000' },
        },
      },
    ],
  });
  assert.equal(parseWalletTrade(tx, wallet, sig(1)).deltas[0].kind, 'unknown');
  assert.equal(
    parseWalletTrade(tx, wallet, sig(1), { airdropSignatures: [sig(1)] })
      .deltas[0].kind,
    'airdrop',
  );
});
await test('complete reconciled FIFO accounting is possible with reviewed history and exact prices', () => {
  const trades = [
    normalized(1, [delta(mint, 10000000, 'airdrop')]),
    normalized(2, [delta(mint, -5000000), delta(USDC_MINT, 10000000)]),
  ];
  const prices = {
    historical: { [priceKey(USDC_MINT, at)]: price(USDC_MINT, '1') },
    current: { [mint]: price(mint, '2'), [USDC_MINT]: price(USDC_MINT, '1') },
    opening: {},
  };
  const result = pnl(
    trades,
    prices,
    coverage(trades, [
      { mint, decimals: 6, amount: '5000000' },
      { mint: USDC_MINT, decimals: 6, amount: '10000000' },
    ]),
  );
  assert.equal(result.complete, true);
  assert.equal(result.realizedUsd6, '10000000');
  assert.equal(result.unrealizedChangeUsd6, '10000000');
  assert.equal(result.netUsd6, '20000000');
  const partial = pnl(trades, prices);
  assert.equal(partial.complete, false);
  assert.equal(partial.netUsd6, null);
  assert.equal(partial.observed.netUsd6, '20000000');
});
await test('reconciliation mismatch or missing basis never becomes a complete or zero PnL', () => {
  const trades = [normalized(1, [delta(mint, 10000000, 'transfer', other)])],
    prices = {
      historical: {},
      current: { [mint]: price(mint, '2') },
      opening: {},
    };
  const result = pnl(
    trades,
    prices,
    coverage(trades, [{ mint, decimals: 6, amount: '11000000' }]),
  );
  assert.equal(result.complete, false);
  assert.equal(result.positions[0].basisUsd6, null);
  assert.equal(result.observed.netUsd6, null);
  assert.ok(result.exceptions.includes('HOLDINGS_NOT_RECONCILED'));
});
await test('estimated quote basis survives into later-month disposal and cannot become verified PnL', () => {
  const prior = '2026-09-10T12:00:00.000Z';
  const trades = [
    normalized(1, [delta(USDC_MINT, 10000000, 'airdrop')], {
      timestamp: prior,
    }),
    normalized(2, [delta(USDC_MINT, -10000000), delta(mint, 10000000)], {
      timestamp: prior,
    }),
    normalized(3, [delta(mint, -10000000), delta(USDC_MINT, 20000000)]),
  ];
  const prices = {
    historical: {
      [priceKey(USDC_MINT, prior)]: {
        ...price(USDC_MINT, '1.04', prior),
        estimated: true,
      },
      [priceKey(USDC_MINT, at)]: price(USDC_MINT, '1'),
    },
    current: { [USDC_MINT]: price(USDC_MINT, '1') },
    opening: { [mint]: price(mint, '1.5', '2026-10-01T00:00:00.000Z') },
  };
  const result = pnl(
    trades,
    prices,
    coverage(trades, [{ mint: USDC_MINT, decimals: 6, amount: '20000000' }]),
  );
  assert.equal(result.complete, false);
  assert.equal(result.netUsd6, null);
  assert.ok(result.exceptions.includes('ESTIMATED_PRICE'));
});
await test('missing market evidence cannot turn a quote into a dead holding or complete PnL', () => {
  const trades = [normalized(1, [delta(mint, 10000000, 'airdrop')])];
  const prices = {
    historical: {},
    opening: {},
    current: {
      [mint]: { ...price(mint, '2'), liquidityUsd: null, lastTradeAt: null },
    },
  };
  const result = pnl(
    trades,
    prices,
    coverage(trades, [{ mint, decimals: 6, amount: '10000000' }]),
  );
  assert.equal(result.positions[0].valueUsd6, '20000000');
  assert.notEqual(result.positions[0].market, 'no_market');
  assert.equal(result.complete, false);
  assert.ok(result.exceptions.includes('MARKET_EVIDENCE_UNAVAILABLE'));
});
await test('estimated month-opening marks remain a limit after that holding is fully sold', () => {
  const prior = '2026-09-10T12:00:00.000Z';
  const trades = [
    normalized(1, [delta(mint, 10000000, 'airdrop')], { timestamp: prior }),
    normalized(2, [delta(mint, -10000000), delta(USDC_MINT, 20000000)]),
  ];
  const prices = {
    historical: { [priceKey(USDC_MINT, at)]: price(USDC_MINT, '1') },
    opening: {
      [mint]: {
        ...price(mint, '1.5', '2026-10-01T00:00:00.000Z'),
        estimated: true,
      },
    },
    current: { [USDC_MINT]: price(USDC_MINT, '1') },
  };
  const result = pnl(
    trades,
    prices,
    coverage(trades, [{ mint: USDC_MINT, decimals: 6, amount: '20000000' }]),
  );
  assert.equal(result.complete, false);
  assert.ok(result.exceptions.includes('ESTIMATED_PRICE'));
});
await test('known own-linked transfer carries FIFO lots with no sale or artificial profit', () => {
  const prior = '2026-09-10T12:00:00.000Z';
  const trades = [
    normalized(1, [delta(mint, 10000000, 'airdrop')], {
      timestamp: prior,
      wallet: other,
    }),
    normalized(2, [delta(mint, -5000000, 'transfer', wallet)], {
      wallet: other,
    }),
    normalized(2, [delta(mint, 5000000, 'transfer', other)]),
  ];
  const prices = {
    historical: { [priceKey(mint, at)]: price(mint, '2') },
    current: { [mint]: price(mint, '2') },
    opening: { [mint]: price(mint, '2', '2026-10-01T00:00:00.000Z') },
  };
  const result = pnl(trades, prices, null, { linkedWallets: [other] });
  assert.equal(result.observed.realizedUsd6, '0');
  assert.equal(result.observed.unrealizedChangeUsd6, '0');
  assert.equal(result.positions[0].basisUsd6, '0');
});
await test('no-market policy values stale or illiquid holdings at zero and flags review', () => {
  const trades = [normalized(1, [delta(mint, 10000000, 'airdrop')])];
  for (const extra of [
    { liquidityUsd: '99.999999' },
    { lastTradeAt: '2026-09-01T00:00:00.000Z' },
  ]) {
    const result = pnl(trades, {
      historical: {},
      opening: {},
      current: { [mint]: price(mint, '2', at, extra) },
    });
    assert.equal(result.positions[0].valueUsd6, '0');
    assert.equal(result.positions[0].market, 'no_market');
    assert.ok(result.exceptions.includes('NO_MARKET'));
  }
});
await test('missing fee pricing remains nullable and rent is not a fee', () => {
  const trade = normalized(1, [], {
    fees: [{ kind: 'network', mint: SOL_MINT, amount: '5000', decimals: 9 }],
    rentLamports: '2039280',
  });
  const result = pnl([trade]);
  assert.equal(result.observed.feesUsd6, null);
  assert.equal(result.fees.networkUsd6, null);
  assert.equal(result.rentExcludedLamports, '2039280');
});
await test('strict source attestations reject wrong wallet network count and missing coverage', () => {
  const cov = { ...coverage([], []), holdingsIncludeRentReserves: true };
  assert.equal(
    parseCoverage(cov, wallet, 'fixture', 'snapshot', 'review-v1')
      .transactionCount,
    0,
  );
  for (const patch of [
    { wallet: other },
    { genesisHash: key(8) },
    { startsAtGenesis: false },
    { transactionCount: -1 },
    { holdingsIncludeRentReserves: false },
  ])
    assert.throws(() =>
      parseCoverage(
        { ...cov, ...patch },
        wallet,
        'fixture',
        'snapshot',
        'review-v1',
      ),
    );
});
await test('price records must bind requested mint and time and use exact decimals', () => {
  assert.equal(
    parseWalletPrice(price(mint, '0.000000000000001'), mint, at).priceUsd,
    '0.000000000000001',
  );
  assert.throws(() => parseWalletPrice(price(other, '1'), mint, at));
  assert.throws(() => parseWalletPrice(price(mint, '1e3'), mint, at));
  assert.throws(() =>
    parseWalletPrice(price(mint, '1', '2020-01-01T00:00:00.000Z'), mint, at),
  );
});
await test('unconfigured ingestion is unavailable and transport never signs or submits', async () => {
  assert.equal(walletCapability({}).configured, false);
  let calls = 0;
  assert.equal(
    createWalletSource(walletIngestConfig({}), async () => {
      calls++;
      throw new Error();
    }),
    null,
  );
  assert.equal(calls, 0);
  const methods = [];
  const source = createWalletSource(config, async (_url, init) => {
    const body = JSON.parse(init.body);
    methods.push(body.method);
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result:
        body.method === 'getGenesisHash'
          ? SOLANA_NETWORKS['mainnet-beta'].genesisHash
          : [],
    });
  });
  const page = await source.page(wallet, null, null);
  assert.equal(page.exhausted, true);
  assert.deepEqual(methods, ['getGenesisHash', 'getSignaturesForAddress']);
});
await test('redirect oversized response and mismatched genesis fail before trusting history', async () => {
  await assert.rejects(
    readWalletJson(
      'https://rpc.example.test',
      {},
      async () => new Response('[]', { status: 302 }),
    ),
  );
  await assert.rejects(
    readWalletJson(
      'https://rpc.example.test',
      {},
      async () => new Response('x'.repeat(30)),
      undefined,
      10,
    ),
  );
  const source = createWalletSource(config, async (_url, init) => {
    const body = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: 'wrong' });
  });
  await assert.rejects(source.page(wallet, null, null));
});
await test('confirmed fork disappearance removes provisional economics without claiming no payment', () => {
  assert.equal(finalizationDecision(null, '100', '110'), 'pending');
  assert.equal(finalizationDecision(null, '100', '200'), 'remove_provisional');
  assert.equal(
    finalizationDecision({ slot: '100', state: 'finalized' }, '100', '200'),
    'finalized',
  );
});

const databaseUrl = process.env.CONCLAVE_TEST_DATABASE_URL;
await test(
  'isolated PostgreSQL ownership unlink and paged ingestion invariants',
  { skip: !databaseUrl },
  async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.pathname.endsWith('_test'),
    );
    const pool = createDatabase(databaseUrl, 5);
    // This dedicated database belongs to this suite. No shared/live database migration.
    await pool.query(
      'CREATE TABLE IF NOT EXISTS accounts(id uuid PRIMARY KEY)',
    );
    const exists = await pool.query(
      "SELECT to_regclass('second_look_wallets') AS present",
    );
    if (!exists.rows[0].present)
      await pool.query(
        await readFile(
          new URL(
            '../server/db/migrations/024-second-look-wallet.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    const encrypted = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='second_look_wallets' AND column_name='address_ciphertext'",
    );
    if (!encrypted.rowCount)
      await pool.query(
        await readFile(
          new URL(
            '../server/db/migrations/026-second-look-wallet-encryption.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
    const accountId = randomUUID(),
      otherId = randomUUID();
    await pool.query('INSERT INTO accounts(id) VALUES($1),($2)', [
      accountId,
      otherId,
    ]);
    t.after(async () => {
      await pool.query(
        'DELETE FROM second_look_wallets WHERE account_id=ANY($1::uuid[])',
        [[accountId, otherId]],
      );
      await pool.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [
        [accountId, otherId],
      ]);
      await pool.end();
    });
    const linked = await linkWallet(pool, accountId, wallet, 'Wallet');
    assert.equal(linked.proof, 'unverified');
    assert.equal(
      (await linkWallet(pool, accountId, wallet, 'Replay')).id,
      linked.id,
    );
    await assert.rejects(
      getWallet(pool, otherId, linked.id),
      (e) => e.code === 'WALLET_NOT_FOUND',
    );
    assert.equal((await listWallets(pool, otherId)).length, 0);
    const foreign = await handleApi(() =>
      walletRoutes(
        pool,
        new Request(
          'https://example.test/api/second-look/wallets/' + linked.id + '/pnl',
        ),
        `second-look/wallets/${linked.id}/pnl`,
        otherId,
      ),
    );
    assert.equal(foreign.status, 404);
    let pages = 0;
    const source = {
      kind: 'rpc',
      page: async (_wallet, _cursor) => {
        pages++;
        return pages === 1
          ? {
              entries: [
                {
                  signature: sig(1),
                  slot: '10',
                  timestamp: at,
                  confirmation: 'finalized',
                  transaction: transactionFixture(),
                },
              ],
              nextCursor: sig(1),
              exhausted: false,
              snapshotId: null,
              coverage: null,
            }
          : {
              entries: [],
              nextCursor: null,
              exhausted: true,
              snapshotId: null,
              coverage: null,
            };
      },
      transaction: async () => null,
      statuses: async () => ({ finalizedSlot: '1000', values: [] }),
    };
    const first = await runWalletIngestOnce(pool, { config, source });
    assert.equal(first.state, 'queued');
    const progress = await getWallet(pool, accountId, linked.id);
    assert.equal(progress.sync.signatures, 1);
    assert.equal(progress.sync.finalized, 1);
    await pool.query(
      'UPDATE second_look_wallet_jobs SET next_run_at=now() WHERE wallet_id=$1',
      [linked.id],
    );
    await runWalletIngestOnce(pool, { config, source });
    assert.equal(
      (await getWallet(pool, accountId, linked.id)).sync
        .providerHistoryExhausted,
      true,
    );
    const report = await walletPnl(pool, accountId, linked.id);
    assert.equal(report.complete, false);
    assert.equal(report.netUsd6, null);
    // Failed source responses do not advance progress.
    await pool.query(
      'UPDATE second_look_wallet_jobs SET next_run_at=now() WHERE wallet_id=$1',
      [linked.id],
    );
    const failure = await runWalletIngestOnce(pool, {
      config,
      source: {
        ...source,
        page: async () => {
          throw new Error('fixture');
        },
      },
    });
    assert.equal(failure.state, 'blocked');
    assert.equal((await getWallet(pool, accountId, linked.id)).sync.pages, 2);
    await assert.rejects(unlinkWallet(pool, otherId, linked.id));
    await unlinkWallet(pool, accountId, linked.id);
    for (const table of [
      'second_look_wallet_jobs',
      'second_look_wallet_transactions',
      'second_look_wallet_prices',
    ])
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::text AS n FROM ${table} WHERE wallet_id=$1`,
            [linked.id],
          )
        ).rows[0].n,
        '0',
      );
  },
);

await test('archive source binds snapshot identity and requires final completeness evidence', async () => {
  const transaction = {
    ...transactionFixture(),
    transactionIndex: 3,
    airdrop: false,
  };
  const archiveConfig = {
    ...config,
    rpcUrl: null,
    archiveUrl: 'https://archive.example.test',
    archiveSourceId: 'fixture',
  };
  const result = {
    version: 1,
    sourceId: 'fixture',
    wallet,
    genesisHash: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
    snapshotId: 'snapshot',
    transactions: [transaction],
    nextCursor: null,
    coverage: {
      ...coverage([normalized(1, [])], []),
      holdingsIncludeRentReserves: true,
    },
  };
  const source = createWalletSource(archiveConfig, async () =>
    Response.json(result),
  );
  const page = await source.page(wallet, null, null);
  assert.equal(page.entries[0].transactionIndex, 3);
  assert.equal(page.coverage.sourceId, 'fixture');
  await assert.rejects(source.page(wallet, null, 'different'));
  for (const patch of [
    { coverage: null },
    { wallet: other },
    { sourceId: 'other' },
    { nextCursor: 'unsafe cursor' },
  ])
    await assert.rejects(
      createWalletSource(archiveConfig, async () =>
        Response.json({ ...result, ...patch }),
      ).page(wallet, null, null),
    );
});

await test('aborted stalled fetch or body reader settles without exposing endpoint', async () => {
  const controller = new AbortController();
  const promise = readWalletJson(
    'https://rpc.example.test?credential=fixture',
    {},
    async () => new Promise(() => {}),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(
    promise,
    (error) => error.message === 'WALLET_SOURCE_TIMEOUT',
  );
  const stream = new ReadableStream({ start() {} }),
    bodyController = new AbortController();
  const body = readWalletJson(
    'https://rpc.example.test',
    {},
    async () => new Response(stream),
    bodyController.signal,
  );
  setTimeout(() => bodyController.abort(), 5);
  await assert.rejects(
    body,
    (error) => error.message === 'WALLET_SOURCE_TIMEOUT',
  );
});

await test('wrapped SOL principal is not misclassified as rent or acquisition', () => {
  const tx = transactionFixture({
    solDelta: -1002039280,
    tokenDelta: 0,
    instructions: [
      {
        programId: SYSTEM_PROGRAM,
        parsed: {
          type: 'createAccount',
          info: {
            source: wallet,
            newAccount: tokenAccount,
            lamports: 1002039280,
          },
        },
      },
    ],
  });
  tx.meta.preBalances[1] = 0;
  tx.meta.postBalances[1] = 1002039280;
  tx.meta.preTokenBalances = [token(3, other, 0)];
  tx.meta.postTokenBalances = [
    token(1, wallet, 1000000000, SOL_MINT, 9),
    token(3, other, 0),
  ];
  const result = parseWalletTrade(tx, wallet, sig(1), {
    feePolicyReviewed: true,
  });
  assert.equal(result.rentLamports, '2039280');
  assert.equal(result.deltas.length, 0);
});

await test(
  'archive count rollback lease fencing dedup and provisional fork invalidation',
  { skip: !databaseUrl },
  async (t) => {
    const url = new URL(databaseUrl);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        url.pathname.endsWith('_test'),
    );
    const pool = createDatabase(databaseUrl, 5),
      accountId = randomUUID();
    await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
    t.after(async () => {
      await pool.query('DELETE FROM second_look_wallets WHERE account_id=$1', [
        accountId,
      ]);
      await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      await pool.end();
    });
    const linked = await linkWallet(pool, accountId, wallet, 'Archive fixture');
    const empty = () => ({
      entries: [],
      nextCursor: null,
      exhausted: true,
      snapshotId: null,
      coverage: null,
    });
    const archiveConfig = {
      ...config,
      archiveUrl: 'https://archive.example.test',
      archiveSourceId: 'fixture',
    };
    const archive = {
      kind: 'archive',
      page: async () => ({
        entries: [
          {
            signature: sig(1),
            slot: '10',
            timestamp: at,
            transaction: transactionFixture(),
            transactionIndex: 1,
            confirmation: 'finalized',
          },
        ],
        snapshotId: 'snapshot',
        nextCursor: null,
        exhausted: true,
        coverage: coverage([normalized(1, []), normalized(2, [])], []),
      }),
      transaction: async () => null,
      statuses: async () => ({ finalizedSlot: '1000', values: [] }),
    };
    assert.equal(
      (
        await runWalletIngestOnce(pool, {
          config: archiveConfig,
          source: archive,
        })
      ).state,
      'blocked',
    );
    assert.equal(
      (await getWallet(pool, accountId, linked.id)).sync.signatures,
      0,
    );
    assert.equal((await getWallet(pool, accountId, linked.id)).sync.pages, 0);
    await pool.query(
      'UPDATE second_look_wallet_jobs SET next_run_at=now() WHERE wallet_id=$1',
      [linked.id],
    );
    const confirmed = {
      ...archive,
      kind: 'rpc',
      page: async () => ({
        entries: [
          {
            signature: sig(1),
            slot: '10',
            timestamp: at,
            transaction: transactionFixture(),
            confirmation: 'confirmed',
          },
        ],
        snapshotId: null,
        nextCursor: null,
        exhausted: true,
        coverage: null,
      }),
      statuses: async () => ({ finalizedSlot: '1000', values: [null] }),
    };
    await runWalletIngestOnce(pool, { config, source: confirmed });
    assert.equal((await getWallet(pool, accountId, linked.id)).sync.pending, 1);
    await pool.query(
      "UPDATE second_look_wallet_transactions SET last_checked_at=now()-interval '1 minute' WHERE wallet_id=$1",
      [linked.id],
    );
    await pool.query(
      'UPDATE second_look_wallet_jobs SET next_run_at=now() WHERE wallet_id=$1',
      [linked.id],
    );
    await runWalletIngestOnce(pool, {
      config,
      source: { ...confirmed, page: async () => empty() },
    });
    const row = (
      await pool.query(
        'SELECT state,ledger_ciphertext AS ledger FROM second_look_wallet_transactions WHERE wallet_id=$1',
        [linked.id],
      )
    ).rows[0];
    assert.equal(row.state, 'unavailable');
    assert.equal(row.ledger, null);
    await pool.query(
      'UPDATE second_look_wallet_jobs SET next_run_at=now() WHERE wallet_id=$1',
      [linked.id],
    );
    let release, enteredResolve;
    const entered = new Promise((resolve) => (enteredResolve = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    const pending = runWalletIngestOnce(pool, {
      config,
      source: {
        ...confirmed,
        statuses: async () => ({ finalizedSlot: '1000', values: [null] }),
        page: async () => {
          enteredResolve();
          await gate;
          return empty();
        },
      },
    });
    await entered;
    assert.equal(
      (await runWalletIngestOnce(pool, { config, source: confirmed }))
        .processed,
      false,
    );
    await unlinkWallet(pool, accountId, linked.id);
    release();
    assert.equal((await pending).state, 'lease_lost');
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::text AS n FROM second_look_wallet_transactions WHERE wallet_id=$1',
          [linked.id],
        )
      ).rows[0].n,
      '0',
    );
  },
);

await test(
  'archive worker persists complete accounting with pricing and source-bound provenance',
  { skip: !databaseUrl },
  async (t) => {
    const pool = createDatabase(databaseUrl, 4),
      accountId = randomUUID();
    await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
    t.after(async () => {
      await pool.query('DELETE FROM second_look_wallets WHERE account_id=$1', [
        accountId,
      ]);
      await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      await pool.end();
    });
    const linked = await linkWallet(
        pool,
        accountId,
        wallet,
        'Complete fixture',
      ),
      now = new Date().toISOString();
    const tx = transactionFixture({
      fee: 0,
      solDelta: 0,
      tokenDelta: 10000000,
      instructions: [
        {
          programId: TOKEN_PROGRAM,
          parsed: {
            type: 'mintTo',
            info: { account: tokenAccount, mint, amount: '10000000' },
          },
        },
      ],
    });
    tx.blockTime = Math.floor(Date.now() / 1000);
    tx.meta.preBalances[0] = 0;
    tx.meta.postBalances[0] = 0;
    tx.meta.preTokenBalances[0] = token(1, wallet, 0);
    tx.meta.postTokenBalances[0] = token(1, wallet, 10000000);
    const cov = {
      ...coverage(
        [normalized(1, [])],
        [{ mint, decimals: 6, amount: '10000000' }],
      ),
      asOf: now,
      holdingsIncludeRentReserves: true,
    };
    const cfg = {
      ...config,
      rpcUrl: null,
      archiveUrl: 'https://archive.example.test',
      archiveSourceId: 'fixture',
      priceUrl: 'https://prices.example.test',
    };
    const fetcher = async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === cfg.archiveUrl)
        return Response.json({
          version: 1,
          sourceId: 'fixture',
          wallet,
          genesisHash: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
          snapshotId: 'snapshot',
          nextCursor: null,
          transactions: [{ ...tx, transactionIndex: 0, airdrop: true }],
          coverage: cov,
        });
      assert.equal(url, cfg.priceUrl);
      return Response.json({
        price: price(body.mint, body.mint === mint ? '2' : '100', body.at),
      });
    };
    const run = await runWalletIngestOnce(pool, { config: cfg, fetcher });
    assert.equal(run.state, 'idle');
    const report = await walletPnl(pool, accountId, linked.id);
    assert.equal(report.complete, true);
    assert.equal(report.netUsd6, '20000000');
    assert.equal(report.positions[0].airdrop, true);
    // Replaying the same immutable snapshot does not double holdings, fees or P&L.
    await pool.query(
      'UPDATE second_look_wallet_jobs SET next_run_at=now() WHERE wallet_id=$1',
      [linked.id],
    );
    await runWalletIngestOnce(pool, { config: cfg, fetcher });
    assert.equal(
      (await walletPnl(pool, accountId, linked.id)).netUsd6,
      '20000000',
    );
    const row = (
      await pool.query(
        'SELECT coverage_ciphertext FROM second_look_wallet_jobs WHERE wallet_id=$1',
        [linked.id],
      )
    ).rows[0];
    const savedCoverage = await openWallet(
      row.coverage_ciphertext,
      accountId,
      linked.id,
      'coverage',
      configuredKeyring(),
    );
    assert.equal(savedCoverage.sourceId, 'fixture');
    assert.equal(savedCoverage.snapshotId, 'snapshot');
    const rls = await pool.query(
      'SELECT relrowsecurity FROM pg_class WHERE relname=ANY($1::text[])',
      [
        [
          'second_look_wallets',
          'second_look_wallet_jobs',
          'second_look_wallet_transactions',
          'second_look_wallet_prices',
        ],
      ],
    );
    assert.equal(rls.rows.length, 4);
    assert.ok(rls.rows.every((r) => r.relrowsecurity));
  },
);

await test('wallet encryption binds account record and purpose with distinct account lookups', async () => {
  const keys = configuredKeyring(),
    account = randomUUID(),
    id = randomUUID();
  const encrypted = await sealWallet(
    { address: wallet, label: 'Private label' },
    account,
    id,
    'address',
    keys,
  );
  assert.ok(!encrypted.includes(wallet));
  assert.ok(!encrypted.includes('Private label'));
  assert.equal(
    (await openWallet(encrypted, account, id, 'address', keys)).address,
    wallet,
  );
  await assert.rejects(
    openWallet(encrypted, randomUUID(), id, 'address', keys),
  );
  await assert.rejects(
    openWallet(encrypted, account, randomUUID(), 'address', keys),
  );
  await assert.rejects(openWallet(encrypted, account, id, 'ledger', keys));
  assert.notEqual(
    walletDigest(account, 'address', wallet, keys),
    walletDigest(randomUUID(), 'address', wallet, keys),
  );
  assert.equal(
    walletCapability({
      CONCLAVE_WALLET_INGEST_ENABLED: 'true',
      CONCLAVE_WALLET_RPC_URL: 'https://rpc.example.test',
    }).reason,
    'WALLET_STORAGE_REQUIRED',
  );
});

await test(
  'stored associations contain no plaintext address label signature or token mint',
  { skip: !databaseUrl },
  async (t) => {
    const pool = createDatabase(databaseUrl, 4),
      accountId = randomUUID();
    await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
    t.after(async () => {
      await pool.query('DELETE FROM second_look_wallets WHERE account_id=$1', [
        accountId,
      ]);
      await pool.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      await pool.end();
    });
    const linked = await linkWallet(
      pool,
      accountId,
      wallet,
      'Private fixture label',
    );
    const source = {
      kind: 'rpc',
      page: async () => ({
        entries: [
          {
            signature: sig(1),
            slot: '10',
            timestamp: at,
            confirmation: 'finalized',
            transaction: transactionFixture(),
          },
        ],
        nextCursor: sig(1),
        exhausted: false,
        snapshotId: null,
        coverage: null,
      }),
      transaction: async () => null,
      statuses: async () => ({ finalizedSlot: '1000', values: [] }),
    };
    await runWalletIngestOnce(pool, { config, source });
    for (const table of [
      'second_look_wallets',
      'second_look_wallet_jobs',
      'second_look_wallet_transactions',
      'second_look_wallet_prices',
    ]) {
      const rows = await pool.query(
        `SELECT row_to_json(r)::text AS data FROM ${table} r WHERE account_id=$1`,
        [accountId],
      );
      for (const { data } of rows.rows)
        for (const secret of [
          wallet,
          other,
          mint,
          sig(1),
          'Private fixture label',
        ])
          assert.ok(!data.includes(secret), table);
    }
    const originalKeys = process.env.CONCLAVE_DATA_KEYS,
      originalActive = process.env.CONCLAVE_ACTIVE_DATA_KEY;
    try {
      process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
        ...JSON.parse(originalKeys),
        rotated: Buffer.alloc(32, 72).toString('base64'),
      });
      process.env.CONCLAVE_ACTIVE_DATA_KEY = 'rotated';
      assert.equal(
        (await getWallet(pool, accountId, linked.id)).address,
        wallet,
      );
      assert.equal(
        (await linkWallet(pool, accountId, wallet, 'Rotation replay')).id,
        linked.id,
      );
      await pool.query(
        'UPDATE second_look_wallet_jobs SET next_run_at=now() WHERE wallet_id=$1',
        [linked.id],
      );
      await runWalletIngestOnce(pool, { config, source });
      assert.equal(
        (await getWallet(pool, accountId, linked.id)).sync.signatures,
        1,
      );
      process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
        rotated: Buffer.alloc(32, 72).toString('base64'),
      });
      await assert.rejects(getWallet(pool, accountId, linked.id));
    } finally {
      process.env.CONCLAVE_DATA_KEYS = originalKeys;
      process.env.CONCLAVE_ACTIVE_DATA_KEY = originalActive;
    }
  },
);

await test(
  'encryption migration refuses existing plaintext cache instead of silently deleting it',
  { skip: !databaseUrl },
  async () => {
    const pool = createDatabase(databaseUrl, 1),
      client = await pool.connect();
    try {
      await client.query('BEGIN');
      const schema = 'wallet_fixture_' + randomUUID().replaceAll('-', '');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query('CREATE TABLE accounts(id uuid PRIMARY KEY)');
      await client.query(
        await readFile(
          new URL(
            '../server/db/migrations/024-second-look-wallet.sql',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const accountId = randomUUID();
      await client.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
      await client.query(
        'INSERT INTO second_look_wallets(id,account_id,address,label) VALUES($1,$2,$3,$4)',
        [randomUUID(), accountId, wallet, 'fixture'],
      );
      await assert.rejects(
        client.query(
          await readFile(
            new URL(
              '../server/db/migrations/026-second-look-wallet-encryption.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
        (error) =>
          error.message.includes('explicit offline encrypted conversion'),
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  },
);

await test('archive can account token owner absent from message account keys', () => {
  const tx = transactionFixture({
    fee: 0,
    solDelta: 0,
    tokenDelta: 1000000,
    instructions: [
      {
        programId: TOKEN_PROGRAM,
        parsed: {
          type: 'transfer',
          info: {
            source: poolAccount,
            destination: tokenAccount,
            amount: '1000000',
          },
        },
      },
    ],
  });
  tx.transaction.message.accountKeys[0].pubkey = key(9);
  const result = parseWalletTrade(tx, wallet, sig(1), {
    feePolicyReviewed: true,
  });
  assert.equal(result.signer, false);
  assert.equal(result.deltas[0].amount, '1000000');
  assert.equal(result.deltas[0].kind, 'transfer');
  assert.equal(result.deltas[0].counterparty, other);
  assert.equal(result.fees.length, 0);
});
