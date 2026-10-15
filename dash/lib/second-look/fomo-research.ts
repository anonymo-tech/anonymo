import type { FomoAnalysis, FomoSource } from './fomo.ts';
import { publicCallStudy } from './fomo-call-study.ts';

export const FOMO_METHOD_VERSION = 'research-0.1.0';
export const FOMO_FACTORS = [
  { id: 'returns', label: 'Net performance', weight: 30, requirement: 'Reconciled, cash-flow-adjusted returns and a matched benchmark.' },
  { id: 'risk', label: 'Downside & exposure', weight: 25, requirement: 'A complete daily equity path, drawdowns and portfolio weights.' },
  { id: 'consistency', label: 'Consistency', weight: 20, requirement: 'At least 30 complete days and 30 closed positions across 3 assets.' },
  { id: 'execution', label: 'Execution costs', weight: 15, requirement: 'Dated fills, fees and executable arrival quotes for the full sample.' },
  { id: 'calls', label: 'Callout follow-through', weight: 10, requirement: 'A complete timestamped callout cohort with fixed-horizon outcomes.' },
] as const;
export type ResearchCheck = {
  id: string; label: string;
  status: 'checked' | 'observed' | 'unknown' | 'conflict' | 'stale';
  detail: string; sourceIds: string[];
};
export type FomoResearch = {
  version: typeof FOMO_METHOD_VERSION;
  score: null;
  status: 'insufficient-evidence';
  confidence: 'insufficient';
  checks: ResearchCheck[];
  observedChecks: number;
  totalChecks: number;
  sourceFamilies: number;
  factors: typeof FOMO_FACTORS;
  reason: string;
};
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const rows = (x: unknown) => Array.isArray(x) ? x.filter(obj) : [];
const present = (s: FomoSource) => s.state !== 'unavailable' && s.data !== null;
const ids = (s: FomoSource[]) => [...new Set(s.map(x => x.id))];
const cleanHandle = (x: unknown) => typeof x === 'string' ? x.toLowerCase() : null;

/** Evidence inspection is deliberately separate from a performance grade. Public
 * leaderboard snapshots cannot silently become a reconciled trade ledger. The
 * server-only quantitative engine accepts no model-authored or API-body score. */
export function researchFomoEvidence(a: FomoAnalysis): FomoResearch {
  const study = publicCallStudy(a);
  const available = a.sources.filter(present);
  const target = cleanHandle(a.input.handle ?? a.callout?.author);
  const profiles = available.filter(s => {
    const d = s.data!;
    const t = obj(d.trader) ? d.trader : d;
    return (s.id === 'profile' || s.id.startsWith('public-profile-')) && !!target && cleanHandle(t.handle) === target;
  });
  const calls = available.filter(s => s.id === 'calls' || s.id === 'public-calls' || s.id === 'public-trader-calls');
  const callRows = calls.flatMap(s => rows(s.data?.items).filter(r => {
    const author = obj(r.author) ? r.author.userHandle : r.authorHandle;
    return !!target && cleanHandle(author) === target;
  }));
  const markets = available.filter(s => s.id === 'market' || /^market-position-\d+$/.test(s.id));
  const chain = available.filter(s => (s.id === 'chain-mint' || /^chain-position-\d+$/.test(s.id)) && s.data?.method === 'finalized-mint-bytes' && rows(s.data.checks).some(c=>c.id===1 && c.status==='complete'));
  const tokens = available.filter(s => s.id === 'token-check' || /^token-position-\d+$/.test(s.id));
  const walletSources = profiles.filter(s => {
    const d = s.data!, t = obj(d.trader) ? d.trader : d;
    return [t.solanaAddress, t.evmAddress].some(x => typeof x === 'string' && /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/.test(x)) || rows(t.wallets).some(w => typeof w.address === 'string' && /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/.test(w.address));
  });
  const timed = profiles.filter(s => {
    const d = s.data!, t = obj(d.trader) ? d.trader : d;
    const ts = Date.parse(String(t.syncedAt ?? t.fetchedAt ?? s.observedAt ?? ''));
    return Number.isFinite(ts) && ts <= Date.parse(a.createdAt) + 60_000 && Date.parse(a.createdAt) - ts <= 86400_000 && d.stale !== true && !/marked.*stale/i.test(s.note);
  });
  const accounting = profiles.filter(s => {
    const t = s.data?.trader;
    return obj(t) && num(t.realizedPnlUsd) && num(t.unrealizedPnlUsd);
  });
  const metadataConflict = profiles.filter(s => obj(s.data?.trader) && typeof s.data.trader.source === 'string' && s.data.trader.source !== s.data.source && /^public-profile-(24h|7d|30d)$/.test(s.id));
  const datedCalls = callRows.filter(r => {
    const stamp = r.createdAt ?? r.fomoCreatedAt;
    const t = typeof stamp === 'number' ? stamp : Date.parse(String(stamp ?? ''));
    return Number.isFinite(t) && t <= Date.parse(a.createdAt);
  });
  const incentives = callRows.filter(r => typeof r.authorIsDev === 'boolean' || num(r.holdingsUsd) || (obj(r.position) && Object.values(r.position).some(num)));
  const c = (id: string, label: string, status: ResearchCheck['status'], detail: string, sources: FomoSource[] = []): ResearchCheck => ({ id, label, status, detail, sourceIds: ids(sources) });
  const checks: ResearchCheck[] = [
    c('identity', 'Profile attribution', profiles.length ? 'observed' : 'unknown', profiles.length ? 'The returned handle matches the requested public profile. This does not verify a real-world identity.' : 'No matching public profile was retrieved.', profiles),
    c('wallets', 'Public wallet links', walletSources.length ? 'observed' : 'unknown', walletSources.length ? 'The source publishes a wallet link. Ownership and ledger reconciliation require separate verification.' : 'No attributable wallet link. We do not guess private wallets.', walletSources),
    c('freshness', 'Observation dates', timed.length ? 'observed' : profiles.length ? 'stale' : 'unknown', timed.length ? 'At least one profile observation is dated within 24 hours of this research snapshot.' : 'No profile observation with a usable date within 24 hours.', timed.length ? timed : profiles),
    c('accounting', 'Accounting basis', metadataConflict.length ? 'conflict' : accounting.length ? 'observed' : 'unknown', metadataConflict.length ? 'Source metadata disagrees. Affected numbers cannot enter the score.' : accounting.length ? 'A provider reports a 30-day realized/unrealized split. Cost basis and transactions are not independently reconciled.' : 'No compatible realized/unrealized breakdown was retrieved.', metadataConflict.length ? metadataConflict : accounting),
    c('ledger', 'Trade history & cash flows', 'unknown', 'Complete fills, transfers, opening inventory and fees are required. Aggregate PnL is not a substitute.'),
    c('risk', 'Drawdowns & consistency', study?.measured ? 'observed' : 'unknown', study?.measured ? 'Post-call adverse price moves and outcome consistency are measured in the public-call study. Account-wide equity drawdown still requires a reconciled ledger.' : 'A complete cash-flow-adjusted equity series is needed to measure losing periods and drawdowns.', study?.measured ? available.filter(s=>s.id.startsWith('call-price-')) : []),
    c('portfolio', 'Portfolio concentration', 'unknown', 'Top holdings omit the portfolio denominator. Concentration cannot be calculated from a partial list.'),
    c('callouts', 'Original callout record', a.input.kind === 'callout' ? a.callout?.verified && !!a.callout.createdAt ? 'observed' : 'unknown' : datedCalls.length ? 'observed' : 'unknown', a.input.kind === 'callout' ? a.callout?.verified ? 'The exact callout ID was matched in the source. Publication history and outcomes remain separate checks.' : 'The exact original callout was not matched. User-supplied text is not verified publication.' : datedCalls.length ? `${datedCalls.length} dated calls match the handle in the retrieved sample. The history is not complete.` : 'No dated callouts for this handle in the retrieved sample. This is not evidence that none exist.', calls),
    c('outcomes', 'Callout outcomes', study?.measured ? 'observed' : 'unknown', study?.measured ? `${study.measured} public calls evaluated over a fixed 24-hour price window. Pool marks and a stated cost scenario, not actual executed trades or the complete call history.` : 'Original timestamps and historical prices at fixed horizons are required. Current prices cannot establish past entry prices.', study?.measured ? available.filter(s=>s.id.startsWith('call-price-')) : []),
    c('markets', 'Liquidity & trading context', markets.length ? 'observed' : 'unknown', markets.length ? `${markets.length} exact-asset market snapshots retrieved. Pool liquidity is not an executable exit quote or proof of historical liquidity.` : 'No exact-asset market snapshot was retrieved.', markets),
    c('token-controls', 'Token controls', chain.length ? 'checked' : tokens.length ? 'observed' : 'unknown', chain.length ? `${chain.length} Solana mint checked from finalized account bytes. Authority state and extension coverage are in the source. Holder concentration and sellability are separate, unverified checks.` : tokens.length ? 'Saved token checks are attached with their original coverage. A saved report is not a new chain verification.' : 'No fresh mint or saved token checks are available.', [...chain, ...tokens]),
    c('incentives', 'Positions & incentives', incentives.length ? 'observed' : 'unknown', incentives.length ? 'Published position/developer fields were found. These are source-reported disclosures, not proof of misconduct or a complete record of compensation.' : 'No usable position/developer disclosure was retrieved. Undisclosed incentives remain unknown.', calls),
  ];
  const families = new Set(available.map(s => s.id.startsWith('call-price-') ? 'historical-market-index' : s.id.startsWith('chain-') ? 'solana-rpc' : s.id === 'market' || s.id.startsWith('market-position-') ? 'market-index' : s.id.startsWith('token-') ? 'saved-token-tools' : s.id === 'supplied-context' ? 'user' : 'fomo-derived'));
  families.delete('user');
  return {
    version: FOMO_METHOD_VERSION, score: null, status: 'insufficient-evidence', confidence: 'insufficient',
    checks, observedChecks: checks.filter(x => x.status === 'observed' || x.status === 'checked').length, totalChecks: checks.length,
    sourceFamilies: families.size, factors: FOMO_FACTORS,
    reason: 'Research is available, but these public feeds do not provide the reconciled history needed for a fair performance score.',
  };
}

/** Select bounded research targets from observed records, never names/symbols.
 * Do not infer which assets a person owns from unrelated feed entries. */
export function fomoResearchTargets(a: Pick<FomoAnalysis, 'input' | 'sources'>) {
  const result: { chain: string; token: string }[] = [];
  const add = (chain: unknown, token: unknown) => {
    if (typeof chain !== 'string' || typeof token !== 'string' || !['solana', 'ethereum', 'base', 'bsc', 'monad', 'robinhood'].includes(chain)) return;
    if (!(chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-fA-F0-9]{40}$/).test(token)) return;
    const address = chain === 'solana' ? token : token.toLowerCase();
    if (!result.some(x => x.chain === chain && x.token === address)) result.push({ chain, token: address });
  };
  for (const s of a.sources.filter(present)) {
    const d = s.data!;
    if (obj(d.trader) && cleanHandle(d.trader.handle) === cleanHandle(a.input.handle))
      for (const h of rows(d.trader.topHoldings)) add(h.network, h.tokenAddress);
    for (const c of rows(d.items)) {
      const author = obj(c.author) ? c.author.userHandle : c.authorHandle;
      if (!a.input.handle || cleanHandle(author) !== cleanHandle(a.input.handle)) continue;
      if (obj(c.token)) add(c.network, c.token.address);
    }
  }
  return result.slice(0, 3);
}
