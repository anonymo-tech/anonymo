import { randomUUID } from 'node:crypto';
import type { WalletCoverage, WalletPrice } from './pnl.ts';
import { decimalRatio } from './pnl.ts';
import type { WalletIngestConfig } from './wallet-config.ts';
import { safeWalletEndpoint } from './wallet-config.ts';
import { readPythSolSpot } from './wallet-pyth.ts';
import {
  record,
  list,
  uint,
  address,
  signature,
  amount,
  assertGenesis,
  requireSolana,
  SOLANA_NETWORKS,
} from '../solana/validation.ts';

export type HistoryEntry = {
  transactionIndex?: number;
  airdrop?: boolean;
  signature: string;
  slot: string;
  timestamp: string | null;
  confirmation: 'confirmed' | 'finalized';
  transaction?: unknown;
};
export type HistoryPage = {
  entries: HistoryEntry[];
  nextCursor: string | null;
  exhausted: boolean;
  snapshotId: string | null;
  coverage: WalletCoverage | null;
};
export type IngestSource = {
  kind: 'rpc' | 'archive';
  page(
    wallet: string,
    cursor: string | null,
    snapshotId: string | null,
    signal?: AbortSignal,
  ): Promise<HistoryPage>;
  transaction(
    signature: string,
    commitment: 'confirmed' | 'finalized',
    signal?: AbortSignal,
  ): Promise<unknown>;
  statuses(
    signatures: string[],
    signal?: AbortSignal,
  ): Promise<{
    finalizedSlot: string;
    values: ({ slot: string; state: 'confirmed' | 'finalized' } | null)[];
  }>;
};
export class WalletSourceError extends Error {
  readonly code: string;
  constructor(code = 'WALLET_SOURCE_UNAVAILABLE') {
    super(code);
    this.code = code;
    this.name = 'WalletSourceError';
  }
}
export function utc(value: unknown): string {
  requireSolana(
    typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'invalid_response',
  );
  return new Date(value).toISOString();
}
function integerText(value: unknown) {
  requireSolana(
    typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value),
    'invalid_response',
  );
  return value;
}
function cursor(value: unknown) {
  requireSolana(
    value === null ||
      (typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value)),
    'invalid_response',
  );
  return value as string | null;
}
function boundedCount(value: unknown, max: number) {
  return uint(value, max);
}
/** HTTPS endpoint is operator configuration. Never returns its URL or arbitrary upstream errors. */
export async function readWalletJson(
  endpoint: string,
  payload: unknown,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  maximumBytes = 4_194_304,
): Promise<unknown> {
  if (!safeWalletEndpoint(endpoint))
    throw new WalletSourceError('WALLET_SOURCE_CONFIGURATION');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 15_000);
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const stop = () => reject(new WalletSourceError('WALLET_SOURCE_TIMEOUT'));
      if (controller.signal.aborted) {
        stop();
        return;
      }
      controller.signal.addEventListener('abort', stop, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', stop))
        .catch(() => {});
    });
  try {
    if (controller.signal.aborted)
      throw new WalletSourceError('WALLET_SOURCE_TIMEOUT');
    const response = await wait(
      fetcher(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      }),
    );
    if (
      !response.ok ||
      response.redirected ||
      (response.url && response.url !== endpoint) ||
      !response.body
    )
      throw new WalletSourceError();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '',
      bytes = 0;
    try {
      while (true) {
        const part = await wait(reader.read());
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maximumBytes)
          throw new WalletSourceError('WALLET_RESPONSE_TOO_LARGE');
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (controller.signal.aborted)
      throw new WalletSourceError('WALLET_SOURCE_TIMEOUT');
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof WalletSourceError) throw error;
    throw new WalletSourceError(
      controller.signal.aborted
        ? 'WALLET_SOURCE_TIMEOUT'
        : 'WALLET_SOURCE_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export function parseCoverage(
  value: unknown,
  wallet: string,
  sourceId: string,
  snapshotId: string,
  feePolicyId: string | null,
): WalletCoverage {
  const r = record(value);
  requireSolana(
    r.sourceId === sourceId &&
      r.snapshotId === snapshotId &&
      r.wallet === wallet &&
      r.genesisHash === SOLANA_NETWORKS['mainnet-beta'].genesisHash &&
      r.startsAtGenesis === true &&
      r.includesClosedTokenAccounts === true &&
      r.includesDelegatedTransfers === true &&
      r.holdingsIncludeRentReserves === true &&
      feePolicyId !== null &&
      r.feePolicyId === feePolicyId,
    'invalid_response',
  );
  const asOf = utc(r.asOf);
  requireSolana(Date.parse(asOf) <= Date.now() + 60_000, 'invalid_response');
  const holdings = list(r.holdings, 512).map((v) => {
    const h = record(v);
    return {
      mint: address(h.mint),
      decimals: uint(h.decimals, 18),
      amount: amount(h.amount).toString(),
    };
  });
  requireSolana(
    new Set(holdings.map((h) => h.mint)).size === holdings.length,
    'invalid_response',
  );
  return {
    sourceId,
    snapshotId,
    wallet,
    genesisHash: r.genesisHash,
    asOf,
    asOfSlot: integerText(r.asOfSlot),
    startsAtGenesis: true,
    includesClosedTokenAccounts: true,
    includesDelegatedTransfers: true,
    feePolicyId,
    transactionCount: boundedCount(r.transactionCount, 5_000_000),
    holdings,
  };
}
export function createWalletSource(
  config: WalletIngestConfig,
  fetcher: typeof fetch = fetch,
): IngestSource | null {
  if (!config.enabled || (!config.rpcUrl && !config.archiveUrl)) return null;
  const rpc = async (
    method: string,
    params: unknown[],
    signal?: AbortSignal,
  ) => {
    if (!config.rpcUrl) throw new WalletSourceError('WALLET_RPC_REQUIRED');
    const id = randomUUID(),
      r = record(
        await readWalletJson(
          config.rpcUrl,
          { jsonrpc: '2.0', id, method, params },
          fetcher,
          signal,
        ),
      );
    requireSolana(
      r.id === id &&
        r.jsonrpc === '2.0' &&
        !Object.hasOwn(r, 'error') &&
        Object.hasOwn(r, 'result'),
      'invalid_response',
    );
    return r.result;
  };
  // One immutable endpoint per bounded job; retry after failures without caching
  // a rejected promise. Avoid a redundant network check for every transaction.
  let genesisVerified = false;
  const genesis = async (signal?: AbortSignal) => {
    if (genesisVerified) return;
    assertGenesis('mainnet-beta', await rpc('getGenesisHash', [], signal));
    genesisVerified = true;
  };
  const rpcSource: IngestSource = {
    kind: 'rpc',
    async page(wallet, before, _snapshot, signal) {
      address(wallet);
      if (before) signature(before);
      await genesis(signal);
      const values = list(
        await rpc(
          'getSignaturesForAddress',
          [
            wallet,
            {
              commitment: 'confirmed',
              limit: 25,
              ...(before ? { before } : {}),
            },
          ],
          signal,
        ),
        25,
      );
      const entries: HistoryEntry[] = values.map((v) => {
        const r = record(v);
        requireSolana(
          r.confirmationStatus === 'confirmed' ||
            r.confirmationStatus === 'finalized',
          'invalid_response',
        );
        return {
          signature: signature(r.signature),
          slot: String(uint(r.slot)),
          timestamp:
            r.blockTime === null
              ? null
              : new Date(uint(r.blockTime) * 1000).toISOString(),
          confirmation: r.confirmationStatus,
        };
      });
      requireSolana(
        new Set(entries.map((e) => e.signature)).size === entries.length &&
          entries.every(
            (e, i) => i === 0 || BigInt(e.slot) <= BigInt(entries[i - 1].slot),
          ) &&
          !entries.some((e) => e.signature === before),
        'invalid_response',
      );
      return {
        entries,
        nextCursor: entries.at(-1)?.signature ?? null,
        exhausted: entries.length === 0,
        snapshotId: null,
        coverage: null,
      };
    },
    async transaction(sig, commitment, signal) {
      signature(sig);
      await genesis(signal);
      return rpc(
        'getTransaction',
        [
          sig,
          {
            commitment,
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          },
        ],
        signal,
      );
    },
    async statuses(signatures, signal) {
      signatures.forEach(signature);
      requireSolana(signatures.length <= 25, 'invalid_input');
      await genesis(signal);
      const r = record(
        await rpc(
          'getSignatureStatuses',
          [signatures, { searchTransactionHistory: true }],
          signal,
        ),
      );
      const values = list(r.value, 25);
      requireSolana(values.length === signatures.length, 'invalid_response');
      const slot = String(
        uint(await rpc('getSlot', [{ commitment: 'finalized' }], signal)),
      );
      return {
        finalizedSlot: slot,
        values: values.map((v) => {
          if (v === null) return null;
          const s = record(v);
          requireSolana(
            s.confirmationStatus === 'confirmed' ||
              s.confirmationStatus === 'finalized',
            'invalid_response',
          );
          return { slot: String(uint(s.slot)), state: s.confirmationStatus };
        }),
      };
    },
  };
  if (!config.archiveUrl || !config.archiveSourceId) return rpcSource;
  return {
    ...rpcSource,
    kind: 'archive',
    async page(wallet, after, snapshot, signal) {
      address(wallet);
      cursor(after);
      if (snapshot)
        requireSolana(/^[A-Za-z0-9_-]{1,128}$/.test(snapshot), 'invalid_input');
      const r = record(
        await readWalletJson(
          config.archiveUrl!,
          {
            version: 1,
            operation: 'wallet-history',
            cluster: 'mainnet-beta',
            wallet,
            cursor: after,
            snapshotId: snapshot,
            limit: 25,
          },
          fetcher,
          signal,
        ),
      );
      assertGenesis('mainnet-beta', r.genesisHash);
      requireSolana(
        r.version === 1 &&
          r.sourceId === config.archiveSourceId &&
          r.wallet === wallet &&
          typeof r.snapshotId === 'string' &&
          /^[A-Za-z0-9_-]{1,128}$/.test(r.snapshotId) &&
          (!snapshot || r.snapshotId === snapshot),
        'invalid_response',
      );
      const next = cursor(r.nextCursor);
      requireSolana(next !== after || next === null, 'invalid_response');
      const entries = list(r.transactions, 25).map((value) => {
        const t = record(value),
          tx = record(t.transaction);
        return {
          transactionIndex: uint(t.transactionIndex, 1000000),
          airdrop: t.airdrop === true,
          signature: signature(list(tx.signatures, 64)[0]),
          slot: String(uint(t.slot)),
          timestamp:
            t.blockTime === null
              ? null
              : new Date(uint(t.blockTime) * 1000).toISOString(),
          confirmation: 'finalized' as const,
          transaction: value,
        };
      });
      requireSolana(
        new Set(entries.map((e) => e.signature)).size === entries.length &&
          (entries.length > 0 || next === null),
        'invalid_response',
      );
      return {
        entries,
        nextCursor: next,
        exhausted: next === null,
        snapshotId: r.snapshotId,
        coverage:
          next === null
            ? parseCoverage(
                r.coverage,
                wallet,
                config.archiveSourceId!,
                r.snapshotId,
                config.feePolicyId,
              )
            : null,
      };
    },
  };
}
export function parseWalletPrice(
  value: unknown,
  mint: string,
  at: string,
): WalletPrice {
  const p = record(value);
  requireSolana(
    p.mint === mint &&
      typeof p.priceUsd === 'string' &&
      typeof p.liquidityUsd === 'string' &&
      typeof p.estimated === 'boolean' &&
      typeof p.source === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(p.source),
    'invalid_response',
  );
  decimalRatio(p.priceUsd);
  decimalRatio(p.liquidityUsd);
  const observed = utc(p.at),
    lastTradeAt = utc(p.lastTradeAt);
  requireSolana(
    Math.abs(Date.parse(observed) - Date.parse(at)) <= 300_000 &&
      Date.parse(lastTradeAt) <= Date.parse(observed) + 60_000,
    'invalid_response',
  );
  return {
    mint,
    priceUsd: p.priceUsd,
    liquidityUsd: p.liquidityUsd,
    at: observed,
    lastTradeAt,
    estimated: p.estimated,
    source: p.source,
  };
}
export async function readWalletPrice(
  config: WalletIngestConfig,
  mint: string,
  at: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WalletPrice | null> {
  address(mint);
  utc(at);
  if (!config.priceUrl) {
    if (!config.solSpotEnabled || !config.rpcUrl) return null;
    return readPythSolSpot(
      async (method, params) => {
        const id = randomUUID();
        const response = record(
          await readWalletJson(
            config.rpcUrl!,
            { jsonrpc: '2.0', id, method, params },
            fetcher,
            signal,
            16384,
          ),
        );
        requireSolana(
          response.jsonrpc === '2.0' &&
            response.id === id &&
            !Object.hasOwn(response, 'error') &&
            Object.hasOwn(response, 'result'),
          'invalid_response',
        );
        return response.result;
      },
      mint,
      at,
    );
  }
  const r = record(
    await readWalletJson(
      config.priceUrl,
      { version: 1, operation: 'price', cluster: 'mainnet-beta', mint, at },
      fetcher,
      signal,
      16384,
    ),
  );
  if (r.price === null) return null;
  return parseWalletPrice(r.price, mint, at);
}
