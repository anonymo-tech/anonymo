import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { API_PATHS, createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';
import { formatVideoUsd, pollWhileVisible, videoBlocked, videoCost, videoDurations } from '../lib/anonymo/video.ts';

const base = 'https://demo.anonymo.invalid';
const prompt = 'A ribbon of pale light across a violet sky';

async function demo(credit = 2_000_000) {
  let now = 1_700_000_000_000;
  const storage = new Map();
  const mock = createMockGateway({ videoNow: () => now, storage: { getItem: storage.get.bind(storage), setItem: storage.set.bind(storage) } });
  async function connect() {
    const { key } = await createAnonymoClient({ baseUrl: base, fetch: mock.fetch }).createKey();
    return { key, client: createAnonymoClient({ baseUrl: base, fetch: mock.fetch, key }) };
  }
  const { key, client } = await connect();
  await mock.simulateDeposit(key, 'rhc', 'USDG', credit);
  return { mock, client, key, connect, storage, advance: (ms) => { now += ms; } };
}

test('video is opt-in and the five models expose exact rates, shapes and durations', async () => {
  assert.equal(parseUpdates(undefined).has('video'), false);
  assert.equal(parseUpdates('video').has('video'), true);
  assert.equal(updateOn('video', true), true);
  const { client } = await demo();
  const models = await client.videoModels();
  assert.deepEqual(models.map((model) => [model.id, model.pricing.usd_per_second]), [
    ['alibaba/wan-3.0', '0.125'],
    ['kling/kling-3.0-turbo', '0.140'],
    ['bytedance/seedance-2.0-fast', '0.150'],
    ['google/veo-3.1-lite', '0.065'],
    ['lightricks/ltx-2.3-fast', '0.040'],
  ]);
  assert.ok(models.every((m) => m.sizes.join() === '1280x720,720x1280'));
  assert.deepEqual(models.map(videoDurations), [
    Array.from({ length: 29 }, (_, i) => i + 2),
    Array.from({ length: 13 }, (_, i) => i + 3),
    [5, 10, 15], [4, 6, 8], [6, 8, 10, 12, 14, 16, 18, 20],
  ]);
  assert.equal(videoCost(models[0], 5), 625_000);
  assert.equal(formatVideoUsd(0.625), '$0.625');
});

test('demo queues, generates, and completes with a preview and receipt, charging once without storing the prompt', async () => {
  const { client, connect, advance, storage } = await demo();
  const job = await client.generateVideo({ model: 'google/veo-3.1-lite', prompt, seconds: 6, size: '720x1280' });
  assert.equal(job.status, 'queued');
  assert.equal((await client.videoStatus(job.id)).status, 'queued');
  const other = await connect();
  await assert.rejects(other.client.videoStatus(job.id), { status: 404 });
  advance(2500);
  assert.equal((await client.videoStatus(job.id)).status, 'in_progress');
  assert.equal((await client.balance()).available_usd, 2);
  advance(5000);
  const done = await client.videoStatus(job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.url, '/demo/video-portrait.mp4');
  assert.equal(client.videoMediaUrl(done.url), done.url);
  assert.equal(client.videoMediaUrl('/v1/media/sample?sig=sample'), base + '/v1/media/sample?sig=sample');
  assert.equal(done.anonymo.cost_usd, 0.39);
  assert.equal(done.anonymo.receipt.payload.request_id, done.id);
  assert.equal(done.anonymo.receipt.payload.cost_usd, 0.39);
  assert.equal(done.anonymo.receipt.payload.provenance, 'demo');
  assert.deepEqual(await client.videoStatus(job.id), done);
  assert.equal((await client.balance()).available_usd, 1.61);
  assert.ok(![...storage.values()].some((value) => value.includes(prompt)));
  assert.ok(!JSON.stringify(done).includes(prompt));
  const clips = ['/demo/video.mp4', done.url].map((path) => readFileSync(new URL('../public' + path, import.meta.url)));
  assert.ok(clips.every((clip) => clip.toString('ascii', 4, 8) === 'ftyp'));
  assert.ok(clips.reduce((size, clip) => size + clip.length, 0) < 1_000_000);
});

test('demo rejects unsupported lengths, reference media and blocked prompts without a charge', async () => {
  const { client, mock, key } = await demo();
  const body = { model: 'bytedance/seedance-2.0-fast', prompt, seconds: 5, size: '1280x720' };
  await assert.rejects(client.generateVideo({ ...body, seconds: 6 }), { status: 400, code: 'invalid_duration' });
  await assert.rejects(client.generateVideo({ ...body, prompt: 'full nudity' }), { status: 451, code: 'explicit_media_unavailable' });
  const upload = await mock.fetch(base + API_PATHS.videos, {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ ...body, referenceVideos: ['fixture'] }),
  });
  assert.equal(upload.status, 400);
  assert.equal((await upload.json()).error.type, 'video_uploads_not_supported');
  assert.equal((await client.balance()).available_usd, 2);
  assert.equal(videoBlocked({ status: 'failed', error: { type: 'upstream_blocked' } }), true);
  assert.equal(videoBlocked({ status: 'failed', error: { type: 'upstream_failed' } }), false);
});

test('polling pauses and aborts in a hidden tab, resumes once visible, and stops on a terminal job', async () => {
  const page = new EventTarget();
  page.hidden = true;
  let count = 0;
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const stop = pollWhileVisible(page, async (signal) => {
    count++;
    if (count === 1) {
      started.resolve(signal);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return true;
    }
    finished.resolve();
    return false;
  }, 5);
  const visible = (on) => {
    page.hidden = !on;
    page.dispatchEvent(new Event('visibilitychange'));
  };
  try {
    await delay(15);
    assert.equal(count, 0);
    visible(true);
    const signal = await started.promise;
    visible(false);
    assert.equal(signal.aborted, true);
    await delay(15);
    assert.equal(count, 1);
    visible(true);
    await finished.promise;
    await delay(15);
    visible(false);
    visible(true);
    await delay(15);
    assert.equal(count, 2);
  } finally {
    stop();
  }
});
