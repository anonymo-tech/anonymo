import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendPdfPage,
  emptyPdfText,
  pdfTextDecision,
  PDF_PAGE_LIMIT,
  textReferenceBlock,
  utf8Prefix,
} from '../lib/client/pdf-references.ts';

const bytes = (text) => new TextEncoder().encode(text).length;
const readable = 'Readable reference text with enough meaningful characters.';

test('page separators preserve page order and extracted text', () => {
  let result = emptyPdfText(3, 1000);
  for (const text of [readable, '', '末页的可读取文本'])
    result = appendPdfPage(result, text);
  assert.equal(
    result.text,
    `--- Page 1 ---\n${readable}\n\n--- Page 2 ---\n\n\n--- Page 3 ---\n末页的可读取文本`,
  );
  assert.equal(result.pagesRead, 3);
  assert.equal(result.totalPages, 3);
  assert.equal(result.bytes, bytes(result.text));
  assert.equal(result.partialPage, false);
  assert.equal(pdfTextDecision(result), 'ok');
});

test('only the first 200 pages of a longer document are kept', () => {
  let result = emptyPdfText(340, 100000);
  for (let n = 0; n < 340; n++) result = appendPdfPage(result, readable);
  assert.equal(PDF_PAGE_LIMIT, 200);
  assert.equal(result.pagesRead, 200);
  assert.equal(result.totalPages, 340);
  assert.match(result.text, /--- Page 200 ---/);
  assert.doesNotMatch(result.text, /--- Page 201 ---/);
  assert.equal(result.partialPage, false);
});

test('UTF-8 truncation keeps a prefix without broken multibyte characters', () => {
  assert.equal(utf8Prefix('A中😀Z', 7), 'A中');
  assert.equal(utf8Prefix('A中😀Z', 8), 'A中😀');
  assert.equal(utf8Prefix('中文', 2), '');
  assert.equal(utf8Prefix('abc', 0), '');
  assert.equal(utf8Prefix('abc', 3), 'abc');
  const budget = bytes('--- Page 1 ---\n') + bytes(readable) + 4;
  const result = appendPdfPage(
    emptyPdfText(12, budget),
    `${readable}中😀 suffix`,
  );
  assert.equal(result.pagesRead, 1);
  assert.equal(result.partialPage, true);
  assert.equal(result.byteLimited, true);
  assert.equal(result.text, `--- Page 1 ---\n${readable}中`);
  assert.ok(result.bytes <= budget);
  assert.equal(appendPdfPage(result, 'Later page'), result);
});

test('an exact page boundary does not claim the previous page was partial', () => {
  const page = `--- Page 1 ---\n${readable}`;
  let result = appendPdfPage(emptyPdfText(5, bytes(page) + 2), readable);
  result = appendPdfPage(result, 'Second page');
  assert.equal(result.text, page);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.partialPage, false);
  assert.equal(result.byteLimited, true);
  assert.equal(appendPdfPage(emptyPdfText(3, 0), readable).pagesRead, 0);
});

test('empty pages and sparse scan artefacts are not treated as readable references', () => {
  let empty = emptyPdfText(200, 100000);
  for (let n = 0; n < 200; n++) empty = appendPdfPage(empty, ' \n\t');
  assert.equal(pdfTextDecision(empty), 'no-text'); // Generated headers never count.
  assert.equal(
    pdfTextDecision(appendPdfPage(emptyPdfText(1, 1000), '1 -- .')),
    'little-text',
  );
  assert.equal(
    pdfTextDecision(appendPdfPage(emptyPdfText(1, 1000), 'a'.repeat(19))),
    'little-text',
  );
  assert.equal(
    pdfTextDecision(appendPdfPage(emptyPdfText(1, 1000), 'a'.repeat(20))),
    'ok',
  );
  assert.equal(
    pdfTextDecision(appendPdfPage(emptyPdfText(1, 1000), '中文'.repeat(10))),
    'ok',
  );
  assert.equal(
    pdfTextDecision(appendPdfPage(emptyPdfText(2, 0), readable)),
    'limit',
  );
  const boundary = bytes('--- Page 1 ---\n123');
  assert.equal(
    pdfTextDecision(appendPdfPage(emptyPdfText(2, boundary), '123')),
    'limit',
  );
});

test('text references include the original file name and fit the remaining draft budget', () => {
  const draft = 'Compare the evidence.';
  const name = 'reference.pdf';
  const budget = 160;
  const remaining = budget - bytes(draft + textReferenceBlock(name, ''));
  const extracted = appendPdfPage(
    emptyPdfText(5, remaining),
    readable.repeat(5),
  );
  const combined = draft + textReferenceBlock(name, extracted.text);
  assert.ok(bytes(combined) <= budget);
  assert.match(combined, /--- Reference: reference.pdf ---\n--- Page 1 ---/);
  assert.equal(
    combined.replace(textReferenceBlock(name, extracted.text), ''),
    draft,
  );
});
