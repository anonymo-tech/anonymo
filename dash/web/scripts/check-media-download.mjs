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
