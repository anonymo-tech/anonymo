import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createMediaClient,
  MediaClientError,
  makeMediaApproval,
  mediaAssetUrl,
  mediaErrorMessage,
  parseMediaCapability,
  parseMediaInput,
  parseMediaJob,
  parseMediaOptions,
  parseMediaQuote,
  parseMediaRoute,
} from '../lib/client/media.ts';
import {
  mediaCapability,
  parseMediaOptions as serverOptions,
} from '../server/media/contract.ts';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = uuid(1),
  projectId = uuid(2),
  routeVersionId = uuid(3),
  quoteId = uuid(4),
  jobId = uuid(5),
  assetId = uuid(6);
const at = '2026-10-10T12:00:00.000Z',
  expiresAt = '2026-10-10T12:02:00.000Z';
const privacy = {
  level: 'unverified',
  provider: 'gateway',
  plaintextVisibility: 'gateway_and_upstream',
  retentionDisclosure:
    'The gateway and upstream provider receive this description.',
};
const options = () => ({
  kind: 'video',
  duration: 5,
  quality: '720p',
  aspectRatio: '16:9',
});
const input = () => ({
  prompt: 'A quiet ocean at dawn.\nStatic camera.',
  privacy: 'standard',
  options: options(),
});
const route = () => ({
  versionId: routeVersionId,
  routeId: 'studio-runway',
  version: 1,
  modelId: 'runway-gen4',
  family: 'runway',
  modality: 'video',
  expiresAt,
  privacy,
  pricing: {
    kind: 'media-fixed-v1',
    maxInputBytes: 16000,
    markupBps: 500,
    variants: [
      {
        options: options(),
        providerUsd6: '1000000',
        catalogQuality: '720p',
        catalogSize: '16:9_5',
      },
    ],
  },
});
const quote = () => ({
  id: quoteId,
  projectId,
  routeVersionId,
  modelId: 'runway-gen4',
  input: input(),
  maximumUsd6: '1050000',
  providerMaximumUsd6: '1000000',
  expiresAt,
  privacy,
  mediaAssetState: 'pending_storage',
  deliveryReady: false,
});
const job = () => ({
  id: jobId,
  projectId,
  routeVersionId,
  modelId: 'runway-gen4',
  modality: 'video',
  input: input(),
  state: 'queued',
  cancelRequested: false,
  errorCode: null,
  mediaAssetState: 'none',
  processingState: 'queued',
  processingErrorCode: null,
  deliveryReady: false,
  asset: null,
  billing: { maximumUsd6: '1050000', actualUsd6: null, state: 'held' },
  createdAt: at,
  updatedAt: at,
  canRecover: false,
});
const completed = () => ({
  ...job(),
  state: 'completed',
  mediaAssetState: 'stored',
  processingState: 'completed',
  deliveryReady: true,
  asset: { id: assetId, contentType: 'video/mp4', byteLength: 12000 },
  billing: { maximumUsd6: '1050000', actualUsd6: '1049000', state: 'captured' },
});
const json = (v, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
const key = 'fixture_request_key_000001';
const approval = () => makeMediaApproval(quote(), key, Date.parse(at));
const failure = (code, unknown) => (e) =>
  e instanceof MediaClientError &&
  e.code === code &&
  (unknown === undefined || e.outcomeUnknown === unknown);
const clientWith = (value) =>
  createMediaClient(owner, { fetch: async () => json(value) });

// All HTTP operations inject local fakes. No provider, account, database or key is accessed.
void test('capabilities match the server and allow existing delivery while generation is disabled', () => {
  assert.deepEqual(
    parseMediaCapability(mediaCapability({})),
    mediaCapability({}),
  );
  assert.equal(
    parseMediaCapability({ ...mediaCapability({}), deliveryReady: true })
      .configured,
    false,
  );
  for (const change of [
    { referenceUploads: true },
    { providerCancellation: true },
    { configured: true },
    { reason: 'READY' },
    { supportedModalities: ['video', 'video'] },
  ])
    assert.throws(
      () => parseMediaCapability({ ...mediaCapability({}), ...change }),
      MediaClientError,
    );
});

void test('all model-specific option combinations agree with the server contract', () => {
  for (const modelId of [
    'runway-gen4',
    'veo3-fast',
    'kling-2.5-turbo',
    'nano-banana-2',
  ])
    for (const aspectRatio of ['1:1', '16:9', '9:16']) {
      for (const duration of [5, 8, 10])
        for (const quality of ['720p', '1080p', 'standard']) {
          const v = { kind: 'video', duration, quality, aspectRatio };
          let accepted = true;
          try {
            serverOptions(v, modelId);
          } catch {
            accepted = false;
          }
          if (accepted)
            assert.deepEqual(
              parseMediaOptions(v, modelId),
              serverOptions(v, modelId),
            );
          else
            assert.throws(
              () => parseMediaOptions(v, modelId),
              MediaClientError,
            );
        }
      for (const resolution of ['1K', '2K', '4K']) {
        const v = { kind: 'image', count: 1, resolution, aspectRatio };
        if (modelId === 'nano-banana-2')
          assert.deepEqual(
            parseMediaOptions(v, modelId),
            serverOptions(v, modelId),
          );
        else
          assert.throws(() => parseMediaOptions(v, modelId), MediaClientError);
      }
    }
  for (const v of [
    { ...options(), duration: '5' },
    { ...options(), extra: 1 },
    { ...options(), quality: ['720p'] },
    { kind: 'image', count: 2, resolution: '1K', aspectRatio: '1:1' },
  ])
    assert.throws(() => parseMediaOptions(v), MediaClientError);
});

void test('input preserves whitespace and enforces UTF-8 bounds and control character policy', () => {
  const v = { ...input(), prompt: '\t' + 'a\n'.repeat(7900) };
  assert.equal(parseMediaInput(v).prompt, v.prompt);
  for (const change of [
    { prompt: 'é'.repeat(8001) },
    { prompt: '\0'.repeat(16000) },
    { prompt: 'a\x7fb' },
    { prompt: '  ' },
    { privacy: 'strict' },
    { referenceUrl: 'https://example.invalid/reference' },
  ])
    assert.throws(
      () => parseMediaInput({ ...input(), ...change }),
      MediaClientError,
    );
});

void test('routes require exact catalog tuples and integer costs with bounded prices and unique options', () => {
  assert.equal(
    parseMediaRoute(route()).pricing.variants[0].providerUsd6,
    '1000000',
  );
  const changes = [
    (r) => {
      r.modelId = 'unknown';
    },
    (r) => {
      r.family = 'veo';
    },
    (r) => {
      r.modality = 'image';
    },
    (r) => {
      r.pricing.markupBps = 10001;
    },
    (r) => {
      r.pricing.variants[0].catalogSize = '16:9_10';
    },
    (r) => {
      r.pricing.variants.push(r.pricing.variants[0]);
    },
    (r) => {
      r.pricing.variants = [];
    },
    (r) => {
      r.expiresAt = '2026-02-30T12:00:00.000Z';
    },
    (r) => {
      r.expiresAt = '2026-10-10T12:00:00-04:00';
    },
  ];
  for (const amount of [
    '1.000000',
    '01',
    '-1',
    1000000,
    '9000000000000001',
  ])
    changes.push((r) => {
      r.pricing.variants[0].providerUsd6 = amount;
    });
  for (const mutate of changes) {
    const v = route();
    mutate(v);
    assert.throws(() => parseMediaRoute(v), MediaClientError);
  }
});

void test('quotes match the exact input snapshot and cannot claim private media or premature delivery', () => {
  const expected = { projectId, routeVersionId, input: input() };
  assert.deepEqual(parseMediaQuote(quote(), expected).input, expected.input);
  for (const change of [
    { projectId: uuid(80) },
    { routeVersionId: uuid(81) },
    { input: { ...input(), prompt: 'Changed' } },
    { maximumUsd6: '999999' },
    { maximumUsd6: '2000001' },
    { deliveryReady: true },
    { privacy: { ...privacy, level: 'private' } },
    { privacy: { ...privacy, provider: 'unknown' } },
  ])
    assert.throws(
      () => parseMediaQuote({ ...quote(), ...change }, expected),
      MediaClientError,
    );
});

void test('approval freezes the exact amount and caller key, and expired quotes require a new review', () => {
  const v = approval();
  assert.equal(Object.isFrozen(v), true);
  assert.deepEqual(v, {
    quoteId,
    idempotencyKey: key,
    approvedMaximumUsd6: '1050000',
  });
  assert.throws(
    () => makeMediaApproval(quote(), key, Date.parse(expiresAt)),
    failure('QUOTE_EXPIRED'),
  );
  for (const k of ['', 'short', 'request/with/a/path', 'k'.repeat(129)])
    assert.throws(
      () => makeMediaApproval(quote(), k, Date.parse(at)),
      MediaClientError,
    );
});

void test('job validation preserves unknown billing and validates delivery, ownership, model and asset bounds', () => {
  assert.equal(parseMediaJob(job()).billing.actualUsd6, null);
  assert.deepEqual(parseMediaJob(completed()).asset, completed().asset);
  for (const change of [
    { id: 'https://example.invalid/job' },
    { modelId: 'veo3-fast' },
    { modality: 'image' },
    { state: 'succeeded' },
    { deliveryReady: true },
    { asset: completed().asset },
    { canRecover: true },
    { updatedAt: '2026-10-09T12:00:00.000Z' },
    { billing: { ...job().billing, actualUsd6: '0' } },
    { billing: { ...job().billing, state: 'captured' } },
  ])
    assert.throws(
      () => parseMediaJob({ ...job(), ...change }),
      MediaClientError,
    );
  for (const change of [
    { asset: { ...completed().asset, url: 'https://example.invalid/asset' } },
    { asset: { ...completed().asset, contentType: 'image/png' } },
    { asset: { ...completed().asset, byteLength: 104857601 } },
    { billing: { ...completed().billing, actualUsd6: '1050001' } },
    { billing: { ...completed().billing, actualUsd6: '0' } },
  ])
    assert.throws(
      () => parseMediaJob({ ...completed(), ...change }),
      MediaClientError,
    );
  assert.equal(
    parseMediaJob({
      ...job(),
      state: 'reconciliation_pending',
      canRecover: true,
      billing: { ...job().billing, state: 'reconciliation_pending' },
    }).canRecover,
    true,
  );
  assert.throws(() => parseMediaJob(job(), { id: uuid(90) }), MediaClientError);
  assert.throws(
    () => parseMediaJob(job(), { projectId: uuid(90) }),
    MediaClientError,
  );
});

void test('asset URLs have a fixed same-origin path and explicit account fence without arbitrary URLs', () => {
  assert.equal(
    mediaAssetUrl(assetId, owner),
    `/api/media/assets/${assetId}/content?accountId=${owner}`,
  );
  assert.equal(
    mediaAssetUrl(assetId.toUpperCase(), owner, { download: true }),
    `/api/media/assets/${assetId}/content?accountId=${owner}&download=1`,
  );
  for (const bad of [
    'https://example.invalid/media',
    '//example.invalid/media',
    '../asset',
    `${assetId}?token=fixture`,
    `${assetId}/content`,
  ]) {
    assert.throws(() => mediaAssetUrl(bad, owner), MediaClientError);
    assert.throws(() => mediaAssetUrl(assetId, bad), MediaClientError);
  }
  assert.throws(
    () => mediaAssetUrl(assetId, owner, { download: '1' }),
    MediaClientError,
  );
});

void test('account and transport are captured with same-origin credentials and stale-account errors stay sanitized', async () => {
  const calls = [],
    settings = {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return json({ routes: [] });
      },
    };
  const client = createMediaClient(owner, settings);
  settings.fetch = async () => {
    throw new Error('Must not use changed transport');
  };
  assert.deepEqual(await client.routes(), []);
  const { url, init } = calls[0];
  assert.equal(url, '/api/media/routes');
  assert.equal(init.headers['X-Conclave-Account-Id'], owner);
  for (const field of ['credentials', 'mode'])
    assert.equal(init[field], 'same-origin');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.redirect, 'error');
  const rejected = createMediaClient(owner, {
    fetch: async () =>
      json(
        {
          error: {
            code: 'ACCOUNT_CHANGED',
            message: 'private diagnostic must not render',
          },
        },
        409,
      ),
  });
  await assert.rejects(
    rejected.get(jobId),
    (e) =>
      e.code === 'ACCOUNT_CHANGED' && !e.message.includes('private diagnostic'),
  );
  assert.throws(() => createMediaClient('invalid'), MediaClientError);
});

void test('quote snapshots are copied before awaiting and matched against the saved response', async () => {
  const source = { projectId, routeVersionId, input: input() };
  let finish;
  const client = createMediaClient(owner, {
    fetch: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), source);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = client.quote(source);
  source.input.prompt = 'changed after request';
  finish(json({ quote: quote() }, 201));
  assert.equal((await pending).input.prompt, input().prompt);
});

void test('uncertain paid approval keeps the exact key and makes no automatic retry', async () => {
  const calls = [],
    accepted = approval();
  let count = 0;
  const client = createMediaClient(owner, {
    fetch: async (url, init) => {
      calls.push({ url, body: init.body });
      count += 1;
      if (count === 1) throw new TypeError('private network details');
      return json({ job: job(), replayed: true });
    },
  });
  await assert.rejects(client.create(accepted), failure('NETWORK_ERROR', true));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.equal((await client.create(accepted)).replayed, true);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(calls[1].body), accepted);
  assert.equal(accepted.idempotencyKey, key);
});

void test('malformed or oversized approval responses remain uncertain after a possible commit', async () => {
  for (const response of [
    () => json({ job: { ...job(), id: 'malformed' }, replayed: false }, 201),
    () => json({ job: job(), replayed: 'false' }, 201),
    () =>
      json(
        {
          job: {
            ...job(),
            billing: { ...job().billing, maximumUsd6: '1050001' },
          },
          replayed: false,
        },
        201,
      ),
    () =>
      new Response('{', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    () => json({ padding: 'a'.repeat(131073) }, 201),
    () => new Response('unavailable', { status: 502 }),
  ]) {
    let count = 0;
    const client = createMediaClient(owner, {
      fetch: async () => {
        count += 1;
        return response();
      },
    });
    await assert.rejects(
      client.create(approval()),
      (e) =>
        e instanceof MediaClientError &&
        e.outcomeUnknown &&
        /original request key/.test(e.message),
    );
    assert.equal(count, 1);
  }
});

void test('invalid approval fails before fetch, while explicit rejection never claims acceptance', async () => {
  let count = 0;
  const client = createMediaClient(owner, {
    fetch: async () => {
      count += 1;
      return json({ error: { code: 'QUOTE_EXPIRED' } }, 409);
    },
  });
  for (const change of [
    { approvedMaximumUsd6: 1050000 },
    { approvedMaximumUsd6: '01' },
    { idempotencyKey: 'short' },
    { extra: 'value' },
  ])
    await assert.rejects(
      client.create({ ...approval(), ...change }),
      MediaClientError,
    );
  assert.equal(count, 0);
  await assert.rejects(
    client.create(approval()),
    failure('QUOTE_EXPIRED', false),
  );
  assert.equal(count, 1);
});

void test('account-switch abort discards late replies and prevents another fetch', async () => {
  const controller = new AbortController();
  let finish,
    count = 0;
  const client = createMediaClient(owner, {
    signal: controller.signal,
    fetch: async () => {
      count += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = client.get(jobId);
  controller.abort();
  finish(json({ job: job() }));
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  await assert.rejects(client.get(jobId), (e) => e.name === 'AbortError');
  assert.equal(count, 1);
});

void test('stalled response body is cancelled on timeout and paid outcome remains unknown', async () => {
  let cancelled = false;
  const client = createMediaClient(owner, {
    timeoutMs: 10,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  await assert.rejects(
    client.create(approval()),
    failure('REQUEST_TIMEOUT', true),
  );
  assert.equal(cancelled, true);
});

void test('history is bounded and project-scoped; wrong identifiers and forged recovery claims fail', async () => {
  assert.equal(
    (await clientWith({ jobs: [job()], nextCursor: null }).list(projectId)).jobs
      .length,
    1,
  );
  for (const value of [
    { jobs: [{ ...job(), projectId: uuid(99) }], nextCursor: null },
    { jobs: [job(), job()], nextCursor: null },
    {
      jobs: Array.from({ length: 21 }, (_, i) => ({
        ...job(),
        id: uuid(100 + i),
      })),
      nextCursor: null,
    },
    { jobs: [], nextCursor: 'https://example.invalid/cursor' },
  ])
    await assert.rejects(clientWith(value).list(projectId), MediaClientError);
  await assert.rejects(
    clientWith({ job: { ...job(), id: uuid(99) } }).get(jobId),
    MediaClientError,
  );
  await assert.rejects(
    clientWith({ job: job(), providerCancellation: true }).cancel(jobId),
    MediaClientError,
  );
  await assert.rejects(
    clientWith({ job: job(), scheduled: true, paidResubmission: true }).recover(
      jobId,
    ),
    MediaClientError,
  );
});

void test('cancel and recovery only call explicit non-generation actions', async () => {
  const paths = [],
    client = createMediaClient(owner, {
      fetch: async (path, init) => {
        paths.push(path);
        assert.equal(init.method, 'POST');
        assert.equal(init.body, '{}');
        return json(
          path.endsWith('/cancel')
            ? { job: job(), providerCancellation: false }
            : { job: job(), scheduled: true, paidResubmission: false },
        );
      },
    });
  assert.equal((await client.cancel(jobId)).providerCancellation, false);
  assert.equal((await client.recover(jobId)).paidResubmission, false);
  assert.deepEqual(paths, [
    `/api/media/jobs/${jobId}/cancel`,
    `/api/media/jobs/${jobId}/recover`,
  ]);
});

void test('unexpected server diagnostics and local failures never become user messages', async () => {
  const client = createMediaClient(owner, {
    fetch: async () =>
      json(
        {
          error: {
            code: 'UNEXPECTED_PROVIDER_FAILURE',
            message: 'private diagnostic must not render',
          },
        },
        503,
      ),
  });
  await assert.rejects(
    client.get(jobId),
    (e) => !mediaErrorMessage(e).includes('private diagnostic'),
  );
  assert.equal(
    mediaErrorMessage(new Error('private diagnostic')).includes(
      'private diagnostic',
    ),
    false,
  );
});

void test('browser client has no runtime server import, browser storage or Node dependency', async () => {
  const source = await readFile(
    new URL('../lib/client/media.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /(?:localStorage|sessionStorage|indexedDB|process\.env|node:|from\s+['"][^'"]*server\/)/,
  );
  assert.doesNotMatch(source, /^(?!import type)import\s/m);
});

void test('owned asset deletion uses DELETE and verifies the exact deleted identifier without retries', async () => {
  const calls = [];
  const client = createMediaClient(owner, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return json({ asset: { id: assetId, state: 'deleted' } });
    },
  });
  assert.deepEqual(await client.deleteAsset(assetId), {
    asset: { id: assetId, state: 'deleted' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/media/assets/${assetId}`);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.headers['X-Conclave-Account-Id'], owner);
  assert.equal(calls[0].init.body, undefined);
  await assert.rejects(
    client.deleteAsset('../another-account'),
    MediaClientError,
  );
  assert.equal(calls.length, 1);
  for (const asset of [
    { id: uuid(99), state: 'deleted' },
    { id: assetId, state: 'ready' },
    { id: assetId, state: 'deleted', refundedUsd6: '1050000' },
  ])
    await assert.rejects(
      createMediaClient(owner, {
        fetch: async () => json({ asset }),
      }).deleteAsset(assetId),
      MediaClientError,
    );
});

void test('large catalog prices survive route quote approval and final job parsing unchanged', () => {
  const r = route(); r.pricing.variants[0].providerUsd6 = '12500000';
  assert.equal(parseMediaRoute(r).pricing.variants[0].providerUsd6, '12500000');
  const q = {...quote(), providerMaximumUsd6: '12500000', maximumUsd6: '13125000'};
  const checked = parseMediaQuote(q, {projectId, routeVersionId, input: input()});
  assert.equal(checked.maximumUsd6, '13125000');
  assert.equal(makeMediaApproval(checked, key, Date.parse(at)).approvedMaximumUsd6, '13125000');
  const j = completed(); j.billing.maximumUsd6 = '13125000'; j.billing.actualUsd6 = '13125000';
  assert.equal(parseMediaJob(j).billing.actualUsd6, '13125000');
});
