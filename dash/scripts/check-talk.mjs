import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { DEMO_TRANSCRIPT, DEMO_VOICE_MODELS, DEMO_VOICE_REPLY, demoVoiceWav } from '../lib/anonymo/mock/talk.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';
import { microphoneError } from '../lib/anonymo/voice-capture.ts';
import { createVoiceRecorder } from '../lib/anonymo/voice-recorder.ts';
import { speechChunks, speechQuote, speechRate, transcriptionRate } from '../lib/anonymo/talk.ts';

const file = () => new File([demoVoiceWav()], 'clip.wav', { type: 'audio/wav' });
const [speech, transcription] = DEMO_VOICE_MODELS;

test('voice is opt-in and labels use listed prices down to per-answer precision', () => {
  assert.equal(parseUpdates(undefined).has('talk'), false);
  assert.equal(parseUpdates('talk').has('talk'), true);
  assert.equal(updateOn('talk', true), true);
  assert.equal(transcriptionRate(transcription), '$0.001 / started minute');
  assert.equal(speechRate(speech), '$0.003 / 1,000 characters');
  assert.equal(speechQuote(speech, ' Hello '), '$0.000015');
  assert.equal(speechQuote({ ...speech, pricing: { usd_per_1k_chars: '0.000001' } }, 'x'), '$0.000000001');
  const text = 'a'.repeat(9_999) + '🦉' + 'b'.repeat(10_000);
  const chunks = [...speechChunks(text, speech.max_chars)];
  assert.ok(chunks.every((chunk) => chunk.length <= speech.max_chars));
  assert.ok(chunks.every((chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk)));
  assert.equal(chunks.join(''), text);
});

test('press and release transcribes once, after stopping the recording', async () => {
  const events = [];
  const recorder = createVoiceRecorder({
    async capture(signal) {
      signal.addEventListener('abort', () => events.push('cleanup'));
      return { async stop() { events.push('stop'); return file(); } };
    },
    async transcribe(audio) { assert.equal(audio.name, 'clip.wav'); events.push('upload'); return 'sample transcript'; },
    onState: (state) => events.push(state),
    onText: (text) => events.push(text),
    onError: assert.fail,
  });
  await recorder.press();
  await Promise.all([recorder.release(), recorder.release()]);
  assert.deepEqual(events, ['requesting', 'recording', 'transcribing', 'stop', 'upload', 'sample transcript', 'cleanup', 'idle']);
});

test('release while permission is pending and Escape during upload discard stale results', async () => {
  const pending = Promise.withResolvers();
  const upload = Promise.withResolvers();
  let signal;
  let uploads = 0;
  let first = true;
  const texts = [];
  const recorder = createVoiceRecorder({
    async capture(value) {
      signal = value;
      if (first) { first = false; await pending.promise; }
      return { async stop() { return file(); } };
    },
    async transcribe() { uploads++; return upload.promise; },
    onState: () => {},
    onText: (text) => texts.push(text),
    onError: assert.fail,
  });
  const firstPress = recorder.press();
  await recorder.release();
  assert.equal(signal.aborted, true);
  pending.resolve();
  await firstPress;
  assert.equal(uploads, 0);

  await recorder.press();
  const finishing = recorder.release();
  await Promise.resolve();
  assert.equal(uploads, 1);
  assert.equal(recorder.cancel(), true);
  assert.equal(signal.aborted, true);
  upload.resolve('late transcript');
  await finishing;
  assert.deepEqual(texts, []);
});

test('capture failures return to idle with clear microphone messages', async () => {
  const states = [];
  const errors = [];
  const recorder = createVoiceRecorder({
    async capture() { throw new DOMException('sample', 'NotAllowedError'); },
    transcribe: assert.fail,
    onState: (state) => states.push(state),
    onText: assert.fail,
    onError: (error, duringCapture) => { assert.equal(duringCapture, true); errors.push(microphoneError(error)); },
  });
  await recorder.press();
  assert.deepEqual(states, ['requesting', 'idle']);
  assert.deepEqual(errors, ['Microphone permission denied.']);
  assert.equal(microphoneError(new DOMException('sample', 'NotFoundError')), 'No microphone found.');
});

test('demo records to transcript, gets a matching chat reply, then returns a short PCM WAV', async () => {
  const state = new Map();
  const mock = createMockGateway({
    delayMs: 0,
    storage: { getItem: state.get.bind(state), setItem: state.set.bind(state) },
  });
  const baseUrl = 'https://demo.anonymo.invalid';
  const api = createAnonymoClient({ baseUrl, fetch: mock.fetch });
  const { key } = await api.createKey();
  const client = createAnonymoClient({ baseUrl, fetch: mock.fetch, key });
  await mock.simulateDeposit(key, 'rhc', 'USDG', 2_000_000);

  const models = await client.voiceModels();
  // The demo lists one stock speech model (Night Call's), as production lists one (Kokoro).
  assert.ok(models.speech.voices.length > 0);
  assert.deepEqual(models.transcription, transcription);
  const result = await client.transcribe(file());
  assert.deepEqual(result, { text: DEMO_TRANSCRIPT });
  const answer = await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: result.text }] });
  assert.equal(answer.content, DEMO_VOICE_REPLY);
  const wav = Buffer.from(await client.speak(answer.content, models.speech.voices[0], 1, undefined, models.speech.id));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.ok(wav.length > 44 && wav.length < 2_000_000);
  assert.ok(![...state.values()].some((value) => value.includes(DEMO_TRANSCRIPT) || value.includes(DEMO_VOICE_REPLY)));

  const workspace = readFileSync(new URL('../components/dashboard/chat-workspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /updateOn\('talk', demo\)/);
  const capture = readFileSync(new URL('../lib/anonymo/voice-capture.ts', import.meta.url), 'utf8');
  assert.match(capture, /MediaRecorder/);
  assert.doesNotMatch(capture, /SpeechRecognition/);
});
