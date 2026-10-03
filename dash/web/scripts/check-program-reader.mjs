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
