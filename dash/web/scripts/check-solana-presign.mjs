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
test('v0 binds loaded addresses to one finalized ALT snapshot and simulation floor', async () => {
  const f = fixture();
  const result = await f.run(v0());
  assert.equal(result.lookups.status, 'resolved');
  assert.equal(result.lookups.simulationBinding, 'matched');
  assert.equal(f.calls[2].params[1].minContextSlot, 100);
  assert.equal(result.accounts[2].address, key(2));
});
test('same-slot extension only exposes previously active prefix', async () => {
  assert.equal(
    (await fixture({ alt: alt({ extended: 100n, start: 1 }) }).run(v0()))
      .simulation.status,
    'succeeded',
  );
  const f = fixture({ alt: alt({ extended: 100n, start: 1 }) });
  assert.equal((await f.run(v0(1))).lookups.status, 'unavailable');
  assert.equal(f.calls.length, 2);
});
test('deactivating, future, malformed-owner, executable and duplicate tables do not simulate', async () => {
  for (const table of [
    alt({ deactivation: 99n }),
    alt({ extended: 101n }),
    alt({ start: 3 }),
    alt({ owner: SYSTEM_PROGRAM }),
    alt({ executable: true }),
    alt({ addresses: [key(1)] }),
  ]) {
    const f = fixture({ alt: table });
    const result = await f.run(v0());
    assert.equal(result.lookups.status, 'unavailable');
    assert.equal(result.simulation.status, 'not-run');
    assert.equal(f.calls.length, 2);
  }
});
test('missing or remapped loaded addresses withhold all simulated state', async () => {
  for (const loadedAddresses of [
    undefined,
    { writable: [key(77)], readonly: [] },
    { writable: [key(2)], readonly: [key(4)] },
  ]) {
    const result = await fixture({ value: { loadedAddresses } }).run(v0());
    assert.equal(result.simulation.status, 'unavailable');
    assert.deepEqual(result.simulation.accounts, []);
    assert.equal(result.lookups.simulationBinding, 'unverified');
    assert.ok(
      result.warnings.some((w) => w.code === 'LOOKUP_BINDING_UNVERIFIED'),
    );
  }
});
test('simulation cannot precede lookup snapshot', async () => {
  assert.equal(
    (await fixture({ slot: 99 }).run(v0())).simulation.status,
    'unavailable',
  );
});
test('durable nonce preserves original hash and rejects an unexpected replacement', async () => {
  const input = wire({
    keys: [
      key(1),
      key(2),
      'SysvarRecentB1ockHashes11111111111111111111',
      SYSTEM_PROGRAM,
    ],
    header: [1, 0, 2],
    data: u32(4),
    indexes: [1, 2, 0],
  });
  const f = fixture();
  const result = await f.run(input);
  assert.equal(result.input.nonce, 'durable');
  assert.equal(f.calls[1].params[1].replaceRecentBlockhash, false);
  assert.equal(result.simulation.replacementBlockhash, null);
  assert.equal(
    (
      await fixture({
        value: {
          replacementBlockhash: { blockhash: key(8), lastValidBlockHeight: 9 },
        },
      }).run(input)
    ).simulation.status,
    'unavailable',
  );
});
test('ambiguous nonce marker does not simulate or substitute hash', async () => {
  const f = fixture();
  const result = await f.run(wire({ data: Buffer.from([4]) }));
  assert.equal(result.input.nonce, 'ambiguous');
  assert.equal(result.simulation.status, 'not-run');
  assert.equal(f.calls.length, 1);
});
test('unavailable v0 lookup retains known durable or ambiguous nonce warnings', async () => {
  for (const [data, nonce, warning] of [
    [u32(4), 'durable', 'DURABLE_NONCE'],
    [Buffer.from([4]), 'ambiguous', 'NONCE_AMBIGUOUS'],
  ]) {
    const f = fixture({
      rpc: async (method) => {
        if (method === 'getGenesisHash')
          return SOLANA_NETWORKS.devnet.genesisHash;
        assert.equal(method, 'getMultipleAccounts');
        return { context: { slot: 100 }, value: [null] };
      },
    });
    const result = await f.run(
      wire({
        version: 0,
        keys: [
          key(1),
          key(2),
          'SysvarRecentB1ockHashes11111111111111111111',
          SYSTEM_PROGRAM,
        ],
        header: [1, 0, 2],
        data,
        indexes: [1, 2, 0],
        lookups: [{ key: key(40), writable: [0], readonly: [] }],
      }),
    );
    assert.equal(result.input.nonce, nonce);
    assert.equal(result.lookups.status, 'unavailable');
    assert.equal(result.simulation.status, 'not-run');
    assert.equal(result.simulation.blockhashReplacementRequested, false);
    assert.ok(result.warnings.some((item) => item.code === warning));
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ['getGenesisHash', 'getMultipleAccounts'],
    );
  }
});
test('decoded instruction secrets are blocked before even genesis RPC', async () => {
  const mnemonic = entropyToMnemonic(new Uint8Array(16), wordlist);
  const f = fixture();
  await assert.rejects(
    f.run(
      wire({
        keys: [key(1), key(99)],
        indexes: [0],
        data: Buffer.from(mnemonic),
      }),
    ),
    { code: 'sensitive_input' },
  );
  assert.equal(f.calls.length, 0);
});
test('unsupported versions and malformed wire make no RPC request', async () => {
  const f = fixture();
  await assert.rejects(f.run(wire({ version: 1 })), {
    code: 'unsupported_transaction',
  });
  await assert.rejects(f.run('AAAA'), { code: 'invalid_input' });
  assert.equal(f.calls.length, 0);
});
test('genesis mismatch aborts before simulation', async () => {
  const f = fixture({ genesis: SOLANA_NETWORKS['mainnet-beta'].genesisHash });
  await assert.rejects(f.run(), { code: 'wrong_cluster' });
  assert.equal(f.calls.length, 1);
});
test('custom instruction error is bounded without reflecting logs or arbitrary diagnostic prose', async () => {
  const result = await fixture({
    value: {
      err: { InstructionError: [0, { Custom: 4294967295 }] },
      logs: ['untrusted prose'],
    },
  }).run();
  assert.equal(result.simulation.status, 'failed');
  assert.equal(result.simulation.error.customCode, '4294967295');
  assert.equal(JSON.stringify(result).includes('untrusted prose'), false);
  const unknown = await fixture({
    value: { err: '<script>untrusted error</script>' },
  }).run();
  assert.equal(unknown.simulation.error.code, 'execution-failed');
  assert.equal(JSON.stringify(unknown).includes('<script>'), false);
});
test('unsafe RPC integer amounts never become rounded amounts', async () => {
  for (const value of [
    -0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    '01',
    '18446744073709551616',
  ]) {
    assert.equal(
      (await fixture({ value: { fee: value } }).run()).simulation.status,
      'unavailable',
    );
  }
  const max = await fixture({ value: { fee: '18446744073709551615' } }).run();
  assert.equal(max.simulation.feeLamports, '18446744073709551615');
});
test('malformed simulation errors do not expose an outcome or post-state', async () => {
  for (const err of [
    undefined,
    [],
    false,
    0,
    {},
    { A: 1, B: 2 },
    { InstructionError: [0, []] },
    { InstructionError: [0, { Custom: -1 }] },
  ]) {
    const result = await fixture({ value: { err } }).run();
    assert.equal(result.simulation.status, 'unavailable');
    assert.deepEqual(result.simulation.accounts, []);
  }
});
test('classic token post-state preserves exact u64 and authorities without inventing deltas', async () => {
  const data = Buffer.alloc(165);
  data.set(bs58.decode(key(11)));
  data.set(bs58.decode(key(12)), 32);
  data.writeBigUInt64LE((1n << 64n) - 1n, 64);
  data[108] = 2;
  data.writeUInt32LE(1, 72);
  data.set(bs58.decode(key(13)), 76);
  data.writeBigUInt64LE(7n, 121);
  const result = await fixture({
    mutate: (r) => {
      r.value.accounts[0] = {
        owner: TOKEN_PROGRAM,
        executable: false,
        lamports: 0,
        data: [data.toString('base64'), 'base64'],
      };
    },
  }).run();
  assert.equal(
    result.simulation.accounts[0].token.amount,
    '18446744073709551615',
  );
  assert.equal(result.simulation.accounts[0].token.delegate, key(13));
  assert.equal(result.simulation.accounts[0].token.state, 'frozen');
  assert.equal(Object.hasOwn(result.simulation.accounts[0], 'delta'), false);
});
test('Token-2022 and oversized account payloads remain explicitly uninspected', async () => {
  const result = await fixture({
    mutate: (r) => {
      r.value.accounts[0] = {
        owner: TOKEN_2022_PROGRAM,
        executable: false,
        lamports: 0,
        data: [Buffer.alloc(5000).toString('base64'), 'base64'],
      };
    },
  }).run();
  assert.equal(result.simulation.accounts[0].dataStatus, 'too-large');
  assert.equal(result.simulation.accounts[0].token, null);
  assert.ok(
    result.warnings.some((w) => w.code === 'TOKEN_2022_STATE_UNINSPECTED'),
  );
});
test('only first eight writable post-accounts are requested', async () => {
  const f = fixture();
  const input = wire({
    keys: [...Array.from({ length: 10 }, (_, i) => key(i + 1)), SYSTEM_PROGRAM],
  });
  const result = await f.run(input);
  assert.equal(result.simulation.requestedAccounts.length, 8);
  assert.equal(result.simulation.omittedWritableAccounts, 2);
});
test('missing account metadata is explicit and does not become zero balances', async () => {
  const result = await fixture({
    value: { accounts: null, unitsConsumed: null, fee: null },
  }).run();
  assert.equal(result.simulation.status, 'succeeded');
  assert.deepEqual(result.simulation.accounts, []);
  assert.equal(result.simulation.feeLamports, null);
  assert.ok(result.warnings.some((w) => w.code === 'ACCOUNTS_INCOMPLETE'));
});
test('abort and deadline settle even when injected RPC ignores signals', async () => {
  const rpc = () => new Promise(() => {});
  await assert.rejects(
    readPreSignInspection('devnet', rpc, wire(), undefined, { deadlineMs: 10 }),
    { code: 'rpc_timeout' },
  );
  const controller = new AbortController();
  const promise = readPreSignInspection(
    'devnet',
    rpc,
    wire(),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(promise, { code: 'cancelled' });
});
test('configured transport exposes only read simulation calls', async () => {
  const methods = [];
  const f = fixture();
  const reader = createSolanaReader({
    rpcUrl: 'https://rpc.example.test',
    cluster: 'devnet',
    fetcher: async (_url, options) => {
      const { id, method, params } = JSON.parse(options.body);
      methods.push(method);
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: await f.rpc(method, params),
      });
    },
  });
  assert.equal(
    (await reader.readPreSign(wire())).simulation.status,
    'succeeded',
  );
  assert.deepEqual(methods, ['getGenesisHash', 'simulateTransaction']);
  assert.equal(Object.hasOwn(reader, 'sendTransaction'), false);
});
test('oversized simulation transport is cancelled and becomes explicitly unavailable', async () => {
  let cancelled = false;
  const reader = createSolanaReader({
    rpcUrl: 'https://rpc.example.test',
    cluster: 'devnet',
    fetcher: async (_url, options) => {
      const { id, method } = JSON.parse(options.body);
      if (method === 'getGenesisHash')
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: SOLANA_NETWORKS.devnet.genesisHash,
        });
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: {
            'content-type': 'application/json',
            'content-length': '600000',
          },
        },
      );
    },
  });
  const result = await reader.readPreSign(wire());
  assert.equal(result.simulation.status, 'unavailable');
  assert.deepEqual(result.simulation.accounts, []);
  assert.equal(cancelled, true);
});
test('abort before queued RPC begins makes no call and raw callback failures are sanitized', async () => {
  let calls = 0;
  const controller = new AbortController();
  const pending = readPreSignInspection(
    'devnet',
    async () => {
      calls++;
      throw new Error('untrusted diagnostic');
    },
    wire(),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(calls, 0);
  await assert.rejects(
    readPreSignInspection(
      'devnet',
      async () => {
        throw new Error('untrusted diagnostic');
      },
      wire(),
    ),
    (error) =>
      error.code === 'rpc_unavailable' && !error.message.includes('untrusted'),
  );
});
