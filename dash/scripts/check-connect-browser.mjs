// Update 05 "Pair my coding tool" in a local live-mode build. Every gateway response is a fixture (page.route): no
// coding tool, MCP server or gateway runs here, so this checks the page, not a real client.
//   CONNECT_TEST_URL=http://127.0.0.1:5235 BROWSER_CHANNEL=chrome node --test scripts/check-connect-browser.mjs
//   SCREENSHOT_DIR=… also saves the 390 px populated and recovery screenshots there.
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { chromium, devices } from 'playwright-core';

const origin = new URL(process.env.CONNECT_TEST_URL ?? 'http://127.0.0.1:5235');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
const KEY = 'anm_test_local_fixture_abcdefgh';
const shots = process.env.SCREENSHOT_DIR;
const text = { input_modalities: ['text'], output_modalities: ['text'] };
const MODELS = [
  { id: 'anonymo-council', architecture: text },
  { id: 'acme/embed-small', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
  { id: 'anonymo-1', architecture: text },
  { id: 'qwen/qwen3-32b', architecture: text },
];
const GOOD = 'gen-1795400000-GoodMcpCall01';
const REST = 'gen-1795400000-RestCallNoMcp';
const OTHER = 'gen-1795400000-OtherKeysCall';

async function open(browser, { key = KEY, phone = true, models = MODELS, available = '5.00' } = {}) {
  const context = await browser.newContext({
    ...(phone ? devices['Pixel 7'] : {}),
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript((k) => {
    if (k) sessionStorage.setItem('anonymo.key', k);
    localStorage.setItem('anonymo.adult.v1', 'true');
  }, key);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const seen = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin.origin) return route.continue();
    seen.push({ path: url.pathname, url: req.url(), auth: req.headers().authorization ?? null });
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'cache-control': 'no-store' };
    const json = (data, status = 200) => route.fulfill({ status, headers, json: data });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/models') return json({ data: models });
    if (url.pathname === '/balance') return json({ balance_usd: available, held_usd: '0', available_usd: available, withdraw_to: [] });
    if (url.pathname === '/api/v1/generation') {
      const id = url.searchParams.get('id');
      const now = new Date().toISOString();
      if (id === GOOD) return json({ data: { id, model: 'anonymo-1', created_at: now, origin: 'mcp', total_cost: 0.0000179, checked_at: now } });
      if (id === REST) return json({ data: { id, model: 'anonymo-1', created_at: now, origin: null, total_cost: 0.0000179, checked_at: now } });
      return json({ error: { code: 404, message: 'Generation not found.', type: 'not_found' } }, 404);
    }
    return json({ data: [] });
  });
  await page.goto(new URL('/dashboard/connect', origin).href);
  await page.getByRole('heading', { name: 'Pair my coding tool' }).waitFor();
  return { context, page, seen };
}

/** The key must not be in the page's text, its attributes, form values or anything copied. */
async function assertNoKey(page) {
  const dump = await page.evaluate(() => {
    const parts = [document.body.innerText];
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes) parts.push(a.value);
      if ('value' in el && typeof el.value === 'string') parts.push(el.value);
    }
    return parts.join('\n');
  });
  assert.ok(!dump.includes(KEY), 'the key appears on the page');
  assert.ok(!dump.includes(KEY.slice(0, 13)), 'a masked key appears on the page');
}

/** The workspace scrolls inside its own panel, so a full-page capture misses most of it: grow the viewport to the
 *  content's height for the shot, then put it back. */
async function tallShot(page, name) {
  const size = page.viewportSize();
  const height = await page.evaluate(() => Math.max(...[document.scrollingElement, document.getElementById('main'), document.querySelector('.ws-body')].filter(Boolean).map((el) => el.scrollHeight)));
  await page.setViewportSize({ width: size.width, height: Math.min(height + 120, 6000) });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shots, name) });
  await page.setViewportSize(size);
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('05 phone: keyless setup, a live test model, confirmed only for an MCP call after the test started', async (t) => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const { page, seen } = await open(browser);

  // Cursor is the default; the setup reads ANONYMO_API_KEY and shows only the placeholder.
  assert.equal(await page.getByRole('combobox', { name: 'Coding tool' }).inputValue(), 'cursor');
  await page.getByText('Setup ready', { exact: true }).waitFor();
  const setup = page.getByRole('region', { name: 'Setup for Cursor' });
  assert.match(await setup.innerText(), /\$\{env:ANONYMO_API_KEY\}/);
  assert.match(await setup.innerText(), /export ANONYMO_API_KEY=anm_live_YOUR_KEY/);
  await page.getByRole('button', { name: 'Copy setup for my computer' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /http:\/\/127\.0\.0\.1:5999\/mcp/);
  assert.ok(!copied.includes(KEY));

  // The test model: anonymo-1 first; the council and the embedding model are not offered.
  const modelSelect = page.getByRole('combobox', { name: 'Test model' });
  assert.equal(await modelSelect.inputValue(), 'anonymo-1');
  assert.deepEqual(await modelSelect.locator('option').allTextContents(), ['anonymo-1', 'qwen/qwen3-32b']);
  await page.getByText('Use the anonymo chat tool with model "anonymo-1"', { exact: false }).waitFor();

  await page.getByRole('button', { name: 'Run test request' }).click();
  await page.getByText('› Awaiting test request').waitFor();
  const receipt = page.getByRole('textbox', { name: 'Receipt from Cursor' });
  await receipt.fill(`ready\n{"receipt_id":"${GOOD}","cost_usd":0.0000179}`);
  await page.getByRole('button', { name: 'Check receipt' }).click();
  await page.getByText('Confirmed from your coding tool').waitFor();
  await page.getByText('› Receipt confirmed').waitFor();
  const lookup = seen.find((r) => r.path === '/api/v1/generation');
  assert.equal(lookup.auth, `Bearer ${KEY}`);
  assert.ok(!lookup.url.includes(KEY));
  assert.ok(await noOverflow(page));
  await assertNoKey(page);
  if (shots) await tallShot(page, '05-connect-390-confirmed.png');

  // A call that did not come through MCP is unconfirmed, with the reason.
  await page.getByRole('button', { name: 'Start a new test' }).click();
  await receipt.fill(REST);
  await page.getByRole('button', { name: 'Check receipt' }).click();
  await page.getByText('Unconfirmed', { exact: true }).waitFor();
  await page.getByText(/did not come in through the MCP server/).waitFor();
  assert.equal(await page.getByText('Confirmed from your coding tool').count(), 0);

  // Another key's receipt (the owner lookup answers 404) is unconfirmed.
  await receipt.fill(OTHER);
  await page.getByRole('button', { name: 'Check receipt' }).click();
  await page.getByText(/cannot see that receipt/).waitFor();

  // Errors pasted from the tool lead to their recovery.
  const cases = [
    ['{"error":{"code":402,"type":"insufficient_credits"}}', 'Not enough credit', 'Add funds'],
    ['{"error":{"code":401,"type":"missing_key","message":"The chat tool needs an Anonymo API key."}}', 'Key missing', null],
    ['That model is not live yet (model_not_found)', 'Test model unavailable', 'Pick another model'],
    ['Failed to connect: ECONNREFUSED 127.0.0.1:5999', 'Setup not supported', null],
  ];
  for (const [paste, title, action] of cases) {
    await receipt.fill(paste);
    await page.getByRole('button', { name: 'Check receipt' }).click();
    const panel = page.getByRole('region', { name: title });
    await panel.waitFor();
    if (action) await panel.getByRole(action === 'Add funds' ? 'link' : 'button', { name: action }).waitFor();
    if (title === 'Key missing') await panel.getByText(/Set ANONYMO_API_KEY in your shell/).waitFor();
    if (shots && title === 'Not enough credit') {
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, '05-connect-390-recovery-funds.png') });
    }
    // A pasted error is answered where it was pasted, and focus moves to it.
    assert.ok(await panel.evaluate((el) => el.closest('output') === document.activeElement));
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await panel.waitFor({ state: 'detached' });
  }

  // Claude Code: single quotes keep ${ANONYMO_API_KEY} out of the shell.
  await page.getByRole('combobox', { name: 'Coding tool' }).selectOption('claude-code');
  const cc = await page.getByRole('region', { name: 'Setup for Claude Code' }).innerText();
  assert.ok(cc.includes("claude mcp add --transport http --scope project anonymo http://127.0.0.1:5999/mcp --header 'Authorization: Bearer ${ANONYMO_API_KEY}'"));
  await page.getByText('$ claude').waitFor();
  assert.ok(await noOverflow(page));
  await page.setViewportSize({ width: 320, height: 720 });
  assert.ok(await noOverflow(page), 'no sideways scroll at 320 px');
  await assertNoKey(page);
  assert.equal(seen.filter((r) => r.path === '/mcp').length, 0, 'the dashboard never calls /mcp');
});

test('05 recovery states from the dashboard: no key, no credit, no live model; desktop has no phone handoff', async (t) => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());

  const noKey = await open(browser, { key: null });
  const keyPanel = noKey.page.getByRole('region', { name: 'Key missing' });
  await keyPanel.getByRole('link', { name: 'Add your key' }).waitFor();
  assert.equal(await keyPanel.getByRole('link', { name: 'Add your key' }).getAttribute('href'), '/dashboard/key');
  if (shots) await tallShot(noKey.page, '05-connect-390-recovery-key.png');
  await noKey.context.close();

  const broke = await open(browser, { available: '0' });
  await broke.page.getByRole('region', { name: 'Not enough credit' }).getByRole('link', { name: 'Add funds' }).waitFor();
  await broke.context.close();

  const noModel = await open(browser, { models: [MODELS[0], MODELS[1]] });
  await noModel.page.getByRole('region', { name: 'Test model unavailable' }).waitFor();
  assert.equal(await noModel.page.getByRole('button', { name: 'Run test request' }).isDisabled(), true);
  if (shots) await tallShot(noModel.page, '05-connect-390-recovery-model.png');
  await noModel.context.close();

  const desk = await open(browser, { phone: false });
  assert.equal(await desk.page.getByRole('button', { name: 'Copy setup for my computer' }).count(), 0);
  await desk.page.getByRole('button', { name: 'Copy whole setup' }).waitFor();
  await desk.context.close();
});
