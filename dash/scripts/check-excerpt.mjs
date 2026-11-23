// Features 02 "Circle anything" and 03 "Send only this part": PDF text positions, selection geometry, the text inside
// a selection on a two-column page, tap-a-line, nearby lines, rotated pages, empty selections and the excerpt payload.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pageLayout } from '../lib/pdf-layout.ts';
import { adjacentLine, clampRect, growRect, itemsIn, lineAt, moveRect, nearbyText, rectFromPoints, resizeRect, textInRegion, toPixels, toSource } from '../lib/anonymo/region.ts';
import { excerptContent, excerptMessage } from '../lib/anonymo/excerpt.ts';
import { makePdf, twoColumnPage } from './pdf-fixture.mjs';

async function layouts(bytes) {
  const task = getDocument({ data: bytes, useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const legacy = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('').trim();
    out.push({ ...pageLayout(content.items, page.getViewport({ scale: 1 })), legacy });
  }
  await task.destroy();
  return out;
}

const LEFT = ['Billing and fees', 'Usage is calculated monthly.', 'A $12 service fee applies', 'each billing cycle.', 'Taxes are itemized.'];
const RIGHT = ['RIGHT-SENTINEL account', 'reference DEMO-1048', 'Billing contact', 'Sample office', 'Payment is due in 21 days.'];

void test('02/03 page text is unchanged and every item keeps its range and a box inside the page', async () => {
  const [page] = await layouts(makePdf([twoColumnPage(LEFT, RIGHT)]));
  assert.equal(page.text, page.legacy);
  assert.equal(page.layout.items.length, 10);
  for (const item of page.layout.items) {
    assert.equal(page.text.slice(item.start, item.end), item.text);
    for (const v of [item.x, item.y, item.x + item.w, item.y + item.h]) assert.ok(v >= 0 && v <= 1, `${item.text} box ${v}`);
  }
  const fee = page.layout.items.find((i) => i.text === 'A $12 service fee applies');
  assert.ok(fee.x < 0.1 && fee.y > 0.1 && fee.y < 0.15, JSON.stringify(fee));
});

void test('02/03 a selection on a two-column page takes only its own column, in reading order', async () => {
  const [page] = await layouts(makePdf([twoColumnPage(LEFT, RIGHT)]));
  const leftColumn = { x: 0.05, y: 0.05, w: 0.4, h: 0.15 };
  const text = textInRegion(page.text, page.layout, leftColumn);
  assert.equal(text, LEFT.join('\n'));
  assert.ok(!text.includes('RIGHT-SENTINEL') && !text.includes('DEMO-1048'));
  // A tap on a line selects that line only, never the other column's line on the same baseline.
  const fee = page.layout.items.find((i) => i.text === 'A $12 service fee applies');
  const line = lineAt(page.layout, { x: fee.x + 0.01, y: fee.y + fee.h / 2 });
  assert.equal(textInRegion(page.text, page.layout, line), 'A $12 service fee applies');
  const below = adjacentLine(page.layout, line, 1);
  assert.equal(textInRegion(page.text, page.layout, below), 'each billing cycle.');
  assert.equal(textInRegion(page.text, page.layout, adjacentLine(page.layout, line, -1)), 'Usage is calculated monthly.');
  // "Include nearby lines" returns the exact extra text, separately.
  assert.deepEqual(nearbyText(page.text, page.layout, line), { before: 'Usage is calculated monthly.', after: 'each billing cycle.' });
  // A box spanning both columns reads the left column first, then the right.
  const both = textInRegion(page.text, page.layout, { x: 0, y: 0.05, w: 1, h: 0.075 });
  assert.equal(both, 'Billing and fees\nUsage is calculated monthly.\nRIGHT-SENTINEL account\nreference DEMO-1048');
});

void test('02/03 blank space gives an empty extraction and no line', async () => {
  const [page] = await layouts(makePdf([twoColumnPage(LEFT, RIGHT)]));
  const blank = { x: 0.1, y: 0.6, w: 0.5, h: 0.2 };
  assert.equal(textInRegion(page.text, page.layout, blank), '');
  assert.equal(lineAt(page.layout, { x: 0.3, y: 0.7 }), null);
  assert.deepEqual(itemsIn(page.layout, blank), []);
});

void test('02/03 a rotated page keeps boxes normalised against the rotated page', async () => {
  const [page] = await layouts(makePdf([{ rotate: 90, texts: [{ x: 72, y: 700, text: 'Rotated clause here' }, { x: 72, y: 100, text: 'OTHER-END sentinel' }] }]));
  assert.equal(page.layout.width, 792);
  assert.equal(page.layout.height, 612);
  const item = page.layout.items.find((i) => i.text === 'Rotated clause here');
  assert.ok(item.w < item.h, 'a line on a page rotated 90° runs top to bottom');
  const around = { x: item.x - 0.01, y: item.y - 0.01, w: item.w + 0.02, h: item.h + 0.02 };
  assert.equal(textInRegion(page.text, page.layout, around), 'Rotated clause here');
});

void test('02/03 geometry: rectangles stay inside the source; pixels cover the selection', () => {
  fc.assert(fc.property(fc.double({ min: -2, max: 2, noNaN: true }), fc.double({ min: -2, max: 2, noNaN: true }), fc.double({ min: -2, max: 2, noNaN: true }), fc.double({ min: -2, max: 2, noNaN: true }), (a, b, c, d) => {
    for (const r of [rectFromPoints({ x: a, y: b }, { x: c, y: d }), moveRect({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, a, b), resizeRect({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 'nw', a, b), resizeRect({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 'se', c, d), growRect({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, a, b)]) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, JSON.stringify(r));
      const px = toPixels(r, 640, 480);
      assert.ok(px.sx >= 0 && px.sy >= 0 && px.sw >= 1 && px.sh >= 1 && px.sx + px.sw <= 640 && px.sy + px.sh <= 480);
      assert.ok(px.sx <= r.x * 640 + 1e-6 && px.sx + px.sw >= Math.min(640, (r.x + r.w) * 640) - 1e-6);
    }
  }), { numRuns: 400 });
  // Display pixels map to source space whatever the zoom: a point at half the element is 0.5.
  assert.deepEqual(toSource(150, 300, { left: 50, top: 100, width: 200, height: 400 }), { x: 0.5, y: 0.5 });
  assert.deepEqual(clampRect({ x: 0.99, y: -1, w: 0.5, h: 0 }), { x: 0.5, y: 0, w: 0.5, h: 0.02 });
});

void test('03 the excerpt payload has the question, a neutral label and page, and nothing else', () => {
  const message = excerptMessage('What is this charge?', { purpose: 'excerpt', page: 2, text: 'A $12 service fee applies each billing cycle.', nearby: null, image: null });
  assert.match(message, /^What is this charge\?\n\nExcerpt \(p\. 2\):\n"""\nA \$12 service fee applies each billing cycle\.\n"""\n\nAnswer from the excerpt only\./);
  assert.ok(!/\.pdf|service-terms|Attached document/i.test(message));
  const nearby = excerptMessage('Why?', { purpose: 'explain', page: 1, text: 'middle', nearby: { before: 'above', after: 'below' }, image: null });
  assert.match(nearby, /"""\nabove\nmiddle\nbelow\n"""/);
  const image = { url: 'data:image/png;base64,AAAA', width: 2, height: 2 };
  const withImage = excerptMessage('What is circled?', { purpose: 'explain', page: null, text: '', nearby: null, image });
  assert.match(withImage, /Excerpt: the cropped image attached\./);
  assert.deepEqual(excerptContent(withImage, image), [{ type: 'text', text: withImage }, { type: 'image_url', image_url: { url: image.url } }]);
  assert.equal(excerptContent('plain', null), 'plain');
});
