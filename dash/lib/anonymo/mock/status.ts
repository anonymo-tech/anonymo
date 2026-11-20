// Status for the demo gateway (update "status"): the shape of GET /api/v1/status/slo with seeded, plausible figures
// (a quiet 90 days with two dips and one resolved incident), so the status page has something to show in demo mode.

import type { Incident, SloLane, SloSurface, SloWindow, StatusSlo } from '../types.ts';

const DAY = 86_400_000;

function seeded(seed: number) {
  let h = seed >>> 0;
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const win = (availability: number, eligible: number): SloWindow => ({ availability, eligible });

export function demoStatus(now: number): StatusSlo {
  const today = Math.floor(now / DAY) * DAY;
  const rand = seeded(4663);
  const dips: Record<number, number> = { 23: 0.9812, 61: 0.9934 };
  const daily = Array.from({ length: 90 }, (_, i) => {
    const daysAgo = 89 - i;
    const availability = dips[daysAgo] ?? Math.min(1, 0.9985 + rand() * 0.0015);
    return { day: new Date(today - daysAgo * DAY).toISOString().slice(0, 10), availability: Math.round(availability * 100000) / 100000, eligible: 1800 + Math.floor(rand() * 2400) };
  });
  const lat = (p50: number, p95: number) => ({ p50_ms: p50, p95_ms: p95, samples: 3400 });
  const windows = { '1h': win(1, 142), '24h': win(0.99962, 3120), '7d': win(0.99941, 21870), '30d': win(0.99893, 92410) };
  const publicLane: SloLane = { lane: 'public', state: 'operational', target: 0.995, windows, latency_24h: lat(640, 1900), daily };
  const attested: SloLane = { lane: 'attested', state: 'operational', target: 0.99, windows: { '1h': win(1, 12), '24h': win(0.9981, 260), '7d': win(0.9978, 1730), '30d': win(0.9969, 7120) } };
  const surface = (name: string, p50: number, p95: number, a24 = 0.99962): SloSurface => ({
    surface: name,
    state: 'operational',
    target: 0.995,
    windows: { '1h': win(1, 90), '24h': win(a24, 2400), '7d': win(0.99938, 16100), '30d': win(0.99891, 70200) },
    latency_24h: lat(p50, p95),
  });
  const started = new Date(today - 23 * DAY + 14 * 3_600_000);
  const incident: Incident = {
    id: 'inc_demo0001',
    title: 'Slower replies on anonymo-council',
    status: 'resolved',
    impact: 'minor',
    lanes: ['public'],
    surfaces: ['chat'],
    started_at: started.toISOString(),
    resolved_at: new Date(started.getTime() + 47 * 60_000).toISOString(),
    updated_at: new Date(started.getTime() + 47 * 60_000).toISOString(),
    updates: [
      { at: new Date(started.getTime() + 47 * 60_000).toISOString(), status: 'resolved', text: 'Replies are back to normal speed. The slow route was taken out of rotation; no requests were lost.' },
      { at: new Date(started.getTime() + 18 * 60_000).toISOString(), status: 'identified', text: 'One upstream route for the council was answering slowly. The router is sending its seat to other routes.' },
      { at: started.toISOString(), status: 'investigating', text: 'Council replies are taking longer than usual. Other models are not affected.' },
    ],
  };
  return {
    generated_at: new Date(now).toISOString(),
    targets: { public: 0.995, attested: 0.99 },
    lanes: [publicLane, attested],
    surfaces: [surface('chat', 610, 1850), surface('messages', 700, 2100), surface('images', 14_200, 31_000, 0.9989)],
    synthetic_24h: { ok: 7712, total: 7741, availability: 0.99625 },
    incidents: { open: [], recent: [incident] },
  };
}
