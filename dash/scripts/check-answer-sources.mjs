import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAnswerSources } from '../lib/answer-sources.ts';

test('extracts markdown, autolinks and bare links in appearance order', () => {
  assert.deepEqual(extractAnswerSources(
    '[Solana docs](https://docs.example.com/start "Docs") then <https://example.org/guide> and http://example.net/page.',
  ), [
    { url: 'https://docs.example.com/start', domain: 'docs.example.com', label: 'Solana docs' },
    { url: 'https://example.org/guide', domain: 'example.org' },
    { url: 'http://example.net/page', domain: 'example.net' },
  ]);
});

test('strips trailing punctuation and surrounding prose delimiters', () => {
  const text = '(https://example.com/a), https://example.com/b! https://example.com/c? '
    + 'https://example.com/d; https://example.com/e: https://example.com/f。 '
    + '"https://example.com/g" [https://example.com/h]';
  assert.deepEqual(extractAnswerSources(text).map((source) => source.url),
    'abcdefgh'.split('').map((letter) => `https://example.com/${letter}`));
});

test('preserves balanced and nested parentheses in markdown and bare URLs', () => {
  assert.deepEqual(extractAnswerSources(
    '[Reference](https://example.com/wiki/Topic_(detail)) '
    + '(https://example.org/a_(b_(c))). <https://example.net/search?q=(term)>',
  ).map((source) => source.url), [
    'https://example.com/wiki/Topic_(detail)',
    'https://example.org/a_(b_(c))',
    'https://example.net/search?q=(term)',
  ]);
});

test('uses the markdown destination when the label itself looks like a URL', () => {
  assert.deepEqual(extractAnswerSources('[https://label.example](https://target.example/path)'), [
    { url: 'https://target.example/path', domain: 'target.example', label: 'https://label.example' },
  ]);
});

test('deduplicates normalised URLs, keeping the first spelling and label', () => {
  assert.deepEqual(extractAnswerSources(
    '[First](HTTPS://EXAMPLE.COM:443) https://example.com/ [Later](https://example.com) '
    + 'https://example.com/other https://example.com/other',
  ), [
    { url: 'HTTPS://EXAMPLE.COM:443', domain: 'example.com', label: 'First' },
    { url: 'https://example.com/other', domain: 'example.com' },
  ]);
});

test('rejects javascript and other schemes, incomplete URLs and empty output', () => {
  for (const text of ['', 'No links here.', '[Unsafe](javascript:alert(1))',
    '<ftp://example.com/file> mailto:demo@example.com data:text/plain,hello',
    '[Unsafe](javascript:https://example.com) ftp://https://example.com embeddedhttps://example.com',
    'https:// https://.']) {
    assert.deepEqual(extractAnswerSources(text), []);
  }
});

test('caps unique sources at 20 and retains their first appearance order', () => {
  const urls = Array.from({ length: 25 }, (_, index) => `https://example.com/${index}`);
  assert.deepEqual(extractAnswerSources(urls.flatMap((url) => [url, url]).join('\n'))
    .map((source) => source.url), urls.slice(0, 20));
});

test('keeps paths, queries and fragments distinct and reports the destination host', () => {
  assert.deepEqual(extractAnswerSources(
    'https://example.com/a?x=1&y=2#part https://example.com/a?x=2 https://example.org/a#part',
  ).map((source) => source.url), [
    'https://example.com/a?x=1&y=2#part', 'https://example.com/a?x=2', 'https://example.org/a#part',
  ]);
  assert.equal(extractAnswerSources('https://example.com@destination.example/path')[0].domain, 'destination.example');
});
