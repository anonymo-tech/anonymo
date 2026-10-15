import { address } from '../solana/validation.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import {
  createTokenProviders,
  object,
  safeText,
  finite,
  type TokenProviders,
} from './providers.ts';
import type {
  TokenCandidate,
  TokenResolution,
} from '../../lib/second-look/token.ts';
export type TokenInput = { kind: 'mint' | 'pair' | 'ticker'; value: string };
export function parseTokenInput(raw: unknown): TokenInput {
  requireCondition(
    typeof raw === 'string' && raw.length <= 512 && raw.trim().length > 0,
    400,
    'TOKEN_INPUT_INVALID',
    'Enter a mint, supported token link, or ticker.',
  );
  const input = raw.trim();
  try {
    return { kind: 'mint', value: address(input) };
  } catch {
    /* Tickers and reviewed link forms are separate. */
  }
  if (/^\$?[a-zA-Z0-9._-]{1,16}$/.test(input))
    return { kind: 'ticker', value: input.replace(/^\$/, '') };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new ServiceError(
      400,
      'TOKEN_INPUT_INVALID',
      'Enter a valid mint, supported token link or ticker.',
    );
  }
  requireCondition(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.search &&
      !u.hash &&
      !input.includes('%') &&
      !input.includes('\\') &&
      u.href === input,
    400,
    'TOKEN_LINK_UNSUPPORTED',
    'This token link format is not supported. Paste the mint address.',
  );
  const parts = u.pathname.split('/').filter(Boolean);
  let value: string | undefined,
    kind: 'mint' | 'pair' = 'mint';
  if (
    u.hostname === 'dexscreener.com' &&
    parts.length === 2 &&
    parts[0] === 'solana'
  ) {
    value = parts[1];
    kind = 'pair';
  }
  if (u.hostname === 'pump.fun' && parts.length === 2 && parts[0] === 'coin')
    value = parts[1];
  if (u.hostname === 'jup.ag' && parts.length === 2 && parts[0] === 'tokens')
    value = parts[1];
  requireCondition(
    value,
    400,
    'TOKEN_LINK_UNSUPPORTED',
    'This token link format is not supported. Paste the mint address.',
  );
  try {
    return { kind, value: address(value) };
  } catch {
    throw new ServiceError(
      400,
      'TOKEN_INPUT_INVALID',
      'Enter a valid mint, supported token link or ticker.',
    );
  }
}
export function tokenCandidates(
  value: unknown,
  ticker?: string,
): TokenCandidate[] {
  const rows = Array.isArray(value) ? value : object(value).pairs;
  requireCondition(
    Array.isArray(rows) && rows.length <= 100,
    503,
    'TOKEN_SOURCE_INVALID',
    'Token search returned invalid data.',
  );
  const found = new Map<string, TokenCandidate>();
  for (const raw of rows) {
    const row = object(raw);
    if (row.chainId !== 'solana') continue;
    const token = object(row.baseToken);
    let mint: string;
    try {
      mint = address(token.address);
    } catch {
      continue;
    }
    const symbol = safeText(token.symbol, 64),
      name = safeText(token.name, 128);
    if (ticker && symbol.toLowerCase() !== ticker.toLowerCase()) continue;
    const liquidity =
      row.liquidity && object(row.liquidity).usd != null
        ? finite(object(row.liquidity).usd)
        : null;
    const created =
      row.pairCreatedAt == null
        ? null
        : new Date(finite(row.pairCreatedAt, Date.now())).toISOString();
    const prior = found.get(mint);
    if (!prior || (liquidity ?? 0) > (prior.liquidityUsd ?? 0))
      found.set(mint, {
        mint,
        name,
        symbol,
        liquidityUsd: liquidity,
        pairCreatedAt: created,
        source: 'dexscreener',
        lookalike: false,
      });
  }
  const result = [...found.values()]
    .sort(
      (a, b) =>
        (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) ||
        (a.pairCreatedAt ?? 'z').localeCompare(b.pairCreatedAt ?? 'z') ||
        a.mint.localeCompare(b.mint),
    )
    .slice(0, 20);
  return result.map((x) => ({
    ...x,
    lookalike: result.some(
      (y) =>
        y.mint !== x.mint && y.symbol.toLowerCase() === x.symbol.toLowerCase(),
    ),
  }));
}
export async function resolveTokenInput(
  input: unknown,
  signal?: AbortSignal,
  providers: TokenProviders = createTokenProviders(),
): Promise<TokenResolution> {
  const parsed = parseTokenInput(input);
  if (parsed.kind === 'mint')
    return {
      status: 'resolved',
      mint: parsed.value,
      candidates: [],
      reason: null,
    };
  if (!providers.config.dex)
    return {
      status: 'unavailable',
      mint: null,
      candidates: [],
      reason: 'TOKEN_SEARCH_UNAVAILABLE',
    };
  const candidates = tokenCandidates(
    parsed.kind === 'ticker'
      ? await providers.search(parsed.value, signal)
      : await providers.pair(parsed.value, signal),
    parsed.kind === 'ticker' ? parsed.value : undefined,
  );
  return {
    status: candidates.length ? 'choose' : 'not_found',
    mint: null,
    candidates,
    reason:
      parsed.kind === 'pair' ? 'CONFIRM_PAIR_BASE_TOKEN' : 'CONFIRM_EXACT_MINT',
  };
}
