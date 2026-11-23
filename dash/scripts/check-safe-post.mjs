// Feature 06 "Make this safe to post": which recognised lines are suggested for hiding, and the PNG chunk check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWED_CHUNKS, classifyLine, pngChunks, suggestBoxes } from '../lib/anonymo/safe-post.ts';

void test('06 recognised lines with addresses, handles and emails are suggested; plain text is not', () => {
  assert.equal(classifyLine(`Sent to 0x${'ab'.repeat(20)}`), 'address');
  assert.equal(classifyLine('0xabab…abab'), 'address');
  assert.equal(classifyLine('bc1qabababababababababababababababababab'), 'address');
  assert.equal(classifyLine('From @sample_user'), 'handle');
  assert.equal(classifyLine('sample-user@example.com'), 'email');
  for (const plain of ['Payment received', '24.00 USDG', 'Total $53.00', 'Order 12345']) assert.equal(classifyLine(plain), null, plain);
});

void test('06 suggestions are padded, clamped and ordered QR first', () => {
  const boxes = suggestBoxes([{ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }], [{ text: 'hello', rect: { x: 0, y: 0, w: 0.1, h: 0.1 } }, { text: '@sample_user', rect: { x: 0.95, y: 0.95, w: 0.05, h: 0.05 } }]);
  assert.deepEqual(boxes.map((b) => b.kind), ['qr', 'handle']);
  for (const { rect } of boxes) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1 + 1e-9 && rect.y + rect.h <= 1 + 1e-9);
  assert.ok(boxes[0].rect.w > 0.2);
  assert.deepEqual(suggestBoxes(null, null), []);
});

void test('06 PNG chunk listing finds text chunks and rejects non-PNG bytes', () => {
  const chunk = (type, data = Buffer.alloc(0)) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('Comment\0x')), chunk('IDAT', Buffer.alloc(3)), chunk('IEND')]);
  assert.deepEqual(pngChunks(new Uint8Array(png)), ['IHDR', 'tEXt', 'IDAT', 'IEND']);
  assert.equal(ALLOWED_CHUNKS.has('tEXt'), false);
  assert.throws(() => pngChunks(new Uint8Array([1, 2, 3])), /Not a PNG/);
});
