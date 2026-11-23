// Feature 07 "Show me the proof": citations parsed from answers and checked against the local source.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { claimGaps, context, locate, normalise, parseCitations, statusLabel } from '../lib/anonymo/citations.ts';
import { paperPrompt } from '../lib/paper-trail.ts';

const FEE = 'A $12 service fee applies each billing cycle.';
const DUE = 'Payment is due within 21 days.';
const SOURCE = {
  name: 'service-terms.pdf',
  pages: [
    { number: 1, text: `Welcome.\n${DUE}\nAccount reference DEMO-1048.` },
    { number: 2, text: `Billing and fees\nUsage is calculated monthly.\nA $12 service fee applies\neach billing cycle.\n${DUE}` },
  ],
};
const ANSWER = `Yes. The terms allow a recurring $12 service fee every month [p. 2 "${FEE}"]. Payment is due in three weeks [p. 1 "${DUE}"]. Late fees are waived [p. 2 "Late fees are waived for members."]. See the welcome [p. 1].`;

void test('07 a quote across a line break on the cited page is found, with its exact range', () => {
  const found = locate(SOURCE, 2, FEE);
  assert.equal(found.status, 'found');
  const text = SOURCE.pages[1].text;
  assert.equal(normalise(text.slice(found.at.start, found.at.end)).text, normalise(FEE).text);
  const ctx = context(SOURCE, found.at, 30);
  assert.equal(normalise(ctx.quote).text, normalise(FEE).text);
  assert.ok(ctx.before.endsWith('monthly.\n'));
});

void test('07 the same phrase on two pages is ambiguous, a fabricated quote is missing, an expired source is never verified', () => {
  const two = locate(SOURCE, 1, DUE);
  assert.equal(two.status, 'ambiguous');
  assert.deepEqual(two.pages, [1, 2]);
  assert.equal(two.at.page, 1);
  assert.equal(statusLabel(two), 'Found on several pages');
  const fake = locate(SOURCE, 2, 'Late fees are waived for members.');
  assert.deepEqual(fake, { status: 'missing' });
  assert.equal(statusLabel(fake), 'Not in your document');
  assert.deepEqual(locate(null, 2, FEE), { status: 'expired' });
  assert.equal(statusLabel({ status: 'expired' }), 'Source no longer on this device');
  const elsewhere = locate(SOURCE, 1, 'Usage is calculated monthly.');
  assert.equal(elsewhere.status, 'other-page');
  assert.deepEqual(locate(SOURCE, 1, null), { status: 'page-only' });
});

void test('07 a true amount with an unsupported frequency is a located quote with the gap named', () => {
  const [, cite] = parseCitations(ANSWER);
  assert.equal(cite.claim, 'The terms allow a recurring $12 service fee every month');
  const found = locate(SOURCE, cite.page, cite.quote);
  const gaps = claimGaps(cite.claim, cite.quote);
  assert.deepEqual(gaps, ['frequency']);
  assert.equal(statusLabel(found, gaps), 'Quote found; frequency not stated');
  assert.deepEqual(claimGaps('a $15 fee', FEE), ['amount']);
  assert.deepEqual(claimGaps('a $12 fee each billing cycle', FEE), []);
  assert.deepEqual(claimGaps('billed monthly', 'Usage is calculated monthly.'), []);
});

void test('07 parsing: four citations in order, older [p. N] kept, text round-trips', () => {
  const segments = parseCitations(ANSWER);
  const cites = segments.filter((s) => s.kind === 'cite');
  assert.deepEqual(cites.map((c) => [c.index, c.page, c.quote]), [[1, 2, FEE], [2, 1, DUE], [3, 2, 'Late fees are waived for members.'], [4, 1, null]]);
  assert.equal(segments.map((s) => (s.kind === 'text' ? s.text : s.raw)).join(''), ANSWER);
  assert.equal(parseCitations('Curly [p. 3: “words here”] too.')[1].quote, 'words here');
  assert.equal(parseCitations('No citations at all.').length, 1);
});

void test('07 streaming: every prefix of an answer parses, and a mark appears only once its citation is closed', () => {
  let seen = 0;
  for (let i = 0; i <= ANSWER.length; i++) {
    const prefix = ANSWER.slice(0, i);
    const cites = parseCitations(prefix).filter((s) => s.kind === 'cite');
    assert.ok(cites.length >= seen, 'marks never disappear as text streams in');
    for (const c of cites) assert.ok(prefix.includes(c.raw) && c.raw.endsWith(']'));
    seen = cites.length;
  }
  assert.equal(seen, 4);
  fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
    const parts = parseCitations(s);
    assert.equal(parts.map((p) => (p.kind === 'text' ? p.text : p.raw)).join(''), s);
  }), { numRuns: 500 });
});

void test('07 the whole-document prompt asks for exact quotes with each page', () => {
  const prompt = paperPrompt('Is there a fee?', SOURCE);
  assert.match(prompt, /\[p\. 2 "exact quote"\]/);
  assert.match(prompt, /--- Attached document: service-terms\.pdf ---\n\[p\. 1\]\nWelcome\./);
});
