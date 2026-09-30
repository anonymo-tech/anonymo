import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveModelMentions,
  parseRoutingProfile,
  routingProfileFresh,
} from '../lib/model-routing.ts';

const now = Date.parse('2026-10-10T10:00:00.000Z');
const routes = ['claude', 'gpt', 'gemini', 'deepseek', 'qwen', 'llama'].map(
  (family, i) => ({
    versionId: `00000000-0000-4000-8000-00000000000${i}`,
    modelId: `${family}/test-model`,
    family,
    available: true,
    expiresAt: '2026-10-10T11:00:00.000Z',
  }),
);
const resolve = (prompt, catalog = routes) =>
  resolveModelMentions(prompt, catalog, now);
const rejects = (prompt, code, catalog = routes) =>
  assert.throws(
    () => resolve(prompt, catalog),
    (error) => error.code === code,
  );
const profile = () => ({
  version: 1,
  tasks: ['general', 'code'],
  evidenceUrl: 'https://inference.invalid/api-docs',
  reviewedAt: '2026-10-10T09:00:00.000Z',
});

void test('mentions choose exact routes in order anywhere in prose and preserve other text', () => {
  assert.deepEqual(resolve('Review @Claude this change with @gpt, please.'), {
    prompt: 'Review  this change with , please.',
    routeVersionIds: [routes[0].versionId, routes[1].versionId],
    mentions: ['@Claude', '@gpt'],
  });
});
