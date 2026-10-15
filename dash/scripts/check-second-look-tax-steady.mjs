import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { calculateTax } from '../server/second-look/tax-engine.ts';
import {
  renderTaxExport,
  exactAmount,
} from '../server/second-look/tax-exports.ts';
import {
  getEntitlements,
  purchaseSteady,
  addCalendarMonth,
} from '../server/second-look/steady-store.ts';
import {
  previewTax,
  unlockTax,
  exportTax,
} from '../server/second-look/tax-store.ts';
import { creditVerifiedDeposit, getBalance } from '../server/ledger/ledger.ts';
import {
  linkWallet,
  unlinkWallet,
} from '../server/second-look/wallet-store.ts';
import {
  taxOptions,
  taxPreviewResponse,
  taxExportResponse,
} from '../lib/client/tax-contracts.ts';
import { steadyPurchaseResponse } from '../lib/client/steady-contracts.ts';
import {
  configuredKeyring,
  walletDigest,
  sealWallet,
} from '../server/second-look/wallet-crypto.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw Error('An isolated loopback *_test database is required.');
const url = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw Error('Use a loopback *_test database only.');
for (const key of Object.keys(process.env))
  if (key.startsWith('CONCLAVE_')) delete process.env[key];
Object.assign(process.env, {
  CONCLAVE_ACTIVE_DATA_KEY: 'tax-test',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    'tax-test': randomBytes(32).toString('base64'),
  }),
});
const pool = createDatabase(connection, 4);
const SOL = 'So11111111111111111111111111111111111111112',
  USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  TOKEN = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const A = SOL,
  B = USDC,
  at = (day) => `2025-01-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const options = {
  year: 2025,
  jurisdiction: 'US',
  method: 'fifo',
  selections: [],
};
const delta = (mint, amount, kind = 'swap', counterparty = null) => ({
  mint,
  amount: String(amount),
  decimals: 0,
  kind,
  counterparty,
});
const trade = (sig, day, deltas, wallet = A, extra = {}) => ({
  signature: sig.repeat(64),
  transactionIndex: 0,
  slot: String(day),
  timestamp: at(day),
  wallet,
  feePayer: wallet,
  signer: true,
  failed: false,
  deltas,
  fees: [],
  rentLamports: '0',
  warnings: [],
  ...extra,
});
const price = (mint, day, priceUsd = '1') => ({
  mint,
  at: at(day),
  priceUsd,
  lastTradeAt: at(day),
  liquidityUsd: '1000',
  estimated: false,
  source: 'https://example.org/observed-swap',
});
const input = (trades, prices, patch = {}) => ({
  walletId: randomUUID(),
  wallet: A,
  linkedWallets: [A, B],
  trades,
  prices,
  options,
  coverageVerified: true,
  unresolved: 0,
  now: new Date('2026-02-01T00:00:00.000Z'),
  ...patch,
});
async function cacheTrade(
  owner,
  wallet,
  observed = trade('a', 1, [delta(USDC, -30), delta(TOKEN, 3)], wallet.address),
) {
  const keyring = configuredKeyring(),
    digest = walletDigest(owner, 'signature', observed.signature, keyring);
  await pool.query(
    "INSERT INTO second_look_wallet_transactions(wallet_id,account_id,signature_digest,locator_ciphertext,slot,state,ledger_ciphertext) VALUES($1,$2,$3,$4,$5,'finalized',$6)",
    [
      wallet.id,
      owner,
      digest,
      await sealWallet(
        { signature: observed.signature },
        owner,
        wallet.id,
        'locator',
        keyring,
        digest,
      ),
      observed.slot,
      await sealWallet(observed, owner, wallet.id, 'ledger', keyring, digest),
    ],
  );
}
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.end();
});
async function account() {
  const id = randomUUID();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  return id;
}
async function credit(id, amount = '100000000') {
  await creditVerifiedDeposit(pool, {
    accountId: id,
    reference: `synthetic-tax-test-${randomUUID()}`,
    amountUsd6: amount,
  });
}

test('exact FIFO lots retain integer basis through partial sales', () => {
  const report = calculateTax(
    input(
      [
        trade('a', 1, [delta(USDC, -30), delta(TOKEN, 3)]),
        trade('b', 2, [delta(TOKEN, -1), delta(USDC, 20)]),
        trade('c', 3, [delta(TOKEN, -2), delta(USDC, 40)]),
      ],
      [price(USDC, 1), price(USDC, 2), price(USDC, 3)],
    ),
  );
  const sales = report.rows.filter(
    (r) => r.mint === TOKEN && r.kind === 'disposal',
  );
  assert.deepEqual(
    sales.map((r) => r.basisUsd6),
    ['10000000', '20000000'],
  );
  assert.deepEqual(
    sales.map((r) => r.gainUsd6),
    ['10000000', '20000000'],
  );
  assert.equal(
    exactAmount('900719925474099312345', 18),
    '900.719925474099312345',
  );
});
test('own-wallet transfer carries original acquisition date and basis, no disposal', () => {
  const buy = trade('a', 1, [delta(USDC, -30), delta(TOKEN, 3)]),
    out = trade('b', 2, [delta(TOKEN, -2, 'transfer', B)]),
    incoming = trade('b', 2, [delta(TOKEN, 2, 'transfer', A)], B),
    sell = trade('c', 3, [delta(TOKEN, -2), delta(USDC, 40)], B);
  const r = calculateTax(
    input([buy, out, incoming, sell], [price(USDC, 1), price(USDC, 3)], {
      wallet: B,
    }),
  );
  assert.equal(r.rows.find((r) => r.kind === 'own_transfer_in').gainUsd6, null);
  const s = r.rows.find((r) => r.mint === TOKEN && r.kind === 'disposal');
  assert.equal(s.basisUsd6, '20000000');
  assert.equal(s.acquisitionLots[0].acquiredAt, at(1));
});
test('specific ID consumes explicit documented lot and rejects late identification', () => {
  const trades = [
      trade('a', 1, [delta(USDC, -10), delta(TOKEN, 1)]),
      trade('b', 2, [delta(USDC, -20), delta(TOKEN, 1)]),
      trade('c', 3, [delta(TOKEN, -1), delta(USDC, 30)]),
    ],
    prices = [price(USDC, 1), price(USDC, 2), price(USDC, 3)];
  const selection = {
    disposalId: `${'c'.repeat(64)}:0`,
    lots: [{ lotId: `${A}:${'b'.repeat(64)}:1`, amount: '1' }],
    identifiedAt: at(2),
    evidenceReference: 'Contemporaneous local tax records',
  };
  const r = calculateTax(
    input(trades, prices, {
      options: { ...options, method: 'specific_id', selections: [selection] },
    }),
  );
  assert.equal(
    r.rows.find((r) => r.id === selection.disposalId).basisUsd6,
    '20000000',
  );
  const late = calculateTax(
    input(trades, prices, {
      options: {
        ...options,
        method: 'specific_id',
        selections: [{ ...selection, identifiedAt: at(4) }],
      },
    }),
  );
  assert.equal(
    late.rows.find((r) => r.id === selection.disposalId).basisUsd6,
    '10000000',
  );
  assert(late.exceptions.includes('SPECIFIC_ID_NOT_CONTEMPORANEOUS'));
});
test('unknown historical prices and external transfer basis never become zero', () => {
  const r = calculateTax(
    input(
      [
        trade('a', 1, [delta(TOKEN, 2, 'transfer')]),
        trade('b', 2, [delta(TOKEN, -1), delta(USDC, 3)]),
      ],
      [],
    ),
  );
  assert.equal(r.rows.find((r) => r.kind === 'disposal').gainUsd6, null);
  assert.equal(r.complete, false);
  assert(r.exceptions.includes('HISTORICAL_PRICE_UNAVAILABLE'));
});
test('US airdrop gets evidenced FMV basis and review flag; rent remains separate', () => {
  const r = calculateTax(
    input(
      [trade('a', 1, [delta(TOKEN, 5, 'airdrop')], A, { rentLamports: '-12' })],
      [price(TOKEN, 1, '2')],
    ),
  );
  assert.equal(r.rows[0].basisUsd6, '10000000');
  assert(r.exceptions.includes('AIRDROP_INCOME_REVIEW'));
  assert.equal(r.rows.find((r) => r.kind === 'rent').gainUsd6, null);
});
test('last observed price fallback is labelled estimate; worthless holdings are not fabricated sales', () => {
  const r = calculateTax(
    input(
      [trade('a', 2, [delta(TOKEN, 5, 'airdrop')])],
      [price(TOKEN, 1, '2')],
    ),
  );
  assert(r.exceptions.includes('ESTIMATED_PRICE'));
  assert.equal(r.possibleWorthless.length, 1);
  assert.equal(r.rows.filter((r) => r.kind === 'disposal').length, 0);
});
test('all five exports preserve declared formats, signatures and precision failures', () => {
  const r = calculateTax(
    input(
      [trade('a', 1, [delta(USDC, -30), delta(TOKEN, 3)])],
      [price(USDC, 1)],
    ),
  );
  for (const f of [
    'generic_csv',
    'generic_json',
    'koinly',
    'cointracker',
    'awaken',
  ]) {
    const e = renderTaxExport(r, f, randomUUID());
    assert(taxExportResponse(e));
    assert(e.notes.includes(r.disclaimer));
    if (f !== 'cointracker') assert(e.content.includes('a'.repeat(64)));
  }
  const tiny = { ...r, rows: [{ ...r.rows[0], amount: '1', decimals: 9 }] };
  assert.throws(
    () => renderTaxExport(tiny, 'awaken', randomUUID()),
    (e) => e.code === 'TAX_FORMAT_PRECISION_LIMIT',
  );
  const malicious = {
    ...r,
    rows: [{ ...r.rows[0], exceptions: ['=HYPERLINK("bad")'] }],
  };
  assert(
    renderTaxExport(malicious, 'generic_csv', randomUUID()).content.includes(
      "'=HYPERLINK",
    ),
  );
});
test('tax option validators reject duplicate lots, giant atoms, wrong methods and future years', () => {
  assert(taxOptions(options));
  for (const patch of [
    { method: 'hifo' },
    { year: 2500 },
    { jurisdiction: 'UK' },
    {
      selections: [
        {
          disposalId: 'a',
          identifiedAt: at(1),
          evidenceReference: 'x',
          lots: [{ lotId: 'l', amount: '1'.repeat(2000) }],
        },
      ],
    },
  ])
    assert.equal(taxOptions({ ...options, ...patch }), false);
});
test('calendar-month renewal clamps end-of-month without drifting into March', () => {
  assert.equal(
    addCalendarMonth(new Date('2025-01-31T03:04:05.000Z')).toISOString(),
    '2025-02-28T03:04:05.000Z',
  );
});
test('Steady purchase is atomic, concurrent-idempotent, exact and declines unfunded accounts', async () => {
  const id = await account();
  await assert.rejects(
    purchaseSteady(pool, id, randomUUID(), '12000000'),
    (e) => e.code === 'INSUFFICIENT_BALANCE',
  );
  assert.equal((await getEntitlements(pool, id)).plan, 'free');
  await credit(id);
  const key = randomUUID(),
    results = await Promise.all([
      purchaseSteady(pool, id, key, '12000000'),
      purchaseSteady(pool, id, key, '12000000'),
    ]);
  assert(results.every(steadyPurchaseResponse));
  assert.equal(results.filter((r) => r.replayed).length, 1);
  assert.equal((await getBalance(pool, id)).availableUsd6, '88000000');
  assert.equal((await getEntitlements(pool, id)).followedTraderLimit, 25);
  await assert.rejects(
    purchaseSteady(pool, id, randomUUID(), '1'),
    (e) => e.code === 'PRICE_CHANGED',
  );
  await pool.query(
    "UPDATE second_look_steady SET active_until=now()-interval '1 second' WHERE account_id=$1",
    [id],
  );
  assert.equal((await getEntitlements(pool, id)).followedTraderLimit, 3);
});
test('tax unlock debits once, export fixes method and relinking cannot reset it', async () => {
  const id = await account();
  await credit(id);
  const wallet = await linkWallet(pool, id, A, 'Tax wallet'),
    key = randomUUID();
  await cacheTrade(id, wallet);
  const preview = await previewTax(pool, id, wallet.id, options);
  assert(taxPreviewResponse(preview));
  assert.equal(preview.exportAccess.unlocked, false);
  const results = await Promise.all([
    unlockTax(pool, id, wallet.id, 2025, key, '9000000'),
    unlockTax(pool, id, wallet.id, 2025, key, '9000000'),
  ]);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  assert.equal((await getBalance(pool, id)).availableUsd6, '91000000');
  const exported = await exportTax(
    pool,
    id,
    wallet.id,
    options,
    'generic_json',
  );
  assert(taxExportResponse(exported));
  assert.equal(exported.report.methodLocked, true);
  await assert.rejects(
    previewTax(pool, id, wallet.id, { ...options, method: 'specific_id' }),
    (e) => e.code === 'TAX_METHOD_LOCKED',
  );
  await unlinkWallet(pool, id, wallet.id);
  const linked = await linkWallet(pool, id, A, 'Re-linked');
  await assert.rejects(
    previewTax(pool, id, linked.id, { ...options, method: 'specific_id' }),
    (e) => e.code === 'TAX_METHOD_LOCKED',
  );
  const other = await account();
  await assert.rejects(
    previewTax(pool, other, linked.id, options),
    (e) => e.code === 'WALLET_NOT_FOUND',
  );
  const raw = await pool.query(
    'SELECT report_ciphertext FROM second_look_tax_exports WHERE account_id=$1',
    [id],
  );
  assert(!raw.rows[0].report_ciphertext.includes(A));
});
test('Steady includes exactly three wallet-year exports and an unfunded fourth cannot charge', async () => {
  const id = await account();
  await credit(id, '12000000');
  await purchaseSteady(pool, id, randomUUID(), '12000000');
  const addresses = [A, B, TOKEN, '11111111111111111111111111111111'];
  const wallets = [];
  for (const address of addresses)
    wallets.push(await linkWallet(pool, id, address, 'Included wallet'));
  for (const wallet of wallets.slice(0, 3))
    assert.equal(
      (await exportTax(pool, id, wallet.id, options, 'generic_json')).report
        .methodLocked,
      true,
    );
  assert.equal((await getBalance(pool, id)).availableUsd6, '0');
  await cacheTrade(id, wallets[3]);
  await assert.rejects(
    exportTax(pool, id, wallets[3].id, options, 'generic_json'),
    (e) => e.code === 'TAX_EXPORT_LOCKED',
  );
  await assert.rejects(
    unlockTax(pool, id, wallets[3].id, 2025, randomUUID(), '9000000'),
    (e) => e.code === 'INSUFFICIENT_BALANCE',
  );
});
test('empty or unindexed tax years never charge; a paid receipt still replays after history is removed', async () => {
  const id = await account(),
    wallet = await linkWallet(pool, id, A, 'Empty year fixture'),
    key = randomUUID();
  await credit(id);
  await assert.rejects(
    unlockTax(pool, id, wallet.id, 2025, key, '9000000'),
    (e) => e.code === 'TAX_RECORDS_REQUIRED',
  );
  assert.equal((await getBalance(pool, id)).availableUsd6, '100000000');
  assert.equal(
    (
      await pool.query(
        'SELECT id FROM second_look_purchases WHERE account_id=$1',
        [id],
      )
    ).rowCount,
    0,
  );
  await cacheTrade(
    id,
    wallet,
    trade('a', 1, [delta(TOKEN, 2, 'airdrop')], wallet.address, {
      timestamp: '2024-01-01T12:00:00.000Z',
    }),
  );
  await assert.rejects(
    unlockTax(pool, id, wallet.id, 2025, key, '9000000'),
    (e) => e.code === 'TAX_RECORDS_REQUIRED',
  );
  await cacheTrade(
    id,
    wallet,
    trade('b', 2, [delta(TOKEN, -1), delta(USDC, 20)], wallet.address),
  );
  const partial = await previewTax(pool, id, wallet.id, options);
  assert(partial.report.rows.length > 0);
  assert.equal(partial.report.complete, false);
  await unlockTax(pool, id, wallet.id, 2025, key, '9000000');
  await pool.query(
    'DELETE FROM second_look_wallet_transactions WHERE account_id=$1',
    [id],
  );
  const replay = await unlockTax(pool, id, wallet.id, 2025, key, '9000000');
  assert.equal(replay.replayed, true);
  assert.equal(replay.chargedUsd6, '9000000');
  assert.equal((await getBalance(pool, id)).availableUsd6, '91000000');
});
test('private tax tables enforce RLS and provide no public grants', async () => {
  const tables = [
    'second_look_steady',
    'second_look_purchases',
    'second_look_tax_access',
    'second_look_tax_exports',
  ];
  const { rows } = await pool.query(
    'SELECT relname,relrowsecurity FROM pg_class WHERE relname=ANY($1)',
    [tables],
  );
  assert.equal(rows.length, 4);
  assert(rows.every((r) => r.relrowsecurity));
  const grants = await pool.query(
    "SELECT * FROM information_schema.role_table_grants WHERE table_name=ANY($1) AND grantee='PUBLIC'",
    [tables],
  );
  assert.equal(grants.rowCount, 0);
});

test('post-2024 crypto swap allocates fees to disposal, and separately tracks fee-asset basis', () => {
  const r = calculateTax(
    input(
      [
        trade('a', 1, [delta(SOL, 10, 'airdrop')]),
        trade('b', 2, [delta(SOL, -5), delta(TOKEN, 5)], A, {
          fees: [{ kind: 'network', mint: SOL, decimals: 0, amount: '1' }],
        }),
      ],
      [price(SOL, 1, '2'), price(SOL, 2, '2')],
    ),
  );
  const sold = r.rows.find((row) => row.kind === 'disposal');
  assert.equal(sold.proceedsUsd6, '8000000');
  assert.equal(sold.basisUsd6, '10000000');
  assert.equal(r.rows.find((row) => row.kind === 'fee').basisUsd6, '2000000');
  assert.equal(
    r.rows.find((row) => row.kind === 'acquisition').basisUsd6,
    '10000000',
  );
});

test('stored finalized encrypted transactions and price evidence reach preview and export', async () => {
  const owner = await account();
  const wallet = await linkWallet(pool, owner, A, 'Observed ledger fixture');
  const keyring = configuredKeyring();
  const trades = [
    trade('a', 1, [delta(USDC, -30), delta(TOKEN, 3)]),
    trade('b', 2, [delta(TOKEN, -1), delta(USDC, 20)]),
  ];
  for (const t of trades) {
    const digest = walletDigest(owner, 'signature', t.signature, keyring);
    await pool.query(
      "INSERT INTO second_look_wallet_transactions(wallet_id,account_id,signature_digest,locator_ciphertext,slot,state,ledger_ciphertext) VALUES($1,$2,$3,$4,$5,'finalized',$6)",
      [
        wallet.id,
        owner,
        digest,
        await sealWallet(
          { signature: t.signature },
          owner,
          wallet.id,
          'locator',
          keyring,
          digest,
        ),
        t.slot,
        await sealWallet(t, owner, wallet.id, 'ledger', keyring, digest),
      ],
    );
  }
  for (const p of [price(USDC, 1), price(USDC, 2)]) {
    const digest = walletDigest(owner, 'price', `${p.mint}:${p.at}`, keyring);
    await pool.query(
      "INSERT INTO second_look_wallet_prices(wallet_id,account_id,price_at,price_digest,price_ciphertext,priced,kind) VALUES($1,$2,$3,$4,$5,true,'historical')",
      [
        wallet.id,
        owner,
        p.at,
        digest,
        await sealWallet(
          { mint: p.mint, at: p.at, price: p },
          owner,
          wallet.id,
          'price',
          keyring,
          digest,
        ),
      ],
    );
  }
  const preview = await previewTax(pool, owner, wallet.id, options);
  assert(taxPreviewResponse(preview));
  assert.equal(
    preview.report.rows.find((r) => r.kind === 'disposal' && r.mint === TOKEN)
      .gainUsd6,
    '10000000',
  );
  assert.equal(preview.report.complete, false);
  assert(preview.report.exceptions.includes('HISTORY_COVERAGE_UNVERIFIED'));
  await credit(owner, '9000000');
  await unlockTax(pool, owner, wallet.id, 2025, randomUUID(), '9000000');
  const result = await exportTax(pool, owner, wallet.id, options, 'koinly');
  assert(taxExportResponse(result));
  assert(result.content.includes(`TOKEN:${TOKEN}:SOL`));
  assert(result.content.includes('b'.repeat(64)));
});
