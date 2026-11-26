// A local live-mode build exercises the full and compact Chat components. Every gateway response is a fixture.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, devices } from 'playwright-core';

const origin = new URL(process.env.MODEL_PICKER_TEST_URL ?? 'http://127.0.0.1:49911');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
const architecture = { input_modalities: ['text'], output_modalities: ['text'] };
const demoId = 'demo/direct-chat';
const verified = Array.from({ length: 12 }, (_, i) => ({ id: i === 0 ? 'demo/e2ee-deepseek' : `demo/verified-${i}`, name: 'Legacy name', architecture,
  anonymo_chat: { source: 'ppq', standard_chat: true, category: 'uncensored', name: `Published title ${i + 1}` } }));
const rows = [{ id: 'anonymo-1' }, { id: demoId, name: 'Demo model', architecture }, ...verified,
  { id: 'demo/guard-2', architecture }, { id: 'private/protocol', architecture }, { id: 'demo/e2ee-unverified', architecture },
  { id: 'demo/media', architecture: { ...architecture, output_modalities: ['image', 'text'] } }];

test('Phone model picker selects verified and regular chat routes across full Chat, mascot and reload', async t => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ ...devices['Pixel 7'], viewport: { width: 320, height: 720 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  page.setDefaultTimeout(14000);
  await page.addInitScript(() => {
    sessionStorage.setItem('anonymo.key', 'anm_test_local_fixture_abcdefgh');
    localStorage.setItem('anonymo.adult.v1', 'true');
    localStorage.setItem('anonymo.history.keep.v1', 'true');
  });
  const requests = [];
  let unavailable = false;
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin.origin) return route.continue();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-anonymo-refusal-catch,x-anonymo-sealed', 'cache-control': 'no-store' };
    const json = (data, status = 200) => route.fulfill({ status, headers, json: data });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/models') return json({ data: unavailable ? rows.filter(m => m.id !== demoId) : rows });
    if (url.pathname === '/balance') return json({ available_usd: '5.00', held_usd: '0', withdraw_to: [] });
    if (url.pathname === '/v1/chat/completions') {
      const body = req.postDataJSON(); requests.push(body);
      if (requests.length === 2) return json({ error: { code: 'model_not_found', message: 'This model is unavailable.' } }, 404);
      const id = `gen-1795000000-modeltest${requests.length}`;
      const text = `Fixture reply ${requests.length}`;
      const receipt = { request_id: id, model: body.model, model_id: body.model, routes: [], weights_hash: [], tokens: { in: 4, out: 3 }, cost: '0.001', refused: false, sealed: false, ts: '2026-01-01T00:00:00Z' };
      return route.fulfill({ headers, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ id, choices: [{ delta: { content: text } }], anonymo_receipt: { payload: receipt } })}\n\ndata: [DONE]\n\n` });
    }
    return json({ data: [] });
  });
  await page.goto(new URL('/dashboard/chat', origin).href);
  const trigger = page.getByRole('button', { name: /^Choose model:/ });
  await trigger.click();
  const chooser = page.getByRole('dialog', { name: 'Choose a model' });
  await chooser.getByRole('button', { name: 'Uncensored', exact: true }).click();
  const list = chooser.getByRole('list', { name: 'Direct models' });
  await list.getByRole('button').first().waitFor();
  assert.equal(await list.getByRole('button').count(), 12);
  const first = list.getByRole('button', { name: 'Published title 1', exact: true });
  assert.equal(await first.innerText(), 'Published title 1');
  assert.match(await first.getAttribute('title'), /Regular Chat via PPQ/);
  assert.equal(await first.locator('img').getAttribute('src'), '/model-logos/deepseek.svg');
  await first.locator('img').evaluate(image => image.decode());
  await chooser.getByRole('searchbox').fill(verified[0].id);
  await list.getByRole('button', { name: 'Published title 1', exact: true }).click();
  assert.ok(await trigger.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Fixture reply 1', { exact: true }).waitFor().catch(async error => { throw new Error(`${error.message}\nFixture requests ${requests.length}. Thread: ${(await page.locator('body').innerText()).slice(-1600)}`); });
  await page.locator('.turn').getByText('Regular Chat', { exact: true }).waitFor();
  assert.equal(await page.locator('.turn').getByText(/zero retention|fully private/i).count(), 0);
  assert.equal(requests[0].model, verified[0].id);
  assert.equal(requests[0].dashboard_chat, true);
  assert.ok(await page.evaluate(id => JSON.parse(localStorage.getItem('anonymo.receipts.v1')).some(r => r.model === id), verified[0].id));
  await page.reload();
  await page.getByRole('button', { name: 'Choose model: Published title 1' }).waitFor();
  await page.goto(new URL('/docs', origin).href);
  await page.getByRole('button', { name: 'Open Anonymo chat', exact: true }).click();
  const compact = page.getByRole('dialog', { name: 'Anonymo chat' });
  await compact.getByRole('button', { name: 'Choose model: Published title 1' }).click();
  assert.equal(await chooser.getByRole('button', { name: /private\/protocol|demo\/media|demo\/guard-2|e2ee-unverified/ }).count(), 0);
  await chooser.getByRole('searchbox').fill(demoId);
  await chooser.getByRole('button', { name: /Demo model/ }).click();
  await compact.getByRole('textbox', { name: 'Message', exact: true }).fill('Say hello.');
  await compact.getByRole('button', { name: 'Send', exact: true }).click();
  await compact.getByRole('status').filter({ hasText: /model.*(?:available|not live)/i }).waitFor();
  assert.equal(requests[1].model, demoId);
  assert.equal(requests[1].dashboard_chat, undefined);
  unavailable = true;
  await page.goto(new URL('/dashboard/chat', origin).href);
  await page.getByText(/Your selected model is unavailable/).waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello again.');
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
});

test('a new visitor chooses from the scrollable uncensored catalog before composing', async t => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, serviceWorkers: 'block' });
  let created = 0;
  let failOnce = true;
  let received = null;
  const sampleKey = 'anm_test_onboarding_fixture_example';
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin.origin) return route.continue();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'cache-control': 'no-store' };
    const json = (data, status = 200) => route.fulfill({ status, headers, json: data });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/models') return json({ data: [...rows, { ...verified[0], id: 'demo/offline', availability: 'temporarily_unavailable' }] });
    if (url.pathname === '/keys' && req.method() === 'POST') {
      assert.ok(req.postDataJSON().dashboard_signup);
      if (failOnce) { failOnce = false; return json({ error: { message: 'Try again.', code: 'unavailable' } }, 503); }
      created++;
      return json({ key: sampleKey, first_chat_available: true }, 201);
    }
    if (url.pathname === '/keys/me') return json({ first_chat_available: !received });
    if (url.pathname === '/balance') return json({ available_usd: 0, held_usd: 0, withdraw_to: [] });
    if (url.pathname === '/v1/chat/completions') {
      assert.equal(req.headers().authorization, 'Bearer ' + sampleKey);
      assert.equal(received, null);
      received = req.postDataJSON();
      const id = 'gen-1795000000-fixturefirst';
      const receipt = { request_id: id, model_id: received.model, routes: [], weights_hash: [], tokens: { in: 1, out: 1 }, cost: '0', refused: false, sealed: false };
      const chunk = { id, choices: [{ delta: { content: 'First reply.' } }], anonymo_receipt: { payload: receipt } };
      return route.fulfill({ headers, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n' });
    }
    return json({ data: [] });
  });
  await page.goto(origin.href);
  const welcome = page.getByRole('dialog', { name: 'Choose your chat model' });
  assert.equal(await welcome.count(), 0);
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
  await page.getByRole('button', { name: 'I am 18 or older' }).click();
  await page.getByRole('link', { name: 'Open app', exact: true }).click();
  await page.waitForURL('**/dashboard/chat');
  await welcome.getByRole('listitem').first().waitFor();
  assert.equal(await welcome.getByRole('listitem').count(), verified.length);
  assert.ok(await welcome.locator('.model-results').evaluate(el => el.scrollHeight > el.clientHeight));
  assert.equal(await welcome.locator('li img').first().getAttribute('src'), '/model-logos/deepseek.svg');
  assert.ok(await welcome.locator('li small').first().innerText());
  await welcome.getByRole('listitem').last().getByRole('button').click();
  await welcome.getByRole('alert').waitFor();
  await welcome.getByRole('listitem').last().getByRole('button').click();
  await welcome.waitFor({ state: 'hidden' });
  assert.equal(created, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('anonymo.key')), null);
  await page.reload();
  await page.getByRole('button', { name: 'Choose model: Published title 12' }).waitFor();
  assert.equal(await welcome.count(), 0);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('First reply.', { exact: true }).waitFor();
  assert.equal(received.model, verified.at(-1).id);
  assert.equal(received.dashboard_chat, true);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('One more.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('region', { name: 'Set up chat' }).getByRole('link', { name: 'Add funds' }).waitFor();
  assert.equal(created, 1);
});
