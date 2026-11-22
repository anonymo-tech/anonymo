// Update "auto": the Auto model (anonymo-auto). The update switch, the picker entry and its copy, what the answer card
// says about the model that answered, the demo classifier and ranking, and the demo gateway's part in it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { DEMO_MODELS } from '../lib/anonymo/mock/fixtures.ts';
import {
  AUTO_CHOICE, AUTO_CLASSES, AUTO_EXPLAINER, AUTO_HEADER, AUTO_MODEL, DEMO_AUTO_CANDIDATES, autoClassOf, autoNote, autoTabLabel, classifyDemo, isAutoModel, rankAuto,
} from '../lib/anonymo/auto.ts';
import { chatModels } from '../lib/anonymo/chat-models.ts';
import { slotModels } from '../lib/anonymo/sidebyside.ts';
import { RELEASED, UPDATE_IDS, parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

const BASE = 'https://demo.anonymo.invalid';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const user = (content) => ({ role: 'user', content });

async function funded(musd = 5_000_000) {
  const mock = createMockGateway({ delayMs: 0 });
  const { key } = await createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key });
  if (musd) await mock.simulateDeposit(key, 'rhc', 'USDG', musd);
  return { mock, client, key };
}

void test('the update: optional, off unless built with it, shown in demo mode', () => {
  assert.ok(UPDATE_IDS.includes('auto'));
  assert.equal(RELEASED.has('auto'), false);
  assert.equal(updateOn('auto', true), true);
  assert.ok(parseUpdates('auto').has('auto'));
  assert.ok(parseUpdates('all').has('auto'));
  assert.equal(parseUpdates('history').has('auto'), false);
  assert.match(read('lib/anonymo/updates.ts'), /^\/\/\s+auto\s+\S/m, 'the comment list names the update');
});

void test('the picker offers Auto first, only while the update is on, and never as a direct model', () => {
  const picker = read('components/dashboard/model-picker.tsx');
  const autoList = picker.indexOf('aria-label="Auto"');
  assert.ok(autoList > 0 && autoList < picker.indexOf('aria-label="Anonymo models"'), 'Auto is listed above the Anonymo and direct models');
  assert.match(picker, /const showAuto = auto &&/);
  const workspace = read('components/dashboard/chat-workspace.tsx');
  assert.match(workspace, /updateOn\('auto', demo\)/);
  assert.match(workspace, /auto=\{autoOn\}/);
  assert.match(workspace, /isAutoModel\(stored\) && !autoOn\) \? 'anonymo-1'/, 'a stored Auto choice falls back while the update is off');
  // The default model stays anonymo-1.
  assert.match(read('lib/anonymo/prefs.ts'), /readJson<unknown>\(MODEL, 'anonymo-1'\)/);
  const listed = [{ id: AUTO_MODEL, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, family: null, quant: null, weights_hash: null, attested: false, refusal_rate_30d: null }];
  assert.deepEqual(chatModels(listed), []);
  assert.deepEqual(slotModels(listed), [], 'Side by Side cannot price Auto before sending, so it is not a column');
});

void test('copy: short plain sentences, none of the banned words, no unexplained "best"', () => {
  const copy = [AUTO_CHOICE.name, AUTO_CHOICE.summary, AUTO_EXPLAINER, autoNote('m', 'code'), autoNote(null, null), read('lib/anonymo/auto.ts')];
  for (const text of copy) {
    assert.doesNotMatch(text, /unfiltered|no rules|anything goes|\byield\b|\binvest|\bprofit|\bAPY\b|\bmoon\b/i);
    assert.doesNotMatch(text, /\bbest\b/i);
  }
  for (const sentence of AUTO_EXPLAINER.split(/(?<=\.)\s+/)) assert.ok(sentence.split(/\s+/).length <= 25, `short sentence: ${sentence}`);
  assert.ok(AUTO_CHOICE.summary.length <= 80, 'one line in the picker');
  assert.match(AUTO_EXPLAINER, /refusal rate over the last 30 days, then by price/);
  assert.match(read('components/docs-view.tsx'), /id="auto"/);
});

void test('the answer card names the model that answered', () => {
  assert.equal(autoTabLabel('dolphin-venice-24b'), 'Auto · dolphin-venice-24b');
  assert.equal(autoTabLabel(null), 'Auto');
  assert.equal(autoTabLabel(AUTO_MODEL), 'Auto');
  assert.equal(autoNote('kimi-k2.7-code', 'code'), 'Auto sent this code request to kimi-k2.7-code.');
  assert.equal(autoNote('gemma-4-26b-uncensored', 'vision'), 'Auto sent this image request to gemma-4-26b-uncensored.');
  assert.equal(autoClassOf(' Reasoning '), 'reasoning');
  assert.equal(autoClassOf('chess'), null);
  assert.equal(isAutoModel(AUTO_MODEL), true);
  const card = read('components/dashboard/answer-card.tsx');
  assert.match(card, /autoTabLabel\(answeredBy\(turn\)\)/);
  assert.match(card, /turn\.answeredBy \?\? turn\.receipt\?\.routes\.find/);
});

void test('demo classifier: each class, in the gateway order', () => {
  const cases = {
    code: [[user('Why does this fail?\n```\nx = [1,2\n```')], [user('Write a python script that renames files')]],
    roleplay: [[{ role: 'system', content: "Write Mira's next reply in a fictional chat between Mira and User. Stay in character." }, user('Hello.')], [user('*pushes the door open* Anyone here?')]],
    reasoning: [[user('What is 17 * 23?')], [user('Explain step by step how tides work.')]],
    vision: [[user([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])]],
    general: [[user('Who painted the Mona Lisa?')], [user('I found a bug in my soup.')]],
  };
  for (const cls of AUTO_CLASSES) for (const messages of cases[cls]) assert.equal(classifyDemo(messages), cls, JSON.stringify(messages));
  assert.equal(classifyDemo([user('hello')], true), 'code', 'tools mean code');
});

void test('demo ranking: refusal rate first, then price, then order; sealed and image filters; deterministic', () => {
  const m = (id, rate, extra = {}) => ({ id, refusal_rate_30d: rate, attested: false, architecture: { input_modalities: ['text'] }, ...extra });
  const candidates = { ...DEMO_AUTO_CANDIDATES, general: ['a', 'b', 'c', 'd'] };
  const models = [m('a', 0.05), m('b', 0.01, { price: 9 }), m('c', 0.012, { price: 1 }), m('d', null, { attested: true })];
  assert.deepEqual(rankAuto('general', models, { candidates }), ['c', 'b', 'a', 'd']);
  assert.deepEqual(rankAuto('general', models, { candidates, sealed: true }), ['d']);
  for (let i = 0; i < 20; i++) assert.deepEqual(rankAuto('general', [...models].reverse(), { candidates }), ['c', 'b', 'a', 'd']);
  assert.deepEqual(rankAuto('vision', [m('gemma-4-26b-uncensored', 0)]), [], 'an image request only goes to a model that reads images');
  assert.deepEqual(rankAuto('vision', [m('gemma-4-26b-uncensored', 0, { architecture: { input_modalities: ['text', 'image'] } })]), ['gemma-4-26b-uncensored']);
  for (const ids of Object.values(DEMO_AUTO_CANDIDATES)) for (const id of ids) assert.ok(DEMO_MODELS.some((x) => x.id === id), `${id} is a demo model`);
});

void test('demo gateway: lists anonymo-auto first and answers with the model it picked', async () => {
  const { client, mock, key } = await funded();
  const models = await client.models();
  assert.equal(models.data[0].id, AUTO_MODEL);
  assert.match(models.data[0].description, /refusal rate/);

  const general = await client.chat({ model: AUTO_MODEL, messages: [user('Who painted the Mona Lisa?')] });
  assert.equal(general.autoClass, 'general');
  assert.notEqual(general.model, AUTO_MODEL);
  assert.equal(general.model, rankAuto('general', DEMO_MODELS)[0]);
  assert.equal(general.receipt.model_id, general.model, 'the receipt names the model that answered');
  assert.ok(general.content.length > 0);

  const code = await client.chat({ model: AUTO_MODEL, messages: [user('Fix this:\n```js\nlet a = \n```')] });
  assert.equal(code.autoClass, 'code');
  assert.equal(code.model, rankAuto('code', DEMO_MODELS)[0]);

  const again = await client.chat({ model: AUTO_MODEL, messages: [user('Who painted the Mona Lisa?')] });
  assert.equal(again.model, general.model, 'same request, same counts, same pick');

  const sealed = await client.chat({ model: AUTO_MODEL, messages: [user('Who painted the Mona Lisa?')] }, { headers: { sealed: true } });
  assert.ok(DEMO_MODELS.find((x) => x.id === sealed.model)?.attested, 'sealed: attested models only');
  assert.equal(sealed.receipt.sealed, true);

  const raw = await mock.fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: AUTO_MODEL, messages: [user('What is 17 * 23?')], stream: true }) });
  assert.equal(raw.headers.get(AUTO_HEADER), 'reasoning');
  await raw.text();
});
