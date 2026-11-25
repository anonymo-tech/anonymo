import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { canonicalCode, codeFromFragment, DEMO_CODE, formatCodeInput } from '../lib/anonymo/codes.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { setupHref, setupReturn } from '../lib/anonymo/setup-return.ts';
import { parseUpdates, RELEASED, updateOn } from '../lib/anonymo/updates.ts';
import { CODE_ALPHABET, codeChecksum, formatCode } from '../../gateway/src/anonymo/codes/format.ts';

test('Codes is an opt-in live switch and is visible in demo mode', () => {
  assert.equal(parseUpdates(undefined).has('codes'), false);
  assert.equal(RELEASED.has('codes'), false);
  assert.equal(parseUpdates('free, codes').has('codes'), true);
  assert.equal(updateOn('codes', true), true);
});

test('typing and paste format gateway vouchers and the browser detects single-symbol typos', () => {
  for (const [i, char] of [...CODE_ALPHABET].entries()) {
    const payload = `01${char}${CODE_ALPHABET.slice(i).padEnd(12, 'Z').slice(0, 12)}`;
    const raw = payload + codeChecksum(payload);
    const expected = formatCode(raw);
    const entered = ' ' + raw.toLowerCase().replaceAll('0', 'o').replaceAll('1', 'l') + '\n';
    assert.equal(formatCodeInput(entered), expected);
    assert.equal(canonicalCode(entered), expected);
    const changed = CODE_ALPHABET[(CODE_ALPHABET.indexOf(raw[i % 16]) + 1) % CODE_ALPHABET.length];
    const typo = raw.slice(0, i % 16) + changed + raw.slice(i % 16 + 1);
    assert.equal(canonicalCode(typo), null);
    assert.equal(canonicalCode(raw + 'A'), null);
  }
  assert.equal(formatCodeInput('7dm4k'), '7DM4-K');
});

test('scanned vouchers ride in URL fragments and setup only carries an allowlisted destination', () => {
  assert.equal(codeFromFragment(`#code=${DEMO_CODE}`), DEMO_CODE);
  assert.equal(codeFromFragment('#code=wrong'), null);
  const chat = '/dashboard/chat?character=abababababababab';
  const href = new URL(setupHref('redeem', chat), 'https://anonymo.example');
  assert.equal(href.pathname, '/redeem');
  assert.equal(setupReturn(href.searchParams.get('returnTo')).href, chat);
  assert.equal(setupHref('redeem', '//example.test'), '/redeem');
});

const clientFor = (gateway, key) => createAnonymoClient({ baseUrl: 'https://anonymo.example', fetch: gateway.fetch, key });

test('demo voucher creates a funded key or credits the current key with the same API shape', async () => {
  for (const existing of [false, true]) {
    const saved = new Map();
    const storage = { getItem: (name) => saved.get(name), setItem: (name, value) => saved.set(name, value) };
    const gateway = createMockGateway({ storage });
    const guest = clientFor(gateway);
    const oldKey = existing ? await guest.createKey() : null;
    const client = clientFor(gateway, oldKey?.key);

    await assert.rejects(client.redeemCode('not a voucher'), { code: 'invalid_code' });
    const [winner, duplicate] = await Promise.allSettled([client.redeemCode(DEMO_CODE), client.redeemCode(DEMO_CODE)]);
    const outcome = [winner, duplicate].find((result) => result.status === 'fulfilled').value;
    const rejection = [winner, duplicate].find((result) => result.status === 'rejected').reason;
    assert.equal(rejection.code, 'code_already_redeemed');
    assert.equal(outcome.added_usd, 25);
    assert.equal('key' in outcome, !existing);
    assert.equal(outcome.key_hash, oldKey?.key_hash ?? outcome.key_hash);
    const secret = oldKey?.key ?? outcome.key;
    const funded = clientFor(gateway, secret);
    const balance = await funded.balance();
    assert.equal(Number(balance.available_usd), 25);
    assert.equal(Number(balance.code_credit_usd), 25);
    assert.deepEqual(balance.withdraw_to, []);
    assert.ok([...saved.values()].every((value) => !value.includes(DEMO_CODE) && !value.includes(secret)));
    await assert.rejects(clientFor(createMockGateway({ storage })).redeemCode(DEMO_CODE), { code: 'code_already_redeemed' });
  }
});
