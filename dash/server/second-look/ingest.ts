import type { Pool, PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { one, transaction } from '../db/database.ts';
import { parseWalletTrade, type WalletTrade } from './trade-parser.ts';
import {
  createWalletSource,
  readWalletPrice,
  WalletSourceError,
  type IngestSource,
} from './ingest-source.ts';
import {
  walletIngestConfig,
  type WalletIngestConfig,
} from './wallet-config.ts';
import type { WalletCoverage, WalletPrice } from './pnl.ts';
import {
  configuredKeyring,
  sealWallet,
  openWallet,
  walletDigest,
  walletKeyId,
  type DataKeyring,
} from './wallet-crypto.ts';
type Job = {
  wallet_id: string;
  account_id: string;
  address: string;
  cursor: string | null;
  snapshot_id: string | null;
  exhausted: boolean;
  mode: 'backfill' | 'head';
  lease_token: string;
  source_kind: string | null;
  source_revision: string | null;
  keyId: string;
  keyring: DataKeyring;
};
export type IngestOptions = {
  config?: WalletIngestConfig;
  source?: IngestSource;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};
export type IngestResult = {
  processed: boolean;
  transactions: number;
  state: 'idle' | 'queued' | 'blocked' | 'lease_lost' | 'disabled';
};
const parserOptions = (config: WalletIngestConfig) => ({
  jitoAccounts: config.jitoAccounts,
  platformAccounts: config.platformAccounts,
  feePolicyReviewed: Boolean(config.feePolicyId),
});
const digest = (job: Job, kind: string, value: string) =>
  walletDigest(
    job.account_id,
    `${job.wallet_id}:${kind}`,
    value,
    job.keyring,
    job.keyId,
  );
const seal = (job: Job, value: unknown, kind: string, id = '') =>
  sealWallet(value, job.account_id, job.wallet_id, kind, job.keyring, id);
async function ownedLease(client: PoolClient, job: Job) {
  // Wallet before job: unlink takes the same order through its cascade.
  if (
    !(await one(
      client,
      'SELECT id FROM second_look_wallets WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [job.wallet_id, job.account_id],
    ))
  )
    return null;
  return one(
    client,
    `SELECT wallet_id FROM second_look_wallet_jobs WHERE wallet_id=$1 AND account_id=$2 AND lease_token=$3 AND lease_until>now() FOR UPDATE`,
    [job.wallet_id, job.account_id, job.lease_token],
  );
}
async function queuePrice(
  client: PoolClient,
  job: Job,
  mint: string,
  at: string,
  kind: 'historical' | 'mark',
) {
  const id = digest(job, 'price', JSON.stringify([mint, at]));
  await client.query(
    `INSERT INTO second_look_wallet_prices(wallet_id,account_id,price_digest,price_at,price_ciphertext,kind,checked_at) VALUES($1,$2,$3,$4,$5,$6,'epoch') ON CONFLICT(wallet_id,price_digest) DO NOTHING`,
    [
      job.wallet_id,
      job.account_id,
      id,
      at,
      await seal(job, { mint, at, price: null }, 'price', id),
      kind,
    ],
  );
}
async function saveTrade(
  client: PoolClient,
  job: Job,
  trade: WalletTrade,
  state: 'confirmed' | 'finalized',
  snapshotId: string | null,
) {
  const id = digest(job, 'signature', trade.signature);
  await client.query(
    `INSERT INTO second_look_wallet_transactions(wallet_id,account_id,signature_digest,locator_ciphertext,slot,state,ledger_ciphertext,snapshot_digest,last_checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(wallet_id,signature_digest) DO UPDATE SET slot=EXCLUDED.slot,state=EXCLUDED.state,ledger_ciphertext=EXCLUDED.ledger_ciphertext,snapshot_digest=EXCLUDED.snapshot_digest,last_checked_at=now(),missing_observations=0 WHERE second_look_wallet_transactions.account_id=EXCLUDED.account_id AND (second_look_wallet_transactions.state<>'finalized' OR EXCLUDED.state='finalized')`,
    [
      job.wallet_id,
      job.account_id,
      id,
      await seal(job, { signature: trade.signature }, 'locator', id),
      trade.slot,
      state,
      await seal(job, trade, 'ledger', id),
      snapshotId ? digest(job, 'snapshot', snapshotId) : null,
    ],
  );
  if (state !== 'finalized') return;
  const row = await one<{ assets_ciphertext: string }>(
    client,
    'SELECT assets_ciphertext FROM second_look_wallets WHERE id=$1 AND account_id=$2',
    [job.wallet_id, job.account_id],
  );
  const assets = await openWallet<{ mint: string; decimals: number }[]>(
    row!.assets_ciphertext,
    job.account_id,
    job.wallet_id,
    'assets',
    job.keyring,
  );
  const mints = new Map(assets.map((a) => [a.mint, a]));
  for (const d of [...trade.deltas, ...trade.fees])
    mints.set(d.mint, { mint: d.mint, decimals: d.decimals });
  if (mints.size > 512) throw new WalletSourceError('WALLET_ASSET_LIMIT');
  await client.query(
    'UPDATE second_look_wallets SET assets_ciphertext=$3 WHERE id=$1 AND account_id=$2',
    [
      job.wallet_id,
      job.account_id,
      await seal(job, [...mints.values()], 'assets'),
    ],
  );
  if (trade.timestamp)
    for (const mint of new Set(
      [...trade.deltas, ...trade.fees].map((d) => d.mint),
    ))
      await queuePrice(client, job, mint, trade.timestamp, 'historical');
}
/** Null status never proves absence; remove provisional economics, retain a retryable gap. */
export function finalizationDecision(
  status: { slot: string; state: 'confirmed' | 'finalized' } | null,
  originalSlot: string,
  finalizedSlot: string,
): 'finalized' | 'pending' | 'remove_provisional' {
  if (status?.state === 'finalized') return 'finalized';
  if (!status && BigInt(finalizedSlot) > BigInt(originalSlot) + 64n)
    return 'remove_provisional';
  return 'pending';
}
async function fillPrices(
  pool: Pool,
  job: Job,
  config: WalletIngestConfig,
  options: IngestOptions,
  coverage: WalletCoverage | null,
) {
  if (!config.priceUrl && !(config.solSpotEnabled && config.rpcUrl)) return;
  const now =
      coverage?.asOf ??
      new Date(Math.floor(Date.now() / 300000) * 300000).toISOString(),
    date = new Date(now),
    opening = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    ).toISOString();
  await transaction(pool, async (client) => {
    if (!(await ownedLease(client, job))) return;
    const row = await one<{ assets_ciphertext: string }>(
      client,
      'SELECT assets_ciphertext FROM second_look_wallets WHERE id=$1 AND account_id=$2',
      [job.wallet_id, job.account_id],
    );
    const assets = await openWallet<{ mint: string }[]>(
      row!.assets_ciphertext,
      job.account_id,
      job.wallet_id,
      'assets',
      job.keyring,
    );
    for (const asset of assets)
      for (const at of [opening, now])
        await queuePrice(client, job, asset.mint, at, 'mark');
  });
  const pending = await pool.query<{
    price_digest: string;
    price_ciphertext: string;
  }>(
    `(SELECT price_digest,price_ciphertext FROM second_look_wallet_prices WHERE wallet_id=$1 AND account_id=$2 AND kind='historical' AND priced=false AND checked_at<now()-interval '5 minutes' ORDER BY checked_at,price_at LIMIT 14) UNION ALL (SELECT price_digest,price_ciphertext FROM second_look_wallet_prices WHERE wallet_id=$1 AND account_id=$2 AND kind='mark' AND priced=false AND checked_at<now()-interval '5 minutes' ORDER BY price_at DESC,checked_at LIMIT 6)`,
    [job.wallet_id, job.account_id],
  );
  for (const row of pending.rows) {
    if (options.signal?.aborted) break;
    const request = await openWallet<{ mint: string; at: string }>(
      row.price_ciphertext,
      job.account_id,
      job.wallet_id,
      'price',
      job.keyring,
      row.price_digest,
    );
    let price: WalletPrice | null;
    try {
      price = await readWalletPrice(
        config,
        request.mint,
        request.at,
        options.fetcher,
        options.signal,
      );
    } catch {
      price = null;
    }
    const saved = await transaction(pool, async (client) => {
      if (!(await ownedLease(client, job))) return false;
      await client.query(
        `UPDATE second_look_wallet_prices SET price_ciphertext=$4,priced=$5,checked_at=now() WHERE wallet_id=$1 AND account_id=$2 AND price_digest=$3`,
        [
          job.wallet_id,
          job.account_id,
          row.price_digest,
          await seal(job, { ...request, price }, 'price', row.price_digest),
          price !== null,
        ],
      );
      return true;
    });
    if (!saved) break;
  }
}
/** One bounded page; persisted cursors, locators, ledger, coverage and price payloads are encrypted. */
export async function runWalletIngestOnce(
  pool: Pool,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const config = options.config ?? walletIngestConfig(),
    source = options.source ?? createWalletSource(config, options.fetcher);
  if (!config.enabled || !source)
    return { processed: false, transactions: 0, state: 'disabled' };
  const keyring = configuredKeyring(),
    sourceRevision = createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex');
  type Claim = {
    wallet_id: string;
    account_id: string;
    address_digest: string;
    address_ciphertext: string;
    cursor_ciphertext: string | null;
    snapshot_ciphertext: string | null;
    exhausted: boolean;
    mode: 'backfill' | 'head';
    source_kind: string | null;
    source_revision: string | null;
  };
  const job = await transaction(pool, async (client) => {
    const selected = await one<Claim>(
      client,
      `SELECT j.wallet_id,j.account_id,w.address_digest,w.address_ciphertext,j.cursor_ciphertext,j.snapshot_ciphertext,j.exhausted,j.mode,j.source_kind,j.source_revision FROM second_look_wallet_jobs j JOIN second_look_wallets w ON w.id=j.wallet_id AND w.account_id=j.account_id WHERE j.next_run_at<=now() AND (j.lease_until IS NULL OR j.lease_until<now()) ORDER BY j.next_run_at,j.wallet_id FOR UPDATE OF w,j SKIP LOCKED LIMIT 1`,
    );
    if (!selected) return null;
    const changed =
      selected.source_revision !== null &&
      selected.source_revision !== sourceRevision;
    const address = await openWallet<string>(
      selected.address_ciphertext,
      selected.account_id,
      selected.wallet_id,
      'address',
      keyring,
    );
    const cursor = changed
      ? null
      : selected.cursor_ciphertext
        ? await openWallet<string>(
            selected.cursor_ciphertext,
            selected.account_id,
            selected.wallet_id,
            'cursor',
            keyring,
          )
        : null;
    const snapshot = changed
      ? null
      : selected.snapshot_ciphertext
        ? await openWallet<string>(
            selected.snapshot_ciphertext,
            selected.account_id,
            selected.wallet_id,
            'snapshot',
            keyring,
          )
        : null;
    if (changed) {
      await client.query(
        'DELETE FROM second_look_wallet_prices WHERE wallet_id=$1 AND account_id=$2',
        [selected.wallet_id, selected.account_id],
      );
      await client.query(
        "UPDATE second_look_wallet_jobs SET cursor_ciphertext=NULL,snapshot_ciphertext=NULL,coverage_ciphertext=NULL,exhausted=false,mode='backfill' WHERE wallet_id=$1 AND account_id=$2",
        [selected.wallet_id, selected.account_id],
      );
    }
    const lease = randomUUID();
    await client.query(
      `UPDATE second_look_wallet_jobs SET state='running',lease_token=$3,lease_until=now()+interval '15 minutes',source_kind=$4,source_revision=$5 WHERE wallet_id=$1 AND account_id=$2`,
      [
        selected.wallet_id,
        selected.account_id,
        lease,
        source.kind,
        sourceRevision,
      ],
    );
    return {
      ...selected,
      address,
      cursor,
      snapshot_id: snapshot,
      mode: changed ? ('backfill' as const) : selected.mode,
      exhausted: changed ? false : selected.exhausted,
      lease_token: lease,
      keyId: walletKeyId(selected.address_digest),
      keyring,
    };
  });
  if (!job) return { processed: false, transactions: 0, state: 'idle' };
  let count = 0;
  try {
    const pendingRows = await pool.query<{
      signature_digest: string;
      locator_ciphertext: string;
      slot: string;
    }>(
      `SELECT signature_digest,locator_ciphertext,slot::text FROM second_look_wallet_transactions WHERE wallet_id=$1 AND account_id=$2 AND state<>'finalized' AND (last_checked_at IS NULL OR last_checked_at<now()-interval '30 seconds') ORDER BY last_checked_at NULLS FIRST,slot LIMIT 10`,
      [job.wallet_id, job.account_id],
    );
    const pending = await Promise.all(
      pendingRows.rows.map(async (row) => ({
        ...row,
        ...(await openWallet<{ signature: string }>(
          row.locator_ciphertext,
          job.account_id,
          job.wallet_id,
          'locator',
          keyring,
          row.signature_digest,
        )),
      })),
    );
    if (pending.length && source.kind === 'rpc') {
      const status = await source.statuses(
        pending.map((r) => r.signature),
        options.signal,
      );
      for (let i = 0; i < pending.length; i++) {
        const row = pending[i],
          decision = finalizationDecision(
            status.values[i],
            row.slot,
            status.finalizedSlot,
          );
        if (decision === 'finalized') {
          const value = await source.transaction(
            row.signature,
            'finalized',
            options.signal,
          );
          if (value) {
            const trade = parseWalletTrade(
              value,
              job.address,
              row.signature,
              parserOptions(config),
            );
            if (trade.slot !== status.values[i]?.slot)
              throw new WalletSourceError('WALLET_FINALITY_MISMATCH');
            await transaction(pool, async (client) => {
              if (await ownedLease(client, job))
                await saveTrade(client, job, trade, 'finalized', null);
            });
            count++;
          }
        } else if (decision === 'remove_provisional')
          await transaction(pool, async (client) => {
            if (await ownedLease(client, job))
              await client.query(
                `UPDATE second_look_wallet_transactions SET state='unavailable',ledger_ciphertext=NULL,last_checked_at=now(),missing_observations=missing_observations+1 WHERE wallet_id=$1 AND account_id=$2 AND signature_digest=$3 AND state<>'finalized'`,
                [job.wallet_id, job.account_id, row.signature_digest],
              );
          });
      }
    }
    const page = await source.page(
        job.address,
        job.cursor,
        job.snapshot_id,
        options.signal,
      ),
      parsed: { trade: WalletTrade; state: 'confirmed' | 'finalized' }[] = [],
      unavailable: typeof page.entries = [];
    for (const entry of page.entries) {
      if (options.signal?.aborted)
        throw new WalletSourceError('WALLET_INGEST_CANCELLED');
      const value =
        entry.transaction ??
        (await source.transaction(
          entry.signature,
          entry.confirmation,
          options.signal,
        ));
      if (!value) {
        unavailable.push(entry);
        continue;
      }
      try {
        const trade = parseWalletTrade(value, job.address, entry.signature, {
          ...parserOptions(config),
          transactionIndex: entry.transactionIndex,
          airdropSignatures: entry.airdrop ? [entry.signature] : [],
        });
        if (trade.slot !== entry.slot) throw new Error();
        parsed.push({ trade, state: entry.confirmation });
      } catch {
        unavailable.push(entry);
      }
    }
    let overlap = false;
    if (source.kind === 'rpc' && job.mode === 'head' && page.entries.length) {
      const old = await pool.query(
        `SELECT signature_digest FROM second_look_wallet_transactions WHERE wallet_id=$1 AND account_id=$2 AND signature_digest=ANY($3::text[]) AND state='finalized'`,
        [
          job.wallet_id,
          job.account_id,
          page.entries.map((e) => digest(job, 'signature', e.signature)),
        ],
      );
      overlap = Boolean(old.rowCount);
    }
    const done = page.exhausted || overlap,
      snapshotDigest = page.snapshotId
        ? digest(job, 'snapshot', page.snapshotId)
        : null;
    const saved = await transaction(pool, async (client) => {
      if (!(await ownedLease(client, job))) return false;
      for (const item of parsed)
        await saveTrade(client, job, item.trade, item.state, page.snapshotId);
      for (const entry of unavailable) {
        const id = digest(job, 'signature', entry.signature);
        await client.query(
          `INSERT INTO second_look_wallet_transactions(wallet_id,account_id,signature_digest,locator_ciphertext,slot,state,snapshot_digest,last_checked_at,attempts) VALUES($1,$2,$3,$4,$5,'unavailable',$6,now(),1) ON CONFLICT(wallet_id,signature_digest) DO UPDATE SET attempts=second_look_wallet_transactions.attempts+1,snapshot_digest=EXCLUDED.snapshot_digest,last_checked_at=now() WHERE second_look_wallet_transactions.account_id=EXCLUDED.account_id`,
          [
            job.wallet_id,
            job.account_id,
            id,
            await seal(job, { signature: entry.signature }, 'locator', id),
            entry.slot,
            snapshotDigest,
          ],
        );
      }
      if (page.coverage) {
        const recorded = await one<{ n: string }>(
          client,
          `SELECT count(*)::text AS n FROM second_look_wallet_transactions WHERE wallet_id=$1 AND account_id=$2 AND snapshot_digest=$3 AND state='finalized'`,
          [job.wallet_id, job.account_id, snapshotDigest],
        );
        if (Number(recorded!.n) !== page.coverage.transactionCount)
          throw new WalletSourceError('WALLET_ARCHIVE_COUNT_MISMATCH');
        await client.query(
          `DELETE FROM second_look_wallet_transactions WHERE wallet_id=$1 AND account_id=$2 AND snapshot_digest IS DISTINCT FROM $3`,
          [job.wallet_id, job.account_id, snapshotDigest],
        );
      }
      await client.query(
        `UPDATE second_look_wallet_jobs SET cursor_ciphertext=$4,snapshot_ciphertext=$5,pages=pages+1,exhausted=exhausted OR $6,coverage_ciphertext=$7,error_code=NULL,last_sync_at=now(),mode=$8 WHERE wallet_id=$1 AND account_id=$2 AND lease_token=$3`,
        [
          job.wallet_id,
          job.account_id,
          job.lease_token,
          done || !page.nextCursor
            ? null
            : await seal(job, page.nextCursor, 'cursor'),
          done || !page.snapshotId
            ? null
            : await seal(job, page.snapshotId, 'snapshot'),
          done,
          page.coverage ? await seal(job, page.coverage, 'coverage') : null,
          done ? 'head' : job.mode,
        ],
      );
      return true;
    });
    if (!saved)
      return { processed: true, transactions: 0, state: 'lease_lost' };
    count += parsed.length;
    await fillPrices(pool, job, config, options, page.coverage);
    const updated = await pool.query(
      `UPDATE second_look_wallet_jobs SET state=$4,lease_token=NULL,lease_until=NULL,next_run_at=now()+($5::integer*interval '1 second') WHERE wallet_id=$1 AND account_id=$2 AND lease_token=$3 AND lease_until>now()`,
      [
        job.wallet_id,
        job.account_id,
        job.lease_token,
        done ? 'idle' : 'queued',
        done ? 300 : 1,
      ],
    );
    return {
      processed: true,
      transactions: count,
      state: updated.rowCount ? (done ? 'idle' : 'queued') : 'lease_lost',
    };
  } catch (error) {
    const code =
      error instanceof WalletSourceError
        ? error.code
        : 'WALLET_SOURCE_UNAVAILABLE';
    await pool.query(
      `UPDATE second_look_wallet_jobs SET state='blocked',error_code=$4,lease_token=NULL,lease_until=NULL,next_run_at=now()+interval '1 minute' WHERE wallet_id=$1 AND account_id=$2 AND lease_token=$3`,
      [job.wallet_id, job.account_id, job.lease_token, code],
    );
    return { processed: true, transactions: count, state: 'blocked' };
  }
}
