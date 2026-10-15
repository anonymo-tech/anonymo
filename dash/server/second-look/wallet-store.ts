import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { one, transaction } from '../db/database.ts';
import { requireCondition } from '../core/errors.ts';
import { address } from '../solana/validation.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import type {
  LinkedWallet,
  WalletSync,
  WalletPnl,
} from '../../lib/second-look/wallet.ts';
import type { WalletTrade } from './trade-parser.ts';
import {
  calculateWalletPnl,
  priceKey,
  type WalletCoverage,
  type WalletPrice,
  type PriceBook,
} from './pnl.ts';
import {
  configuredKeyring,
  walletDigest,
  sealWallet,
  openWallet,
  type DataKeyring,
} from './wallet-crypto.ts';

type WalletRow = {
  id: string;
  address_ciphertext: string;
  label_ciphertext: string;
  created_at: Date;
  state: WalletSync['state'];
  pages: number;
  exhausted: boolean;
  last_sync_at: Date | null;
  error_code: string | null;
  dropped: number;
  coverage_ciphertext: string | null;
};
const walletSelect = `SELECT w.id,w.address_ciphertext,w.label_ciphertext,w.created_at,j.state,j.pages,j.exhausted,j.last_sync_at,j.error_code,j.dropped,j.coverage_ciphertext FROM second_look_wallets w JOIN second_look_wallet_jobs j ON j.wallet_id=w.id AND j.account_id=w.account_id`;
async function view(
  pool: Pool | PoolClient,
  row: WalletRow,
  accountId: string,
  keyring: DataKeyring,
): Promise<LinkedWallet> {
  const counts = await one<{
    total: string;
    finalized: string;
    pending: string;
    unavailable: string;
  }>(
    pool,
    `SELECT count(*)::text AS total,count(*) FILTER(WHERE state='finalized')::text AS finalized,count(*) FILTER(WHERE state IN ('pending','confirmed'))::text AS pending,count(*) FILTER(WHERE state='unavailable')::text AS unavailable FROM second_look_wallet_transactions WHERE wallet_id=$1 AND account_id=$2`,
    [row.id, accountId],
  );
  return {
    id: row.id,
    address: await openWallet<string>(
      row.address_ciphertext,
      accountId,
      row.id,
      'address',
      keyring,
    ),
    label: await openWallet<string>(
      row.label_ciphertext,
      accountId,
      row.id,
      'label',
      keyring,
    ),
    cluster: 'mainnet-beta',
    proof: 'unverified',
    createdAt: row.created_at.toISOString(),
    sync: {
      state: row.state,
      pages: row.pages,
      signatures: Number(counts!.total),
      finalized: Number(counts!.finalized),
      pending: Number(counts!.pending),
      unavailable: Number(counts!.unavailable),
      dropped: row.dropped,
      providerHistoryExhausted: row.exhausted,
      coverage: row.coverage_ciphertext ? 'verified' : 'partial',
      lastSyncAt: row.last_sync_at?.toISOString() ?? null,
      errorCode: row.error_code,
    },
  };
}
export async function listWallets(
  pool: Pool,
  accountId: string,
): Promise<LinkedWallet[]> {
  const keyring = configuredKeyring(),
    rows = await pool.query<WalletRow>(
      `${walletSelect} WHERE w.account_id=$1 ORDER BY w.created_at,w.id LIMIT 16`,
      [accountId],
    );
  return Promise.all(rows.rows.map((r) => view(pool, r, accountId, keyring)));
}
export async function getWallet(
  pool: Pool | PoolClient,
  accountId: string,
  id: string,
): Promise<LinkedWallet> {
  const row = await one<WalletRow>(
    pool,
    `${walletSelect} WHERE w.account_id=$1 AND w.id=$2`,
    [accountId, id],
  );
  requireCondition(
    row,
    404,
    'WALLET_NOT_FOUND',
    'This linked wallet is unavailable.',
  );
  return view(pool, row, accountId, configuredKeyring());
}
export async function linkWallet(
  pool: Pool,
  accountId: string,
  wallet: string,
  label: string,
): Promise<LinkedWallet> {
  const keyring = configuredKeyring();
  address(wallet);
  requireCondition(
    typeof label === 'string' && label.trim().length > 0 && label.length <= 80,
    400,
    'INVALID_WALLET_LABEL',
    'Use a wallet label of up to 80 characters.',
  );
  requireCondition(
    !scanPrompt(label).findings.some((f) => f.severity === 'block'),
    422,
    'SENSITIVE_CONTENT',
    'Remove the detected secret before saving.',
  );
  return transaction(pool, async (client) => {
    await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
      accountId,
    ]);
    // Check retained old keys too. A missing decryption key fails rather than creating duplicate links.
    const existing = await client.query<{
      id: string;
      address_ciphertext: string;
    }>(
      'SELECT id,address_ciphertext FROM second_look_wallets WHERE account_id=$1',
      [accountId],
    );
    for (const row of existing.rows)
      if (
        (await openWallet<string>(
          row.address_ciphertext,
          accountId,
          row.id,
          'address',
          keyring,
        )) === wallet
      )
        return getWallet(client, accountId, row.id);
    requireCondition(
      existing.rows.length < 16,
      409,
      'WALLET_LIMIT',
      'Up to 16 read-only wallets can be linked.',
    );
    const id = randomUUID(),
      digest = `${keyring.active}.${walletDigest(accountId, 'address', wallet, keyring)}`;
    await client.query(
      'INSERT INTO second_look_wallets(id,account_id,address_digest,address_ciphertext,label_ciphertext,assets_ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        accountId,
        digest,
        await sealWallet(wallet, accountId, id, 'address', keyring),
        await sealWallet(label.trim(), accountId, id, 'label', keyring),
        await sealWallet([], accountId, id, 'assets', keyring),
      ],
    );
    await client.query(
      'INSERT INTO second_look_wallet_jobs(wallet_id,account_id) VALUES($1,$2)',
      [id, accountId],
    );
    return getWallet(client, accountId, id);
  });
}
export async function unlinkWallet(pool: Pool, accountId: string, id: string) {
  await transaction(pool, async (client) => {
    // Serialize with account-scoped plan creation so unlink cannot leave a
    // reminder draft behind or race its ownership check.
    await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [
      accountId,
    ]);
    const result = await client.query(
      'DELETE FROM second_look_wallets WHERE id=$1 AND account_id=$2 RETURNING id',
      [id, accountId],
    );
    requireCondition(
      result.rowCount === 1,
      404,
      'WALLET_NOT_FOUND',
      'This linked wallet is unavailable.',
    );
  });
}
export async function queueWalletSync(
  pool: Pool,
  accountId: string,
  id: string,
) {
  await getWallet(pool, accountId, id);
  await pool.query(
    `UPDATE second_look_wallet_jobs SET state=CASE WHEN state='running' AND lease_until>now() THEN state ELSE 'queued' END,next_run_at=now(),error_code=NULL WHERE wallet_id=$1 AND account_id=$2`,
    [id, accountId],
  );
  return getWallet(pool, accountId, id);
}
export async function walletPnl(
  pool: Pool,
  accountId: string,
  id: string,
): Promise<WalletPnl> {
  const keyring = configuredKeyring();
  return transaction(pool, async (client) => {
    await client.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const wallet = await getWallet(client, accountId, id),
      job = await one<{ coverage_ciphertext: string | null }>(
        client,
        'SELECT coverage_ciphertext FROM second_look_wallet_jobs WHERE wallet_id=$1 AND account_id=$2',
        [id, accountId],
      );
    const coverage = job?.coverage_ciphertext
      ? await openWallet<WalletCoverage>(
          job.coverage_ciphertext,
          accountId,
          id,
          'coverage',
          keyring,
        )
      : null;
    const links = await client.query<{
      id: string;
      address_ciphertext: string;
    }>(
      'SELECT id,address_ciphertext FROM second_look_wallets WHERE account_id=$1',
      [accountId],
    );
    const linkedWallets = await Promise.all(
      links.rows.map((l) =>
        openWallet<string>(
          l.address_ciphertext,
          accountId,
          l.id,
          'address',
          keyring,
        ),
      ),
    );
    const rows = await client.query<{
      wallet_id: string;
      signature_digest: string;
      ledger_ciphertext: string;
    }>(
      `SELECT wallet_id,signature_digest,ledger_ciphertext FROM second_look_wallet_transactions WHERE account_id=$1 AND state='finalized' ORDER BY slot,signature_digest,wallet_id LIMIT 20001`,
      [accountId],
    );
    const trades: WalletTrade[] = [];
    for (const row of rows.rows.slice(0, 20000))
      trades.push(
        await openWallet<WalletTrade>(
          row.ledger_ciphertext,
          accountId,
          row.wallet_id,
          'ledger',
          keyring,
          row.signature_digest,
        ),
      );
    const unresolved = await one<{ n: string }>(
      client,
      `SELECT count(*)::text AS n FROM second_look_wallet_transactions WHERE account_id=$1 AND state<>'finalized'`,
      [accountId],
    );
    const prices = await client.query<{
      wallet_id: string;
      price_digest: string;
      price_ciphertext: string;
    }>(
      `SELECT wallet_id,price_digest,price_ciphertext FROM second_look_wallet_prices WHERE account_id=$1 AND priced=true ORDER BY checked_at LIMIT 100000`,
      [accountId],
    );
    const now = new Date(),
      asOf = coverage ? new Date(coverage.asOf) : now,
      opening = new Date(
        Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1),
      ).toISOString();
    const book: PriceBook = { historical: {}, opening: {}, current: {} };
    for (const row of prices.rows) {
      const p = await openWallet<{
        mint: string;
        at: string;
        price: WalletPrice;
      }>(
        row.price_ciphertext,
        accountId,
        row.wallet_id,
        'price',
        keyring,
        row.price_digest,
      );
      book.historical[priceKey(p.mint, p.at)] = p.price;
      if (p.at === opening) book.opening[p.mint] = p.price;
      if (Math.abs(Date.parse(p.at) - asOf.getTime()) <= 300000)
        book.current[p.mint] = p.price;
    }
    const result = calculateWalletPnl({
      walletId: id,
      wallet: wallet.address,
      trades,
      prices: book,
      coverage,
      linkedWallets,
      asOf,
      unresolvedTransactions:
        Number(unresolved!.n) + (rows.rows.length > 20000 ? 1 : 0),
    });
    if (now.getTime() - asOf.getTime() > 300000) {
      result.complete = false;
      result.coverage = 'partial';
      result.netUsd6 = null;
      result.realizedUsd6 = null;
      result.unrealizedChangeUsd6 = null;
      result.exceptions.push('SNAPSHOT_STALE');
    }
    if (rows.rows.length > 20000)
      result.exceptions.push('LEDGER_CALCULATION_LIMIT');
    return result;
  });
}
