// Update "status": the banner wording, tones and formats (lib/anonymo/status.ts) and the demo gateway's status data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { demoStatus } from '../lib/anonymo/mock/status.ts';
import { dayTone, ms, overall, pct, stateTone, surfaceName } from '../lib/anonymo/status.ts';

const NOW = Date.UTC(2026, 10, 20, 12);
const base = () => structuredClone(demoStatus(NOW));

test('the banner takes the worst of the lane, the services, open incidents and this browser’s own check', () => {
  assert.equal(overall(null, null).title, 'Checking…');
  assert.equal(overall(base(), false).tone, 'bad');
  assert.deepEqual([overall(base(), true).tone, overall(base(), true).title], ['ok', 'All systems operational']);
  const degraded = base();
  degraded.surfaces[1].state = 'degraded';
  assert.equal(overall(degraded, true).tone, 'warn');
  const incident = base();
  incident.incidents.open = [{ ...incident.incidents.recent[0], status: 'investigating', impact: 'critical', title: 'Chat is failing' }];
  assert.deepEqual([overall(incident, true).tone, overall(incident, true).detail], ['bad', 'Chat is failing']);
  const quiet = base();
  quiet.lanes[0].state = 'no_data';
  for (const s of quiet.surfaces) s.state = 'no_data';
  assert.equal(overall(quiet, true).title, 'Up and waiting for traffic');
});

test('formats and tones', () => {
  assert.equal(pct(null), '—');
  assert.equal(pct(1), '100%');
  assert.equal(pct(0.99962), '99.96%');
  assert.equal(pct(0.999991), '99.99%', 'never rounds up to 100% unless it is 100%');
  assert.equal(pct(0.98123, 1), '98.1%');
  assert.equal(dayTone(null, 0.995), 'none');
  assert.equal(dayTone(0.996, 0.995), 'ok');
  assert.equal(dayTone(0.99, 0.995), 'warn');
  assert.equal(dayTone(0.98, 0.995), 'bad');
  assert.equal(stateTone('outage'), 'bad');
  assert.equal(ms(640), '640 ms');
  assert.equal(ms(1900), '1.9 s');
  assert.equal(ms(14200), '14 s');
  assert.equal(surfaceName('chat'), 'Chat API');
  assert.equal(surfaceName('rerank'), 'Rerank');
});

test('the demo gateway serves 90 days of status and a health check, without a key', async () => {
  const client = createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: createMockGateway({ delayMs: 0 }).fetch });
  const slo = await client.statusSlo();
  assert.equal(slo.lanes[0].daily.length, 90);
  assert.ok(slo.surfaces.length >= 2 && slo.incidents.recent.length === 1);
  assert.ok(typeof (await client.ping()) === 'number');
  assert.equal(client.url('/api/v1/status/incidents.rss'), 'https://demo.anonymo.invalid/api/v1/status/incidents.rss');
});
