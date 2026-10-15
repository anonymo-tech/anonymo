import type { Pool } from 'pg';
import { collectPublicCallHistory } from './fomo-public-history.ts';
import { readFomoMintFacts } from './fomo-chain.ts';
import { fomoResearchTargets } from '../../lib/second-look/fomo-research.ts';
import {
  parseFomoInput,
  FOMO_HANDLE,
  FOMO_CHAINS,
  FOMO_ID,
  type FomoAnalysis,
  type FomoInput,
  type FomoSource,
} from '../../lib/second-look/fomo.ts';
import { readJson, jsonResponse, stringField } from '../core/http.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import { savedFomoProfile } from './fomo-snapshots.ts';

const BASE = 'https://fomo-public.pootracker.app';
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (v: unknown): string | null => {
  if (!(typeof v === 'string' || typeof v === 'number') || !v) return null;
  const n = new Date(v).getTime();
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};
const fields = (value: Record<string, unknown>, names: string[]) =>
  Object.fromEntries(
    names.filter((n) => value[n] !== undefined).map((n) => [n, value[n]]),
  );
const PROFILE_FIELDS = [
  'id',
  'handle',
  'name',
  'bio',
  'solanaAddress',
  'evmAddress',
];
const CALL_FIELDS = [
  'id',
  'tokenAddress',
  'tokenNetwork',
  'tokenSymbol',
  'authorHandle',
  'authorId',
  'tradeId',
  'authorIsDev',
  'thesis',
  'holdingsUsd',
  'authorTradeUsd',
  'realizedPnlUsd',
  'unrealizedPnlUsd',
  'tokenAmount',
  'closedAt',
  'fomoCreatedAt',
  'updatedAt',
];
const networks: Record<string, string> = {
  solana: '1399811149',
  ethereum: '1',
  base: '8453',
  bsc: '56',
  monad: '143',
  robinhood: '4663',
};

/** Fixed origins, no redirects/cookies, bounded response and entire-request deadline. */
export async function fomoReadJson(
  url: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const u = new URL(url);
  if (
    ![
      'https://fomo-public.pootracker.app',
      'https://api.dexscreener.com',
      'https://api.fomo-api.com',
      'https://fomolens.app',
    ].includes(u.origin) ||
    u.username ||
    u.password ||
    u.hash ||
    (u.origin === 'https://api.fomo-api.com' &&
      (u.pathname !== '/v1/leaderboard' ||
        !/^\?window=(24h|7d|30d)&limit=10&board=fomo-parity$/.test(
          u.search,
        ))) ||
    (u.origin === 'https://fomolens.app' &&
      !((u.pathname === '/api/public/calls' &&
        (u.search === '' || /^\?network=(solana|ethereum|base|bsc|monad|robinhood)$/.test(u.search))) ||
        (u.pathname === '/api/public/leaderboard' &&
          /^\?window=(24h|7d|30d|all)$/.test(u.search))))
  )
    throw Error('Unapproved evidence origin');
  const deadline = AbortSignal.timeout(10000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Evidence request cancelled'));
    combined.addEventListener('abort', onAbort, { once: true });
    if (combined.aborted) onAbort();
  });
  const bounded = <T>(p: Promise<T>) => Promise.race([p, aborted]);
  try {
    const r = await bounded(
      fetcher(url, {
        signal: combined,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      }),
    );
    if (
      !r.ok ||
      r.redirected ||
      (r.url && r.url !== url) ||
      !/^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(
        r.headers.get('content-type') ?? '',
      )
    )
      throw Error('Evidence unavailable');
    if (Number(r.headers.get('content-length')) > 500000)
      throw Error('Evidence too large');
    reader = r.body?.getReader();
    if (!reader) throw Error('No evidence body');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const part = await bounded(reader.read());
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 500000) throw Error('Evidence too large');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const data: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    return { data, stale: r.headers.get('x-data-stale') === 'true' };
  } finally {
    combined.removeEventListener('abort', onAbort);
    void reader?.cancel().catch(() => {});
  }
}
type Read = typeof fomoReadJson;
const publicSnapshots = new Map<
  string,
  { expiresAt: number; value: Awaited<ReturnType<Read>> }
>();
async function publicRead(url: string, read: Read, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const cached = read === fomoReadJson ? publicSnapshots.get(url) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await read(url, signal);
  if (read === fomoReadJson) {
    if (publicSnapshots.size >= 12)
      publicSnapshots.delete(publicSnapshots.keys().next().value!);
    publicSnapshots.set(url, { expiresAt: Date.now() + 60000, value });
  }
  return value;
}
type Options = {
  signal?: AbortSignal;
  read?: Read;
  now?: Date;
  context?: string;
  chainEvidence?: (mint: string, signal?: AbortSignal) => Promise<FomoSource>;
  publicHistory?: (handle: string, at: string, signal?: AbortSignal) => Promise<FomoSource[]>;
  tokenEvidence?: (mint: string) => Promise<Record<string, unknown> | null>;
};
export async function collectFomoAnalysis(
  value: string,
  options: Options = {},
): Promise<FomoAnalysis> {
  let input: FomoInput;
  try {
    input = parseFomoInput(value);
  } catch (e) {
    throw new ServiceError(
      400,
      'FOMO_INPUT_INVALID',
      e instanceof Error ? e.message : 'Invalid FOMO link.',
    );
  }
  const at = (options.now ?? new Date()).toISOString();
  const historyCollector = options.publicHistory ?? ((handle: string, when: string, signal?: AbortSignal) => collectPublicCallHistory(handle, when, {signal}));
  const earlyHistory = input.kind === 'profile' && (options.publicHistory || !options.read)
    ? historyCollector(input.handle!, at, options.signal).catch(() => [] as FomoSource[]) : null;
  const sameToken = (address: unknown) =>
    typeof address === 'string' &&
    (input.chain === 'solana'
      ? address === input.token
      : address.toLowerCase() === input.token?.toLowerCase());
  const read = options.read ?? fomoReadJson,
    sources: FomoSource[] = [];
  const limitations = [
    'Social and trading data is supplied by an independent index. Its history may be incomplete; source-reported results are not an independently audited track record.',
  ];
  const source = async (
    id: string,
    label: string,
    url: string,
    normalize: (v: unknown) => {
      data: Record<string, unknown>;
      observedAt?: string | null;
      note?: string;
      partial?: boolean;
    },
  ) => {
    let result: FomoSource;
    try {
      const raw = await (url.startsWith('https://api.fomo-api.com/') ||
      url.startsWith('https://fomolens.app/')
        ? publicRead(url, read, options.signal)
        : read(url, options.signal));
      const n = normalize(raw.data);
      if (JSON.stringify(n.data).length > 32000)
        throw Error('Evidence too large');
      result = {
        id,
        label,
        url,
        fetchedAt: at,
        observedAt: n.observedAt ?? null,
        state: raw.stale || n.partial || n.data.stale === true ? 'partial' : 'available',
        note: raw.stale || n.data.stale === true
          ? 'The index marked this snapshot stale. ' + (n.note ?? '')
          : (n.note ?? ''),
        data: n.data,
      };
    } catch {
      if (options.signal?.aborted)
        throw new DOMException('Cancelled', 'AbortError');
      result = {
        id,
        label,
        url,
        fetchedAt: at,
        observedAt: null,
        state: 'unavailable',
        note: 'This source could not be retrieved. No values have been inferred.',
        data: null,
      };
    }
    return result;
  };
  const profile = (handle: string) =>
    source(
      'profile',
      'Trader profile',
      BASE + '/v2/users/handle/' + encodeURIComponent(handle),
      (v) => {
        if (
          !object(v) ||
          typeof v.handle !== 'string' ||
          v.handle.toLowerCase() !== handle.toLowerCase()
        )
          throw Error('Profile mismatch');
        return {
          data: fields(v, PROFILE_FIELDS),
          partial: true,
          note: 'Wallet mappings and biography are source-reported. Public profile identity only.',
        };
      },
    );
  const performance = (handle: string) =>
    source(
      'performance',
      'Trading history',
      BASE + '/v2/users/handle/' + encodeURIComponent(handle) + '/pnl',
      (v) => {
        if (
          !object(v) ||
          typeof v.handle !== 'string' ||
          v.handle.toLowerCase() !== handle.toLowerCase() ||
          !object(v.windows)
        )
          throw Error('Performance mismatch');
        return {
          data: fields(v, ['handle', 'updatedAt', 'windows', 'followers']),
          observedAt: iso(v.updatedAt),
          partial: true,
          note: 'Indexed swap cash flow, not realized profit. Excludes unindexed and off-platform activity. No win rate or complete ledger is implied.',
        };
      },
    );
  const calls = (url: string, handle?: string) =>
    source('calls', 'Callout history', url, (v) => {
      if (
        !object(v) ||
        !Array.isArray(v.items) ||
        typeof v.hasMore !== 'boolean'
      )
        throw Error('Invalid call history');
      const items = v.items
        .filter(object)
        .filter(
          (i) =>
            !handle ||
            (typeof i.authorHandle === 'string' &&
              i.authorHandle.toLowerCase() === handle.toLowerCase()),
        );
      if (
        items.some(
          (i) =>
            typeof i.id !== 'string' ||
            !(i.thesis === null || typeof i.thesis === 'string'),
        )
      )
        throw Error('Invalid thesis');
      return {
        data: {
          items: items.slice(0, 20).map((i) => fields(i, CALL_FIELDS)),
          hasMore: v.hasMore || items.length > 20,
          returned: Math.min(items.length, 20),
        },
        observedAt: iso(v.updatedAt),
        partial: true,
        note: 'Up to 20 indexed callouts. A spotlight and partial history do not establish the complete timeline.',
      };
    });
  const publicProfile = async (handle: string) =>
    Promise.all(
      ['24h', '7d', '30d'].map((window) =>
        source(
          'public-profile-' + window,
          'Public trader snapshot · ' + window,
          'https://api.fomo-api.com/v1/leaderboard?window=' +
            window +
            '&limit=10&board=fomo-parity',
          (v) => {
            if (
              !object(v) ||
              !Array.isArray(v.data) ||
              v.window !== window ||
              v.board !== 'fomo-parity' ||
              !['fomo', 'computed'].includes(String(v.source))
            )
              throw Error('Public board unavailable');
            const trader = v.data
              .filter(object)
              .find(
                (r) =>
                  typeof r.handle === 'string' &&
                  r.handle.toLowerCase() === handle.toLowerCase(),
              );
            if (!trader) throw Error('Outside public coverage');
            return {
              partial: true,
              observedAt: iso(v.syncedAt),
              note:
                'Public top-10 coverage only. Source ' +
                v.source +
                '; ranking basis ' +
                String(v.pnlBasis ?? 'unknown') +
                '. Computed realized/unrealized splits are 30-day figures, not a decomposition of FOMO-reported window PnL. Profile counters and holding PnL are lifetime values. Empty wallet lists mean unknown attribution.',
              data: {
                window,
                source: v.source,
                board: v.board,
                pnlBasis: v.pnlBasis ?? null,
                stale: typeof v.stale === 'boolean' ? v.stale : null,
                syncedAt: iso(v.syncedAt),
                trader: fields(trader, [
                  'handle',
                  'displayName',
                  'avatarUrl',
                  'rank',
                  'source',
                  'syncedAt',
                  'fomoProfileSyncedAt',
                  'pnlBasis',
                  'pnlUsd',
                  'reportedPnlUsd',
                  'computedPnlUsd',
                  'realizedPnlUsd',
                  'unrealizedPnlUsd',
                  'volumeUsd',
                  'trades',
                  'lowCoverage',
                  'pricedSharePct',
                  'divergesFromFomo',
                  'wallets',
                  'walletLinkPending',
                  'networks',
                  'followers',
                  'verified',
                  'allTimePnlUsd',
                  'allTimeRank',
                  'fomoLifetimeVolumeUsd',
                  'fomoNumTrades',
                  'fomoSwapCount',
                  'topHoldings',
                ]),
              },
            };
          },
        ),
      ),
    );
  const sampledPublicProfile = async (handle: string) =>
    Promise.all(
      ['24h', '7d', '30d', 'all'].map((window) =>
        source(
          'public-profile-sampled-' + window,
          'Sampled trader history · ' + window,
          'https://fomolens.app/api/public/leaderboard?window=' + window,
          (v) => {
            if (!object(v) || v.window !== window || v.coverage !== 'sampled' ||
              !Array.isArray(v.rows) || v.rows.length > 100 ||
              typeof v.hasMore !== 'boolean') throw Error('Sampled board unavailable');
            const trader = v.rows.filter(object).find((row) =>
              typeof row.userHandle === 'string' &&
              row.userHandle.toLowerCase() === handle.toLowerCase());
            if (!trader || !Number.isInteger(trader.position) ||
              Number(trader.position) < 1 || Number(trader.position) > 100 ||
              !(trader.pnl === null || (typeof trader.pnl === 'number' && Number.isFinite(trader.pnl))))
              throw Error('Outside sampled public coverage');
            return {
              partial: true,
              observedAt: iso(trader.fetchedAt),
              note: 'Sampled PnL, not FOMO leaderboard rank or an audited return. Only the public top 100 in this window are covered. PnL sample time and profile observation time can differ. A fresh ranking retrieval does not refresh the underlying sample. No stable user ID or wallet mapping is supplied.',
              data: {
                window,
                coverage: 'sampled-top-100',
                retrievedAt: iso(v.retrievedAt),
                hasMore: v.hasMore,
                trader: {
                  handle: trader.userHandle,
                  ...fields(trader, ['displayName', 'position', 'pnl', 'followers', 'numTrades', 'fetchedAt', 'profileObservedAt']),
                },
              },
            };
          },
        ),
      ),
    );
  const publicCalls = (handle?: string) =>
    source(
      'public-calls',
      'Recent public callouts',
      'https://fomolens.app/api/public/calls' +
        (input.chain ? '?network=' + input.chain : ''),
      (v) => {
        if (!object(v) || !Array.isArray(v.rows) || v.rows.length > 100)
          throw Error('Public call feed unavailable');
        const items = v.rows
          .filter(object)
          .filter(
            (r) =>
              typeof r.callId === 'string' && FOMO_ID.test(r.callId) &&
              typeof r.text === 'string' && r.text.trim().length > 0 &&
              iso(r.createdAt) !== null &&
              typeof r.network === 'string' &&
              FOMO_CHAINS.includes(r.network as (typeof FOMO_CHAINS)[number]) &&
              object(r.token) && typeof r.token.address === 'string' &&
              (r.network === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.token.address) : /^0x[a-fA-F0-9]{40}$/.test(r.token.address)) &&
              object(r.author) &&
              typeof r.author.userHandle === 'string' && FOMO_HANDLE.test(r.author.userHandle) &&
              (!handle ||
                r.author.userHandle.toLowerCase() === handle.toLowerCase()) &&
              (!input.chain ||
                (r.network === input.chain &&
                  object(r.token) &&
                  sameToken(r.token.address))),
          )
          .slice(0, 20)
          .map((r) => ({
            ...fields(r, [
              'callId',
              'createdAt',
              'text',
              'network',
              'marketCapAtCall',
              'priceAtCall',
              'position',
            ]),
            token: object(r.token)
              ? fields(r.token, ['address', 'symbol'])
              : null,
            author: object(r.author)
              ? fields(r.author, ['userHandle', 'displayName'])
              : null,
          }));
        return {
          partial: true,
          observedAt: iso(v.refreshedAt),
          note: 'Filtered from the newest 100 public calls, not a complete trader history. An empty result does not mean this trader has never called a token. Provider call IDs are not assumed to match FOMO share-link IDs.',
          data: {
            items,
            feedCount: v.rows.length,
            latestFeedCallAt: v.latestCallAt ?? null,
            coverage: 'latest-public-feed-only',
          },
        };
      },
    );
  const market = (chain: string, token: string, id: string) => source(
    id, 'Asset liquidity & market context',
    'https://api.dexscreener.com/tokens/v1/' + chain + '/' + token,
    (v) => {
      if (!Array.isArray(v)) throw Error('Market data invalid');
      const pairs = v.filter(object).filter(p => p.chainId === chain && object(p.baseToken) && typeof p.baseToken.address === 'string' &&
        (chain === 'solana' ? p.baseToken.address === token : p.baseToken.address.toLowerCase() === token.toLowerCase()));
      if (!pairs.length) throw Error('No exact token market');
      return {
        data: { asset: { chain, address: token }, pairs: pairs.slice(0, 5).map(p => fields(p, [
          'chainId','dexId','pairAddress','baseToken','quoteToken','priceUsd','liquidity','volume','txns','priceChange','fdv','marketCap','pairCreatedAt',
        ])) },
        partial: true,
        note: 'Current snapshot, up to five matching markets. It does not establish the price at callout time or prove sellability.',
      };
    },
  );
  const savedToken = async (mint: string, id: string): Promise<FomoSource> => {
    let saved: Record<string, unknown> | null = null;
    try {
      const candidate = await options.tokenEvidence?.(mint);
      if (candidate && candidate.mint === mint && typeof candidate.expiresAt === 'string' && Date.parse(candidate.expiresAt) > Date.parse(at) && JSON.stringify(candidate).length <= 32000) saved = candidate;
    } catch {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    }
    return {
      id, label: 'Conclave token tools', url: 'https://conclavemodels.com/dashboard', fetchedAt: at,
      observedAt: typeof saved?.updatedAt === 'string' ? saved.updatedAt : null,
      state: saved ? 'partial' : 'unavailable', data: saved,
      note: saved ? 'Your latest fresh saved token report. Each check retains its coverage and sources.' : 'No fresh token report is saved for this token. No paid token tools or simulation were started.',
    };
  };
  let callout: FomoAnalysis['callout'] = null;
  if (input.kind === 'profile') {
    const handle = input.handle!;
    sources.push(
      ...(await Promise.all([
        profile(handle),
        performance(handle),
        calls(
          BASE + '/v2/users/handle/' + encodeURIComponent(handle) + '/theses',
          handle,
        ),
      ])),
    );
    if (!sources.some((s) => s.id === 'profile' && s.data !== null))
      sources.push(...(await publicProfile(handle)));
    if (!sources.some((s) => (s.id === 'profile' || s.id.startsWith('public-profile-')) && s.data !== null))
      sources.push(...(await sampledPublicProfile(handle)));
    if (!sources.some((s) => s.id === 'calls' && s.data !== null))
      sources.push(await publicCalls(handle));
  } else {
    const list = await calls(
      BASE +
        '/v2/tokens/' +
        input.token +
        '/theses?networkId=' +
        networks[input.chain!],
    );
    sources.push(list);
    const items = Array.isArray(list.data?.items)
      ? list.data.items.filter(object)
      : [];
    const linkedId = new URL(input.url).searchParams.has('tradeId') ? 'tradeId' : 'id';
    const matches = items.filter(
      (i) =>
        i[linkedId] === input.calloutId &&
        sameToken(i.tokenAddress) &&
        String(i.tokenNetwork) === networks[input.chain!],
    );
    const match = matches.length === 1 ? matches[0] : null;
    if (match && typeof match.thesis === 'string' && match.thesis.trim()) {
      const handle =
        typeof match.authorHandle === 'string' &&
        FOMO_HANDLE.test(match.authorHandle)
          ? match.authorHandle
          : null;
      callout = {
        text: match.thesis.slice(0, 8000),
        author: handle,
        createdAt: iso(match.fomoCreatedAt),
        verified: true,
      };
      if (handle) {
        sources.push(
          ...(await Promise.all([profile(handle), performance(handle)])),
        );
        if (!sources.some((s) => s.id === 'profile' && s.data !== null))
          sources.push(...(await publicProfile(handle)));
      }
    } else
      limitations.push(
        'The exact linked callout was not found in the retrieved history. Paste its text below to analyze the claim; it will be identified as user-supplied.',
      );
    if (list.state === 'unavailable') sources.push(await publicCalls());
    sources.push(await market(input.chain!, input.token!, 'market'));
    if (options.chainEvidence && input.chain === 'solana') sources.push({...await options.chainEvidence(input.token!, options.signal), id:'chain-mint'});
    if (options.tokenEvidence && input.chain === 'solana') sources.push(await savedToken(input.token!, 'token-check'));
  }
  const historyHandle = input.handle ?? callout?.author;
  if (historyHandle && (options.publicHistory || !options.read)) {
    sources.push(...await (earlyHistory ?? historyCollector(historyHandle, at, options.signal)));
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  }
  if (input.kind === 'profile') {
    const targets = fomoResearchTargets({ input, sources });
    const extra = await Promise.all(targets.map(async (target, i) => {
      const collected = await Promise.all([market(target.chain, target.token, 'market-position-' + i), ...(options.chainEvidence && target.chain === 'solana' ? [options.chainEvidence(target.token,options.signal).then(s=>({...s,id:'chain-position-'+i}))] : [])]);
      if (options.tokenEvidence && target.chain === 'solana') collected.push(await savedToken(target.token, 'token-position-' + i));
      return collected;
    }));
    sources.push(...extra.flat());
  }

  if (options.context?.trim()) {
    if (
      options.context.length > 8000 ||
      scanPrompt(options.context).findings.some((f) => f.severity === 'block')
    )
      throw new ServiceError(
        400,
        'SENSITIVE_CONTENT',
        'Remove credentials and private keys from the supplied context.',
      );
    sources.push({
      id: 'supplied-context',
      label: 'Your supplied context',
      url: input.url,
      fetchedAt: at,
      observedAt: null,
      state: 'partial',
      note: 'Supplied by the user. Not independently verified.',
      data: { text: options.context.trim() },
    });
    if (!callout && input.kind === 'callout')
      callout = {
        text: options.context.trim(),
        author: null,
        createdAt: null,
        verified: false,
      };
  }
  limitations.push('Public-feed coverage only. Profiles outside the available snapshots and older exact callouts may not be retrievable.');
  const available = sources.filter((s) => s.data !== null);
  const sufficient =
    input.kind === 'profile'
      ? sources.some(
          (s) =>
            ((s.id === 'profile' || s.id.startsWith('public-profile-')) &&
              s.data !== null) ||
            ((s.id === 'public-calls' || s.id === 'public-trader-calls') && Array.isArray(s.data?.items) && s.data.items.length > 0),
        )
      : !!callout;
  if (input.kind === 'profile' && !sources.some((s) =>
    (s.id === 'profile' || s.id.startsWith('public-profile-')) && s.data !== null))
    limitations.push(sufficient
      ? 'Only this handle’s recent public calls are available. Profile totals, wallet attribution and performance are unknown; analyze the observed statements without inventing a full track record.'
      : 'This handle is outside the currently available public snapshots, or the sources are unavailable. That does not establish that the FOMO profile does not exist.');
  const state =
    !sufficient || !available.length
      ? 'unavailable'
      : sources.some((s) => s.state !== 'available')
        ? 'partial'
        : 'ready';
  return {
    id: crypto.randomUUID(),
    createdAt: at,
    input,
    title:
      input.kind === 'profile'
        ? 'FOMO profile: @' + input.handle
        : 'FOMO callout' + (callout?.author ? ' by @' + callout.author : ''),
    state,
    callout,
    sources,
    limitations,
  };
}

export async function fomoRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path !== 'second-look/fomo/analyze' || request.method !== 'POST')
    return null;
  await rateLimit(pool, 'fomo-research:' + accountId, 10);
  await rateLimit(pool, 'fomo-research:global', 25);
  const body = await readJson(request, 35000);
  requireCondition(
    Object.keys(body).every((k) => ['input', 'context'].includes(k)) &&
      (body.context === undefined || typeof body.context === 'string'),
    400,
    'FOMO_INPUT_INVALID',
    'Provide a FOMO link and optional callout text.',
  );
  const input = stringField(body, 'input', 2048);
  const parsed = parseFomoInput(input);
  if (parsed.kind === 'profile' && parsed.handle) {
    const analysis = structuredClone(await savedFomoProfile(pool, parsed.handle));
    const context = typeof body.context === 'string' ? body.context.trim() : '';
    if (context) {
      requireCondition(context.length <= 8000 && !scanPrompt(context).findings.some(f => f.severity === 'block'), 400, 'SENSITIVE_CONTENT', 'Remove credentials and private keys from supplied context.');
      analysis.id = crypto.randomUUID();
      analysis.sources.push({ id: 'supplied-context', label: 'Your supplied context', url: parsed.url,
        fetchedAt: new Date().toISOString(), observedAt: null, state: 'partial',
        note: 'Supplied by the user. Not independently verified.', data: { text: context } });
    }
    return jsonResponse({ analysis });
  }
  const analysis = await collectFomoAnalysis(input, {
    signal: request.signal,
    chainEvidence: (mint, signal) => readFomoMintFacts(mint, signal),
    context: body.context as string | undefined,
    tokenEvidence: async (mint) => {
      // Never read another account’s reports, start paid tools, or treat expired evidence as current.
      const r = await pool.query<{ document: Record<string, unknown> }>(
        "SELECT document FROM secondlook_token_reports WHERE account_id=$1 AND state IN ('complete','partial') AND document->>'mint'=$2 AND (document->>'expiresAt')::timestamptz>now() ORDER BY updated_at DESC LIMIT 1",
        [accountId, mint],
      );
      const d = r.rows[0]?.document;
      return d
        ? fields(d, [
            'mint',
            'updatedAt',
            'expiresAt',
            'checks',
            'deep',
            'limitations',
            'reasons',
          ])
        : null;
    },
  });
  return jsonResponse({ analysis });
}
