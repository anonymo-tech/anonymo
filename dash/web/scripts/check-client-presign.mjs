import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { readPreSignInspection as inspect } from '../server/solana/pre-sign.ts';
import {
  parsePreSignInspection,
  readPreSignInspection,
  serializedTransaction,
  serializedTransactionHash,
} from '../lib/client/pre-sign.ts';
const key = (n) => bs58.encode(new Uint8Array(32).fill(n));
const system = '11111111111111111111111111111111',
  token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const accountId = 'fd6cb92c-2694-45f3-af92-fbe9a2c120a6';
function wire({
  version = 'legacy',
  program = system,
  data = Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
  indexes = [0, 1],
} = {}) {
  return Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    ...(version === 'legacy' ? [] : [Buffer.from([128])]),
    Buffer.from([1, 0, 1, 3]),
    ...[key(1), key(2), program].map((a) => Buffer.from(bs58.decode(a))),
    Buffer.from(bs58.decode(key(9))),
    Buffer.from([1, 2, indexes.length, ...indexes, data.length]),
    data,
    ...(version === 'legacy' ? [] : [Buffer.from([0])]),
  ]).toString('base64');
}
const transaction = wire(),
  hash = createHash('sha256')
    .update(Buffer.from(transaction, 'base64'))
    .digest('hex');
async function result(encoded = transaction, simulation = {}) {
  return inspect(
    'devnet',
    async (method, params) => {
      if (method === 'getGenesisHash')
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      assert.equal(method, 'simulateTransaction');
      return {
        context: { slot: 120 },
        value: {
          err: null,
          unitsConsumed: 50,
          fee: 5000,
          loadedAddresses: { writable: [], readonly: [] },
          replacementBlockhash: {
            blockhash: key(8),
            lastValidBlockHeight: 150,
          },
          accounts: params[1].accounts.addresses.map(() => ({
            owner: system,
            executable: false,
            lamports: 10,
            data: ['', 'base64'],
            space: 0,
          })),
          innerInstructions: [],
          ...simulation,
        },
      };
    },
    encoded,
    undefined,
    { now: () => Date.parse('2026-01-01T00:00:00.000Z') },
  );
}
const valid = await result(),
  clone = () => structuredClone(valid);
const response = (value = valid, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { inspection: value } : value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const rejected = (value) =>
  assert.throws(() => parsePreSignInspection(value, hash), {
    code: 'INVALID_RESPONSE',
  });
function mutations(cases) {
  for (const mutate of cases) {
    const v = clone();
    mutate(v);
    rejected(v);
  }
}
test('server legacy and v0 round trip with exact wire hash', async () => {
  assert.deepEqual(parsePreSignInspection(valid, hash), valid);
  const encoded = wire({ version: 0 }),
    value = await result(encoded);
  assert.deepEqual(
    parsePreSignInspection(value, await serializedTransactionHash(encoded)),
    value,
  );
  assert.equal(await serializedTransactionHash(transaction), hash);
});
