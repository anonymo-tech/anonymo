import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { buildCharacterMessages, normalizeCard } from '../lib/anonymo/card.ts';
import { historyOf, loadArchive, memoryDisk } from '../lib/anonymo/movein/archive.ts';
import { CARD_CHECK_UNAVAILABLE, lifeboatCardCheck } from '../lib/anonymo/movein/floor.ts';
import { importFiles } from '../lib/anonymo/movein/importer.ts';
import { boardMemory } from '../lib/anonymo/movein/memory.ts';
import { parseUpdates, RELEASED, updateOn } from '../lib/anonymo/updates.ts';

const clientFor = (fetch) => createAnonymoClient({ baseUrl: 'https://api.example.invalid', fetch });

test('Lifeboat is opt-in for live builds and shown in demo mode', () => {
  assert.equal(parseUpdates(undefined).has('lifeboat'), false);
  assert.equal(RELEASED.has('lifeboat'), false);
  assert.equal(parseUpdates('lifeboat').has('lifeboat'), true);
  assert.equal(updateOn('lifeboat', true), true);
});

test('card check sends supported text fields including lore and greetings, without a key, assets or extensions', async () => {
  const card = normalizeCard({ spec: 'chara_card_v3', data: {
    name: 'Stone Lantern', description: 'A station guide.', alternate_greetings: ['Welcome to the ridge.'],
    group_only_greetings: ['Welcome, crew.'], creator_notes_multilingual: { fr: 'Le guide.' },
    character_book: { entries: [{ keys: ['ridge'], content: 'The telescope is green.', enabled: false }] },
    assets: [{ type: 'icon', uri: 'data:image/png;base64,fixture', name: 'default', ext: 'png' }],
    extensions: { local: 'extension-fixture' },
  } });
  const check = lifeboatCardCheck(false, clientFor(async (url, init) => {
    assert.equal(url, 'https://api.example.invalid/v1/lifeboat/check-card');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.has('authorization'), false);
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(JSON.parse(init.body), { fields: [
      'Stone Lantern', 'A station guide.', 'Welcome to the ridge.', 'Welcome, crew.', 'Le guide.',
      'The telescope is green.', 'ridge',
    ] });
    return Response.json({ allowed: true });
  }));
  assert.equal(await check(card), null);
});

test('the importer shows the floor category and fails closed when the check is unavailable', async () => {
  const file = { name: 'lantern.json', blob: new Blob([JSON.stringify({
    spec: 'chara_card_v2', data: { name: 'Stone Lantern', description: 'fixture-floor-block-marker' },
  })]) };
  const error = { type: 'floor_blocked', message: 'fixture-floor-block-marker', metadata: { category: 'cbrn' } };
  const cases = [
    [() => Response.json({ error }, { status: 451 }), 'Card rejected. Real-world weapons assistance.'],
    [() => Response.json({ error: { type: 'floor_unavailable' } }, { status: 503 }), CARD_CHECK_UNAVAILABLE],
    [() => Response.json({ allowed: false }), CARD_CHECK_UNAVAILABLE],
    [() => { throw new TypeError('offline'); }, CARD_CHECK_UNAVAILABLE],
  ];
  for (const [respond, reason] of cases) {
    const disk = memoryDisk();
    const checkCard = lifeboatCardCheck(false, clientFor(respond));
    const summary = await importFiles([file], disk, false, { checkCard });
    assert.deepEqual(summary.skipped, [{ name: 'lantern.json', why: reason }]);
    assert.equal(summary.characters, 0);
    assert.equal(disk.size(), 0);
  }
});

test('a text transcript produces on-device memory for the first character turn without sending its messages to the card check', async () => {
  const transcript = 'Character: The private opening line.\nYou: We painted the telescope green.\nIt took all night.\nCharacter: I can see it from here.';
  const file = { name: 'Stone Lantern.txt', blob: new Blob([transcript]) };
  const seen = [];
  const checkCard = lifeboatCardCheck(false, clientFor(async (_url, init) => {
    seen.push(JSON.parse(init.body).fields.join('\n'));
    return Response.json({ allowed: true });
  }));
  const disk = memoryDisk();
  const summary = await importFiles([file], disk, false, { checkCard });
  assert.deepEqual([summary.characters, summary.chats, summary.messages], [1, 1, 3]);
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0], /private opening|telescope|all night|see it from here/);
  const { characters, boards } = await loadArchive(disk, false);
  const [character] = characters;
  assert.equal(character.card.data.first_mes, '');
  const memory = boardMemory(boards[character.id]);
  const prompt = buildCharacterMessages(character.card, [{ role: 'user', content: 'Do you remember?' }], { memory });
  assert.match(prompt.messages[0].content, /We painted the telescope green. It took all night/);
  const legacy = memoryDisk();
  assert.equal((await importFiles([file], legacy, false)).chats, 0);
  assert.equal(legacy.size(), 0);
});

test('a re-import updates a saved conversation only after its card passes', async () => {
  const name = 'Stone Lantern';
  const file = (name, value) => ({ name, blob: new Blob([JSON.stringify(value)]) });
  const card = (description) => file('lantern.json', { spec: 'chara_card_v2', data: { name, description } });
  const log = (reply) => file('conversation.json', { id: 'fixture-chat-id', character: name, messages: [
    { role: 'user', content: 'What color is the telescope?' }, { role: 'assistant', content: reply },
  ] });
  const disk = memoryDisk();
  const checkCard = async (candidate) => candidate.data.description === 'fixture-floor-block-marker' ? 'Card rejected. Fixture category.' : null;
  await importFiles([card('A station guide.'), log('Green.')], disk, false, { checkCard });
  const before = await loadArchive(disk, false);
  const size = disk.size();
  const rejected = await importFiles([card('fixture-floor-block-marker'), log('Silver.')], disk, false, { checkCard });
  assert.equal(rejected.chats, 0);
  assert.deepEqual(await loadArchive(disk, false), before);
  assert.equal((await historyOf(disk, false, before.characters[0])).at(-1).text, 'Green.');
  assert.equal(disk.size(), size);
  const accepted = await importFiles([card('A station guide.'), log('Blue.')], disk, false, { checkCard });
  assert.deepEqual([accepted.duplicates, accepted.chats], [1, 1]);
  const after = await loadArchive(disk, false);
  assert.equal(after.characters[0].chats.length, 1);
  assert.equal((await historyOf(disk, false, after.characters[0])).at(-1).text, 'Blue.');
  assert.equal(disk.size(), size);
});
