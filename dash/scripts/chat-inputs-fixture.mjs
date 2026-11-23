// Shared fixture for check-chat-inputs-browser.mjs: a phone page whose gateway is answered in the test.
import assert from 'node:assert/strict';

export const origin = new URL(process.env.CHAT_INPUTS_TEST_URL ?? 'http://localhost:5235');
const GATEWAY = process.env.CHAT_INPUTS_GATEWAY_URL ?? 'http://127.0.0.1:5998';
const architecture = { input_modalities: ['text'], output_modalities: ['text'] };
const visionArchitecture = { input_modalities: ['text', 'image'], output_modalities: ['text'] };
export const MODELS = [
  { id: 'anonymo-1' },
  { id: 'demo/text-only', name: 'Text model', architecture },
  { id: 'demo/vision', name: 'Vision model', architecture: visionArchitecture },
];

/** A phone page whose gateway is a fixture. `reply(body, n)` returns the reply text or `{ status, error }`. */
export async function phone(browser, { reply = (_, n) => `Fixture reply ${n}.`, blockGuard = false, width = 390, model = null, init = null } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  page.setDefaultTimeout(30000);
  await page.addInitScript(({ blockGuard, model }) => {
    sessionStorage.setItem('anonymo.key', 'anm_test_local_fixture_abcdefgh');
    localStorage.setItem('anonymo.adult.v1', 'true');
    if (model) localStorage.setItem('anonymo.model.v1', JSON.stringify(model));
    // The content check's worker cannot start: the composer must fail closed.
    if (blockGuard) {
      const Real = window.Worker;
      window.Worker = function (url, options) {
        if (String(url).includes('content-guard')) throw new Error('Worker blocked by the test');
        return new Real(url, options);
      };
    }
  }, { blockGuard, model });
  const sent = [];
  const chats = [];
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin.origin) return route.continue();
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.origin !== GATEWAY) return route.abort();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type,x-anonymo-refusal-catch,x-anonymo-sealed', 'cache-control': 'no-store' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    sent.push({ path: url.pathname, query: url.search, body: req.postData() ?? '' });
    const json = (data, status = 200) => route.fulfill({ status, headers, json: data });
    if (url.pathname === '/v1/models') return json({ data: MODELS });
    if (url.pathname === '/balance') return json({ available_usd: '5.00', held_usd: '0', withdraw_to: [] });
    if (url.pathname === '/v1/chat/completions') {
      const body = req.postDataJSON();
      chats.push(body);
      const out = reply(body, chats.length);
      if (typeof out === 'object') return json({ error: out.error }, out.status);
      const id = `gen-1795000000-inputs${chats.length}`;
      const receipt = { request_id: id, model: body.model, model_id: body.model, routes: [], weights_hash: [], tokens: { in: 4, out: 3 }, cost: '0.001', refused: false, sealed: false, ts: '2026-01-01T00:00:00Z' };
      // Stream the reply in small pieces so citation parsing sees partial markers.
      const pieces = out.match(/[\s\S]{1,7}/g) ?? [''];
      const events = pieces.map((p, i) => `data: ${JSON.stringify({ id, choices: [{ delta: { content: p } }], ...(i === pieces.length - 1 ? { anonymo_receipt: { payload: receipt } } : {}) })}\n\n`).join('');
      return route.fulfill({ headers, contentType: 'text/event-stream', body: `${events}data: [DONE]\n\n` });
    }
    return json({ data: [] });
  });
  return { page, context, sent, chats };
}

/** Fails if any gateway request so far carried any of `sentinels`. */
export function assertNeverSent(sent, sentinels) {
  for (const request of sent)
    for (const s of sentinels) assert.ok(!request.body.includes(s) && !request.query.includes(s), `${s} reached the gateway in ${request.path}`);
}

/** Clicks (taps) a point given in source coordinates (0–1) on the editor's drawing surface. */
export async function tapAt(page, x, y) {
  await page.locator('.editor-stage').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const box = await page.locator('.editor-stage').boundingBox();
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

/** Drags across the editor's drawing surface between two source-space points. */
export async function dragOn(page, from, to) {
  await page.locator('.editor-stage').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const box = await page.locator('.editor-stage').boundingBox();
  const at = (p) => [box.x + box.width * p.x, box.y + box.height * p.y];
  await page.mouse.move(...at(from));
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(...at({ x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6 }));
  await page.mouse.up();
}
