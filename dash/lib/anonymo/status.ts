// Update "status": how the status page turns the gateway's figures into words and tones. Pure, so it is tested
// (scripts/check-status.mjs). Status colours are never the only signal: every tone comes with a word and an icon.

import type { SloState, StatusSlo } from './types.ts';

export type Tone = 'ok' | 'warn' | 'bad' | 'none';
export type Overall = { tone: Tone; title: string; detail: string };

const RANK: Record<SloState, number> = { no_data: 0, operational: 1, degraded: 2, outage: 3 };

/** The banner: the worst of the public lane, the surfaces, open incidents and this browser's own check. */
export function overall(slo: StatusSlo | null, reachable: boolean | null): Overall {
  if (reachable === false) return { tone: 'bad', title: 'The API isn’t answering', detail: 'This page could not reach the API from your browser. If it lasts, check the incidents below.' };
  if (!slo) return { tone: 'none', title: 'Checking…', detail: 'Reading the latest figures.' };
  const open = slo.incidents.open;
  const states = [slo.lanes.find((l) => l.lane === 'public')?.state ?? 'no_data', ...slo.surfaces.map((s) => s.state)];
  const worst = states.reduce<SloState>((w, s) => (RANK[s] > RANK[w] ? s : w), 'no_data');
  const impact = open.some((i) => i.impact === 'critical') ? 'outage' : open.some((i) => i.impact === 'major' || i.impact === 'minor') ? 'degraded' : null;
  const state: SloState = impact && RANK[impact] > RANK[worst] ? impact : worst;
  if (state === 'outage') return { tone: 'bad', title: 'Major outage', detail: open[0]?.title ?? 'Requests are failing more than they should.' };
  if (state === 'degraded') return { tone: 'warn', title: 'Some systems degraded', detail: open[0]?.title ?? 'Some requests are slower or failing more than usual.' };
  if (state === 'operational') return { tone: 'ok', title: 'All systems operational', detail: 'Requests are succeeding within target.' };
  return { tone: 'ok', title: 'Up and waiting for traffic', detail: 'The API is answering. Uptime figures appear once there are requests to count.' };
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v == null) return '—';
  const p = v * 100;
  return `${p >= 99.995 && p < 100 ? '99.99' : p.toFixed(p === 100 ? 0 : digits)}%`;
}

/** A day's tone against the target: at or above target is ok, within 1 point below is a warning, worse is bad. */
export function dayTone(availability: number | null, target: number): Tone {
  if (availability == null) return 'none';
  if (availability >= target) return 'ok';
  return availability >= target - 0.01 ? 'warn' : 'bad';
}

export const stateTone = (s: SloState): Tone => (s === 'operational' ? 'ok' : s === 'degraded' ? 'warn' : s === 'outage' ? 'bad' : 'none');
export const stateWord = (s: SloState) => ({ operational: 'Operational', degraded: 'Degraded', outage: 'Outage', no_data: 'No traffic yet' })[s];

export function ms(v: number | null | undefined): string {
  if (v == null) return '—';
  return v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

/** Surface names as people read them. */
export const SURFACE_NAMES: Record<string, string> = { chat: 'Chat API', messages: 'Messages API (Anthropic-style)', batch: 'Batch API', images: 'Images', media: 'Images and voice' };
export const surfaceName = (s: string) => SURFACE_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
