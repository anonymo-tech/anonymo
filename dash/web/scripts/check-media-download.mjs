import assert from 'node:assert/strict';
import test from 'node:test';
import {
  downloadGatewayMedia,
  MEDIA_DOWNLOAD_LIMITS,
  MediaDownloadError,
} from '../server/media/download.ts';

const url =
  'https://api.inference.invalid/v1/media/gen_synthetic/0?sig=synthetic-signature&exp=1';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlGkAAAAASUVORK5CYII=',
  'base64',
);
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
const webp = new Uint8Array(22);
webp.set(Buffer.from('RIFF'), 0);
new DataView(webp.buffer).setUint32(4, webp.length - 8, true);
webp.set(Buffer.from('WEBPVP8L'), 8);
const mp4 = new Uint8Array(20);
new DataView(mp4.buffer).setUint32(0, 20);
mp4.set(Buffer.from('ftypisom'), 4);
mp4.set(Buffer.from('mp42'), 16);
const media = (contentType = 'image/png', address = url) => ({
  url: address,
  contentType,
});
const respond = (bytes = png, contentType = 'image/png', headers = {}) =>
  new Response(bytes, { headers: { 'content-type': contentType, ...headers } });
const code = (expected) => (error) => {
  assert.ok(error instanceof MediaDownloadError);
  assert.equal(error.code, expected);
  assert.ok(!JSON.stringify(error).includes('synthetic-signature'));
  assert.ok(!error.message.includes('https://'));
  assert.equal(error.cause, undefined);
  return true;
};

void test('anonymous fixed-origin GET preserves acquired bytes and does not imply sanitization', async () => {
  let observed;
  const result = await downloadGatewayMedia(media(), {
    fetch: async (address, init) => {
      observed = { address, init };
      return respond(png, 'image/png', {
        'content-length': String(png.length),
      });
    },
  });
  assert.deepEqual(result, {
    bytes: new Uint8Array(png),
    contentType: 'image/png',
  });
  assert.equal(observed.address, url);
  assert.equal(observed.init.method, 'GET');
  assert.equal(observed.init.credentials, 'omit');
  assert.equal(observed.init.redirect, 'error');
  assert.equal(observed.init.referrer, '');
  assert.equal(observed.init.referrerPolicy, 'no-referrer');
  assert.equal(observed.init.cache, 'no-store');
  assert.deepEqual(observed.init.headers, {
    Accept: 'image/png',
    'Accept-Encoding': 'identity',
  });
  assert.equal(observed.init.signal.aborted, true);
});

void test('all four declared formats require their own binary signature', async () => {
  for (const [type, bytes] of [
    ['image/png', png],
    ['image/jpeg', jpeg],
    ['image/webp', webp],
    ['video/mp4', mp4],
  ]) {
    assert.equal(
      (
        await downloadGatewayMedia(media(type), {
          fetch: async () => respond(bytes, type),
        })
      ).contentType,
      type,
    );
    await assert.rejects(
      downloadGatewayMedia(media(type), {
        fetch: async () => respond(Buffer.from('<html>not media</html>'), type),
      }),
      code('invalid_response'),
    );
  }
  await assert.rejects(
    downloadGatewayMedia(media('image/png'), {
      fetch: async () => respond(jpeg, 'image/png'),
    }),
    code('invalid_response'),
  );
});

void test('arbitrary origins, parser-normalized addresses and ambiguous signed queries never fetch', async () => {
  let calls = 0;
  for (const address of [
    url.replace('https:', 'http:'),
    url.replace('api.inference.invalid', 'api.inference.invalid.attacker.invalid'),
    url.replace('api.inference.invalid', '127.0.0.1'),
    url.replace('api.inference.invalid', '[::1]'),
    url.replace('api.inference.invalid', 'api.inference.invalid:443'),
    url.replace('api.inference.invalid', 'API.INFERENCE.INVALID'),
    url.replace('api.inference.invalid', 'user@api.inference.invalid'),
    url.replace('api.inference.invalid', 'api.inference.invalid.'),
    url.replace('/gen_', '/%67en_'),
    url.replace('/gen_', '/x/../gen_'),
    url.replace('/gen_', '\\gen_'),
    url.replace('/0?', '/00?'),
    `${url}#fragment`,
    ` ${url}`,
    `${url}\n`,
    url.replace('?sig=', '?%73ig='),
    `${url}&sig=second`,
    `${url}&url=http%3A%2F%2F127.0.0.1`,
    url.replace('&exp=1', '&exp=01'),
    url.replace('&exp=1', ''),
    url.replace('synthetic-signature', ''),
    url.replace('synthetic-signature', 'bad+space'),
    url.replace('synthetic-signature', 's'.repeat(1025)),
  ]) {
    await assert.rejects(
      downloadGatewayMedia(media('image/png', address), {
        fetch: async () => {
          calls++;
          return respond();
        },
      }),
      code('invalid_url'),
    );
  }
  assert.equal(calls, 0);
});

void test('canonical encoded signature and either signed-field order are accepted, expired exp is left to GATEWAY', async () => {
  for (const query of ['sig=abc%2Bdef%2Fghi%3D&exp=0', 'exp=1&sig=synthetic']) {
    const result = await downloadGatewayMedia(
      media('image/png', `${url.split('?')[0]}?${query}`),
      { fetch: async () => respond() },
    );
    assert.deepEqual(result.bytes, new Uint8Array(png));
  }
});

void test('redirect, changed final URL, partial content and error responses fail without leaking provider details', async () => {
  for (const response of [
    new Response('signed secret', {
      status: 302,
      headers: { location: 'http://127.0.0.1/' },
    }),
    new Response('private', { status: 403 }),
    new Response(png, { status: 206 }),
  ])
    await assert.rejects(
      downloadGatewayMedia(media(), { fetch: async () => response }),
      code('unavailable_media'),
    );
  for (const property of [
    { redirected: true },
    { url: 'https://other.invalid/private' },
  ]) {
    const response = respond();
    for (const [name, value] of Object.entries(property))
      Object.defineProperty(response, name, { value });
    await assert.rejects(
      downloadGatewayMedia(media(), { fetch: async () => response }),
      code('unavailable_media'),
    );
  }
  await assert.rejects(
    downloadGatewayMedia(media(), {
      fetch: async () => {
        throw new Error(url);
      },
    }),
    code('unavailable_media'),
  );
});

void test('strict MIME and transfer headers reject missing or misleading media types and compressed bodies', async () => {
  for (const type of [
    'application/octet-stream',
    'image/jpeg',
    'image/png; charset=utf-8',
  ])
    await assert.rejects(
      downloadGatewayMedia(media(), { fetch: async () => respond(png, type) }),
      code('invalid_response'),
    );
  await assert.rejects(
    downloadGatewayMedia(media(), { fetch: async () => new Response(png) }),
    code('invalid_response'),
  );
  await assert.rejects(
    downloadGatewayMedia(media(), {
      fetch: async () =>
        respond(png, 'image/png', { 'content-encoding': 'gzip' }),
    }),
    code('invalid_response'),
  );
});

void test('declared lengths are canonical, bounded and must match the actual bytes', async () => {
  for (const value of [
    '-1',
    '1.5',
    '1e2',
    ' 2',
    '00',
    String(png.length + 1),
    '0',
  ])
    await assert.rejects(
      downloadGatewayMedia(media(), {
        fetch: async () =>
          respond(png, 'image/png', { 'content-length': value }),
      }),
      code('invalid_response'),
    );
  for (const type of ['image/png', 'video/mp4']) {
    const maximum =
      type === 'video/mp4'
        ? MEDIA_DOWNLOAD_LIMITS.videoBytes
        : MEDIA_DOWNLOAD_LIMITS.imageBytes;
    await assert.rejects(
      downloadGatewayMedia(media(type), {
        fetch: async () =>
          respond(png, type, { 'content-length': String(maximum + 1) }),
      }),
      code('too_large'),
    );
  }
});

void test('actual stream bounds apply with absent content-length and cancel an overlong response', async () => {
  for (const type of ['image/png', 'video/mp4']) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      downloadGatewayMedia(media(type), {
        fetch: async () =>
          new Response(stream, { headers: { 'content-type': type } }),
      }),
      code('too_large'),
    );
    assert.equal(cancelled, true);
  }
});

void test('deadline bounds both a stalled fetch and a stalled body even if the mock ignores abort', async () => {
  await assert.rejects(
    downloadGatewayMedia(media(), {
      timeoutMs: 10,
      fetch: async () => new Promise(() => {}),
    }),
    code('timeout'),
  );
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(png);
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    downloadGatewayMedia(media(), {
      timeoutMs: 10,
      fetch: async () =>
        new Response(stream, { headers: { 'content-type': 'image/png' } }),
    }),
    code('timeout'),
  );
  assert.equal(cancelled, true);
});

void test('late fetch completion after timeout cancels its body without publishing it', async () => {
  let finish;
  const promise = downloadGatewayMedia(media(), {
    timeoutMs: 10,
    fetch: async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await assert.rejects(promise, code('timeout'));
  let cancelled = false;
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'image/png' } },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

void test('caller cancellation prevents initial dispatch and interrupts a pending body', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    downloadGatewayMedia(media(), {
      signal: before.signal,
      fetch: async () => {
        throw new Error('must not fetch');
      },
    }),
    code('cancelled'),
  );
  const during = new AbortController();
  let cancelled = false;
  const pending = downloadGatewayMedia(media(), {
    signal: during.signal,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(png);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      ),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  during.abort();
  await assert.rejects(pending, code('cancelled'));
  assert.equal(cancelled, true);
});

void test('unsupported MIME, excessive deadlines and browser execution never dispatch', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return respond();
  };
  await assert.rejects(
    downloadGatewayMedia(media('image/svg+xml'), { fetch }),
    code('invalid_request'),
  );
  for (const timeoutMs of [
    0,
    -1,
    NaN,
    1.5,
    MEDIA_DOWNLOAD_LIMITS.timeoutMs + 1,
  ])
    await assert.rejects(
      downloadGatewayMedia(media(), { fetch, timeoutMs }),
      code('invalid_request'),
    );
  globalThis.window = {};
  try {
    await assert.rejects(
      downloadGatewayMedia(media(), { fetch }),
      code('unavailable'),
    );
  } finally {
    delete globalThis.window;
  }
  assert.equal(calls, 0);
});

void test('truncated headers, misleading MP4 brand and inconsistent RIFF lengths reject safely', async () => {
  const quicktime = mp4.slice();
  quicktime.set(Buffer.from('qt  '), 8);
  await assert.rejects(
    downloadGatewayMedia(media('video/mp4'), {
      fetch: async () => respond(quicktime, 'video/mp4'),
    }),
    code('invalid_response'),
  );
  const wrongRiff = webp.slice();
  new DataView(wrongRiff.buffer).setUint32(4, 0, true);
  await assert.rejects(
    downloadGatewayMedia(media('image/webp'), {
      fetch: async () => respond(wrongRiff, 'image/webp'),
    }),
    code('invalid_response'),
  );
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'])
    await assert.rejects(
      downloadGatewayMedia(media(type), {
        fetch: async () => respond(new Uint8Array(3), type),
      }),
      code('invalid_response'),
    );
});
