// Update "photos": attach photos in chat (lib/anonymo/photos.ts, components/dashboard/chat-photos.tsx). Every image
// here is a few synthetic bytes made in the test; no real photo is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { toMarkdown, toSaved } from '../lib/anonymo/history.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { DEMO_MODELS } from '../lib/anonymo/mock/fixtures.ts';
import {
  JPEG_QUALITY,
  MAX_EDGE,
  MAX_PHOTOS,
  PhotoError,
  attachPhotos,
  fitWithin,
  imageFiles,
  photoHint,
  photoModels,
  photoSupport,
  preparePhoto,
  readPhotoParts,
  withPhotoNote,
} from '../lib/anonymo/photos.ts';
import { parseUpdates, RELEASED, UPDATE_IDS, updateOn } from '../lib/anonymo/updates.ts';

// ---- Synthetic images -------------------------------------------------------------------------------------------------
// A JPEG-shaped byte string with an EXIF block that names GPS, and the stand-in for what the canvas encodes.
const exifJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, ...Buffer.from('Exif\0\0GPSLat52N'), 0xff, 0xd9]);
const encodedJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x01, 0x02, 0xff, 0xd9]);
const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo=';

/** Canvas doubles that record what was drawn and how it was encoded. */
function fakeDeps({ width = 4000, height = 3000, out = encodedJpeg, failDecode = false } = {}) {
  const log = { decoded: null, canvas: null, ops: [], quality: null, closed: false };
  return {
    log,
    deps: {
      async decode(file) {
        if (failDecode) throw new Error('not an image');
        log.decoded = file;
        return { width, height, close: () => (log.closed = true) };
      },
      canvas(w, h) {
        log.canvas = { w, h };
        return {
          getContext: () => ({
            set fillStyle(v) { log.ops.push(['fillStyle', v]); },
            fillRect: (...a) => log.ops.push(['fillRect', ...a]),
            drawImage: (_img, ...a) => log.ops.push(['drawImage', ...a]),
          }),
        };
      },
      async toJpeg(_canvas, quality) {
        log.quality = quality;
        return new Blob([out], { type: 'image/jpeg' });
      },
    },
  };
}

// ---- Resize and re-encode --------------------------------------------------------------------------------------------

test('the long side is shrunk to 1568 px, the aspect is kept and small images are never enlarged', () => {
  assert.equal(MAX_EDGE, 1568);
  assert.deepEqual(fitWithin(4000, 3000), { width: 1568, height: 1176 });
  assert.deepEqual(fitWithin(3000, 4000), { width: 1176, height: 1568 });
  assert.deepEqual(fitWithin(1568, 900), { width: 1568, height: 900 });
  assert.deepEqual(fitWithin(640, 480), { width: 640, height: 480 });
  assert.deepEqual(fitWithin(20000, 2), { width: 1568, height: 1 });
  assert.throws(() => fitWithin(0, 10), PhotoError);
});

test('a photo is drawn on white at the fitted size and re-encoded as JPEG at 0.85; the original bytes and their EXIF are gone', async () => {
  const { deps, log } = fakeDeps();
  const file = new Blob([exifJpeg], { type: 'image/jpeg' });
  const photo = await preparePhoto(file, deps);
  assert.equal(log.decoded, file);
  assert.deepEqual(log.canvas, { w: 1568, h: 1176 });
  assert.deepEqual(log.ops, [['fillStyle', '#ffffff'], ['fillRect', 0, 0, 1568, 1176], ['drawImage', 0, 0, 1568, 1176]]);
  assert.equal(log.quality, JPEG_QUALITY);
  assert.equal(JPEG_QUALITY, 0.85);
  assert.equal(log.closed, true);
  assert.ok(photo.dataUrl.startsWith('data:image/jpeg;base64,'));
  const sent = Buffer.from(photo.dataUrl.split(',')[1], 'base64');
  assert.deepEqual(new Uint8Array(sent), encodedJpeg);
  assert.equal(sent.includes(Buffer.from('Exif')), false);
  assert.equal(sent.includes(Buffer.from('GPS')), false);
  assert.deepEqual([photo.width, photo.height, photo.bytes], [1568, 1176, encodedJpeg.length]);
});

test('PNG, WebP and GIF are accepted; other types, huge files, undecodable files and oversized output are refused', async () => {
  for (const type of ['image/png', 'image/webp', 'image/gif']) assert.ok((await preparePhoto(new Blob([exifJpeg], { type }), fakeDeps().deps)).dataUrl);
  await assert.rejects(preparePhoto(new Blob(['<svg/>'], { type: 'image/svg+xml' }), fakeDeps().deps), /JPEG, PNG, WebP or GIF/);
  await assert.rejects(preparePhoto(new Blob(['x'], { type: 'application/pdf' }), fakeDeps().deps), PhotoError);
  const huge = { type: 'image/jpeg', size: 41 * 1024 * 1024 };
  await assert.rejects(preparePhoto(huge, fakeDeps().deps), /under 40 MB/);
  await assert.rejects(preparePhoto(new Blob([exifJpeg], { type: 'image/jpeg' }), fakeDeps({ failDecode: true }).deps), /could not be opened/);
  const big = fakeDeps({ out: new Uint8Array(5 * 1024 * 1024 + 1) });
  await assert.rejects(preparePhoto(new Blob([exifJpeg], { type: 'image/jpeg' }), big.deps), /over 5 MB/);
  assert.equal(big.log.closed, true);
});

test('only image files are taken from a drop or a paste', () => {
  const files = [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.txt', { type: 'text/plain' }), new File(['c'], 'c.jpg', { type: 'image/jpeg' })];
  assert.deepEqual(imageFiles(files).map((f) => f.name), ['a.png', 'c.jpg']);
  assert.deepEqual(imageFiles(null), []);
});

// ---- Model gating -----------------------------------------------------------------------------------------------------

const textModel = { id: 'text-only/model', name: 'Text Model', architecture: { input_modalities: ['text'], output_modalities: ['text'] } };
const vision = (n) => ({ id: `vision/model-${n}`, name: `Vision ${n}`, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } });
const models = [textModel, vision(1), vision(2), vision(3), vision(4)];

test('only a direct model that lists image input can take photos; the others say which models can', () => {
  assert.deepEqual(photoSupport('vision/model-1', models), { ok: true });
  const text = photoSupport('text-only/model', models);
  assert.equal(text.ok, false);
  assert.equal(photoHint(text), 'Text Model reads text only. Photos work with Vision 1, Vision 2, Vision 3 and 1 more.');
  assert.match(photoHint(photoSupport('anonymo-1', models)), /^anonymo-1 reads text only\. Photos work with Vision 1/);
  assert.match(photoHint(photoSupport('anonymo-sealed', models)), /^Sealed chats cannot take photos yet\./);
  assert.equal(photoSupport('missing/model', models).ok, false);
  assert.equal(photoHint(photoSupport('text-only/model', [textModel])), 'Text Model reads text only. No model here takes photos right now.');
  assert.equal(photoHint({ ok: true }), '');
  assert.deepEqual(photoModels(models).map((m) => m.id), ['vision/model-1', 'vision/model-2', 'vision/model-3', 'vision/model-4']);
});

test('the demo lists models that take photos, so the update can be tried without a key', () => {
  const able = photoModels(DEMO_MODELS).map((m) => m.id);
  assert.ok(able.length >= 1);
  assert.ok(!able.some((id) => id.startsWith('anonymo-')));
});

// ---- The request ------------------------------------------------------------------------------------------------------

test('photos go with the last user message only, as image_url parts after the text', () => {
  const messages = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Sure.' }, { role: 'user', content: 'What is this?' }];
  const out = attachPhotos(messages, [pngDataUrl, pngDataUrl]);
  assert.deepEqual(out.slice(0, 3), messages.slice(0, 3));
  assert.deepEqual(out[3], { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: pngDataUrl } }, { type: 'image_url', image_url: { url: pngDataUrl } }] });
  assert.deepEqual(attachPhotos([{ role: 'user', content: '' }], [pngDataUrl])[0].content, [{ type: 'image_url', image_url: { url: pngDataUrl } }]);
  assert.deepEqual(attachPhotos(messages, []), messages);
  assert.equal(messages[3].content, 'What is this?'); // the input is not changed
  assert.throws(() => attachPhotos(messages, Array(MAX_PHOTOS + 1).fill(pngDataUrl)), /at most 4/);
  assert.throws(() => attachPhotos([{ role: 'system', content: 'x' }], [pngDataUrl]), PhotoError);
});

test('an earlier turn says its photos are not sent again', () => {
  assert.equal(withPhotoNote('Look', 0), 'Look');
  assert.equal(withPhotoNote('Look', 1), 'Look\n\n[A photo was shared here and not sent again.]');
  assert.equal(withPhotoNote('', 2), '[2 photos were shared here and not sent again.]');
});

test('the request rules match the gateway: data URLs only, four at most, four types, 5 MB each', () => {
  const ask = (...urls) => [{ role: 'user', content: [{ type: 'text', text: 'hi' }, ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))] }];
  const ok = readPhotoParts(ask(pngDataUrl, pngDataUrl));
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  assert.deepEqual(ok.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(readPhotoParts(ask('https://images.example/cat.jpg')).type, 'remote_image_unsupported');
  assert.equal(readPhotoParts(ask(...Array(5).fill(pngDataUrl))).type, 'too_many_images');
  assert.equal(readPhotoParts(ask('data:image/svg+xml;base64,PHN2Zy8+')).status, 415);
  assert.equal(readPhotoParts(ask('data:image/png,raw')).type, 'invalid_image');
  assert.equal(readPhotoParts(ask(`data:image/jpeg;base64,${'A'.repeat(7_000_000)}`)).status, 413);
});

// ---- Demo gateway -----------------------------------------------------------------------------------------------------

test('demo mode: a chat with a photo is answered, and a link is refused', async () => {
  const state = new Map();
  const mock = createMockGateway({ delayMs: 0, storage: { getItem: state.get.bind(state), setItem: state.set.bind(state) } });
  const baseUrl = 'https://demo.anonymo.invalid';
  const { key } = await createAnonymoClient({ baseUrl, fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl, fetch: mock.fetch, key });
  await mock.simulateDeposit(key, 'rhc', 'USDG', 2_000_000);
  const model = photoModels(DEMO_MODELS)[0].id;
  const answer = await client.chat({ model, messages: attachPhotos([{ role: 'user', content: 'What colour is this?' }], [pngDataUrl]) });
  assert.match(answer.content, /one photo received and checked/);
  await assert.rejects(client.chat({ model, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://images.example/a.png' } }] }] }), /does not fetch images/);
  assert.ok(![...state.values()].some((v) => String(v).includes('iVBORw0KGgo')), 'the demo keeps no photo bytes');
});

// ---- Saved chats ------------------------------------------------------------------------------------------------------

test('saved chats keep how many photos there were, never the photos', () => {
  const turn = { id: 't1', model: 'vision/model-1', prompt: 'What is this?', attachment: null, character: null, content: 'A square.', status: 'done', error: null, receiptId: null, councilMode: null, photos: [pngDataUrl, pngDataUrl], photoCount: 2 };
  const [saved] = toSaved([turn]);
  assert.equal(saved.photoCount, 2);
  assert.equal('photos' in saved, false);
  assert.equal(JSON.stringify(saved).includes('base64'), false);
  assert.equal('photoCount' in toSaved([{ ...turn, photos: undefined, photoCount: undefined }])[0], false);
  const md = toMarkdown({ id: 'c', title: 'x', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', model: turn.model, turns: [saved] });
  assert.match(md, /_2 photos went with this message \(not saved\)\._/);
});

// ---- The update switch and the composer -------------------------------------------------------------------------------

test('"photos" is an optional update: off by default, on with the switch or "all", shown in demo mode', () => {
  assert.ok(UPDATE_IDS.includes('photos'));
  assert.equal(RELEASED.has('photos'), false);
  assert.ok(parseUpdates('photos').has('photos'));
  assert.ok(parseUpdates('all').has('photos'));
  assert.equal(parseUpdates('history').has('photos'), false);
  assert.equal(updateOn('photos', true), true);
  if (!process.env.NEXT_PUBLIC_ANONYMO_UPDATES) assert.equal(updateOn('photos', false), false);
  const updates = readFileSync(new URL('../lib/anonymo/updates.ts', import.meta.url), 'utf8');
  assert.match(updates, /^\/\/ {3}photos {4}/m);
});

test('the composer gates photos on the update and the model, takes paste and drop, and says photos are not saved', () => {
  const workspace = readFileSync(new URL('../components/dashboard/chat-workspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /updateOn\('photos', demo\)/);
  assert.match(workspace, /photoSupport\(model, directModels\)/);
  assert.match(workspace, /onPaste=/);
  assert.match(workspace, /onDrop=/);
  assert.match(workspace, /withPhotoNote\(t\.prompt, t\.photoCount\)/);
  const tray = readFileSync(new URL('../components/dashboard/chat-photos.tsx', import.meta.url), 'utf8');
  assert.match(tray, /PHOTO_NOTE/);
  assert.match(tray, /Photo not saved/);
  const lib = readFileSync(new URL('../lib/anonymo/photos.ts', import.meta.url), 'utf8');
  assert.match(lib, /imageOrientation: 'from-image'/);
  for (const word of ['unfiltered', 'no rules', 'anything goes', 'yield', 'invest', 'profit', 'APY', 'moon'])
    for (const [name, text] of [['chat-photos.tsx', tray], ['photos.ts', lib]]) assert.equal(text.toLowerCase().includes(word.toLowerCase()), false, `${name} says "${word}"`);
});
