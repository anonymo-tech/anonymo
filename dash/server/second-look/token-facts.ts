import { runForkProbe, type ForkProbeConfig } from './providers-simulation.ts';
import { readMetaplex } from './token-metadata.ts';
import bs58 from 'bs58';
import { requireCondition } from '../core/errors.ts';
import {
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  address,
} from '../solana/validation.ts';
import {
  object,
  safeText,
  integer,
  finite,
  canonicalAmount,
  createTokenProviders,
  type TokenProviders,
} from './providers.ts';
import {
  TOKEN_CHECK_LABELS,
  type TokenCheck,
  type TokenCheckId,
  type TokenFact,
  type TokenSource,
} from '../../lib/second-look/token.ts';
export type TokenFacts = {
  mint: string;
  observedAt: string;
  ageSeconds: number | null;
  checks: TokenCheck[];
};
export const fact = (
  key: string,
  label: string,
  value: TokenFact['value'],
): TokenFact => ({ key, label, value });
export function blankChecks(): TokenCheck[] {
  return TOKEN_CHECK_LABELS.map((label, i) => ({
    id: (i + 1) as TokenCheckId,
    label,
    status: 'pending',
    risk: null,
    facts: [],
    sources: [],
    limitations: [],
  }));
}
export function source(
  provider: TokenSource['provider'],
  now: number,
  slot: string | null = null,
  reference: string | null = null,
): TokenSource {
  return {
    provider,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30000).toISOString(),
    slot,
    reference,
  };
}
function valid(condition: unknown): asserts condition {
  requireCondition(
    condition,
    503,
    'TOKEN_SOURCE_INVALID',
    'Token account data is invalid.',
  );
}
function key(bytes: Uint8Array) {
  valid(bytes.length === 32);
  return bytes.every((b) => b === 0) ? null : bs58.encode(bytes);
}
function view(b: Uint8Array) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
function metadata(bytes: Uint8Array, mint: string): TokenFact[] {
  valid(bytes.length >= 76);
  let at = 64;
  const take = () => {
    valid(at + 4 <= bytes.length);
    const len = view(bytes).getUint32(at, true);
    at += 4;
    valid(len <= 512 && at + len <= bytes.length);
    const text = safeText(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(at, at + len),
      ),
      512,
    );
    at += len;
    return text;
  };
  valid(bs58.encode(bytes.subarray(32, 64)) === mint);
  const name = take(),
    symbol = take(),
    uri = take();
  let host: string | null = null;
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:' && !u.username && !u.password)
      host = u.hostname;
  } catch {
    /* URI is only displayed as a host, never fetched. */
  }
  return [
    fact(
      'metadataMutable',
      'Metadata can be updated',
      key(bytes.subarray(0, 32)) !== null,
    ),
    fact(
      'metadataAuthority',
      'Metadata update authority',
      key(bytes.subarray(0, 32)),
    ),
    fact('name', 'Name', name),
    fact('symbol', 'Symbol', symbol),
    fact('uriHost', 'Metadata URI host', host),
  ];
}
/** Canonical mint and TLV state, without trusting RPC parser omission of unknown extensions. */
export function decodeMintAccount(
  value: unknown,
  mint: string,
  now = Date.now(),
): TokenCheck[] {
  address(mint);
  const envelope = object(value),
    slot = integer(object(envelope.context).slot),
    account = object(envelope.value);
  valid(
    account.executable === false &&
      (account.owner === TOKEN_PROGRAM || account.owner === TOKEN_2022_PROGRAM),
  );
  valid(
    Array.isArray(account.data) &&
      account.data.length === 2 &&
      account.data[1] === 'base64' &&
      typeof account.data[0] === 'string' &&
      account.data[0].length <= 131072,
  );
  const bytes = Buffer.from(account.data[0], 'base64');
  valid(
    bytes.toString('base64') === account.data[0] &&
      bytes.length >= 82 &&
      bytes.length !== 355,
  );
  const dv = view(bytes);
  const option = (at: number) => {
    const flag = dv.getUint32(at, true);
    valid(flag <= 1);
    return flag === 0 ? null : bs58.encode(bytes.subarray(at + 4, at + 36));
  };
  valid(bytes[45] === 1);
  const checks = blankChecks(),
    src = source('solana', now, String(slot));
  checks[0] = {
    ...checks[0],
    status: 'complete',
    sources: [src],
    facts: [
      fact('program', 'Token program', account.owner as string),
      fact('mintAuthority', 'Mint authority', option(0)),
      fact('freezeAuthority', 'Freeze authority', option(46)),
      fact('supply', 'Raw supply', dv.getBigUint64(36, true).toString()),
      fact('decimals', 'Decimals', bytes[44]),
    ],
    limitations: [
      'Authority exceptions require a reviewed mint registry; none are inferred from a token name.',
    ],
  };
  const ext: TokenFact[] = [];
  let complete = true;
  const unsupported: number[] = [];
  if (account.owner === TOKEN_PROGRAM) valid(bytes.length === 82);
  else if (bytes.length > 82) {
    valid(
      bytes.length >= 166 &&
        bytes.subarray(82, 165).every((b) => b === 0) &&
        bytes[165] === 1,
    );
    let at = 166;
    const seen = new Set<number>();
    while (at < bytes.length) {
      if (bytes.subarray(at).every((b) => b === 0)) break;
      valid(at + 4 <= bytes.length);
      const type = dv.getUint16(at, true),
        len = dv.getUint16(at + 2, true);
      at += 4;
      valid(
        type > 0 &&
          !seen.has(type) &&
          seen.size < 64 &&
          at + len <= bytes.length,
      );
      seen.add(type);
      const data = bytes.subarray(at, at + len),
        v = view(data);
      at += len;
      const size = (n: number) => valid(len === n);
      const add = (k: string, l: string, x: TokenFact['value']) =>
        ext.push(fact(k, l, x));
      if (type === 1) {
        size(108);
        const older = v.getUint16(88, true),
          newer = v.getUint16(106, true);
        valid(older <= 10000 && newer <= 10000);
        add(
          'feeAuthority',
          'Transfer fee authority',
          key(data.subarray(0, 32)),
        );
        add(
          'withheldAuthority',
          'Withheld fee authority',
          key(data.subarray(32, 64)),
        );
        add(
          'feeBps',
          'Maximum current or scheduled fee (basis points)',
          Math.max(older, newer),
        );
        add(
          'olderFeeMaximum',
          'Older maximum fee raw tokens',
          v.getBigUint64(80, true).toString(),
        );
        add(
          'newerFeeMaximum',
          'Newer maximum fee raw tokens',
          v.getBigUint64(98, true).toString(),
        );
        add(
          'newerFeeEpoch',
          'Newer fee effective epoch',
          v.getBigUint64(90, true).toString(),
        );
      } else if (type === 3) {
        size(32);
        add('mintCloseAuthority', 'Mint close authority', key(data));
      } else if (type === 6) {
        size(1);
        valid(data[0] === 1 || data[0] === 2);
        add('defaultFrozen', 'New accounts frozen by default', data[0] === 2);
      } else if (type === 9) {
        size(0);
        add('nonTransferable', 'Non-transferable', true);
      } else if (type === 12) {
        size(32);
        add('permanentDelegate', 'Permanent delegate', key(data));
      } else if (type === 14) {
        size(64);
        add(
          'hookAuthority',
          'Transfer hook authority',
          key(data.subarray(0, 32)),
        );
        add('hookProgram', 'Transfer hook program', key(data.subarray(32, 64)));
        add('hookReviewed', 'Hook on reviewed allowlist', false);
      } else if (type === 18) {
        size(64);
        add(
          'metadataPointerAuthority',
          'Metadata pointer authority',
          key(data.subarray(0, 32)),
        );
        add('metadataAddress', 'Metadata account', key(data.subarray(32, 64)));
      } else if (type === 19) {
        checks[2] = {
          ...checks[2],
          status: 'partial',
          facts: metadata(data, mint),
          sources: [src],
          limitations: [
            'Metadata is untrusted descriptive text; external URI content was not fetched.',
          ],
        };
      } else if (type === 25) {
        size(56);
        const multiplier = v.getFloat64(32, true),
          next = v.getFloat64(48, true);
        valid(
          Number.isFinite(multiplier) &&
            multiplier > 0 &&
            Number.isFinite(next) &&
            next > 0,
        );
        add(
          'scaledAuthority',
          'Scaled UI amount authority',
          key(data.subarray(0, 32)),
        );
        add('scaledMultiplier', 'Current UI multiplier', multiplier);
        add('scaledNextMultiplier', 'Scheduled UI multiplier', next);
        add(
          'scaledEffectiveTimestamp',
          'Scheduled multiplier timestamp',
          v.getBigInt64(40, true).toString(),
        );
      } else if (type === 26) {
        size(33);
        valid(data[32] <= 1);
        add('pauseAuthority', 'Pause authority', key(data.subarray(0, 32)));
        add('paused', 'Transfers currently paused', data[32] === 1);
      } else {
        complete = false;
        unsupported.push(type);
      }
    }
  }
  checks[1] = {
    ...checks[1],
    status: complete ? 'complete' : 'partial',
    facts: [
      fact('token2022', 'Token-2022', account.owner === TOKEN_2022_PROGRAM),
      ...ext,
    ],
    sources: [src],
    limitations: unsupported.length
      ? [
          `Extension types not interpreted: ${unsupported.join(', ')}.`,
          'Unknown extension behavior is not a pass.',
        ]
      : [
          'Hook code, off-chain metadata and future authority actions are not proven safe.',
        ],
  };
  if (checks[2].status === 'pending')
    checks[2] = {
      ...checks[2],
      status: 'unavailable',
      limitations: [
        'No supported on-chain metadata was decoded; Metaplex metadata and remote URI contents are uninspected.',
      ],
    };
  return checks;
}
function rowNumbers(row: Record<string, unknown>, key: string, period: string) {
  const all = row[key];
  if (all === undefined) return null;
  const value = object(all)[period];
  return value === undefined ? null : finite(value);
}
export function marketChecks(
  value: unknown,
  mint: string,
  now = Date.now(),
): TokenCheck[] {
  valid(Array.isArray(value) && value.length <= 100);
  const rows = value
    .map(object)
    .filter(
      (r) => r.chainId === 'solana' && object(r.baseToken).address === mint,
    );
  rows.sort(
    (a, b) =>
      (b.liquidity ? finite(object(b.liquidity).usd ?? 0) : 0) -
      (a.liquidity ? finite(object(a.liquidity).usd ?? 0) : 0),
  );
  valid(rows.length > 0);
  const row = rows[0],
    pair = address(row.pairAddress),
    liquidity =
      row.liquidity && object(row.liquidity).usd != null
        ? finite(object(row.liquidity).usd)
        : null,
    src = source(
      'dexscreener',
      now,
      null,
      `https://dexscreener.com/solana/${pair}`,
    );
  const checks = blankChecks();
  checks[8] = {
    ...checks[8],
    status: 'partial',
    sources: [src],
    facts: [
      fact('liquidityUsd', 'Selected pool reported liquidity USD', liquidity),
      fact('pool', 'Selected pool', pair),
      fact('poolType', 'Exchange identifier', safeText(row.dexId, 64)),
    ],
    limitations: [
      'Reported pool liquidity is not executable depth. LP burn/lock status and price impact are uninspected.',
    ],
  };
  const active =
    row.boosts === undefined
      ? null
      : integer(object(row.boosts).active, 1000000);
  checks[10] = {
    ...checks[10],
    status: 'partial',
    sources: [src],
    facts: [
      fact(
        'paidPromotionActive',
        'Active paid boosts observed',
        active === null ? null : active > 0,
      ),
      fact('activeBoosts', 'Active boosts', active),
    ],
    limitations: [
      'Boosts do not enumerate every paid order or promotion; promotion start time is unavailable.',
    ],
  };
  const txns = row.txns ? object(row.txns) : {},
    one = txns.h1 ? object(txns.h1) : null,
    day = txns.h24 ? object(txns.h24) : null;
  checks[11] = {
    ...checks[11],
    status: 'partial',
    sources: [src],
    facts: [
      fact(
        'pairCreatedAt',
        'Selected pool creation time',
        row.pairCreatedAt == null
          ? null
          : new Date(finite(row.pairCreatedAt, now)).toISOString(),
      ),
      fact(
        'volume1h',
        'Selected pool one-hour volume USD',
        rowNumbers(row, 'volume', 'h1'),
      ),
      fact(
        'volume24h',
        'Selected pool 24-hour volume USD',
        rowNumbers(row, 'volume', 'h24'),
      ),
      fact(
        'buys1h',
        'Selected pool one-hour buys',
        one ? integer(one.buys) : null,
      ),
      fact(
        'sells1h',
        'Selected pool one-hour sells',
        one ? integer(one.sells) : null,
      ),
      fact(
        'buys24h',
        'Selected pool 24-hour buys',
        day ? integer(day.buys) : null,
      ),
      fact(
        'sells24h',
        'Selected pool 24-hour sells',
        day ? integer(day.sells) : null,
      ),
    ],
    limitations: [
      'Pool creation time is not mint age. Unique buyers and FOMO flow attribution are unavailable.',
    ],
  };
  return checks;
}
export function paidOrderFacts(
  raw: unknown,
  now = Date.now(),
  mint?: string,
): TokenFact[] {
  // The current API wraps orders and boosts separately. A boost is not an
  // approved order, and neither is evidence that a promotion is still active.
  const rows = Array.isArray(raw) ? raw : object(raw).orders;
  valid(Array.isArray(rows) && rows.length <= 100);
  const orders = rows.map((item) => {
    const o = object(item);
    if (Object.hasOwn(o, 'chainId')) valid(o.chainId === 'solana');
    if (Object.hasOwn(o, 'tokenAddress')) {
      const token = address(o.tokenAddress);
      if (mint) valid(token === mint);
    }
    safeText(o.type, 80);
    const status = safeText(o.status, 40);
    const timestamp = integer(o.paymentTimestamp, now);
    return { status, timestamp };
  });
  const approved = orders.filter((o) => o.status === 'approved');
  return [
    fact('paidOrdersObserved', 'Paid orders returned', orders.length),
    fact(
      'approvedPaidOrders',
      'Approved paid orders returned',
      approved.length,
    ),
    fact(
      'latestPaymentAt',
      'Latest returned paid-order payment time',
      orders.length
        ? new Date(Math.max(...orders.map((o) => o.timestamp))).toISOString()
        : null,
    ),
  ];
}
export async function collectTokenFacts(
  mint: string,
  options: {
    providers?: TokenProviders;
    signal?: AbortSignal;
    onProgress?: (facts: TokenFacts) => Promise<void>;
    forkProbe?: ForkProbeConfig | null;
  } = {},
): Promise<TokenFacts> {
  address(mint);
  const providers = options.providers ?? createTokenProviders(),
    now = Date.now(),
    result: TokenFacts = {
      mint,
      observedAt: new Date(now).toISOString(),
      ageSeconds: null,
      checks: blankChecks(),
    };
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const timer = setTimeout(stop, 25000);
  const signal = controller.signal;
  let progress = Promise.resolve();
  const update = (checks: TokenCheck[]) => {
    for (const c of checks)
      if (c.status !== 'pending') result.checks[c.id - 1] = c;
    const snapshot = structuredClone(result);
    progress = progress.then(() => options.onProgress?.(snapshot));
    return progress;
  };
  try {
    await providers.genesis(signal);
    await Promise.allSettled([
      (async () => {
        if (providers.config.simulation && options.forkProbe) {
          try {
            await update([await runForkProbe(mint, options.forkProbe, signal)]);
          } catch {
            /* Simulation remains missing, never treated as success. */
          }
        }
      })(),
      (async () => {
        try {
          await update(
            decodeMintAccount(await providers.mint(mint, signal), mint, now),
          );
        } catch {
          for (const i of [0, 1, 2])
            result.checks[i] = {
              ...result.checks[i],
              status: 'unavailable',
              limitations: [
                'Mint account was unavailable, malformed, or not an initialized supported token mint.',
              ],
            };
        }
        // Metadata only depends on the mint lookup. Do not hold it behind a
        // slow holder, simulation or market source before showing its result.
        if (result.checks[2].status === 'unavailable' && !signal.aborted) {
          try {
            await update([await readMetaplex(mint, providers, signal)]);
          } catch {
            /* Unsupported/missing metadata remains unavailable. */
          }
        }
      })(),
      (async () => {
        if (!providers.config.dex) return;
        try {
          const checks = marketChecks(
            await providers.market(mint, signal),
            mint,
            now,
          );
          await update(checks);
          try {
            checks[10].facts.push(
              ...paidOrderFacts(
                await providers.orders(mint, signal),
                now,
                mint,
              ),
            );
            checks[10].limitations.push(
              'An approved order and payment timestamp do not prove that a promotion is currently running.',
            );
          } catch {
            checks[10].limitations.push('Paid-order records were unavailable.');
          }
          await update([checks[10]]);
        } catch {
          /* Missing market evidence remains explicit. */
        }
      })(),
      (async () => {
        if (!providers.config.rug) return;
        try {
          const raw = object(await providers.rug(mint, signal));
          valid(Array.isArray(raw.risks) && raw.risks.length <= 64);
          const flags = raw.risks.map((r) => {
            const risk = object(r);
            return safeText(risk.name, 160);
          });
          await update([
            {
              ...result.checks[12],
              status: 'complete',
              sources: [
                source(
                  'rugcheck',
                  now,
                  null,
                  `https://rugcheck.xyz/tokens/${mint}`,
                ),
              ],
              facts: [
                fact('externalRiskCount', 'External risk flags', flags.length),
                ...flags
                  .slice(0, 15)
                  .map((r, i) =>
                    fact(`externalRisk${i}`, 'RugCheck reported risk', r),
                  ),
              ],
              limitations: [
                'External report flags are attributed observations, not independently verified conclusions. Cached report generation time may precede retrieval.',
              ],
            },
          ]);
        } catch {
          /* No vendor verdict is substituted. */
        }
      })(),
      (async () => {
        try {
          const raw = object(await providers.largest(mint, signal)),
            rows = raw.value;
          valid(Array.isArray(rows) && rows.length <= 20);
          const amounts = rows.map((r) => {
            const row = object(r);
            address(row.address);
            return canonicalAmount(row.amount);
          });
          await update([
            {
              ...result.checks[4],
              status: 'partial',
              sources: [
                source(
                  'solana',
                  now,
                  String(integer(object(raw.context).slot)),
                ),
              ],
              facts: [
                fact(
                  'largestTokenAccounts',
                  'Largest token accounts observed',
                  amounts.length,
                ),
                fact(
                  'largestRawTotal',
                  'Sum of reported raw account balances',
                  amounts.reduce((n, a) => n + BigInt(a), 0n).toString(),
                ),
              ],
              limitations: [
                'Token accounts are not unique holders. Pools, curves, burns and related owners have not been excluded or classified. No holder-concentration threshold is applied.',
              ],
            },
          ]);
        } catch {
          /* Classification remains unavailable. */
        }
      })(),
    ]);
    await progress;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
  }
  for (const check of result.checks)
    if (check.status === 'pending') {
      check.status = 'unavailable';
      check.limitations = [
        'A fresh reviewed source for this check is not configured or did not return usable evidence.',
      ];
    }
  return result;
}
