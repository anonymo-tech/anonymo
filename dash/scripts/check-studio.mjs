import assert from 'node:assert/strict';
import test from 'node:test';
import { IMAGE_PRESETS, studioPrompt } from '../lib/anonymo/studio-presets.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

const character = {
  id: 'sample-character',
  name: 'Sample captain',
  description: 'A felt sailor in a green coat.',
  personality: 'Curious and quiet.',
  scenario: 'The cargo ship is leaving the harbour.',
  first_mes: 'This greeting should stay in chat.',
  system_prompt: 'This instruction should stay in chat.',
};

test('Studio is opt-in and available in demo', () => {
  assert.equal(parseUpdates(undefined).has('studio'), false);
  assert.deepEqual([...parseUpdates('studio')], ['studio']);
  assert.equal(updateOn('studio', true), true);
});

test('image presets use the chosen character without sending a character ID or chat fields', () => {
  for (const [id, preset] of Object.entries(IMAGE_PRESETS)) {
    const prompt = studioPrompt('Soft afternoon light', id, character);
    assert.ok(prompt.startsWith(preset.instruction));
    assert.ok(prompt.includes(character.name));
    assert.ok(prompt.includes(character.description));
    assert.ok(prompt.endsWith('Soft afternoon light'));
    assert.ok(!prompt.includes(character.id));
    assert.ok(!prompt.includes(character.first_mes));
    assert.ok(!prompt.includes(character.system_prompt));
  }
  assert.match(studioPrompt('', 'stickers', character), /same character with four distinct expressions: happy, surprised, annoyed and sleepy/);
  assert.match(studioPrompt('', 'scene', character), /leaving the harbour/);
});

test('clip uses selected character and scene context while custom and empty drafts work as before', () => {
  const clip = studioPrompt('Slow pan across the deck', 'clip', character);
  assert.match(clip, /short silent clip/);
  assert.match(clip, /felt sailor/);
  assert.match(clip, /leaving the harbour/);
  assert.match(clip, /Slow pan across the deck$/);
  assert.equal(studioPrompt('  A lighthouse  ', ''), 'A lighthouse');
  assert.equal(studioPrompt(' ', 'avatar'), '');
  assert.ok(studioPrompt('', 'portrait', character));
});

test('video polling preserves a Studio refusal receipt and still rejects a region block', async () => {
  const { createAnonymoClient } = await import('../lib/anonymo/client.ts');
  const id = 'vid_sample';
  const job = {
    id, object: 'video.generation', status: 'failed',
    error: { type: 'media_blocked' },
    anonymo: { cost_usd: 0, receipt: { payload: { safety: { outputs: [{ shieldgemma2: 'safe', llavaguard: 'unsafe' }] } } } },
  };
  const client = createAnonymoClient({
    baseUrl: 'https://gateway.example.invalid', key: 'fixture-key', // gitleaks:allow
    fetch: async (url) => new URL(url).pathname.endsWith(id)
      ? Response.json(job, { status: 451 })
      : Response.json({ error: { type: 'region_blocked', message: 'Region blocked' } }, { status: 451 }),
  });
  assert.deepEqual(await client.videoStatus(id), job);
  await assert.rejects(client.videoStatus('other'), { status: 451, code: 'region_blocked' });
});
