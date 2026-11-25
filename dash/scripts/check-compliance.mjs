import assert from 'node:assert/strict';
import test from 'node:test';
import { AnonymoApiError, createAnonymoClient, describeError } from '../lib/anonymo/client.ts';
import { companionSignals, disclosureDelay, AI_NOTICE_INTERVAL_MS } from '../lib/anonymo/safety.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

test('compliance ships opt-in and appears in demo', () => {
  assert.equal(parseUpdates(undefined).has('compliance'), false);
  assert.equal(parseUpdates('compliance').has('compliance'), true);
  assert.equal(updateOn('compliance', true), true);
});

test('the regional disclosure is due at the supplied interval and resets from the last disclosure', () => {
  const start = 20_000;
  assert.equal(disclosureDelay(start, start, null), AI_NOTICE_INTERVAL_MS);
  for (const minutes of [1, 60, 120]) {
    const dueAt = start + minutes * 60_000;
    assert.equal(disclosureDelay(start, dueAt - 1, minutes), 1);
    assert.equal(disclosureDelay(start, dueAt, minutes), 0);
    assert.equal(disclosureDelay(dueAt, dueAt, minutes), minutes * 60_000);
  }
});

test('companion turns retain the existing crisis signals and disclose when asked', () => {
  assert.deepEqual(companionSignals('I have been thinking about suicide.'), { crisis: true, asksAboutAI: false });
  assert.deepEqual(companionSignals('Are you an AI?'), { crisis: false, asksAboutAI: true });
  assert.deepEqual(companionSignals('Am I talking to a real person?'), { crisis: false, asksAboutAI: true });
  assert.deepEqual(companionSignals('Are you ready to chat?'), { crisis: false, asksAboutAI: false });
});

test('the region client sends the declaration and submits the proof only on the proof endpoint', async () => {
  const calls = [];
  const client = createAnonymoClient({
    baseUrl: '',
    key: 'sample-key', // gitleaks:allow
    declaredRegion: 'US-NY',
    fetch: async (url, options) => {
      calls.push([url, options.headers.get('x-anonymo-declared-region'), options.body]);
      const value = options.method === 'POST'
        ? { verified: true }
        : { mode: 'proof_required', access: false, disclosure_interval_min: 60 };
      return Response.json(value);
    },
  });
  assert.equal((await client.regionCompliance()).access, false);
  assert.equal((await client.submitAgeProof('proof-fixture')).verified, true);
  assert.deepEqual(calls, [
    ['/v1/compliance/region', 'US-NY', undefined],
    ['/v1/compliance/age-proof', 'US-NY', '{"proof":"proof-fixture"}'],
  ]);
  const error = new AnonymoApiError(451, 'region_blocked', 'Anonymo is unavailable here.', null, { region_page: '/v1/compliance/region' });
  assert.equal(describeError(error), 'Anonymo is unavailable here.');
});
