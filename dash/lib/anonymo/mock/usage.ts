// Usage for the demo gateway (update "usage"): the same report shapes as the gateway's /api/v1/spend,
// /api/v1/account/runway and /api/v1/activity, computed from what the demo key spent plus a seeded month of sample
// history, so the charts have something to show. Amounts are micro-USD (1e-6 USD) inside, USD numbers outside.

import type { Runway, SpendGroup, SpendPeriod, SpendReport } from '../types.ts';

export type UsageEntry = { at: number; model: string; musd: number; kind: 'call' | 'image'; requestId: string };

const DAY = 86_400_000;
const PERIOD_DAYS: Record<SpendPeriod, number> = { '7d': 7, '30d': 30, '90d': 90 };
const usd = (musd: number) => Math.round(musd) / 1_000_000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (ms: number) => Math.floor(ms / DAY) * DAY;

function seeded(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const SAMPLE_MODELS: [string, number, number, UsageEntry['kind']][] = [
  // model, weight, typical micro-USD per request, kind
  ['anonymo-1', 0.55, 16_000, 'call'],
  ['anonymo-rp', 0.2, 21_000, 'call'],
  ['anonymo-council', 0.1, 58_000, 'call'],
  ['anonymo-sealed', 0.07, 27_000, 'call'],
  ['google/nano-banana', 0.08, 50_000, 'image'],
];

/** A month of plausible sample usage before `now`, the same every time for the same seed. Today is left empty. */
export function sampleHistory(seed: string, now: number, days = 29): UsageEntry[] {
  const rand = seeded(seed);
  const out: UsageEntry[] = [];
  const today = startOfDay(now);
  for (let d = days; d >= 1; d--) {
    const weekend = new Date(today - d * DAY).getUTCDay() % 6 === 0;
    const count = Math.floor(rand() * (weekend ? 22 : 12));
    for (let i = 0; i < count; i++) {
      let pick = rand();
      const [model, , base, kind] = SAMPLE_MODELS.find(([, w]) => (pick -= w) < 0) ?? SAMPLE_MODELS[0];
      out.push({ at: today - d * DAY + Math.floor(rand() * DAY), model, musd: Math.round(base * (0.5 + rand())), kind, requestId: `sample-${d}-${i}` });
    }
  }
  return out;
}

export function spendReport(entries: UsageEntry[], period: SpendPeriod, groupBy: SpendGroup, now: number): SpendReport {
  const days = PERIOD_DAYS[period];
  const today = startOfDay(now);
  const from = today - (days - 1) * DAY;
  const inPeriod = entries.filter((e) => e.at >= from && e.at < today + DAY);
  const series = Array.from({ length: days }, (_, i) => {
    const start = from + i * DAY;
    const day = inPeriod.filter((e) => e.at >= start && e.at < start + DAY);
    return { date: dayKey(start), cost_usd: usd(day.reduce((s, e) => s + e.musd, 0)), requests: day.length };
  });
  const sum = (a: number, b: number) => entries.filter((e) => e.at >= a && e.at < b).reduce((s, e) => s + e.musd, 0);
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = d.getUTCDate();
  const todayMusd = sum(today, today + DAY);
  const trailing7 = sum(today - 7 * DAY, today);
  const mtd = sum(monthStart, today + DAY);
  const periodMusd = inPeriod.reduce((s, e) => s + e.musd, 0);
  const share = (m: number) => (periodMusd ? Math.round((m / periodMusd) * 1000) / 1000 : 0);
  let breakdown: SpendReport['breakdown'];
  if (groupBy === 'day') breakdown = series.map((s) => ({ id: s.date, cost_usd: s.cost_usd, requests: s.requests, share: share(s.cost_usd * 1_000_000) }));
  else {
    const by = new Map<string, { musd: number; n: number }>();
    for (const e of inPeriod) {
      const v = by.get(e.model) ?? { musd: 0, n: 0 };
      by.set(e.model, { musd: v.musd + e.musd, n: v.n + 1 });
    }
    breakdown = [...by].map(([id, v]) => ({ id, cost_usd: usd(v.musd), requests: v.n, share: share(v.musd) })).sort((a, b) => b.cost_usd - a.cost_usd);
  }
  const avg = trailing7 / 7;
  return {
    scope: 'key',
    period,
    group_by: groupBy,
    as_of: new Date(now).toISOString(),
    timezone: 'UTC',
    range: { from: dayKey(from), to: dayKey(today) },
    totals: {
      today_usd: usd(todayMusd),
      last_7d_usd: usd(sum(today - 6 * DAY, today + DAY)),
      month_to_date_usd: usd(mtd),
      projected_month_usd: usd((mtd / dayOfMonth) * daysInMonth),
      period_usd: usd(periodMusd),
      period_requests: inPeriod.length,
      day_of_month: dayOfMonth,
      days_in_month: daysInMonth,
    },
    anomaly: {
      flagged: todayMusd >= 500_000 && todayMusd > avg * 2,
      today_usd: usd(todayMusd),
      trailing_daily_avg_usd: usd(avg),
      ratio: avg ? Math.round((todayMusd / avg) * 100) / 100 : null,
      multiplier: 2,
      min_today_usd: 0.5,
    },
    series,
    breakdown,
  };
}

/** Days of balance left at the last 7 days' pace, like the gateway's runwayMath. */
export function runway(balanceMusd: number, entries: UsageEntry[], now: number): Runway {
  const spend7 = entries.filter((e) => e.at >= now - 7 * DAY && e.at <= now).reduce((s, e) => s + e.musd, 0);
  return { balance_usd: usd(balanceMusd), spend_7d_usd: usd(spend7), per_day_usd: usd(spend7) / 7, days_left: spend7 ? Math.floor((balanceMusd * 7) / spend7) : null };
}

export function activityCsv(entries: UsageEntry[]): string {
  const rows = [...entries].sort((a, b) => b.at - a.at).map((e) => [new Date(e.at).toISOString(), e.kind === 'image' ? 'image' : 'call', e.model, `-${usd(e.musd).toFixed(6)}`, 'USDG', e.requestId].join(','));
  return `at,kind,model,amount,currency,request_id\n${rows.join('\n')}\n`;
}

/** Spent in the current UTC day, calendar month, and ever (for cap checks). */
export function spentWindows(entries: UsageEntry[], now: number) {
  const today = startOfDay(now);
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  let day = 0, month = 0, life = 0;
  for (const e of entries) {
    life += e.musd;
    if (e.at >= monthStart) month += e.musd;
    if (e.at >= today) day += e.musd;
  }
  return { day, month, life };
}
