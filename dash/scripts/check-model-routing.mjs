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
void test('explicit model identifiers resolve exactly and aliases deduplicate by route', () => {
  const result = resolve(
    'Explain @claude @claude @{claude/test-model} and @{gpt/test-model}.',
  );
  assert.deepEqual(result.routeVersionIds, [
    routes[0].versionId,
    routes[1].versionId,
  ]);
  assert.equal(result.mentions.length, 4);
  assert.equal(result.prompt, 'Explain    and .');
});
void test('mentions leave email handles domain paths and URLs literal', () => {
  const source =
    'Email name@gpt.com, @claude.example, or user+@gpt.test. https://example.invalid/(@claude) and www.example.invalid/@gpt remain text. @friend can help.';
  assert.deepEqual(resolve(source), {
    prompt: source,
    routeVersionIds: [],
    mentions: [],
  });
});
void test('inline code multiple backticks escaped tokens and angle text remain literal', () => {
  const source =
    'Use `@claude`, ``code ` @gpt``, \\@gemini and <@qwen>. Ask @gpt next.';
  const result = resolve(source);
  assert.deepEqual(result.routeVersionIds, [routes[1].versionId]);
  assert.equal(result.prompt, source.replace('Ask @gpt next.', 'Ask  next.'));
});
void test('fenced indented and blockquoted examples never choose a model', () => {
  const source =
    '```js\n@claude\n````\n~~~\n@gpt\n~~~\n    @qwen\n\t@llama\n> @deepseek\n\nAsk @gemini now.';
  const result = resolve(source);
  assert.deepEqual(result.routeVersionIds, [routes[2].versionId]);
  assert.equal(result.prompt, source.replace('Ask @gemini now.', 'Ask  now.'));
});
void test('unclosed code is treated as literal and cannot start paid routing commands', () => {
  for (const source of [
    '```\n@claude',
    'before `@gpt and @qwen',
    '~~~\n@llama',
  ])
    assert.deepEqual(resolve(source).routeVersionIds, []);
});
void test('lazy blockquote continuations stay literal until the paragraph ends', () => {
  const source =
    '> Quoted example\n@gpt is part of the quoted paragraph.\nStill @claude.\n\nAsk @gemini about it.';
  assert.deepEqual(resolve(source).routeVersionIds, [routes[2].versionId]);
  assert.equal(
    resolve(source).prompt,
    source.replace('Ask @gemini about it.', 'Ask  about it.'),
  );
});
void test('unknown malformed and unavailable explicit mentions fail without fallback', () => {
  rejects('Ask @{missing/model}', 'MODEL_MENTION_UNAVAILABLE');
  rejects('Ask @{gpt/test-model', 'MODEL_MENTION_INVALID');
  rejects('Ask @{gpt test-model}', 'MODEL_MENTION_INVALID');
  rejects('Ask @{gpt/test-model}suffix', 'MODEL_MENTION_INVALID');
  rejects('Ask @grok', 'MODEL_MENTION_UNAVAILABLE');
  rejects(
    'Ask @claude',
    'MODEL_MENTION_UNAVAILABLE',
    routes.map((r) => ({ ...r, available: false })),
  );
  rejects(
    'Ask @claude',
    'MODEL_MENTION_UNAVAILABLE',
    routes.map((r) => ({ ...r, expiresAt: new Date(now).toISOString() })),
  );
});
void test('ambiguous aliases require a specific model and ambiguous exact routes fail', () => {
  const duplicate = {
    ...routes[0],
    versionId: routes[5].versionId,
    modelId: 'claude/other-model',
  };
  rejects('Ask @claude', 'MODEL_MENTION_AMBIGUOUS', [...routes, duplicate]);
  assert.deepEqual(
    resolve('Ask @{claude/test-model}', [...routes, duplicate]).routeVersionIds,
    [routes[0].versionId],
  );
  rejects('Ask @{claude/test-model}', 'MODEL_MENTION_AMBIGUOUS', [
    ...routes,
    { ...duplicate, modelId: routes[0].modelId },
  ]);
});
void test('four unique models are allowed and five fail rather than truncate', () => {
  assert.equal(
    resolve('Ask @claude @gpt @gemini @deepseek').routeVersionIds.length,
    4,
  );
  rejects('Ask @claude @gpt @gemini @deepseek @qwen', 'MODEL_MENTION_LIMIT');
});
void test('empty or excessive questions fail and ordinary prompts stay unchanged', () => {
  for (const source of ['', '   ', '@claude', 'x'.repeat(6001)])
    rejects(source, 'INVALID_PROMPT');
  assert.equal(
    resolve('Explain ordinary text.').prompt,
    'Explain ordinary text.',
  );
  assert.equal(resolve('x'.repeat(6000)).prompt.length, 6000);
});
void test('routing profiles are explicit copied task lists without implicit general capability', () => {
  const input = profile(),
    parsed = parseRoutingProfile(input);
  input.tasks.push('writing');
  assert.deepEqual(parsed.tasks, ['general', 'code']);
  assert.deepEqual(
    parseRoutingProfile({ ...profile(), tasks: ['code'] }).tasks,
    ['code'],
  );
});
void test('profile validation rejects unsupported duplicate malformed and extra properties', () => {
  for (const change of [
    { version: 2 },
    { tasks: [] },
    { tasks: ['vision'] },
    { tasks: ['code', 'code'] },
    { evidenceUrl: 'http://inference.invalid/api-docs' },
    { evidenceUrl: 'https://user:password@inference.invalid/api-docs' },
    { evidenceUrl: 'https://inference.invalid/?query=value' },
    { evidenceUrl: 'https://inference.invalid/#fragment' },
    { evidenceUrl: 'https://inference.invalid/\napi-docs' },
    { reviewedAt: '2026-10-10T09:00:00-01:00' },
    { reviewedAt: '2026-02-31T00:00:00.000Z' },
    { extra: true },
  ])
    assert.throws(() => parseRoutingProfile({ ...profile(), ...change }));
});
void test('profile freshness rejects future expired and overlong reviews at exact boundaries', () => {
  const p = parseRoutingProfile(profile());
  assert.equal(routingProfileFresh(p, now, '2026-10-10T11:00:00.000Z'), true);
  assert.equal(routingProfileFresh(p, now, new Date(now).toISOString()), false);
  assert.equal(routingProfileFresh(p, now, '2026-10-12T11:00:00.000Z'), false);
  assert.equal(
    routingProfileFresh(p, now - 7200000, '2026-10-10T11:00:00.000Z'),
    false,
  );
  assert.equal(
    routingProfileFresh(
      p,
      Date.parse(p.reviewedAt) + 86400000,
      '2026-10-11T09:00:00.000Z',
    ),
    false,
  );
  assert.equal(routingProfileFresh(p, NaN, 'bad'), false);
});
