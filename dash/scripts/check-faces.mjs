// Update "faces": the mood of a reply, what is asked of the chat model and of the image model, how one sheet becomes six
// faces, and the demo gateway's side of it (lib/anonymo/faces.ts, lib/anonymo/mock/faces.ts).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';
import { normalizeCard } from '../lib/anonymo/card.ts';
import { AnonymoApiError, createAnonymoClient } from '../lib/anonymo/client.ts';
import {
  EXPRESSIONS,
  FACE_STYLES,
  HELPER_MODEL,
  LOOK_INSTRUCTION,
  LOOK_MAX,
  MOOD_WINDOW,
  SAFE_PERSON,
  SAFE_PLACE,
  SCENE_INSTRUCTION,
  SCENE_MAX,
  SCENE_RATIO,
  SHEET_MARK,
  SHEET_RATIO,
  defaultLabels,
  isExpression,
  lookRequest,
  moodOf,
  pickSize,
  scenePrompt,
  sceneRequest,
  sheetPrompt,
  tidySentence,
  tileFor,
  tileRects,
} from '../lib/anonymo/faces.ts';
import { FACES_DB } from '../lib/anonymo/faces-store.ts';
import { DEVICE_PREFIX } from '../lib/anonymo/history.ts';
import { DEMO_LOOK, DEMO_SCENE, demoCharacterLine, demoFaceReply, demoMood } from '../lib/anonymo/mock/faces.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { DEMO_IMAGE_MODELS, DEMO_NUDITY } from '../lib/anonymo/mock/images.ts';
import { SAMPLE_CARD } from '../lib/anonymo/sample-character.ts';
import { parseUpdates, UPDATE_IDS, updateOn } from '../lib/anonymo/updates.ts';

const STYLES = FACE_STYLES.map((s) => s.id);
const sample = normalizeCard(SAMPLE_CARD);

void test('faces is available in the live workspace and demo without enabling unrelated updates', () => {
  assert.ok(UPDATE_IDS.includes('faces'));
  assert.equal(parseUpdates('history,usage').has('faces'), false);
  assert.equal(parseUpdates(' Faces ').has('faces'), true);
  assert.equal(parseUpdates('all').has('faces'), true);
  assert.equal(updateOn('faces', true), true);
  assert.equal(updateOn('faces', false), true);
});

void test('the mood of a reply is read from its words and emoji', () => {
  const cases = [
    ['', 'calm'],
    ['   \n ', 'calm'],
    ['The ledger shows forty crates. We leave at dawn.', 'calm'],
    ['*She grins.* "Now that is a plan."', 'happy'],
    ['Haha, you actually did it! 😄', 'happy'],
    ['*He sighs and looks at the floor.* "I am sorry."', 'sad'],
    ['*She glares at you.* "How dare you."', 'angry'],
    ['*He blinks.* "You did what?!"', 'surprised'],
    ['*She blushes and answers softly.*', 'tender'],
    ['❤️', 'tender'],
    ['SHE LAUGHS OUT LOUD', 'happy'],
  ];
  for (const [text, mood] of cases) assert.equal(moodOf(text), mood, JSON.stringify(text));
});

void test('how a reply ends decides, and a telling word far back no longer counts', () => {
  const filler = 'The road goes on past the mill. ';
  assert.equal(moodOf(`She laughs at the joke. ${filler.repeat(8)}Then she glares, furious.`), 'angry');
  assert.equal(moodOf(`She glares, furious. ${filler.repeat(8)}Then she laughs and grins.`), 'happy');
  // Inside the window but most of it away: one old word is not enough to leave calm.
  const old = `She smiles. ${'word '.repeat(160)}`;
  assert.ok(old.length < MOOD_WINDOW);
  assert.equal(moodOf(old), 'calm');
  // Beyond the window it is not read at all.
  assert.equal(moodOf(`She sobs. ${filler.repeat(40)}`), 'calm');
  // A reply is read as it streams: the face can change as the words arrive.
  const reply = '*I blink, startled.* "Wait?!" *Then I laugh, and grin, and laugh again.*';
  assert.equal(moodOf(reply.slice(0, 30)), 'surprised');
  assert.equal(moodOf(reply), 'happy');
});

void test('any text gives one of the six moods, and the same one every time', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 3000 }), (text) => {
      const mood = moodOf(text);
      return isExpression(mood) && mood === moodOf(text) && (text.trim() !== '' || mood === 'calm');
    }),
  );
  fc.assert(fc.property(fc.array(fc.constantFrom('smiles', 'sighs', 'glares', 'gasps', 'blushes', 'walks', '?!', '😄', '\n', ' the '), { maxLength: 80 }), (words) => isExpression(moodOf(words.join(' ')))));
});

void test('the demo character lines read as the mood they are meant to show', () => {
  for (const mood of EXPRESSIONS) assert.equal(moodOf(demoCharacterLine(mood)), mood, mood);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((turn) => demoMood('Tell me more.', turn)).sort(), [...EXPRESSIONS].sort(), 'six plain turns show all six faces');
  assert.equal(demoMood('I have bad news', 0), 'sad');
  assert.equal(demoMood('Tell me a joke', 3), 'happy');
});

void test('the look request sends the card cut short and ends with the instruction', () => {
  const req = lookRequest(sample);
  assert.equal(req.length, 2);
  assert.equal(req[0].role, 'system');
  assert.equal(req[1].role, 'user');
  assert.ok(req[1].content.endsWith(LOOK_INSTRUCTION));
  assert.match(req[1].content, /^Name: Mara\n\nDescription: Mara is 34/);
  assert.match(req[1].content, /Scenario: the other person has just come aboard/, 'macros are filled in');
  assert.match(LOOK_INSTRUCTION, /an adult/);
  assert.match(LOOK_INSTRUCTION, /fully dressed/);
  assert.match(LOOK_INSTRUCTION, /do not name any real person/i);
  const long = normalizeCard({ ...SAMPLE_CARD, data: { ...SAMPLE_CARD.data, description: 'x'.repeat(40_000) } });
  assert.ok(lookRequest(long)[1].content.length < 6000, 'a huge card still makes a small request');
});

void test('the scene request reads the last few messages only, and the card before the chat starts', () => {
  const thread = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'y'.repeat(2000)}` }));
  const req = sceneRequest([{ role: 'system', content: 'secret system text' }, ...thread], sample);
  const text = req[1].content;
  assert.ok(text.endsWith(SCENE_INSTRUCTION));
  assert.equal(text.includes('secret system text'), false);
  assert.equal(text.includes('message 3'), false, 'older messages are left out');
  for (const i of [4, 5, 6, 7, 8, 9]) assert.ok(text.includes(`message ${i}`));
  assert.ok(text.length < 6500, 'each message is cut short');
  assert.match(text, /^Scenario: the other person has just come aboard/);
  const fresh = sceneRequest([], sample)[1].content;
  assert.match(fresh, /Character: \*Mara looks up from the chart table/, 'before the chat starts, the greeting sets the scene');
  assert.match(sceneRequest([])[1].content, /^The chat has not started yet\./);
  assert.match(SCENE_INSTRUCTION, /No people/);
});

void test('a model answer is tidied into one sentence', () => {
  assert.equal(tidySentence('  "An adult with\n short hair." ', 400), 'An adult with short hair.');
  assert.equal(tidySentence('Look: *a tall adult in a grey coat*', 400), 'a tall adult in a grey coat');
  const cut = tidySentence('word '.repeat(200), 100);
  assert.ok(cut.length <= 101 && cut.endsWith('…') && !cut.includes('  '));
  assert.equal(tidySentence('   ', 100), '');
});

void test('the face prompt asks for six panels of one clothed adult, in the order the faces are cut', () => {
  for (const style of STYLES) {
    const prompt = sheetPrompt(`  "${DEMO_LOOK}"\n`, style);
    assert.ok(prompt.startsWith(SHEET_MARK));
    assert.ok(prompt.includes(`The person: ${DEMO_LOOK}`), 'the look goes in tidied');
    assert.ok(prompt.endsWith(SAFE_PERSON));
    assert.match(prompt, /six equal panels, three across and two down/);
    assert.match(prompt, /same person/);
    const top = prompt.indexOf('Top row'), bottom = prompt.indexOf('Bottom row');
    const at = EXPRESSIONS.map((e) => prompt.indexOf(` ${e},`, top));
    assert.ok(at.every((i) => i > 0), 'every mood is named');
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in sheet order');
    assert.ok(at[2] < bottom && at[3] > bottom, 'three in each row');
  }
  assert.ok(sheetPrompt('z'.repeat(5000), 'painted').length < LOOK_MAX + 900, 'a long look is cut');
  assert.notEqual(sheetPrompt(DEMO_LOOK, 'painted'), sheetPrompt(DEMO_LOOK, 'anime'));
});

void test('the backdrop prompt asks for an empty place', () => {
  for (const style of STYLES) {
    const prompt = scenePrompt(DEMO_SCENE, style);
    assert.ok(prompt.includes(DEMO_SCENE));
    assert.ok(prompt.endsWith(SAFE_PLACE));
    assert.equal(prompt.startsWith(SHEET_MARK), false);
  }
  assert.ok(scenePrompt('z'.repeat(5000), 'photo').length < SCENE_MAX + 500);
  assert.match(SAFE_PERSON, /adult/);
  assert.match(SAFE_PERSON, /fully clothed/);
  assert.match(SAFE_PERSON, /Safe for work/);
  assert.match(SAFE_PLACE, /no people/);
  assert.match(SAFE_PLACE, /Safe for work/);
});

void test("the prompts pass the gateway's own word rules, which refuse a prompt that names what to leave out", (t) => {
  const prompts = STYLES.flatMap((style) => [sheetPrompt(DEMO_LOOK, style), scenePrompt(DEMO_SCENE, style)]);
  for (const p of prompts) assert.equal(DEMO_NUDITY.test(p), false, 'the demo gateway refuses nothing we send');
  // The real rules, read from the gateway's source next door (the two ship from one repository).
  const file = new URL('../../gateway/src/anonymo/media/prompt-check.ts', import.meta.url);
  if (!existsSync(file)) return t.skip('gateway source is not next to the dashboard here');
  const list = /const BLOCKED = \[\n([\s\S]*?)\n\];/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
  const rules = [...list.matchAll(/^\s*\/(.+)\/([a-z]*),\s*$/gm)].map((m) => new RegExp(m[1], m[2]));
  assert.ok(rules.length >= 6, 'the rules were found');
  const refused = (prompt) => rules.some((r) => r.test(prompt.normalize('NFKC')));
  assert.equal(refused('a naked person on a beach'), true, 'the rules are live');
  assert.equal(refused('a portrait, no clothing'), true);
  for (const p of prompts) assert.equal(refused(p), false, p.slice(0, 60));
});

void test('the size nearest the wanted shape is picked from what a model offers', () => {
  const [banana, gpt] = DEMO_IMAGE_MODELS;
  assert.equal(pickSize(gpt.sizes, SHEET_RATIO), '1536x1024');
  assert.equal(pickSize(banana.sizes, SHEET_RATIO), '1184x864');
  assert.equal(pickSize(gpt.sizes, SCENE_RATIO), '1536x1024');
  assert.equal(pickSize(banana.sizes, SCENE_RATIO), '1344x768');
  assert.equal(pickSize(['512x512', '1024x1024'], 1), '1024x1024', 'between equal shapes, the larger');
  assert.equal(pickSize(['wide', '640x480'], 3), '640x480', 'sizes that are not WxH are passed over');
  assert.equal(pickSize([], 1), '1024x1024');
  assert.equal(pickSize(['banner'], 1), 'banner');
});

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

void test('a sheet is cut into six faces that stay inside it and never overlap', () => {
  for (const [w, h] of [[1536, 1024], [1184, 864], [1024, 1024], [1344, 768], [100, 67]]) {
    const whole = tileRects(w, h, 3, 2, 0);
    assert.equal(whole.length, 6);
    assert.equal(whole.reduce((sum, r) => sum + r.w * r.h, 0), w * h, 'with no trim the faces cover the whole sheet');
    const trimmed = tileRects(w, h);
    for (const [i, r] of trimmed.entries()) {
      assert.ok(r.x >= whole[i].x && r.y >= whole[i].y && r.x + r.w <= whole[i].x + whole[i].w && r.y + r.h <= whole[i].y + whole[i].h, 'a trimmed face stays in its panel');
      assert.ok(r.w > whole[i].w * 0.9 && r.h > whole[i].h * 0.9, 'and keeps most of it');
    }
  }
  assert.deepEqual(tileRects(1536, 1024, 3, 2, 0)[4], { x: 512, y: 512, w: 512, h: 512 });
  fc.assert(
    fc.property(fc.integer({ min: 12, max: 4096 }), fc.integer({ min: 12, max: 4096 }), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), fc.double({ min: 0, max: 0.3, noNaN: true }), (w, h, cols, rows, inset) => {
      const rects = tileRects(w, h, cols, rows, inset);
      if (rects.length !== cols * rows) return false;
      for (const r of rects) if (r.x < 0 || r.y < 0 || r.w < 1 || r.h < 1 || r.x + r.w > w || r.y + r.h > h) return false;
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i], rects[j])) return false;
      return true;
    }),
  );
});

void test('a mood shows the face labelled with it, else the calm one', () => {
  const labels = defaultLabels();
  assert.deepEqual(labels, [...EXPRESSIONS]);
  EXPRESSIONS.forEach((e, i) => assert.equal(tileFor(labels, e), i));
  assert.equal(tileFor(['happy', 'happy', 'calm', 'sad', 'sad', 'sad'], 'angry'), 2, 'no face for a mood: the calm one');
  assert.equal(tileFor(['happy', 'happy', 'sad', 'sad', 'sad', 'sad'], 'tender'), 0, 'no calm one either: the first');
  assert.equal(tileFor(['happy', 'happy', 'calm', 'sad', 'sad', 'sad'], 'happy'), 0, 'two with one label: the first');
  assert.equal(tileFor([], 'calm'), -1);
});

void test('faces are kept under the same prefix "Wipe this device" clears', () => {
  assert.ok(FACES_DB.startsWith(DEVICE_PREFIX));
});

void test('the demo gateway answers the look and scene requests, speaks in character, and charges like any call', async () => {
  const mock = createMockGateway({ delayMs: 0, imageDelayMs: 0 });
  const created = await createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch, key: created.key });
  await mock.simulateDeposit(created.key, 'rhc', 'USDG', 2_000_000);
  const balance = async () => (await client.balance()).available_usd;

  let before = await balance();
  const look = await client.chat({ model: HELPER_MODEL, messages: lookRequest(sample), max_tokens: 160 });
  assert.equal(look.content, DEMO_LOOK);
  assert.ok(look.receiptId, 'a helper request gets a receipt like any other');
  assert.ok((await balance()) < before, 'and is charged');

  const scene = await client.chat({ model: HELPER_MODEL, messages: sceneRequest([{ role: 'user', content: 'Where are we?' }], sample) });
  assert.equal(scene.content, DEMO_SCENE);

  const inCharacter = [{ role: 'system', content: 'Write Mara’s next reply.' }, { role: 'user', content: 'I have bad news.' }];
  assert.equal(moodOf((await client.chat({ model: 'anonymo-1', messages: inCharacter })).content), 'sad');
  assert.equal(demoFaceReply([{ role: 'user', content: 'What is a receipt?' }]), null, 'an ordinary chat is left alone');
  assert.match((await client.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'What is a receipt?' }] })).content, /demo answer/);

  const [banana, gpt] = DEMO_IMAGE_MODELS;
  before = await balance();
  const sheet = await client.generateImages({ model: gpt.id, prompt: sheetPrompt(DEMO_LOOK, 'painted'), n: 1, size: pickSize(gpt.sizes, SHEET_RATIO) });
  assert.ok(sheet.data[0].b64_json);
  assert.equal(Math.round((before - (await balance())) * 1000), 80, 'one sheet costs one image');
  const backdrop = await client.generateImages({ model: banana.id, prompt: scenePrompt(DEMO_SCENE, 'painted'), n: 1, size: pickSize(banana.sizes, SCENE_RATIO) });
  assert.ok(backdrop.data[0].b64_json);

  before = await balance();
  await assert.rejects(client.generateImages({ model: gpt.id, prompt: sheetPrompt('a naked adult', 'painted'), n: 1, size: '1536x1024' }), (e) => e instanceof AnonymoApiError && e.status === 451 && e.code === 'explicit_media_unavailable');
  assert.equal(await balance(), before, 'a refused look is not charged');
});

void test('wardrobe parts combine independently and older designs keep their original hats', async () => {
  const { BASE_PLUSH, OUTFITS, HATS, GLASSES, MOUTHS, SHAPES, partUrl, isPlush, readPlush } = await import('../lib/anonymo/plush.ts');
  for (const outfit of OUTFITS) {
    assert.ok(existsSync(new URL('../public' + partUrl('outfit',outfit), import.meta.url)));
    for (const hat of HATS) for (const glasses of GLASSES) for (const mouth of MOUTHS) for (const shape of SHAPES)
      assert.ok(isPlush({ ...BASE_PLUSH, outfit, hat, glasses, mouth, shape, coat:'#c22e38' }));
  }
  for (const [part, choices] of [['hat',HATS.slice(3)],['glasses', GLASSES.slice(1)]])
    for (const item of choices) assert.ok(existsSync(new URL('../public' + partUrl(part,item), import.meta.url)));
  assert.equal(readPlush({outfit:'Pilot',mask:'Rose',coat:'Teal',thread:'Gold'}).hat,'Flight helmet');
  assert.equal(readPlush({...BASE_PLUSH,outfit:'Pilot',hat:'None'}).hat,'None');
  for (const value of [null, {}, {...BASE_PLUSH,coat:'#gg77gg'}, {...BASE_PLUSH,mask:'constructor'}, {...BASE_PLUSH,hat:'missing'}]) assert.equal(readPlush(value), undefined);
});

void test('custom colors change only their own material and preserve the alpha channel', async () => {
  const { BASE_PLUSH, dyeFabric } = await import('../lib/anonymo/plush.ts');
  const pixels = new Uint8ClampedArray(40 * 4);
  // Grey backdrop, felt forehead, mask, gold eyes, teal coat, gold buttons and cream trim.
  const samples = [[0,45,45,45],[5,200,155,120],[13,60,12,38],[16,245,160,30],[31,7,54,60],[34,200,145,39],[38,202,192,167]];
  for (const [y,r,g,b] of samples) pixels.set([r,g,b,255],y*4);
  for (const [field,target] of [['felt',5],['mask',13],['thread',16],['coat',31]]) {
    for(const value of ['#f91267','#000000','#ffffff','Cobalt']){
      const changed = pixels.slice();
      dyeFabric(changed,1,40,{...BASE_PLUSH,[field]:value});
      for(const [y] of samples){
        const pixel = changed.slice(4*y,4*y+4);
        if(y === target) assert.notDeepEqual(pixel,pixels.slice(4*y,4*y+4));
        else assert.deepEqual(pixel,pixels.slice(4*y,4*y+4));
        assert.equal(pixel[3],255);
      }
    }
  }
});

void test('a named plush becomes a new chat card with the supplied personality', async () => {
  const { plushCard } = await import('../lib/anonymo/sample-character.ts');
  const card = normalizeCard(plushCard('  Orbit  ', ' Curious pilot '));
  assert.equal(card.data.name, 'Orbit');
  assert.equal(card.data.personality, 'Curious pilot');
  assert.match(card.data.first_mes, /Orbit/);
  assert.throws(() => plushCard('  ', ''));
  assert.throws(() => plushCard('A'.repeat(65), ''));
  assert.throws(() => plushCard('Orbit', 'x'.repeat(601)));
});
