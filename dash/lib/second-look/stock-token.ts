import bs58 from 'bs58';
import {
  STOCK_TOKEN_ISSUERS,
  type StockTokenIssuer,
} from './stock-token-issuers.ts';

export const STOCK_TOKEN_PROGRAM =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const STOCK_TOKEN_2022_PROGRAM =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const STOCK_TOKEN_INPUT_ERROR =
  'Paste a Solana mint or a supported Solscan, Solana Explorer or Jupiter token link.';
export const STOCK_TOKEN_DATA_ERROR =
  'The RPC did not return a supported initialized mint with valid parsed fields.';

function valid(value: unknown): asserts value {
  if (!value) throw new Error(STOCK_TOKEN_DATA_ERROR);
}
function record(value: unknown): Record<string, unknown> {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function isStockTokenAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    return false;
  try {
    return (
      bs58.decode(value).length === 32 &&
      bs58.encode(bs58.decode(value)) === value
    );
  } catch {
    return false;
  }
}
function authority(value: unknown): string | null {
  valid(value === null || isStockTokenAddress(value));
  return value as string | null;
}
function text(value: unknown, max: number): string {
  valid(
    typeof value === 'string' &&
      value.length <= max &&
      !Array.from(value).some((c) => {
        const n = c.codePointAt(0)!;
        return (
          n < 32 ||
          (n >= 127 && n <= 159) ||
          (n >= 0x202a && n <= 0x202e) ||
          (n >= 0x2066 && n <= 0x2069)
        );
      }),
  );
  return value as string;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  valid(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= max,
  );
  return value;
}
function multiplier(value: unknown): string {
  valid(
    (typeof value === 'number' && Number.isFinite(value) && value > 0) ||
      (typeof value === 'string' &&
        value.length <= 64 &&
        /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) &&
        Number.isFinite(Number(value)) &&
        Number(value) > 0),
  );
  return String(value);
}
function timestamp(value: unknown): string {
  valid(
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^-?(?:0|[1-9]\d{0,18})$/.test(value)),
  );
  const n = BigInt(value as string | number);
  valid(n >= -(1n << 63n) && n <= (1n << 63n) - 1n);
  return n.toString();
}

/** Extract locally; never navigate to or fetch the supplied URL. Ambiguous swaps fail closed. */
export function parseStockTokenInput(value: unknown): string {
  const fail = () => {
    throw new Error(STOCK_TOKEN_INPUT_ERROR);
  };
  if (typeof value !== 'string' || value.length > 2048) return fail();
  const input = value.trim();
  if (isStockTokenAddress(input as unknown)) return input;
  let url: URL;
  try {
    url = new URL(input.startsWith('https://') ? input : 'https://' + input);
  } catch {
    return fail();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return fail();
  const parts = url.pathname.split('/').filter(Boolean);
  const mainnetQuery =
    !url.search ||
    (Array.from(url.searchParams.keys()).length === 1 &&
      url.searchParams.get('cluster') === 'mainnet-beta');
  let mint: string | undefined;
  if (
    url.hostname === 'solscan.io' &&
    parts.length === 2 &&
    parts[0] === 'token' &&
    mainnetQuery
  )
    mint = parts[1];
  if (
    url.hostname === 'explorer.solana.com' &&
    parts.length === 2 &&
    parts[0] === 'address' &&
    mainnetQuery
  )
    mint = parts[1];
  if (url.hostname === 'jup.ag') {
    if (
      parts.length === 2 &&
      ['tokens', 'token'].includes(parts[0]) &&
      !url.search
    )
      mint = parts[1];
    if (parts[0] === 'swap' && !url.search) {
      const pair = parts.length === 2 ? parts[1].split(/[_-]/) : parts.slice(1);
      if (pair.length === 1) mint = pair[0];
      if (
        pair.length === 2 &&
        (['SOL', 'USDC'].includes(pair[0]) || isStockTokenAddress(pair[0]))
      )
        mint = pair[1];
    }
    if (
      parts.length === 1 &&
      parts[0] === 'swap' &&
      url.searchParams.getAll('outputMint').length === 1 &&
      Array.from(url.searchParams.keys()).every((k) =>
        ['inputMint', 'outputMint'].includes(k),
      ) &&
      url.searchParams.getAll('inputMint').length <= 1 &&
      (!url.searchParams.has('inputMint') ||
        isStockTokenAddress(url.searchParams.get('inputMint')))
    )
      mint = url.searchParams.get('outputMint') ?? undefined;
  }
  return isStockTokenAddress(mint) ? mint : fail();
}

type Pause = { authority: string | null; paused: boolean };
type Hook = { authority: string | null; programId: string | null };
type Scaled = {
  authority: string | null;
  multiplier: string;
  newMultiplier: string;
  newMultiplierEffectiveTimestamp: string;
};
type Metadata = {
  name: string;
  symbol: string;
  updateAuthority: string | null;
  uri: string;
};
export type StockTokenCard = {
  mint: string;
  program: 'Token-2022' | 'SPL Token';
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  pause: Pause | null;
  permanentDelegate: { delegate: string | null } | null;
  transferHook: Hook | null;
  scaledUiAmount: Scaled | null;
  metadata: Metadata | null;
  unknownExtensions: string[];
  slot: number;
  observedAt: string;
};
function pause(value: unknown): Pause {
  const s = record(value);
  valid(typeof s.paused === 'boolean');
  return { authority: authority(s.authority), paused: s.paused };
}
function delegate(value: unknown) {
  return { delegate: authority(record(value).delegate) };
}
function hook(value: unknown): Hook {
  const s = record(value);
  return {
    authority: authority(s.authority),
    programId: authority(s.programId),
  };
}
function scaled(value: unknown): Scaled {
  const s = record(value);
  return {
    authority: authority(s.authority),
    multiplier: multiplier(s.multiplier),
    newMultiplier: multiplier(s.newMultiplier),
    newMultiplierEffectiveTimestamp: timestamp(
      s.newMultiplierEffectiveTimestamp,
    ),
  };
}
function metadata(value: unknown, mint?: string): Metadata {
  const s = record(value);
  if (mint !== undefined) {
    valid(
      s.mint === mint &&
        Array.isArray(s.additionalMetadata) &&
        s.additionalMetadata.length <= 64,
    );
    for (const pair of s.additionalMetadata) {
      valid(Array.isArray(pair) && pair.length === 2);
      text(pair[0], 256);
      text(pair[1], 2048);
    }
  }
  return {
    name: text(s.name, 256),
    symbol: text(s.symbol, 64),
    updateAuthority: authority(s.updateAuthority),
    uri: text(s.uri, 2048),
  };
}
function supply(value: unknown): string {
  valid(
    typeof value === 'string' &&
      /^(0|[1-9]\d{0,19})$/.test(value) &&
      BigInt(value) < 1n << 64n,
  );
  return value;
}
export function decodeStockTokenMint(
  raw: unknown,
  mint: string,
  now = Date.now(),
): StockTokenCard {
  valid(isStockTokenAddress(mint) && Number.isFinite(now));
  const root = record(raw),
    slot = integer(record(root.context).slot),
    account = record(root.value);
  valid(
    account.executable === false &&
      [STOCK_TOKEN_PROGRAM, STOCK_TOKEN_2022_PROGRAM].includes(
        account.owner as string,
      ),
  );
  const data = record(account.data),
    parsed = record(data.parsed),
    info = record(parsed.info);
  valid(
    data.program ===
      (account.owner === STOCK_TOKEN_2022_PROGRAM
        ? 'spl-token-2022'
        : 'spl-token') &&
      parsed.type === 'mint' &&
      info.isInitialized === true,
  );
  const card: StockTokenCard = {
    mint,
    program:
      account.owner === STOCK_TOKEN_2022_PROGRAM ? 'Token-2022' : 'SPL Token',
    decimals: integer(info.decimals, 255),
    supply: supply(info.supply),
    mintAuthority: authority(info.mintAuthority),
    freezeAuthority: authority(info.freezeAuthority),
    pause: null,
    permanentDelegate: null,
    transferHook: null,
    scaledUiAmount: null,
    metadata: null,
    unknownExtensions: [],
    slot,
    observedAt: new Date(now).toISOString(),
  };
  const extensions = info.extensions === undefined ? [] : info.extensions;
  valid(
    Array.isArray(extensions) &&
      extensions.length <= 64 &&
      (card.program === 'Token-2022' || extensions.length === 0),
  );
  const seen = new Set<string>();
  for (const item of extensions) {
    const e = record(item),
      name = text(e.extension, 80);
    valid(/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) && !seen.has(name));
    seen.add(name);
    switch (name) {
      case 'pausableConfig':
        card.pause = pause(e.state);
        break;
      case 'permanentDelegate':
        card.permanentDelegate = delegate(e.state);
        break;
      case 'transferHook':
        card.transferHook = hook(e.state);
        break;
      case 'scaledUiAmountConfig':
        card.scaledUiAmount = scaled(e.state);
        break;
      case 'tokenMetadata':
        card.metadata = metadata(e.state, mint);
        break;
      default:
        card.unknownExtensions.push(name);
    }
  }
  return card;
}

export function stockTokenResponse(
  value: unknown,
): value is { card: StockTokenCard } {
  try {
    const c = record(record(value).card);
    valid(
      isStockTokenAddress(c.mint) &&
        ['Token-2022', 'SPL Token'].includes(c.program as string),
    );
    integer(c.decimals, 255);
    supply(c.supply);
    authority(c.mintAuthority);
    authority(c.freezeAuthority);
    integer(c.slot);
    valid(
      typeof c.observedAt === 'string' &&
        new Date(c.observedAt).toISOString() === c.observedAt,
    );
    if (c.pause !== null) pause(c.pause);
    if (c.permanentDelegate !== null) delegate(c.permanentDelegate);
    if (c.transferHook !== null) hook(c.transferHook);
    if (c.scaledUiAmount !== null) scaled(c.scaledUiAmount);
    if (c.metadata !== null) metadata(c.metadata);
    valid(
      Array.isArray(c.unknownExtensions) && c.unknownExtensions.length <= 64,
    );
    for (const name of c.unknownExtensions)
      valid(/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(text(name, 80)));
    valid(
      c.program !== 'SPL Token' ||
        [
          c.pause,
          c.permanentDelegate,
          c.transferHook,
          c.scaledUiAmount,
          c.metadata,
        ].every((v) => v === null),
    );
    return true;
  } catch {
    return false;
  }
}
export function stockTokenControl(
  card: StockTokenCard,
  issuers: readonly StockTokenIssuer[] = STOCK_TOKEN_ISSUERS,
) {
  // Every listed authority must match: one matching key alone is easy to copy onto a lookalike mint.
  const issuer = issuers.find((i) =>
    i.authorities.length > 0 &&
    i.authorities.every(
      (a) =>
        a.address ===
        (a.kind === 'mintAuthority'
          ? card.mintAuthority
          : card.metadata?.updateAuthority),
    ),
  );
  const hasPowers = !!(
    card.pause?.authority ||
    card.pause?.paused ||
    card.permanentDelegate?.delegate ||
    card.transferHook?.authority ||
    card.transferHook?.programId ||
    card.freezeAuthority
  );
  return {
    issuer: issuer ?? null,
    kind: hasPowers ? (issuer ? 'issuer' : 'controller') : 'none',
  } as const;
}
/** Scaled UI amounts describe display units, not independently verified share backing. */
export function stockTokenMultiplier(card: StockTokenCard, now = Date.now()) {
  const s = card.scaledUiAmount;
  if (!s) return null;
  const pending =
    BigInt(s.newMultiplierEffectiveTimestamp) > BigInt(Math.floor(now / 1000));
  return {
    current: pending ? s.multiplier : s.newMultiplier,
    pending:
      pending && Number(s.multiplier) !== Number(s.newMultiplier)
        ? {
            multiplier: s.newMultiplier,
            timestamp: s.newMultiplierEffectiveTimestamp,
          }
        : null,
  };
}
