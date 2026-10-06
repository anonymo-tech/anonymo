import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { readPreSignInspection } from '../server/solana/pre-sign.ts';
import { createSolanaReader } from '../server/solana/rpc.ts';
import {
  SOLANA_NETWORKS,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from '../server/solana/validation.ts';

const key = (n) => bs58.encode(new Uint8Array(32).fill(n));
const compact = (n) => {
  const out = [];
  do {
    const byte = n & 127;
    n >>>= 7;
    out.push(byte | (n ? 128 : 0));
  } while (n);
  return Buffer.from(out);
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const transfer = Buffer.concat([u32(2), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])]);
function wire({
  version = 'legacy',
  keys = [key(1), key(2), SYSTEM_PROGRAM],
  header = [1, 0, 1],
  data = transfer,
  program = keys.length - 1,
  indexes = [0, 1],
  lookups = [],
} = {}) {
  return Buffer.concat([
    compact(header[0]),
    Buffer.alloc(64 * header[0]),
    ...(version === 'legacy' ? [] : [Buffer.from([128 | version])]),
    Buffer.from(header),
    compact(keys.length),
    ...keys.map((k) => Buffer.from(bs58.decode(k))),
    Buffer.from(bs58.decode(key(9))),
    compact(1),
    Buffer.from([program]),
    compact(indexes.length),
    Buffer.from(indexes),
    compact(data.length),
    data,
    ...(version === 'legacy'
      ? []
      : [
          compact(lookups.length),
          ...lookups.map((l) =>
            Buffer.concat([
              Buffer.from(bs58.decode(l.key)),
              compact(l.writable.length),
              Buffer.from(l.writable),
              compact(l.readonly.length),
              Buffer.from(l.readonly),
            ]),
          ),
        ]),
  ]).toString('base64');
}
const v0 = (index = 0) =>
  wire({
    version: 0,
    keys: [key(1), SYSTEM_PROGRAM],
    indexes: [0, 2],
    lookups: [{ key: key(40), writable: [index], readonly: [] }],
  });
function alt({
  deactivation = (1n << 64n) - 1n,
  extended = 90n,
  start = 0,
  owner = 'AddressLookupTab1e1111111111111111111111111',
  executable = false,
  addresses = [key(2), key(3)],
} = {}) {
  const data = Buffer.alloc(56 + addresses.length * 32);
  data.writeUInt32LE(1);
  data.writeBigUInt64LE(deactivation, 4);
  data.writeBigUInt64LE(extended, 12);
  data[20] = start;
  addresses.forEach((value, i) => data.set(bs58.decode(value), 56 + i * 32));
  return {
    owner,
    executable,
    data: [data.toString('base64'), 'base64'],
    space: data.length,
  };
}
const emptyAccount = () => ({
  owner: SYSTEM_PROGRAM,
  executable: false,
  lamports: 20,
  data: ['', 'base64'],
  space: 0,
});
function fixture(options = {}) {
  const calls = [];
  const rpc = async (method, params, signal) => {
    calls.push({ method, params, signal });
    if (options.rpc) return options.rpc(method, params, signal);
    if (method === 'getGenesisHash')
      return options.genesis ?? SOLANA_NETWORKS.devnet.genesisHash;
    if (method === 'getMultipleAccounts')
      return { context: { slot: 100 }, value: [options.alt ?? alt()] };
    assert.equal(method, 'simulateTransaction');
    const config = params[1];
    assert.equal(config.commitment, 'finalized');
    assert.equal(config.encoding, 'base64');
    assert.equal(config.sigVerify, false);
    assert.equal(config.innerInstructions, true);
    const result = {
      context: { slot: options.slot ?? 100 },
      value: {
        err: null,
        unitsConsumed: 12,
        fee: 5000,
        loadedAddresses: {
          writable: config.minContextSlot ? [key(2)] : [],
          readonly: [],
        },
        replacementBlockhash: config.replaceRecentBlockhash
          ? { blockhash: key(8), lastValidBlockHeight: 500 }
          : null,
        accounts: config.accounts.addresses.map(emptyAccount),
        innerInstructions: [],
        logs: ['untrusted execution prose'],
        ...options.value,
      },
    };
    options.mutate?.(result, config);
    return result;
  };
  return {
    rpc,
    calls,
    run: (input = wire(), extra) =>
      readPreSignInspection('devnet', rpc, input, undefined, extra),
  };
}
test('legacy original bytes are simulated only; signature and post-state limits remain explicit', async () => {
  const f = fixture();
  const input = wire();
  const result = await f.run(input);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ['getGenesisHash', 'simulateTransaction'],
  );
  assert.equal(f.calls[1].params[0], input);
  assert.equal(result.simulation.status, 'succeeded');
  assert.equal(result.input.signaturesVerified, false);
  assert.equal(result.input.presentSignatures, 0);
  assert.equal(result.instructions[0].kind, 'systemTransfer');
  assert.equal(result.simulation.effectsComplete, false);
  assert.equal(result.simulation.accounts[0].lamports, '20');
  assert.equal(
    JSON.stringify(result).includes('untrusted execution prose'),
    false,
  );
});
