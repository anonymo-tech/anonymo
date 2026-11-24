import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { APP_SCOPE, APP_START, canRunAppWorker, isIosSafari } from '../lib/anonymo/phone-app.ts';
import { BUILT_WITH, parseUpdates, updateOn } from '../lib/anonymo/updates.ts';

const origin = 'https://dash.example';
const workerCode = readFileSync(new URL('../lib/anonymo/phone-app-worker.js', import.meta.url), 'utf8');
const offline = readFileSync(new URL('../lib/anonymo/phone-app-offline.html', import.meta.url), 'utf8');
const cacheName = 'anonymo-app-shell-build';

test('the phone app is opt-in even in demo and its start page is in scope', () => {
  assert.equal(parseUpdates(undefined).has('app'), false);
  assert.equal(parseUpdates('pricetag,photos').has('app'), false);
  assert.equal(parseUpdates('app,talk').has('app'), true);
  assert.equal(parseUpdates('all').has('app'), true);
  assert.equal(updateOn('app', true), BUILT_WITH.has('app'));
  assert.ok(APP_START.startsWith(APP_SCOPE));
});

test('manual install instructions are for Safari on iOS', () => {
  const safari = (device) => `Mozilla/5.0 (${device}) AppleWebKit/605.1.15 Version/26.0 Safari/604.1`;
  assert.equal(isIosSafari(safari('iPhone; CPU iPhone OS 26_0 like Mac OS X'), 5), true);
  assert.equal(isIosSafari(safari('Macintosh; Intel Mac OS X'), 5), true);
  assert.equal(isIosSafari(safari('Macintosh; Intel Mac OS X'), 0), false);
  assert.equal(isIosSafari('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140 Safari/604.1', 5), false);
  assert.equal(isIosSafari('Mozilla/5.0 (Android) Chrome/140 Mobile Safari/537.36', 5), false);
});

test('the worker stays off for a gateway hosted on the dashboard origin', () => {
  const page = origin + APP_START;
  assert.equal(canRunAppWorker('', page), true);
  assert.equal(canRunAppWorker('https://gateway.example', page), true);
  assert.equal(canRunAppWorker(origin + '/v1', page), false);
  assert.equal(canRunAppWorker('/api', page), false);
  assert.equal(canRunAppWorker('https://[', page), false);
});

function worker({ enabled = true, fetch = assert.fail } = {}) {
  const listeners = new Map();
  const entries = new Map();
  const names = new Set([cacheName, 'anonymo-app-shell-old', 'unrelated-cache']);
  const lifecycle = [];
  runInNewContext(workerCode, {
    app: { enabled, version: 'build', start: APP_START, offline },
    URL, Response, fetch,
    self: {
      location: { origin },
      addEventListener: (event, handler) => listeners.set(event, handler),
      skipWaiting: async () => { lifecycle.push('skip waiting'); },
      clients: { claim: async () => { lifecycle.push('claim'); } },
      registration: { unregister: async () => { lifecycle.push('unregister'); } },
    },
    caches: {
      keys: async () => [...names],
      delete: async (name) => names.delete(name),
      open: async (name) => {
        assert.equal(name, cacheName);
        return {
          match: async (request) => entries.get(request.url)?.clone(),
          put: async (request, response) => entries.set(request.url, response),
        };
      },
    },
  });
  return {
    entries, names, lifecycle,
    dispatch: async (kind, options = {}) => {
      const deferred = [];
      let response = Promise.resolve(undefined);
      listeners.get(kind)?.({
        waitUntil: (promise) => deferred.push(promise),
        respondWith: (promise) => { response = Promise.resolve(promise); },
        request: { url: origin + APP_START, method: 'GET', mode: 'cors', destination: '', headers: new Headers(), ...options },
      });
      const result = await response;
      await Promise.all(deferred);
      return result;
    },
  };
}

test('worker deployment replaces its own caches and switching off retires the worker', async () => {
  const active = worker();
  await active.dispatch('install');
  await active.dispatch('activate');
  assert.deepEqual([...active.names], [cacheName, 'unrelated-cache']);
  assert.deepEqual(active.lifecycle, ['skip waiting', 'claim']);

  const disabled = worker({ enabled: false });
  await disabled.dispatch('install');
  await disabled.dispatch('activate');
  assert.deepEqual([...disabled.names], ['unrelated-cache']);
  assert.deepEqual(disabled.lifecycle, ['skip waiting', 'unregister']);
  assert.equal(await disabled.dispatch('fetch', { mode: 'navigate' }), undefined);
});

test('API, RSC, receipts, chat mutations and cross-origin requests pass through', async () => {
  const { dispatch, entries } = worker();
  const script = origin + '/_next/static/chunks/shell-abCD1234.js';
  for (const request of [
    { method: 'POST', mode: 'navigate' },
    { method: 'POST', url: script, destination: 'script' },
    { url: 'https://gateway.example/_next/static/chunks/shell-abCD1234.js', destination: 'script' },
    { url: origin + '/api/chat' },
    { url: origin + '/dashboard/receipts/example', mode: 'navigate' },
    { url: origin + APP_START + '?_rsc=example' },
    { url: origin + APP_START, destination: 'script' },
    { url: script },
    { url: script + '?sample=1', destination: 'script' },
    { url: script, destination: 'script', headers: new Headers({ Authorization: 'Bearer sample-key' }) },
    { url: script, destination: 'script', headers: new Headers({ Range: 'bytes=0-1' }) },
  ]) {
    assert.equal(await dispatch('fetch', request), undefined);
  }
  assert.equal(entries.size, 0);
});

test('only successful anonymous scripts, styles and fonts are cached', async () => {
  let calls = 0;
  const assets = [
    ['script', '/_next/static/chunks/app-entry-abCD1234.js', 'text/javascript'],
    ['style', '/_next/static/css/index.abCD1234.css', 'text/css'],
    ['font', '/_next/static/media/space-grotesk.abCD1234.woff2', 'font/woff2'],
  ];
  const { dispatch, entries } = worker({ fetch: async ({ destination }, options) => {
    calls++;
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response('static', { headers: { 'Content-Type': assets.find(([type]) => type === destination)[2] } });
  } });
  for (const [destination, path] of assets) {
    for (let n = 0; n < 2; n++) {
      const response = await dispatch('fetch', { url: origin + path, destination });
      assert.equal(await response.text(), 'static');
    }
  }
  assert.equal(calls, 3);
  assert.equal(entries.size, 3);

  for (const init of [
    { status: 404, headers: { 'Content-Type': 'text/javascript' } },
    { headers: { 'Content-Type': 'text/html' } },
    { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'private, no-store' } },
  ]) {
    const { dispatch, entries } = worker({ fetch: async () => new Response('sample', init) });
    await dispatch('fetch', { url: origin + assets[0][1], destination: 'script' });
    assert.equal(entries.size, 0);
  }
});

test('chat loads fresh online and shows the static retry screen on network failure', async () => {
  let online = true;
  const { dispatch, entries } = worker({ fetch: async (request, options) => {
    assert.equal(request.url, origin + APP_START);
    assert.equal(options.cache, 'no-store');
    if (!online) throw new TypeError('Offline');
    return new Response('Fresh workspace');
  } });
  assert.equal(await (await dispatch('fetch', { mode: 'navigate' })).text(), 'Fresh workspace');
  online = false;
  const response = await dispatch('fetch', { mode: 'navigate' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(await response.text(), /You’re offline[\s\S]*href="\/dashboard\/chat">Try again/);
  assert.equal(entries.size, 0);
});
