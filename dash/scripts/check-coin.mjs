// The contract-address field: only a well-formed EVM address is shown; the env var wins over the pasted constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinAddress, shortAddress } from '../lib/anonymo/coin.ts';

const A = '0x' + 'ab'.repeat(20);
const B = '0x' + 'cd'.repeat(20);

test('nothing set: no address (the field says announced at launch)', () => {
  assert.equal(coinAddress(undefined, ''), null);
  assert.equal(coinAddress('', ''), null);
});

test('the environment variable is used, trimmed', () => {
  assert.equal(coinAddress(`  ${A} `, ''), A);
});

test('the pasted constant is the fallback; the environment wins when both are set', () => {
  assert.equal(coinAddress(undefined, B), B);
  assert.equal(coinAddress(A, B), A);
});

test('anything that is not an EVM address shows nothing', () => {
  for (const bad of ['0x123', A.slice(0, -1), A + 'f', 'ab'.repeat(21), '0x' + 'zz'.repeat(20), 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'])
    assert.equal(coinAddress(bad, ''), null, bad);
});

test('short form keeps the start and end', () => {
  assert.equal(shortAddress(A), '0xabab…abab');
});
