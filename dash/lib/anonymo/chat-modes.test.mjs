import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_MODES, modeHint, imageCounts, pictureEstimate, readModePrefs, reconcilePicture, recordingEstimate, threeEstimate } from './chat-modes.ts';
import { clearSetupDraft, readSetupDraft, readSetupMessage, writeSetupDraft } from './chat-setup.ts';
import { chargeOf, parseUsdAtto } from './pricetag.ts';
import { toSaved } from './history.ts';
import { giveStudioDraft, takeStudioDraft } from '../../components/dashboard/image-studio-draft.ts';
import { createAnonymoClient } from './client.ts';
import { parseUpdates, RELEASED, updateOn } from './updates.ts';

test('hints match whole words and phrases, ignoring case', () => {
  for (const [mode, words] of [
    ['picture', ['draw', 'drawing', 'picture', 'image', 'photo', 'paint', 'painting', 'sketch']],
    ['three', ['which ai', 'which model', 'compare', 'better at', 'best at']],
    ['talk', ['out loud', 'talk', 'voice', 'speak']],
  ]) {
    for (const word of words) assert.deepEqual(modeHint(`(${word.toUpperCase()}!)`, CHAT_MODES), {
      mode, matches: [{ start: 1, end: 1 + word.length }],
    });
  }
  assert.equal(modeHint('withdraw redraw drawing2 photography repaint x_image éimage speech voiceover which air best atlas', CHAT_MODES), null);
  assert.deepEqual(modeHint('Paint, compare, and Paint!', CHAT_MODES), {
    mode: 'picture', matches: [{ start: 0, end: 5 }, { start: 20, end: 25 }],
  });
});

test('one hint appears, only among modes the composer can offer', () => {
  const text = 'Draw it, compare those, and then speak.';
  assert.equal(modeHint(text, CHAT_MODES).mode, 'picture');
  assert.equal(modeHint(text, ['three', 'talk']).mode, 'three');
  assert.equal(modeHint(text, ['talk']).mode, 'talk');
  assert.equal(modeHint(text, []), null);
  assert.equal(parseUpdates('').has('modes'), false);
  assert.equal(RELEASED.has('modes'), false);
  assert.equal(parseUpdates('photos, MODES').has('modes'), true);
  assert.equal(updateOn('modes', true), true);
});

test('picture settings stay within the studio and model limits, and quotes use the listed rate', () => {
  const valid = { id: 'image-model', sizes: ['1024x1024', '1024x1536'], max_images: 2, pricing: { usd_per_image: '0.0325' } };
  assert.deepEqual(imageCounts(valid), [1, 2]);
  assert.deepEqual(reconcilePicture({ model: 'old', size: '64x64', n: 4 }, [valid]), { model: valid.id, size: '1024x1024', n: 2 });
  assert.deepEqual(reconcilePicture({ model: valid.id, size: '1024x1536', n: 1 }, [valid]), { model: valid.id, size: '1024x1536', n: 1 });
  assert.equal(pictureEstimate(valid, 2).typical, parseUsdAtto('0.065'));
  assert.equal(pictureEstimate(undefined, 1).known, false);
  assert.equal(chargeOf({ costUsd: '0.065' }).atto, parseUsdAtto('0.065'));
  assert.equal(chargeOf({ costUsd: null }).kind, 'unknown');
});

test('comparison quotes include all three calls and the merge when selected', () => {
  const models = ['model-a', 'model-b', 'model-c'];
  const list = [...models, 'anonymo-1'].map((id) => ({ id, pricing: { prompt: '0.0000001', completion: '0.0000002' } }));
  const plain = threeEstimate('Compare two approaches', { models, merged: false }, list, false, '');
  const merged = threeEstimate('Compare two approaches', { models, merged: true }, list, false, '');
  assert.ok(plain.known && merged.known && merged.worst > plain.worst);
  assert.equal(threeEstimate('Compare two approaches', { models, merged: true }, list.slice(0, 3), false, '').known, false);
});

test('setup carries an explicit mode even before Talk has a draft', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const scope = { destination: '/dashboard/chat', demo: true };
  assert.equal(writeSetupDraft(storage, scope, '', 'talk'), true);
  assert.deepEqual(readSetupMessage(storage, scope), { text: '', mode: 'talk' });
  assert.equal(readSetupMessage(storage, { ...scope, demo: false }), null);
  writeSetupDraft(storage, scope, 'Draw a forest', 'picture');
  assert.equal(readSetupDraft(storage, scope), 'Draw a forest');
  assert.deepEqual(readSetupMessage(storage, scope), { text: 'Draw a forest', mode: 'picture' });
  clearSetupDraft(storage, scope);
  assert.equal(readSetupMessage(storage, scope), null);
});

test('only validated settings are read from the stored preferences', () => {
  assert.deepEqual(readModePrefs({
    picture: { model: 'sample-model', size: '1024x768', n: 99, prompt: 'ignored' },
    three: { models: ['sample-model', 42], merged: false },
    talk: { voice: 'bf_emma', aloud: 'yes' },
  }), {
    picture: { model: 'sample-model', size: '1024x768', n: 1 },
    three: { models: ['sample-model'], merged: false },
    talk: { voice: 'bf_emma', aloud: true },
  });
});

test('studio handoff is consumed once and a saved chat does not retain the generated PNG', () => {
  const settings = { model: 'image-model', size: '1024x1024', n: 1 };
  const prompt = 'Draw a forest.';
  giveStudioDraft(true, prompt, settings);
  assert.deepEqual(takeStudioDraft(true), { demo: true, prompt, settings });
  assert.equal(takeStudioDraft(true), null);

  const modeResult = { mode: 'picture', settings, name: 'Image model', images: ['data:image/png;base64,dGVzdA=='], costUsd: '0.04' };
  const [saved] = toSaved([{ id: 'demo-turn', status: 'done', prompt, modeResult }]);
  assert.equal(saved.modeResult.images, undefined);
  assert.deepEqual(saved.modeResult.settings, settings);
  assert.equal(saved.modeResult.costUsd, '0.04');
});

test('Talk prices recordings by the started minute and reads the actual charge from the gateway', async () => {
  const rate = parseUsdAtto('0.003');
  assert.equal(recordingEstimate(rate, 60), rate);
  assert.equal(recordingEstimate(rate, 61), 2n * rate);
  assert.equal(recordingEstimate(null, 60), null);

  const client = createAnonymoClient({
    baseUrl: 'https://example.invalid',
    key: 'anm_test_sample_voice_fixture',
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, '/v1/audio/transcriptions');
      assert.equal(init.method, 'POST');
      assert.ok(init.body.get('file') instanceof File);
      return Response.json({ text: 'A sample transcript.' }, { headers: { 'x-anonymo-cost-usd': '0.003' } });
    },
  });
  const clip = new File(['sample audio'], 'sample.wav', { type: 'audio/wav' });
  assert.deepEqual(await client.transcribeWithCost(clip), { text: 'A sample transcript.', costUsd: '0.003' });
  assert.deepEqual(await client.transcribe(clip), { text: 'A sample transcript.' });
});
