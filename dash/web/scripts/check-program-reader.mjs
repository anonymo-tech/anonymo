import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { createSolanaReader } from '../server/solana/rpc.ts';
import {
  programDataAddress,
  readProgramInspection,
} from '../server/solana/program-reader.ts';
import { PROGRAM_LOADER_IDS as L } from '../lib/solana/program-reader.ts';
import { SOLANA_NETWORKS, SolanaError } from '../server/solana/validation.ts';
const key = (n) => bs58.encode(new Uint8Array(32).fill(n)),
  sig = (n) => bs58.encode(new Uint8Array(64).fill(n));
const program = key(30),
  authority = key(31),
  pd = programDataAddress(program);
const rent = 'SysvarRent111111111111111111111111111111111',
  clock = 'SysvarC1ock11111111111111111111111111111111',
  system = '11111111111111111111111111111111';
const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  },
  u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
const account = (owner, executable, bytes, space = 4096) => ({
  owner,
  executable,
  bytes: Buffer.from(bytes),
  space,
});
function tx({ id = 90, slot = 900, deploy = false, inner = false } = {}) {
  const keys = [
    authority,
    pd,
    program,
    key(32),
    key(33),
    rent,
    clock,
    L.v3,
    system,
    key(34),
  ];
  const instruction = {
    programIdIndex: 7,
    accounts: deploy ? [0, 1, 2, 3, 5, 6, 8, 0] : [1, 2, 3, 4, 5, 6, 0],
    data: bs58.encode(deploy ? Buffer.concat([u32(2), u64(4096)]) : u32(3)),
  };
  return {
    version: 'legacy',
    slot,
    blockTime: 1700000000 + slot,
    transaction: {
      signatures: [sig(id)],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 5,
        },
        accountKeys: keys,
        instructions: inner
          ? [
              {
                programIdIndex: 9,
                accounts: [0, 1, 2, 3, 4, 5, 6, 7],
                data: '',
              },
            ]
          : [instruction],
      },
    },
    meta: {
      err: null,
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: inner
        ? [{ index: 0, instructions: [{ ...instruction, stackHeight: 2 }] }]
        : [],
      logMessages: inner
        ? [
            `Program ${key(34)} invoke [1]`,
            `Program ${L.v3} invoke [2]`,
            `Program ${L.v3} success`,
            `Program ${key(34)} success`,
          ]
        : [`Program ${L.v3} invoke [1]`, `Program ${L.v3} success`],
    },
  };
}
function fixture() {
  const accounts = new Map([
    [
      program,
      account(L.v3, true, Buffer.concat([u32(2), bs58.decode(pd)]), 36),
    ],
    [
      pd,
      account(
        L.v3,
        false,
        Buffer.concat([
          u32(3),
          u64(900),
          Buffer.from([1]),
          bs58.decode(authority),
        ]),
      ),
    ],
  ]);
  const transactions = [tx()],
    calls = [];
  let mutate = () => {},
    override = () => null;
  const resultFor = ({ method, params }) => {
    if (method === 'getGenesisHash') return SOLANA_NETWORKS.devnet.genesisHash;
    if (method === 'getAccountInfo' || method === 'getMultipleAccounts') {
      const c = params[1];
      assert.equal(c.commitment, 'finalized');
      assert.equal(c.encoding, 'base64');
      assert.equal(c.dataSlice.offset, 0);
      assert.ok([0, 36, 45, 48].includes(c.dataSlice.length));
      const keys = method === 'getAccountInfo' ? [params[0]] : params[0];
      assert.ok(keys.length <= 2);
      const rows = keys.map((k) => {
        const a = accounts.get(k);
        return a
          ? {
              owner: a.owner,
              executable: a.executable,
              space: a.space,
              data: [
                a.bytes.subarray(0, c.dataSlice.length).toString('base64'),
                'base64',
              ],
            }
          : null;
      });
      return {
        context: { slot: 1000 },
        value: method === 'getAccountInfo' ? rows[0] : rows,
      };
    }
    if (method === 'getSignaturesForAddress') {
      assert.equal(params[1].limit, 8);
      assert.equal(params[1].commitment, 'finalized');
      return transactions.map((t) => ({
        signature: t.transaction.signatures[0],
        slot: t.slot,
        err: t.meta.err,
        confirmationStatus: 'finalized',
        blockTime: t.blockTime,
        memo: null,
      }));
    }
    if (method === 'getSignatureStatuses')
      return {
        context: { slot: 1000 },
        value: params[0].map((s) => {
          const t = transactions.find((t) => t.transaction.signatures[0] === s);
          return t
            ? {
                slot: t.slot,
                confirmations: null,
                err: t.meta.err,
                confirmationStatus: 'finalized',
              }
            : null;
        }),
      };
    if (method === 'getTransaction') {
      assert.deepEqual(params[1], {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
        encoding: 'json',
      });
      return structuredClone(
        transactions.find((t) => t.transaction.signatures[0] === params[0]) ??
          null,
      );
    }
    throw new Error('Unexpected RPC method');
  };
  const fetcher = async (_url, o) => {
    assert.equal(o.method, 'POST');
    assert.equal(o.redirect, 'error');
    assert.equal(o.credentials, 'omit');
    const q = JSON.parse(o.body);
    calls.push(q);
    const custom = override(q, o);
    if (custom) return custom;
    const result = structuredClone(resultFor(q));
    mutate(result, q);
    return Response.json({ jsonrpc: '2.0', id: q.id, result });
  };
  return {
    accounts,
    transactions,
    calls,
    reader: (options = {}) =>
      createSolanaReader({
        rpcUrl: 'https://rpc.example/solana',
        cluster: 'devnet',
        fetcher,
        ...options,
      }),
    mutate(fn) {
      mutate = fn;
    },
    override(fn) {
      override = fn;
    },
  };
}
const has = (r, c) => r.warnings.some((w) => w.code === c),
  error = (code) => (e) =>
    e instanceof SolanaError && (!code || e.code === code);
const read = (f) => f.reader().readProgram(program);

void test('v3 exact PDA and same-bank pair bind authority and deployment slot without reading code', async () => {
  const f = fixture(),
    r = await read(f);
  assert.equal(r.programDataAddress, pd);
  assert.equal(r.contextSlot, 1000);
  assert.equal(r.lastDeploymentSlot, 900);
  assert.equal(r.loaderStateSlot, null);
  assert.deepEqual(r.authority, { status: 'present', address: authority });
  assert.equal(r.mutability, 'upgradeable');
  assert.equal(r.verifiedBuild, 'not-checked');
  assert.deepEqual(
    f.calls
      .filter((c) => c.method === 'getAccountInfo')
      .map((c) => c.params[1].dataSlice.length),
    [0, 36],
  );
  const pair = f.calls.find((c) => c.method === 'getMultipleAccounts');
  assert.deepEqual(pair.params[0], [program, pd]);
  assert.equal(pair.params[1].dataSlice.length, 45);
  assert.equal(pair.params[1].minContextSlot, 1000);
  assert.equal(r.history.events[0].kind, 'upgrade');
  assert.ok(has(r, 'BUILD_UNVERIFIED') && has(r, 'HISTORY_BOUNDED'));
});
void test('removed v3 authority is none, not unknown, even when obsolete trailing bytes remain', async () => {
  const f = fixture();
  f.accounts.get(pd).bytes[12] = 0;
  const r = await read(f);
  assert.deepEqual(r.authority, { status: 'none', address: null });
  assert.equal(r.mutability, 'immutable');
  assert.ok(!has(r, 'UPGRADE_AUTHORITY'));
});
void test('v3 owner, executable, option, slot, state and PDA contradictions fail closed', async () => {
  for (const change of [
    (f) => (f.accounts.get(pd).owner = system),
    (f) => (f.accounts.get(pd).executable = true),
    (f) => (f.accounts.get(pd).bytes[12] = 2),
    (f) => f.accounts.get(pd).bytes.writeBigUInt64LE(1001n, 4),
    (f) => f.accounts.get(pd).bytes.writeBigUInt64LE(9007199254740992n, 4),
    (f) => f.accounts.get(pd).bytes.writeUInt32LE(2, 0),
    (f) =>
      (f.accounts.get(program).bytes = Buffer.concat([
        u32(2),
        bs58.decode(key(80)),
      ])),
    (f) => f.accounts.delete(pd),
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(read(f), error('invalid_response'));
  }
});
void test('changed or older final bank cannot be combined with discovery metadata', async () => {
  for (const change of [
    (r) => (r.context.slot = 999),
    (r) =>
      (r.value[0].data = [
        Buffer.concat([u32(2), bs58.decode(key(80))]).toString('base64'),
        'base64',
      ]),
    (r) => (r.value[0].owner = L.v4),
    (r) => (r.value[0].executable = false),
  ]) {
    const f = fixture();
    f.mutate((r, q) => {
      if (q.method === 'getMultipleAccounts') change(r);
    });
    await assert.rejects(read(f), error('invalid_response'));
  }
});
void test('v4 state overrides executable flag, and retracted slot is not called deployment slot', async () => {
  for (const state of [0, 1, 2]) {
    const f = fixture();
    f.accounts.set(
      program,
      account(
        L.v4,
        true,
        Buffer.concat([u64(850), bs58.decode(authority), u64(state)]),
      ),
    );
    f.transactions.length = 0;
    const r = await read(f);
    assert.equal(r.status, ['retracted', 'deployed', 'finalized'][state]);
    assert.equal(r.loaderStateSlot, 850);
    assert.equal(r.lastDeploymentSlot, state === 0 ? null : 850);
    assert.equal(r.authority.status, state === 2 ? 'none' : 'present');
    assert.equal(r.nextVersionAddress, null);
    assert.equal(r.mutability, state === 2 ? 'immutable' : 'upgradeable');
    assert.equal(r.executable, true);
    if (state === 0) assert.ok(has(r, 'PROGRAM_RETRACTED'));
    assert.ok(has(r, 'LOADER_VERSION_UNVERIFIED'));
    assert.equal(
      f.calls.find((c) => c.method === 'getMultipleAccounts').params[1]
        .dataSlice.length,
      48,
    );
  }
});
void test('unknown v4 header is explicit unsupported with unknown authority', async () => {
  const f = fixture();
  f.accounts.set(
    program,
    account(
      L.v4,
      true,
      Buffer.concat([u64(850), bs58.decode(authority), u64(3)]),
    ),
  );
  const r = await read(f);
  assert.equal(r.status, 'unsupported');
  assert.equal(r.authority.status, 'unknown');
  assert.equal(r.mutability, 'unknown');
  assert.equal(r.history.status, 'not-scanned');
  assert.ok(has(r, 'UNSUPPORTED_STATE'));
});
void test('legacy metadata never fetches ELF; native and unknown loaders remain unassessed', async () => {
  for (const owner of [L.v1, L.v2, L.native, key(85)]) {
    const f = fixture();
    f.accounts.set(
      program,
      account(owner, true, Buffer.from('ELF never requested')),
    );
    f.transactions.length = 0;
    const r = await read(f);
    assert.equal(
      r.status,
      [L.v1, L.v2].includes(owner) ? 'deployed' : 'unsupported',
    );
    assert.equal(
      r.mutability,
      [L.v1, L.v2].includes(owner) ? 'immutable' : 'unknown',
    );
    assert.ok(
      f.calls
        .filter((c) => c.method.includes('Account'))
        .every((c) => c.params[1].dataSlice.length === 0),
    );
    assert.equal(r.lastDeploymentSlot, null);
  }
});
void test('missing and non-program accounts do not query history or invent authority', async () => {
  for (const present of [false, true]) {
    const f = fixture();
    if (present)
      f.accounts.set(program, account(system, false, Buffer.alloc(0), 0));
    else f.accounts.delete(program);
    const r = await read(f);
    assert.equal(r.status, present ? 'not-program' : 'not-found');
    assert.equal(r.history.status, 'not-scanned');
    assert.ok(!f.calls.some((c) => c.method === 'getSignaturesForAddress'));
    assert.equal(r.authority.status, 'unknown');
  }
});
void test('empty recent signatures never mean a complete history or absence of upgrades', async () => {
  const f = fixture();
  f.transactions.length = 0;
  const r = await read(f);
  assert.equal(r.history.status, 'bounded');
  assert.equal(r.history.complete, false);
  assert.deepEqual(r.history.events, []);
  assert.ok(has(r, 'HISTORY_BOUNDED'));
});
void test('successful exact top-level deployment and upgrade targets are recognized', async () => {
  const f = fixture();
  f.transactions.push(tx({ id: 91, slot: 800, deploy: true }));
  const r = await read(f);
  assert.deepEqual(
    r.history.events.map((e) => e.kind),
    ['upgrade', 'deploy'],
  );
  assert.equal(r.history.verifiedTransactions, 2);
});
void test('address mention, wrong loader, substituted target or trailing bytes never count as upgrades', async () => {
  for (const change of [
    (t) => (t.transaction.message.instructions[0].accounts[1] = 3),
    (t) => (t.transaction.message.instructions[0].accounts[0] = 3),
    (t) => (t.transaction.message.instructions[0].programIdIndex = 8),
    (t) =>
      (t.transaction.message.instructions[0].data = bs58.encode(
        Buffer.concat([u32(3), Buffer.from([0])]),
      )),
    (t) => (t.transaction.message.instructions[0].accounts[4] = 8),
  ]) {
    const f = fixture();
    change(f.transactions[0]);
    assert.deepEqual((await read(f)).history.events, []);
  }
});
void test('history for another loader is not attributed to the currently inspected loader', async () => {
  const f = fixture();
  f.accounts.set(
    program,
    account(
      L.v4,
      true,
      Buffer.concat([u64(850), bs58.decode(authority), u64(1)]),
    ),
  );
  const r = await read(f);
  assert.equal(r.loader, 'v4');
  assert.deepEqual(r.history.events, []);
});
void test('ambiguous historical v4 Retract discriminator is never called a deployment', async () => {
  const f = fixture();
  f.accounts.set(
    program,
    account(
      L.v4,
      true,
      Buffer.concat([u64(850), bs58.decode(authority), u64(1)]),
    ),
  );
  const t = f.transactions[0];
  t.transaction.message.accountKeys = [authority, program, L.v4];
  t.transaction.message.header.numReadonlyUnsignedAccounts = 1;
  t.transaction.message.instructions = [
    { programIdIndex: 2, accounts: [1, 0], data: bs58.encode(u32(3)) },
  ];
  const r = await read(f);
  assert.deepEqual(r.history.events, []);
  assert.equal(r.status, 'deployed');
  assert.ok(has(r, 'HISTORY_INCOMPLETE'));
});
void test('legacy v1 and v2 finalized deployment instructions bind signer, target and rent', async () => {
  for (const owner of [L.v1, L.v2]) {
    const f = fixture();
    f.accounts.set(program, account(owner, true, Buffer.alloc(0)));
    const t = f.transactions[0];
    t.transaction.message.accountKeys = [program, rent, owner];
    t.transaction.message.header.numReadonlyUnsignedAccounts = 2;
    t.transaction.message.instructions = [
      { programIdIndex: 2, accounts: [0, 1], data: bs58.encode(u32(1)) },
    ];
    const r = await read(f);
    assert.equal(r.history.events.length, 1);
    assert.equal(r.history.events[0].kind, 'deploy');
  }
});
void test('CPI upgrade needs matching successful invocation and ancestor logs', async () => {
  const f = fixture();
  f.transactions[0] = tx({ inner: true });
  const r = await read(f);
  assert.equal(r.history.events[0].instruction, '0.0');
  assert.equal(r.history.events[0].kind, 'upgrade');
});
void test('caught CPI failure and success inside a failed ancestor are not upgrade evidence', async () => {
  for (const nested of [false, true]) {
    const f = fixture(),
      t = tx({ inner: true });
    f.transactions[0] = t;
    if (!nested)
      t.meta.logMessages[2] = `Program ${L.v3} failed: custom program error: 0x1`;
    else {
      const wrapper = key(35);
      t.transaction.message.accountKeys.push(wrapper);
      t.transaction.message.header.numReadonlyUnsignedAccounts++;
      t.meta.innerInstructions[0].instructions = [
        { programIdIndex: 10, accounts: [], data: '', stackHeight: 2 },
        { ...t.meta.innerInstructions[0].instructions[0], stackHeight: 3 },
      ];
      t.meta.logMessages = [
        `Program ${key(34)} invoke [1]`,
        `Program ${wrapper} invoke [2]`,
        `Program ${L.v3} invoke [3]`,
        `Program ${L.v3} success`,
        `Program ${wrapper} failed: custom program error: 0x1`,
        `Program ${key(34)} success`,
      ];
    }
    assert.deepEqual((await read(f)).history.events, []);
  }
});
void test('stackHeight zero or one cannot turn an inner instruction into a trusted top-level call', async () => {
  for (const depth of [0, 1, null, 65]) {
    const f = fixture(),
      t = tx({ inner: true });
    f.transactions[0] = t;
    t.meta.innerInstructions[0].instructions[0].stackHeight = depth;
    t.meta.logMessages = null;
    const r = await read(f);
    assert.deepEqual(r.history.events, []);
    assert.ok(has(r, 'HISTORY_INCOMPLETE'));
  }
});
void test('missing, truncated, spoof-prefixed and mismatched CPI logs are explicit incomplete history', async () => {
  for (const change of [
    (t) => (t.meta.logMessages = null),
    (t) => t.meta.logMessages.push('Log truncated'),
    (t) => (t.meta.logMessages[2] = `Program log: Program ${L.v3} success`),
    (t) => (t.meta.logMessages[1] = `Program ${L.v3} invoke [3]`),
    (t) => (t.meta.innerInstructions = []),
  ]) {
    const f = fixture(),
      t = tx({ inner: true });
    f.transactions[0] = t;
    change(t);
    const r = await read(f);
    assert.deepEqual(r.history.events, []);
    assert.ok(has(r, 'HISTORY_INCOMPLETE'));
  }
});
void test('missing inner metadata preserves independent top-level events with an incomplete warning', async () => {
  const f = fixture();
  f.transactions[0].meta.innerInstructions = null;
  const r = await read(f);
  assert.equal(r.history.events.length, 1);
  assert.equal(r.history.verifiedTransactions, 1);
  assert.ok(has(r, 'HISTORY_INCOMPLETE'));
});
void test('failed, unfinalized, future, missing, wrongly bound and unsupported transactions do not contribute events', async () => {
  for (const mode of [
    'failed',
    'unfinalized',
    'future',
    'missing',
    'signature',
    'version',
  ]) {
    const f = fixture();
    if (mode === 'failed')
      f.transactions[0].meta.err = { InstructionError: [0, 'failed'] };
    f.mutate((r, q) => {
      if (q.method === 'getSignaturesForAddress' && mode === 'future')
        r[0].slot = 1001;
      if (q.method === 'getSignatureStatuses' && mode === 'unfinalized')
        r.value[0].confirmationStatus = 'confirmed';
      if (q.method === 'getTransaction' && mode === 'signature')
        r.transaction.signatures = [sig(99)];
      if (q.method === 'getTransaction' && mode === 'version') r.version = 1;
    });
    if (mode === 'missing')
      f.override((q) =>
        q.method === 'getTransaction'
          ? Response.json({ jsonrpc: '2.0', id: q.id, result: null })
          : null,
      );
    const r = await read(f);
    assert.deepEqual(r.history.events, []);
    assert.ok(has(r, 'HISTORY_INCOMPLETE'));
  }
});
void test('unavailable history retains metadata and static warnings without provider diagnostics', async () => {
  const f = fixture();
  f.override((q) =>
    q.method === 'getSignaturesForAddress'
      ? Response.json({
          jsonrpc: '2.0',
          id: q.id,
          error: { code: -1, message: 'private diagnostic' },
        })
      : null,
  );
  const r = await read(f);
  assert.equal(r.status, 'deployed');
  assert.equal(r.history.status, 'unavailable');
  assert.equal(r.history.scannedSignatures, 0);
  assert.ok(has(r, 'HISTORY_UNAVAILABLE'));
  assert.ok(!JSON.stringify(r).includes('private diagnostic'));
});
void test('eight signatures bound total RPC calls; no history pagination or auto retries', async () => {
  const f = fixture();
  f.transactions.splice(
    0,
    1,
    ...Array.from({ length: 8 }, (_, i) => tx({ id: 90 + i, slot: 900 - i })),
  );
  const r = await read(f);
  assert.equal(f.calls.length, 14);
  assert.equal(r.history.scannedSignatures, 8);
  assert.equal(r.history.events.length, 8);
  assert.equal(
    f.calls.filter((c) => c.method === 'getSignaturesForAddress').length,
    1,
  );
});
void test('excess and duplicate signatures fail history safely before transaction reads', async () => {
  for (const duplicate of [false, true]) {
    const f = fixture();
    f.mutate((r, q) => {
      if (q.method === 'getSignaturesForAddress')
        r.push(...Array(duplicate ? 1 : 8).fill(r[0]));
    });
    const r = await read(f);
    assert.equal(r.history.status, 'unavailable');
    assert.equal(
      f.calls.filter((c) => c.method === 'getTransaction').length,
      0,
    );
  }
});
void test('wrong genesis stops account reads and malformed address stops all network calls', async () => {
  const f = fixture();
  f.override((q) =>
    q.method === 'getGenesisHash'
      ? Response.json({
          jsonrpc: '2.0',
          id: q.id,
          result: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
        })
      : null,
  );
  await assert.rejects(read(f), error('wrong_cluster'));
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    f.reader().readProgram('https://example.com'),
    error('invalid_input'),
  );
  assert.equal(f.calls.length, 1);
});
void test('program response bytes are capped below the general reader limit', async () => {
  const f = fixture();
  f.override((q) =>
    q.method === 'getAccountInfo'
      ? new Response('x'.repeat(262145), {
          headers: { 'content-type': 'application/json' },
        })
      : null,
  );
  await assert.rejects(
    f.reader({ maximumBytes: 4 * 1024 * 1024 }).readProgram(program),
    error('response_too_large'),
  );
});
void test('cancellation stops a stalled body, cleans its reader and starts no more calls', async () => {
  const f = fixture();
  let cancelled = false;
  f.override((q) =>
    q.method === 'getAccountInfo'
      ? new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      : null,
  );
  const c = new AbortController();
  setTimeout(() => c.abort(), 10);
  await assert.rejects(
    f.reader().readProgram(program, c.signal),
    error('cancelled'),
  );
  assert.ok(cancelled);
  assert.equal(f.calls.length, 2);
});
void test('per-call timeout handles fetchers that ignore abort without retrying', async () => {
  const f = fixture();
  f.override((q) =>
    q.method === 'getAccountInfo' ? new Promise(() => {}) : null,
  );
  await assert.rejects(
    f.reader({ timeoutMs: 10 }).readProgram(program),
    error('rpc_timeout'),
  );
  assert.equal(f.calls.length, 2);
});
void test('overall deadline includes multiple individually timely calls', async () => {
  let calls = 0;
  const rpc = async (method, _params, signal) => {
    calls++;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 8);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new SolanaError('cancelled'));
        },
        { once: true },
      );
    });
    return method === 'getGenesisHash'
      ? SOLANA_NETWORKS.devnet.genesisHash
      : { context: { slot: 1 }, value: null };
  };
  await assert.rejects(
    readProgramInspection('devnet', rpc, program, undefined, 10),
    error('rpc_timeout'),
  );
  assert.equal(calls, 2);
});
