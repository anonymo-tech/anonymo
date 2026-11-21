import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BIBLE_FIELDS, RECAP_CHARS, STORY_ACTIONS, STORY_CONTEXT_CHARS, acceptStoryProposal, earlierRecap, exportStory,
  formatContinuation, newChapter, newStory, storyEstimate, storyMessages, storyOutputTokens, storyTarget,
  undoStoryProposal, wordCount,
} from '../lib/anonymo/story.ts';
import { DEMO_STORY, storyDemoClient } from '../lib/anonymo/mock/story.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { createVault, storySlot, VaultLocked } from '../lib/anonymo/vault.ts';
import { DEVICE_PREFIX, wipeDevice } from '../lib/anonymo/device-store.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

test('Story Studio is an optional update and demo enables it', () => {
  assert.equal(parseUpdates('').has('story'), false);
  assert.equal(parseUpdates('story').has('story'), true);
  assert.equal(updateOn('story', true), true);
});

function longStory() {
  const story = newStory();
  story.title = 'Title '.repeat(600);
  for (const field of Object.keys(BIBLE_FIELDS)) story.bible[field] = `${field} marker ${'note '.repeat(600)}`;
  for (let i = 1; i <= 10; i++) {
    story.chapters.push({
      ...newChapter(i + 1),
      title: `Earlier chapter ${i}`,
      text: 'EXCLUDED EARLIER MANUSCRIPT '.repeat(6_000),
      recap: `RECAP marker ${i} ${'event '.repeat(600)}`,
    });
  }
  return story;
}

test('recaps keep recent earlier chapter summaries within their own budget and in chapter order', () => {
  const story = longStory();
  const current = newChapter(12);
  const later = { ...newChapter(13), recap: 'EXCLUDED FUTURE RECAP' };
  story.chapters.push(current, later);
  const recap = earlierRecap(story, current.id);
  assert.ok(recap.length <= RECAP_CHARS);
  assert.ok(recap.indexOf('Earlier chapter 9') < recap.indexOf('Earlier chapter 10'));
  assert.match(recap, /RECAP marker 10/);
  assert.doesNotMatch(recap, /EXCLUDED|Earlier chapter 1\n/);
  assert.equal(earlierRecap(story, story.chapters[0].id), '');
});

test('all actions keep the bible, relevant chapter excerpts and recaps inside the context budget', () => {
  const story = longStory();
  const start = 'OPENING ' + 'old prose '.repeat(3_000) + ' CLOSE BEFORE ';
  const selected = 'SELECTED FIRST ' + 'selected prose '.repeat(6_000) + ' SELECTED LAST ';
  const end = ' CLOSE AFTER ' + 'later prose '.repeat(3_000) + ' ENDING';
  const chapter = { ...newChapter(12), title: 'Current chapter '.repeat(600), text: start + selected + end, recap: 'EXCLUDED CURRENT RECAP' };
  story.chapters.push(chapter);
  const range = { start: start.length, end: start.length + selected.length };

  for (const action of Object.keys(STORY_ACTIONS)) {
    const messages = storyMessages(story, chapter, action, storyTarget(chapter, action, range), 'More dialogue. '.repeat(600));
    assert.deepEqual(messages.map(({ role }) => role), ['system', 'user']);
    assert.ok(messages.reduce((sum, { content }) => sum + content.length, 0) <= STORY_CONTEXT_CHARS, action);
    const request = messages[1].content;
    assert.match(request, /premise marker[\s\S]*cast marker[\s\S]*rules marker/);
    assert.match(request, /RECAP marker 10/);
    assert.doesNotMatch(request, /EXCLUDED/);
    if (action !== 'summarize') {
      assert.match(request, /CLOSE BEFORE/);
      assert.doesNotMatch(request, /OPENING|ENDING/);
    } else {
      assert.match(request, /OPENING[\s\S]*selected prose[\s\S]*ENDING/);
    }
    if (action === 'rewrite' || action === 'expand') {
      assert.match(request, /SELECTED FIRST[\s\S]*SELECTED LAST[\s\S]*CLOSE AFTER/);
    }
    assert.equal(request.includes('More dialogue.'), action === 'rewrite');
  }
});

test('only accepted proposals change text, and text and recap changes undo in order', () => {
  const source = { ...newChapter(1), text: 'Before. Old. After.', recap: 'Prior recap.' };
  const target = storyTarget(source, 'rewrite', { start: 8, end: 12 });
  const revised = acceptStoryProposal(source, target, 'New.', 'rewrite');
  assert.equal(source.text, 'Before. Old. After.');
  assert.equal(revised.text, 'Before. New. After.');
  assert.equal(revised.recap, source.recap);
  assert.equal(acceptStoryProposal(revised, target, 'Too late.', 'stale'), revised);
  assert.equal(acceptStoryProposal(source, target, '   ', 'blank'), source);

  const recap = storyTarget(revised, 'summarize', { start: 0, end: 0 });
  const summarized = acceptStoryProposal(revised, recap, 'A new recap.', 'summary');
  assert.equal(summarized.recap, 'A new recap.');
  assert.equal(summarized.text, revised.text);
  assert.deepEqual(undoStoryProposal(summarized, 'summary'), revised);
  assert.deepEqual(undoStoryProposal(revised, 'rewrite'), source);
  const manuallyEdited = { ...revised, text: 'A manual edit.' };
  assert.equal(undoStoryProposal(manuallyEdited, 'rewrite'), manuallyEdited);
  assert.deepEqual(undoStoryProposal(manuallyEdited, 'rewrite', true), source);
});

test('continuation inserts at the supplied cursor or appends with paragraph spacing', () => {
  const chapter = { ...newChapter(1), text: 'One. Two.' };
  const middle = storyTarget(chapter, 'continue', { start: 4, end: 8 });
  const end = storyTarget(chapter, 'continue', { start: 99, end: 99 });
  assert.equal(acceptStoryProposal(chapter, middle, formatContinuation(middle, 'Inserted.'), 'mid').text, 'One. Inserted. Two.');
  assert.equal(acceptStoryProposal(chapter, end, formatContinuation(end, 'Three.'), 'end').text, 'One. Two.\n\nThree.');
});

test('exports contain the manuscript in chapter order and count prose words', () => {
  const story = {
    ...newStory(),
    title: ' A # tide ',
    chapters: [
      { ...newChapter(1), title: '', text: 'First chapter.\n\nSecond line.' },
      { ...newChapter(2), title: 'The cove', text: '“It’s time.”' },
    ],
  };
  assert.deepEqual(exportStory(story, 'md'), {
    name: 'a-tide.md', text: '# A \\# tide\n\n## Chapter 1\n\nFirst chapter.\n\nSecond line.\n\n## The cove\n\n“It’s time.”\n',
  });
  assert.deepEqual(exportStory(story, 'txt'), {
    name: 'a-tide.txt', text: 'A # tide\n\nChapter 1\n\nFirst chapter.\n\nSecond line.\n\nThe cove\n\n“It’s time.”\n',
  });
  assert.deepEqual(story.chapters.map(({ text }) => wordCount(text)), [4, 2]);
  assert.equal(wordCount(' '), 0);
});

function memoryVault() {
  const local = new Map();
  const legacy = {
    get length() { return local.size; },
    key: (index) => [...local.keys()][index] ?? null,
    getItem: (key) => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, value),
    removeItem: (key) => local.delete(key),
  };
  const records = new Map();
  const disk = {
    async get(key) { return structuredClone(records.get(key)); },
    async entries(prefix) { return [...records].filter(([key]) => key.startsWith(prefix)); },
    async commit(puts, deletes = []) {
      for (const key of deletes) records.delete(key);
      for (const [key, value] of puts) records.set(key, structuredClone(value));
    },
    async clear() { records.clear(); },
  };
  let queue = Promise.resolve();
  const spawn = () => createVault({
    disk,
    legacy: () => legacy,
    exclusive: (operation) => {
      const next = queue.then(operation);
      queue = next.catch(() => {});
      return next;
    },
  });
  return { local, legacy, records, spawn };
}

test('stories round trip across vault migration, lock, passphrase changes, disable, and device wipe', async () => {
  const { local, legacy, records, spawn } = memoryVault();
  const vault = spawn();
  const live = { ...newStory(), title: 'Device-only manuscript', chapters: DEMO_STORY.chapters };
  const demo = DEMO_STORY;
  await Promise.all([
    vault.updateStories(false, () => [live]),
    vault.updateStories(true, () => [demo]),
    vault.updateChats(false, () => [{ id: 'sample-chat' }]),
  ]);
  assert.deepEqual(JSON.parse(local.get(storySlot(false))), [live]);
  const reloaded = spawn();
  await reloaded.refresh();
  assert.deepEqual(reloaded.snapshotStories(false), [live]);
  assert.deepEqual(reloaded.snapshotStories(true), [demo]);
  await reloaded.clearChats();
  assert.deepEqual(reloaded.snapshotChats(false), []);
  assert.deepEqual(reloaded.snapshotStories(false), [live]);

  const pass = 'sample passphrase one';
  const nextPass = 'sample passphrase two';
  await reloaded.enable(pass);
  assert.equal(local.has(storySlot(false)), false);
  assert.equal(local.has(storySlot(true)), false);
  const encrypted = records.get(storySlot(false))[0];
  assert.ok(encrypted.ciphertext instanceof ArrayBuffer);
  assert.ok(encrypted.iv instanceof Uint8Array);
  const locked = spawn();
  await locked.refresh();
  assert.equal(locked.state().mode, 'locked');
  assert.deepEqual(locked.snapshotStories(false), []);
  await assert.rejects(locked.updateStories(false, () => []), VaultLocked);
  await locked.unlock(pass);
  assert.deepEqual(locked.snapshotStories(false), [live]);
  await locked.changePassphrase(pass, nextPass);
  assert.notDeepEqual(records.get(storySlot(false))[0], encrypted);
  assert.deepEqual(locked.snapshotStories(true), [demo]);
  await locked.disable(nextPass);
  assert.ok(records.get(storySlot(true))[0] instanceof ArrayBuffer);

  await locked.enable(nextPass);
  locked.lock();
  local.set(DEVICE_PREFIX + 'sample', 'remove');
  local.set('unrelated', 'keep');
  await locked.wipe(() => wipeDevice([legacy]));
  assert.equal(records.size, 0);
  assert.deepEqual([...local.keys()], ['unrelated']);
  assert.deepEqual(locked.snapshotStories(false), []);
  assert.deepEqual(locked.snapshotStories(true), []);
});

test('demo writing actions return distinct prose through the chat client and show published estimates', async () => {
  const mock = createMockGateway({ delayMs: 0 });
  const client = await storyDemoClient(mock);
  const models = (await client.models()).data;
  const model = 'anonymo-1';
  const price = models.find(({ id }) => id === model).pricing;
  const chapter = DEMO_STORY.chapters.at(-1);
  const returned = [];
  for (const action of Object.keys(STORY_ACTIONS)) {
    const range = action === 'continue' ? { start: chapter.text.length, end: chapter.text.length } : { start: 0, end: 24 };
    const messages = storyMessages(DEMO_STORY, chapter, action, storyTarget(chapter, action, range), 'More dialogue');
    const max_tokens = storyOutputTokens(action);
    const deltas = [];
    const result = await client.chat({ model, messages, max_tokens }, { onDelta: (delta) => deltas.push(delta) });
    returned.push(result.content);
    assert.equal(deltas.join(''), result.content);
    assert.ok(deltas.length > 1);
    assert.ok(result.receiptId);
    assert.match(storyEstimate(messages, max_tokens, price), /^\$0\.00\d+/);
    if (action === 'continue') assert.ok(wordCount(result.content) >= 350 && wordCount(result.content) <= 450);
    if (action === 'rewrite') assert.match(result.content, /“/);
    if (action === 'summarize') assert.match(result.content, /^The keeper wakes/);
  }
  assert.equal(new Set(returned).size, 4);

  const action = 'summarize';
  const messages = storyMessages(DEMO_STORY, chapter, action, storyTarget(chapter, action, { start: 0, end: 0 }));
  const council = await client.chat({ model: 'anonymo-council', messages, max_tokens: storyOutputTokens(action) });
  assert.equal(council.content, returned[3]);
  assert.ok(council.council);
});
