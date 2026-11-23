// Feature 01 "Mask my details": personal-detail detectors, stable placeholders, manual masks, undo inputs and the
// digest that binds a reviewed preview to the payload. Sample values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { ibanValid, luhnValid, scanPersonal } from '../lib/guards/personal.ts';
import { handleGuardRequest } from '../lib/guards/worker.ts';
import { MaskVault, addMask, hasPlaceholder, maskSegments, maskText, masksFromFindings, payloadDigest, placeholderParts, segmentsText, toggleMask, wordAt } from '../lib/anonymo/masking.ts';
import { CHAT_INPUT_UPDATE } from '../lib/anonymo/chat-inputs.ts';
import { parseUpdates, RELEASED } from '../lib/anonymo/updates.ts';

const DRAFT = 'Hello Sample Person, your account 4410-2231-88 has a service fee for 12 Elm Street. Reference INV-028.';
const kinds = (text) => scanPersonal(text).map((f) => [f.kind, text.slice(f.start, f.end), f.suggested]);

void test('01 detectors: name, account, address, reference, email, phone, card, IBAN', () => {
  assert.deepEqual(kinds(DRAFT), [
    ['name', 'Sample Person', true],
    ['account', '4410-2231-88', true],
    ['address', '12 Elm Street', true],
    ['reference', 'INV-028', false],
  ]);
  const more = 'Mail sample-user@example.com or call +1 415 555 0134. Card 4111 1111 1111 1111. IBAN GB82 WEST 1234 5698 7654 32. My name is Demo Account.';
  assert.deepEqual(kinds(more).map(([k, v]) => `${k}:${v}`), [
    'email:sample-user@example.com',
    'phone:+1 415 555 0134',
    'card:4111 1111 1111 1111',
    'account:GB82 WEST 1234 5698 7654 32',
    'name:Demo Account',
  ]);
  assert.equal(luhnValid('4111111111111111'), true);
  assert.equal(luhnValid('4111111111111112'), false);
  assert.equal(ibanValid('GB82WEST12345698765432'), true);
  assert.equal(ibanValid('GB82WEST12345698765431'), false);
});

void test('01 detectors leave ordinary prose, amounts, dates and greetings without names alone', () => {
  for (const text of [
    'Hello there, the total is $53.00 due on 2026-11-22.',
    'Hi team, can you summarise this?',
    'Water usage $38.00, service fee $12.00, sales tax $3.00.',
    'Card ending 4111 1111 1111 1112 is not a valid number.',
    'Call me on Monday at 10:30.',
  ]) assert.deepEqual(kinds(text), [], text);
});

void test('01 findings hold offsets and a kind only, never the matched text', () => {
  const findings = scanPersonal(DRAFT);
  for (const f of findings) assert.deepEqual(Object.keys(f).sort(), ['code', 'end', 'kind', 'start', 'suggested']);
  assert.ok(!JSON.stringify(findings).includes('4410'));
});

void test('01 worker: personal suggestions only on request, none when the text could not be checked', () => {
  const plain = handleGuardRequest({ id: 'a', text: DRAFT });
  assert.equal(plain.personal, undefined);
  const asked = handleGuardRequest({ id: 'b', text: DRAFT, personal: true });
  assert.equal(asked.personal.length, 4);
  const failed = handleGuardRequest({ id: 'c', text: 'x'.repeat(16 * 1024 * 1024 + 1), personal: true });
  assert.equal(failed.findings[0].type, 'input');
  assert.deepEqual(failed.personal, []);
});

void test('01 placeholders are stable per value and numbered per kind across turns', () => {
  const vault = new MaskVault();
  const text = 'Dear Sample Person, Hi Other Person. Dear Sample Person again.';
  const masks = masksFromFindings(scanPersonal(text));
  const out = maskText(text, masks, vault);
  assert.equal(out, 'Dear [name 1], Hi [name 2]. Dear [name 1] again.');
  // A later turn reuses the same placeholder for the same value.
  const later = 'Hello Sample Person';
  assert.equal(maskText(later, masksFromFindings(scanPersonal(later)), vault), 'Hello [name 1]');
  assert.equal(vault.restore(out), text);
  // A cleared vault that reserves the chat's existing placeholders never reuses [name 1] for another value.
  const fresh = new MaskVault();
  fresh.reserve(out);
  const next = 'Hello Third Person';
  assert.equal(maskText(next, masksFromFindings(scanPersonal(next)), fresh), 'Hello [name 3]');
  assert.equal(fresh.restore('[name 1]'), '[name 1]');
  // A value masked earlier is masked again wherever it reappears, even with no detector match.
  const again = 'thanks, sample-user@EXAMPLE.com and Sample Person';
  vault.placeholder('email', 'sample-user@example.com');
  assert.equal(maskText(again, masksFromFindings(scanPersonal(again), vault.knownMasks(again)), vault), 'thanks, [email 1] and [name 1]');
});

void test('01 suggestions that are off stay as text; tapping one masks it; manual masks cover every occurrence', () => {
  const vault = new MaskVault();
  let masks = masksFromFindings(scanPersonal(DRAFT));
  assert.equal(maskText(DRAFT, masks, vault.clone()), 'Hello [name 1], your account [account 1] has a service fee for [address 1]. Reference INV-028.');
  const ref = masks.findIndex((m) => m.kind === 'reference');
  masks = toggleMask(masks, ref);
  assert.match(maskText(DRAFT, masks, vault.clone()), /Reference \[reference 1\]\.$/);
  const text = 'Ask Robin about it. Robin knows.';
  const word = wordAt(text, text.indexOf('Robin') + 2);
  assert.deepEqual(word, { start: 4, end: 9 });
  const manual = addMask(text, [], word.start, word.end);
  assert.equal(manual.length, 2);
  assert.equal(maskText(text, manual, new MaskVault()), 'Ask [detail 1] about it. [detail 1] knows.');
  // Switching a manual mask off removes it; undo is the caller's stack of previous mask arrays.
  assert.equal(toggleMask(manual, 0).length, 1);
  assert.deepEqual(wordAt(text, 3), null);
});

void test('01 digest binds the preview: any change to the outgoing text changes it', () => {
  const vault = new MaskVault();
  const masks = masksFromFindings(scanPersonal(DRAFT));
  const segments = maskSegments(DRAFT, masks, vault.clone());
  const outgoing = segmentsText(segments);
  const digest = payloadDigest(outgoing);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(payloadDigest(maskText(DRAFT, masks, vault.clone())), digest);
  assert.notEqual(payloadDigest(`${outgoing} `), digest);
  assert.notEqual(payloadDigest(maskText(DRAFT, toggleMask(masks, 0), vault.clone())), digest);
});

void test('01 property: a masked value never survives in the outgoing text, and restore gives back the draft', () => {
  const filler = fc.constantFrom('Please help me', 'with this bill', 'thanks', 'it says', 'and also', 'today');
  const detail = fc.constantFrom('sample-user@example.com', 'demo.account@example.org', '4111 1111 1111 1111', '+44 20 7946 0958', 'GB82 WEST 1234 5698 7654 32');
  fc.assert(fc.property(fc.array(fc.tuple(filler, detail), { minLength: 1, maxLength: 6 }), (parts) => {
    const draft = parts.map(([f, d]) => `${f} ${d}`).join('. ');
    const vault = new MaskVault();
    const out = maskText(draft, masksFromFindings(scanPersonal(draft)), vault);
    for (const [, d] of parts) assert.ok(!out.includes(d), `${d} leaked in ${out}`);
    assert.ok(hasPlaceholder(out));
    assert.equal(vault.restore(out), draft);
    assert.equal(placeholderParts(out).map((p) => p.text).join(''), out);
  }), { numRuns: 300 });
});

void test('mobile input tools are released independently of other switches', () => {
  const ids = Object.values(CHAT_INPUT_UPDATE);
  assert.deepEqual(ids.filter((id) => parseUpdates(undefined).has(id)), []);
  assert.deepEqual(ids.filter((id) => parseUpdates('history,mask,proof').has(id)), ['mask', 'proof']);
  assert.equal(ids.filter((id) => parseUpdates('all').has(id)).length, 5);
  assert.ok([...ids, 'connect', 'walletreview'].every((id) => RELEASED.has(id)), 'mobile dashboard tools are released');
});

void test('01 a greeting that finds no name leaves "my name is" to find it', () => {
  const names = (t) => scanPersonal(t).filter((f) => f.kind === 'name').map((f) => t.slice(f.start, f.end));
  assert.deepEqual(names('Hello, my name is Sample Person. Help me dispute this bill.'), ['Sample Person']);
  assert.deepEqual(names('Hi there, Dear Sample Person'), ['Sample Person']);
  assert.deepEqual(names('Dear Sample, thanks'), ['Sample']);
  assert.deepEqual(names('Hello, how are you?'), []);
  assert.deepEqual(names('From Monday the fee changes.'), []);
});
