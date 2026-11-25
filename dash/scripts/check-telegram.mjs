import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { handoffFromFragment, takeTelegramFragment, telegramEvent, telegramInitFromFragment, telegramWorkspaceUrl } from '../lib/anonymo/telegram.ts';
import { parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

test('Telegram is optional and demo exposes it', () => {
  assert.equal(parseUpdates(undefined).has('telegram'), false);
  assert.equal(parseUpdates('telegram').has('telegram'), true);
  assert.equal(updateOn('telegram', true), true);
});

test('launch and handoff fragments are parsed without keeping them in the address', () => {
  const token = 'a'.repeat(64);
  const launch = 'auth_date=123&user=%7B%22id%22%3A42%7D&hash=fixture';
  assert.equal(telegramInitFromFragment(`#tgWebAppData=${encodeURIComponent(launch)}&tgWebAppVersion=8.0`), launch);
  assert.equal(telegramInitFromFragment('#tgWebAppData=a&tgWebAppData=b'), null);
  assert.equal(handoffFromFragment(`#handoff=${token}`), token);
  assert.equal(handoffFromFragment(`?handoff=${token}`), null);
  assert.equal(handoffFromFragment(`#handoff=${token}&extra=1`), null);
  const writes = [];
  const hash = takeTelegramFragment({ hash: `#handoff=${token}`, pathname: '/telegram/handoff', search: '' },
    { state: { route: true }, replaceState: (...args) => writes.push(args) });
  assert.equal(handoffFromFragment(hash), token);
  assert.deepEqual(writes, [[{ route: true }, '', '/telegram/handoff']]);
});

test('opening the workspace only accepts the two same-origin destinations', () => {
  const origin = 'https://workspace.example';
  const handoff = `/telegram/handoff#handoff=${'a'.repeat(64)}`;
  assert.equal(telegramWorkspaceUrl(handoff, origin), origin + handoff);
  assert.equal(telegramWorkspaceUrl('/dashboard/chat', origin), origin + '/dashboard/chat');
  for (const target of ['https://elsewhere.example/dashboard/chat', '/dashboard/funds', '/dashboard/chat?checkout=1', '/telegram/handoff#invalid', 'javascript:alert(1)'])
    assert.equal(telegramWorkspaceUrl(target, origin), null);
  const messages = [];
  const host = { parent: { postMessage: (...args) => messages.push(args) } };
  assert.equal(telegramEvent(host, 'web_app_open_link', { url: origin + handoff }), true);
  assert.equal(messages[0][1], 'https://web.telegram.org');
  assert.deepEqual(JSON.parse(messages[0][0]), { eventType: 'web_app_open_link', eventData: { url: origin + handoff } });
});

test('handoff and Mini App authorization travel in POST bodies without the browser key', async () => {
  const sent = [];
  const client = createAnonymoClient({
    baseUrl: 'https://gateway.example', key: 'fixture-api-key', declaredRegion: 'NZ', // gitleaks:allow
    fetch: async (url, init) => { sent.push({ url, ...init }); return Response.json({ ok: true }); },
  });
  await client.telegramLinkCode();
  await client.telegramMini('signed-fields', 'chat', { adult: true, work: 'work-proof', text: 'A message' });
  await client.telegramHandoff('handoff-token');
  assert.equal(sent[0].headers.get('authorization'), 'Bearer fixture-api-key'); // gitleaks:allow
  for (const request of sent.slice(1)) {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(request.headers.get('x-anonymo-declared-region'), 'NZ');
    assert.equal(request.referrerPolicy, 'no-referrer');
    assert.equal(request.cache, 'no-store');
    assert.equal(new URL(request.url).search, '');
  }
  assert.deepEqual(JSON.parse(sent[1].body), { init_data: 'signed-fields', action: 'chat', adult: true, work: 'work-proof', text: 'A message' });
  assert.deepEqual(JSON.parse(sent[2].body), { token: 'handoff-token' });
});
