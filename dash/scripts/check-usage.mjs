// Update "usage": the demo gateway's usage reports (lib/anonymo/mock/usage.ts) and spending limits, through the client.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AnonymoApiError, createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { activityCsv, runway, sampleHistory, spendReport, spentWindows } from '../lib/anonymo/mock/usage.ts';

const NOW = Date.UTC(2026, 10, 18, 15, 0, 0); // 18 Nov 2026, 15:00 UTC
const DAY = 86_400_000;
const e = (daysAgo, musd, model = 'anonymo-1') => ({ at: NOW - daysAgo * DAY, model, musd, kind: 'call', requestId: `r${daysAgo}-${musd}` });

test('the report sums by day and by model, with totals, a projection and shares that add up', () => {
  const entries = [e(0, 100_000), e(0, 50_000, 'anonymo-rp'), e(1, 200_000), e(8, 1_000_000), e(40, 9_000_000)];
  const r = spendReport(entries, '30d', 'day', NOW);
  assert.equal(r.series.length, 30);
  assert.equal(r.series.at(-1).date, '2026-11-18');
  assert.equal(r.series.at(-1).cost_usd, 0.15);
  assert.equal(r.totals.today_usd, 0.15);
  assert.equal(r.totals.last_7d_usd, 0.35);
  assert.equal(r.totals.period_usd, 1.35);
  assert.equal(r.totals.period_requests, 4);
  assert.equal(r.totals.month_to_date_usd, 1.35);
  assert.equal(r.totals.projected_month_usd, Math.round((1_350_000 / 18) * 30) / 1_000_000);
  const m = spendReport(entries, '30d', 'model', NOW);
  assert.deepEqual(m.breakdown.map((b) => b.id), ['anonymo-1', 'anonymo-rp']);
  assert.ok(Math.abs(m.breakdown.reduce((s, b) => s + b.share, 0) - 1) < 0.01);
  assert.equal(spendReport(entries, '7d', 'day', NOW).series.length, 7);
});

test('a spike today is flagged only above twice the daily average and at least $0.50', () => {
  const quiet = [e(1, 70_000), e(2, 70_000), e(3, 70_000)];
  assert.equal(spendReport([...quiet, e(0, 60_000)], '7d', 'day', NOW).anomaly.flagged, false);
  assert.equal(spendReport([...quiet, e(0, 600_000)], '7d', 'day', NOW).anomaly.flagged, true);
});

test('runway: days of balance left at the last 7 days pace, none without spend', () => {
  assert.deepEqual(runway(10_000_000, [], NOW), { balance_usd: 10, spend_7d_usd: 0, per_day_usd: 0, days_left: null });
  assert.equal(runway(10_000_000, [e(1, 700_000), e(3, 700_000)], NOW).days_left, 50);
});

test('sample history is stable per seed, leaves today empty, and the CSV has one row per entry', () => {
  const a = sampleHistory('seed-1', NOW), b = sampleHistory('seed-1', NOW);
  assert.deepEqual(a, b);
  assert.ok(a.length > 0 && a.every((x) => x.at < NOW - (NOW % DAY)));
  const csv = activityCsv(a);
  assert.equal(csv.trim().split('\n').length, a.length + 1);
  assert.match(csv, /^at,kind,model,amount,currency,request_id\n/);
  const w = spentWindows([e(0, 5), e(3, 7), e(30, 11)], NOW);
  assert.deepEqual(w, { day: 5, month: 12, life: 23 });
});

test('limits: saved through PATCH /keys/caps, enforced as 402 key_cap_reached, and cleared with null', async () => {
  const mock = createMockGateway({ delayMs: 0, imageDelayMs: 0 });
  const anon = createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch });
  const created = await anon.createKey();
  const client = createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch, key: created.key });
  await mock.simulateDeposit(created.key, 'rhc', 'USDG', 5_000_000);
  const saved = await client.updateCaps({ daily_usd: '0.05' });
  assert.equal(saved.caps.daily_usd, 0.05);
  assert.equal((await client.keyInfo()).caps.daily_usd, 0.05);
  await client.generateImages({ model: 'google/nano-banana', prompt: 'a lighthouse', n: 1 });
  await assert.rejects(client.generateImages({ model: 'google/nano-banana', prompt: 'a lighthouse', n: 1 }), (err) => err instanceof AnonymoApiError && err.status === 402 && err.code === 'key_cap_reached' && /daily/.test(err.message));
  await assert.rejects(client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'hi' }] }), (err) => err instanceof AnonymoApiError && err.code === 'key_cap_reached');
  await assert.rejects(client.updateCaps({ daily_usd: 'lots' }), (err) => err instanceof AnonymoApiError && err.status === 400);
  await client.updateCaps({ daily_usd: null });
  await client.generateImages({ model: 'google/nano-banana', prompt: 'a lighthouse', n: 1 });
  const report = await client.spend('7d', 'model');
  assert.ok(report.breakdown.some((b) => b.id === 'google/nano-banana' && b.requests >= 2));
  assert.equal((await client.runway()).balance_usd, 4.9);
  assert.match(await client.activityCsv(), /google\/nano-banana/);
});
