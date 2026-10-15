import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  addCouncil, councilLimits, councilName, councilsKey, parseCouncils,
  readCouncils, selectCouncil, validCouncil, writeCouncils,
} from '../lib/saved-councils.ts';

const council = (id = 'council-1') => ({ id, name: 'Review team', modelIds: ['claude', 'gemini'], createdAt: 100 });

test('names are trimmed and capped at 24 characters without splitting Unicode', () => {
  assert.equal(councilName('  Review team  '), 'Review team');
  assert.equal(councilName('a'.repeat(30)), 'a'.repeat(24));
  assert.equal(councilName('😀'.repeat(25)), '😀'.repeat(24));
  assert.equal(councilName(`team${' '.repeat(22)}x`), 'team');
  assert.equal(validCouncil({ ...council(), name: '   ' }), null);
  assert.equal(validCouncil({ ...council(), name: '  团队  ' }).name, '团队');
});

test('only unique line-ups of two through four models can be saved', () => {
  for (const modelIds of [[], ['claude'], ['claude', 'claude'], ['a', 'b', 'c', 'd', 'e'], ['a', 1], ['', 'b']]) {
    assert.equal(validCouncil({ ...council(), modelIds }), null);
  }
  assert.equal(validCouncil({ ...council(), modelIds: ['a', 'b', 'c', 'd'] }).modelIds.length, 4);
  for (const patch of [{ id: '' }, { createdAt: NaN }, { createdAt: -1 }, { name: 1 }, { modelIds: null }]) {
    assert.equal(validCouncil({ ...council(), ...patch }), null);
  }
});

test('invalid stored JSON and malformed entries are ignored', () => {
  for (const json of [null, '', '{', '{}', 'null', 'true']) assert.deepEqual(parseCouncils(json), []);
  assert.deepEqual(parseCouncils(JSON.stringify([null, {}, council(), council()])), [council()]);
  assert.equal(parseCouncils(JSON.stringify([{ ...council(), name: 'x'.repeat(30) }]))[0].name.length, 24);
});

test('storage and additions enforce six councils without replacing existing councils', () => {
  const entries = Array.from({ length: 8 }, (_, i) => council(`council-${i}`));
  assert.deepEqual(parseCouncils(JSON.stringify(entries)), entries.slice(0, 6));
  const original = entries.slice(0, 6);
  assert.deepEqual(addCouncil(original, council('extra')), original);
  assert.deepEqual(addCouncil([council()], council()), [council()]);
  assert.deepEqual(addCouncil([], { ...council(), name: ' ' }), []);
  assert.deepEqual(addCouncil([], council()), [council()]);
  assert.equal(councilLimits.councils, 6);
});

test('selection replaces the roster, skips unknown and unavailable models, and never changes saved IDs', () => {
  const saved = { ...council(), modelIds: ['gemini', 'unknown', 'claude', 'gpt'] };
  const before = structuredClone(saved);
  assert.deepEqual(selectCouncil(saved, ['claude', 'gemini', 'gpt'], ['claude', 'gpt']), {
    modelIds: ['claude', 'gpt'], skipped: ['gemini', 'unknown'],
  });
  assert.deepEqual(selectCouncil(saved, ['claude', 'gemini', 'gpt'], null), {
    modelIds: ['gemini', 'claude', 'gpt'], skipped: ['unknown'],
  });
  assert.deepEqual(selectCouncil(saved, ['claude', 'gemini', 'gpt'], []).modelIds, []);
  assert.deepEqual(saved, before);
  assert.equal(selectCouncil({ ...saved, modelIds: ['a', 'b', 'c', 'd', 'e'] }, ['a', 'b', 'c', 'd', 'e'], null).modelIds.length, 4);
});

test('storage uses one key and reports refused getters, reads and writes without throwing', () => {
  let raw = null;
  const storage = () => ({
    getItem(key) { assert.equal(key, councilsKey); return raw; },
    setItem(key, value) { assert.equal(key, councilsKey); raw = value; },
  });
  assert.equal(writeCouncils(storage, [council()]), true);
  assert.deepEqual(readCouncils(storage), { councils: [council()], stored: true });
  raw = 'broken JSON';
  assert.deepEqual(readCouncils(storage), { councils: [], stored: true });
  const refused = () => { throw new Error('Storage refused'); };
  assert.deepEqual(readCouncils(refused), { councils: [], stored: false });
  assert.equal(writeCouncils(refused, [council()]), false);
  assert.deepEqual(readCouncils(() => ({ getItem: refused })), { councils: [], stored: false });
  assert.equal(writeCouncils(() => ({ setItem: refused }), [council()]), false);
  // A refused write leaves the caller's in-memory roster intact.
  const inMemory = addCouncil([], council());
  writeCouncils(refused, inMemory);
  assert.deepEqual(inMemory, [council()]);
});

test('picker entry is gated and council selection follows the existing manual routing path', () => {
  const source = readFileSync(new URL('../components/dashboard/canvas-workspace.tsx', import.meta.url), 'utf8');
  assert.match(source, /featureOn\('savedCouncils'\) && !isStudio && \(\s*<Suspense fallback=\{null\}>\s*<SavedCouncilsPicker/);
  const entry = source.slice(source.indexOf('<SavedCouncilsPicker'), source.indexOf('/>', source.indexOf('<SavedCouncilsPicker')));
  assert.match(entry, /routing\.mode === 'auto'/);
  assert.match(entry, /updateRouting\(\{ \.\.\.routing, mode: 'manual' \}\)/);
  assert.match(entry, /updateRoom\(\{ selectedModels: pickerOrder\(ids, composerModels\) \}\)/);
});
