import { parseFomoInput, type FomoAnalysis } from '../second-look/fomo.ts';
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown, max: number) =>
  typeof x === 'string' && x.length <= max;
const date = (x: unknown) =>
  typeof x === 'string' && Number.isFinite(Date.parse(x));
export function fomoAnalysisResponse(
  x: unknown,
): x is { analysis: FomoAnalysis } {
  if (!object(x) || !object(x.analysis)) return false;
  const a = x.analysis;
  if (
    !text(a.id, 80) ||
    !date(a.createdAt) ||
    !text(a.title, 160) ||
    !['ready', 'partial', 'unavailable'].includes(String(a.state)) ||
    !object(a.input) ||
    typeof a.input.url !== 'string'
  )
    return false;
  try {
    const parsed = parseFomoInput(a.input.url),
      input = a.input;
    if (
      Object.keys(parsed).some(
        (k) => parsed[k as keyof typeof parsed] !== input[k],
      )
    )
      return false;
  } catch {
    return false;
  }
  if (
    a.callout !== null &&
    (!object(a.callout) ||
      !text(a.callout.text, 8000) ||
      !(a.callout.author === null || text(a.callout.author, 64)) ||
      !(a.callout.createdAt === null || date(a.callout.createdAt)) ||
      typeof a.callout.verified !== 'boolean')
  )
    return false;
  if (
    !Array.isArray(a.limitations) ||
    a.limitations.length > 30 ||
    !a.limitations.every((v) => text(v, 1000))
  )
    return false;
  if (
    !Array.isArray(a.sources) ||
    a.sources.length > 64 ||
    !a.sources.every((s) => {
      if (
        !object(s) ||
        !text(s.id, 40) ||
        !text(s.label, 100) ||
        !date(s.fetchedAt) ||
        !(s.observedAt === null || date(s.observedAt)) ||
        !text(s.note, 1000) ||
        !['available', 'partial', 'unavailable'].includes(String(s.state)) ||
        !(s.data === null || object(s.data))
      )
        return false;
      try {
        const u = new URL(String(s.url));
        return (
          u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          !u.port &&
          [
            'fomo-public.pootracker.app',
            'api.dexscreener.com',
            'api.fomo-api.com',
            'fomolens.app',
            'conclavemodels.com',
            'fomo.family',
            'explorer.solana.com',
            'api.geckoterminal.com',
          ].includes(u.hostname)
        );
      } catch {
        return false;
      }
    })
  )
    return false;
  return new Set(a.sources.map((s) => s.id)).size === a.sources.length;
}
