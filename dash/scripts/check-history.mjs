// Update "history": chats kept in this browser (lib/anonymo/history.ts) and the update switches (lib/anonymo/updates.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVICE_PREFIX, fileNameOf, rename, remove, titleOf, toJson, toMarkdown, toSaved, upsert, wipeDevice } from '../lib/anonymo/history.ts';
import { parseUpdates, UPDATE_IDS } from '../lib/anonymo/updates.ts';

const turn = (over = {}) => ({ id: 't1', model: 'anonymo-1', prompt: 'Plan a weekend in Lisbon', attachment: null, character: null, content: 'Day one: …', status: 'done', error: null, receiptId: 'rcpt_1', councilMode: null, receipt: { big: 'x'.repeat(50) }, council: { seats: [] }, ...over });
const chat = (id, updatedAt, turns = [turn()]) => ({ id, title: titleOf(turns), createdAt: updatedAt, updatedAt, model: 'anonymo-1', turns: toSaved(turns) });

test('titles come from the first prompt, shortened, with the character', () => {
  assert.equal(titleOf([]), 'New chat');
  assert.equal(titleOf([turn({ prompt: '  Plan\n a   weekend ' })]), 'Plan a weekend');
  const long = titleOf([turn({ prompt: 'word '.repeat(40) })]);
  assert.ok(long.length <= 60 && long.endsWith('…'));
  assert.equal(titleOf([turn({ character: 'Mara', prompt: 'Hello' })]), 'Mara: Hello');
});

test('only finished turns are saved, without receipts bodies or council texts', () => {
  const saved = toSaved([turn(), turn({ id: 't2', status: 'streaming' }), turn({ id: 't3', status: 'stopped' }), turn({ id: 't4', status: 'error', error: 'x' })]);
  assert.deepEqual(saved.map((t) => t.id), ['t1', 't3', 't4']);
  assert.equal('receipt' in saved[0], false);
  assert.equal('council' in saved[0], false);
  assert.equal(saved[0].receiptId, 'rcpt_1');
});

test('newest first, one copy per chat, trimmed by count and by size', () => {
  let list = [];
  list = upsert(list, chat('a', '2026-11-01T00:00:00Z'));
  list = upsert(list, chat('b', '2026-11-02T00:00:00Z'));
  list = upsert(list, chat('a', '2026-11-03T00:00:00Z'));
  assert.deepEqual(list.map((c) => c.id), ['a', 'b']);
  const many = Array.from({ length: 5 }, (_, i) => chat(`c${i}`, `2026-11-0${i + 1}T00:00:00Z`)).reduce((l, c) => upsert(l, c, { chats: 3, bytes: 1e9 }), []);
  assert.deepEqual(many.map((c) => c.id), ['c4', 'c3', 'c2']);
  const big = chat('big', '2026-11-09T00:00:00Z', [turn({ content: 'y'.repeat(4000) })]);
  const sized = upsert(many, big, { chats: 60, bytes: JSON.stringify([big]).length + 10 });
  assert.deepEqual(sized.map((c) => c.id), ['big']);
});

test('rename, delete and exports', () => {
  const c = chat('a', '2026-11-01T00:00:00Z');
  assert.equal(rename([c], 'a', '  Lisbon   trip ')[0].title, 'Lisbon trip');
  assert.equal(rename([c], 'a', '   ')[0].title, c.title);
  assert.deepEqual(remove([c], 'a'), []);
  const md = toMarkdown(c);
  assert.match(md, /^# Plan a weekend in Lisbon\n/);
  assert.match(md, /\*\*You:\*\*\n\nPlan a weekend in Lisbon/);
  assert.match(md, /\*\*anonymo-1:\*\*\n\nDay one/);
  assert.match(md, /Receipt: rcpt_1/);
  const j = JSON.parse(toJson(c));
  assert.equal(j.format, 'anonymo-chat');
  assert.equal(j.turns.length, 1);
  assert.equal(fileNameOf(c, 'md'), 'anonymo-plan-a-weekend-in-lisbon.md');
  assert.equal(fileNameOf({ ...c, title: '!!!' }, 'json'), 'anonymo-chat.json');
});

test('wiping the device removes every anonymo entry and nothing else', () => {
  const fake = () => {
    const m = new Map();
    return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), _m: m };
  };
  const local = fake(), session = fake();
  for (const k of ['anonymo.key', 'anonymo.history.v1', 'anonymo.characters.v1', 'anonymo.receipts.v1', 'anonymo.adult.v1', 'other.site']) local.setItem(k, '1');
  session.setItem('anonymo.demo.key', '1');
  assert.equal(DEVICE_PREFIX, 'anonymo.');
  assert.equal(wipeDevice([local, session]), 6);
  assert.deepEqual([...local._m.keys()], ['other.site']);
  assert.equal(session.length, 0);
});

test('updates are off unless listed; "all" turns every one on', () => {
  assert.equal(parseUpdates(undefined).size, 0);
  assert.equal(parseUpdates('').size, 0);
  assert.deepEqual([...parseUpdates(' History, usage ,nope')].sort(), ['history', 'usage']);
  assert.deepEqual([...parseUpdates('all')], [...UPDATE_IDS]);
});

test('switching sessions restores tab-only turns without mixing in saved history', async () => {
  const { freshTabChats, switchTabChat } = await import('../lib/anonymo/tab-chats.ts');
  const a = { ...freshTabChats('a'), active: { id: 'a', turns: [turn()] } };
  const b = switchTabChat(a, 'b', undefined, true);
  assert.deepEqual(b.active.turns, []);
  assert.deepEqual(b.recent, [a.active]);
  assert.deepEqual(switchTabChat(b, 'a', undefined, true), a);
  assert.deepEqual(switchTabChat(a, 'saved', [turn({ id: 'saved-turn' })], false).recent, []);
  const busy = { ...a, active: { id: 'a', turns: [turn({ status: 'streaming' })] } };
  assert.equal(switchTabChat(busy, 'b', undefined, true), busy);
  assert.equal(switchTabChat(a, 'a', [], true), a);
  assert.deepEqual(freshTabChats('wiped'), { active: { id: 'wiped', turns: [] }, recent: [] });
});

test('tab session history drops empty sessions and bounds recent conversations', async () => {
  const { freshTabChats, switchTabChat } = await import('../lib/anonymo/tab-chats.ts');
  let state = freshTabChats('start');
  for (let id = 0; id < 20; id++) {
    state.active.turns = [turn()];
    state = switchTabChat(state, String(id), undefined, true);
  }
  assert.equal(state.recent.length, 12);
  assert.deepEqual(state.recent.map((chat) => chat.id), Array.from({ length: 12 }, (_, i) => String(18 - i)));
  assert.deepEqual(switchTabChat(state, 'empty', undefined, true).recent, state.recent);
});

test('the mascot advertises only enabled features, in a stable rotation', async () => {
  const { availableFeatureTips } = await import('../lib/anonymo/feature-tips.ts');
  const { updateOn } = await import('../lib/anonymo/updates.ts');
  const demo = availableFeatureTips(true), live = availableFeatureTips(false);
  assert.equal(new Set(demo.map(tip => tip.title)).size, 9);
  assert.deepEqual(live, demo.filter(tip => !tip.update || updateOn(tip.update, false)));
  assert.ok(demo.every(tip => tip.href.startsWith('/') && !tip.href.startsWith('//')));
});
