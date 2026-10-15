import { fomoAnalysisResponse } from '../client/fomo-contracts.ts';
import { FOMO_HANDLE, type FomoAnalysis } from './fomo.ts';
import { publicCallStudy } from './fomo-call-study.ts';
import { fomoProfileView } from './fomo-view.ts';

export type FomoTopTenBundle = {
  schemaVersion: 1;
  generatedAt: string;
  leaderboard: {
    window: '30d';
    url: string;
    fetchedAt: string;
    observedAt: string;
    sha256: string;
    attribution: 'FOMO-reported via FOMO API';
  };
  entries: { rank: number; handle: string; analysis: FomoAnalysis }[];
};
const BOARD = 'https://api.fomo-api.com/v1/leaderboard?window=30d&limit=10&board=fomo-parity';
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const date = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));

/** A public, dated batch. Never ingest account-owned reports or user context. */
export function isFomoTopTenBundle(value: unknown): value is FomoTopTenBundle {
  if (!obj(value) || value.schemaVersion !== 1 || !date(value.generatedAt) || !obj(value.leaderboard) || !Array.isArray(value.entries) || value.entries.length !== 10) return false;
  const b = value.leaderboard;
  const generatedAt = value.generatedAt;
  if (b.window !== '30d' || b.url !== BOARD || b.attribution !== 'FOMO-reported via FOMO API' || !date(b.fetchedAt) || !date(b.observedAt) || typeof b.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(b.sha256) || Date.parse(b.observedAt) > Date.parse(b.fetchedAt) || Date.parse(b.fetchedAt) > Date.parse(generatedAt)) return false;
  const handles = new Set<string>();
  for (const [i, row] of value.entries.entries()) {
    if (!obj(row) || row.rank !== i + 1 || typeof row.handle !== 'string' || !FOMO_HANDLE.test(row.handle) || handles.has(row.handle.toLowerCase()) || !fomoAnalysisResponse({ analysis: row.analysis })) return false;
    const a = row.analysis as FomoAnalysis;
    if (a.input.kind !== 'profile' || a.input.handle?.toLowerCase() !== row.handle.toLowerCase() || a.callout !== null || Date.parse(a.createdAt) > Date.parse(generatedAt)) return false;
    if (a.sources.some(s => s.id === 'supplied-context' || s.id.startsWith('token-') || new URL(s.url).hostname === 'conclavemodels.com' || Date.parse(s.fetchedAt) > Date.parse(generatedAt))) return false;
    const rankSource = a.sources.find(s => s.id === 'public-profile-30d');
    const d = rankSource?.data, trader = d?.trader as Record<string, unknown> | undefined;
    if (!rankSource || rankSource.url !== BOARD || rankSource.fetchedAt !== b.fetchedAt || !d || d.source !== 'fomo' || d.board !== 'fomo-parity' || d.window !== '30d' || d.pnlBasis !== 'mark-to-market' || d.syncedAt !== b.observedAt || trader?.rank !== row.rank || typeof trader.handle !== 'string' || trader.handle.toLowerCase() !== row.handle.toLowerCase()) return false;
    handles.add(row.handle.toLowerCase());
  }
  return true;
}

export function fomoTopTenSummary(bundle: FomoTopTenBundle) {
  return {
    schemaVersion: 1 as const,
    generatedAt: bundle.generatedAt,
    leaderboard: bundle.leaderboard,
    entries: bundle.entries.map(({ rank, handle, analysis }) => {
      const profile = fomoProfileView(analysis), study = publicCallStudy(analysis);
      return { rank, handle, name: profile?.displayName ?? null, avatarUrl: profile?.avatarUrl ?? null,
        score: study?.score ?? null, measured: study?.measured ?? 0,
        pending: study?.pending ?? 0, calls: study?.outcomes.length ?? 0,
        collectedAt: analysis.createdAt };
    }),
  };
}
export type FomoTopTenSummary = ReturnType<typeof fomoTopTenSummary>;
export function isFomoTopTenSummary(v: unknown): v is FomoTopTenSummary {
  if (!obj(v) || v.schemaVersion !== 1 || !date(v.generatedAt) || !obj(v.leaderboard) || v.leaderboard.url !== BOARD || v.leaderboard.window !== '30d' || !date(v.leaderboard.observedAt) || !Array.isArray(v.entries) || v.entries.length !== 10) return false;
  return v.entries.every((e,i) => obj(e) && e.rank === i+1 && typeof e.handle === 'string' && FOMO_HANDLE.test(e.handle) && (e.score === null || typeof e.score === 'number' && Number.isInteger(e.score) && e.score >= 0 && e.score <= 100) && ['measured','pending','calls'].every(k => typeof e[k] === 'number' && Number.isInteger(e[k]) && e[k] >= 0) && date(e.collectedAt));
}
