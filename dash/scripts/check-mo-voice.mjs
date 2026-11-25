import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { CallPlayback } from '../lib/anonymo/mo-voice-browser.ts';
import { callOptions, voiceSocketUrl } from '../lib/anonymo/mo-voice.ts';
import { characterDestination, setupReturn } from '../lib/anonymo/setup-return.ts';
import { parseUpdates, RELEASED, updateOn } from '../lib/anonymo/updates.ts';

test('Mo Voice is opt-in and demo and character setup links use the gated screen', () => {
  assert.equal(parseUpdates('').has('movoice'), false);
  assert.equal(RELEASED.has('movoice'), false);
  assert.equal(updateOn('movoice', true), true);
  assert.equal(parseUpdates('movoice').has('movoice'), true);
  const destination = characterDestination('mo-voice', '0123456789abcdef');
  assert.equal(setupReturn(destination)?.href, destination);
  assert.equal(setupReturn('/dashboard/mo-voice?character=someone'), null);
});

test('voice client sends text only, uses the key and region, and forms a same-origin socket URL without the ticket', async () => {
  const base = 'https://api.example.invalid';
  const key = 'fixture-key'; // gitleaks:allow
  const calls = [];
  const client = createAnonymoClient({
    baseUrl: base, key, declaredRegion: 'US-NY',
    fetch: async (url, options) => {
      assert.equal(options.headers.get('authorization'), `Bearer ${key}`);
      assert.equal(options.headers.get('x-anonymo-declared-region'), 'US-NY');
      assert.equal(options.credentials, 'omit');
      calls.push([new URL(url).pathname, options.body ? JSON.parse(options.body) : null]);
      return Response.json({});
    },
  });
  await client.moVoiceList();
  await client.moVoiceConnect();
  await client.moVoicePreview('warm, low, slightly husky');
  await client.moVoiceSave('id', 'Evening');
  assert.deepEqual(calls, [
    ['/v1/voice/voices', null],
    ['/v1/voice/sessions', { transport: 'websocket' }],
    ['/v1/voice/voices/preview', { description: 'warm, low, slightly husky' }],
    ['/v1/voice/voices', { preview_id: 'id', name: 'Evening' }],
  ]);
  assert.equal(voiceSocketUrl(base, '/v1/voice/socket'), 'wss://api.example.invalid/v1/voice/socket');
  assert.throws(() => voiceSocketUrl(base, 'https://elsewhere.example.invalid/v1/voice/socket'));
  assert.throws(() => voiceSocketUrl(base, '/v1/voice/socket?ticket=fixture'));
  assert.deepEqual(callOptions({ designed: [{ id: 'id', name: 'Evening' }], stock: [] }), [
    { id: 'designed:id', name: 'Evening', engine: 'Designed voice' },
  ]);
});

test('an interruption stops current playback and discards already queued or decoding audio', async () => {
  let wake;
  const decoded = new Promise((resolve) => { wake = resolve; });
  const events = [];
  const context = {
    destination: {},
    decodeAudioData: (wav) => wav.byteLength === 1 ? decoded : Promise.resolve(wav),
    createBufferSource: () => ({
      connect() {}, disconnect() {},
      start() { events.push(['start', this.buffer.byteLength]); },
      stop() { events.push(['stop', this.buffer.byteLength]); this.onended(); },
    }),
  };
  const playback = new CallPlayback(context, () => {});
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  playback.append(new ArrayBuffer(1));
  playback.append(new ArrayBuffer(2));
  await tick();
  playback.stop();
  wake(new ArrayBuffer(1));
  await tick();
  playback.append(new ArrayBuffer(3));
  playback.append(new ArrayBuffer(4));
  await tick();
  playback.stop();
  await tick();
  assert.deepEqual(events, [['start', 3], ['stop', 3]]);
});
