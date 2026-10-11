import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import {
  parseSerializedTransaction,
  resolveSerializedAccounts,
  detectDurableNonce,
} from '../server/solana/serialized.ts';
import { SYSTEM_PROGRAM, SolanaError } from '../server/solana/validation.ts';

const key = (n) => bs58.encode(Buffer.alloc(32, n));
const short = (n) => {
  const b = [];
  do {
    let v = n & 127;
    n >>>= 7;
    if (n) v |= 128;
    b.push(v);
  } while (n);
  return Buffer.from(b);
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
function wire({
  version = 'legacy',
  signatures = [Buffer.alloc(64)],
  header = [1, 0, 1],
  keys = [key(1), key(2), SYSTEM_PROGRAM],
  instructions = [
    {
      programIdIndex: 2,
      accountIndexes: [0, 1],
      data: Buffer.concat([u32(2), Buffer.alloc(8)]),
    },
  ],
  lookups = [],
  trailing = [],
} = {}) {
  return Buffer.concat([
    short(signatures.length),
    ...signatures,
    ...(version === 'legacy' ? [] : [Buffer.from([128 | version])]),
    Buffer.from(header),
    short(keys.length),
    ...keys.map((value) => Buffer.from(bs58.decode(value))),
    Buffer.alloc(32, 9),
    short(instructions.length),
    ...instructions.map((i) =>
      Buffer.concat([
        Buffer.from([i.programIdIndex]),
        short(i.accountIndexes.length),
        Buffer.from(i.accountIndexes),
        short(i.data.length),
        Buffer.from(i.data),
      ]),
    ),
    ...(version === 'legacy'
      ? []
      : [
          short(lookups.length),
          ...lookups.map((l) =>
            Buffer.concat([
              Buffer.from(bs58.decode(l.accountKey)),
              short(l.writableIndexes.length),
              Buffer.from(l.writableIndexes),
              short(l.readonlyIndexes.length),
              Buffer.from(l.readonlyIndexes),
            ]),
          ),
        ]),
    Buffer.from(trailing),
  ]);
}
const parse = (value) =>
  parseSerializedTransaction(Buffer.from(value).toString('base64'));
const bad = (value) => assert.throws(() => parse(value), SolanaError);

void test('legacy original bytes/hash and unsigned signature state are preserved', () => {
  const bytes = wire(),
    result = parse(bytes);
  assert.equal(result.version, 'legacy');
  assert.equal(result.byteLength, bytes.length);
  assert.equal(
    result.serializedHash,
    createHash('sha256').update(bytes).digest('hex'),
  );
  assert.equal(result.wireBase64, bytes.toString('base64'));
  assert.equal(result.messageBase64, bytes.subarray(65).toString('base64'));
  assert.equal(result.signatures[0].present, false);
  assert.deepEqual(
    result.staticAccounts.map((a) => [a.signer, a.writable]),
    [
      [true, true],
      [false, true],
      [false, false],
    ],
  );
});
void test('nonzero signatures remain present but are not authenticated', () => {
  const result = parse(wire({ signatures: [Buffer.alloc(64, 7)] }));
  assert.equal(result.signatures[0].present, true);
  assert.equal(result.signatures[0].value, bs58.encode(Buffer.alloc(64, 7)));
});
void test('base64 rejects whitespace, URL alphabet, missing padding, nonzero padbits and excessive input', () => {
  const input = wire().toString('base64');
  for (const value of [
    null,
    {},
    input + '\n',
    input.replace(/=+$/, ''),
    'Zh==',
    '_w==',
    'A'.repeat(1648),
  ])
    assert.throws(() => parseSerializedTransaction(value), SolanaError);
});
void test('shortvec rejects alias encodings, overflow and continuation third byte', () => {
  const bytes = wire();
  for (const prefix of [
    [129, 0],
    [129, 128, 0],
    [255, 255, 4],
    [255, 255, 128],
  ])
    bad(Buffer.concat([Buffer.from(prefix), bytes.subarray(1)]));
  // Static key and instruction vectors obey the same canonical rule.
  bad(
    Buffer.concat([
      bytes.subarray(0, 68),
      Buffer.from([131, 0]),
      bytes.subarray(69),
    ]),
  );
});
void test('every truncation fails and trailing bytes fail', () => {
  const bytes = wire();
  for (let i = 0; i < bytes.length; i++) bad(bytes.subarray(0, i));
  bad(Buffer.concat([bytes, Buffer.from([0])]));
});
void test('signature/header mismatch and readonly payer are rejected', () => {
  for (const header of [
    [0, 0, 1],
    [2, 0, 1],
    [1, 1, 1],
    [1, 0, 3],
  ])
    bad(wire({ header }));
  bad(wire({ signatures: [] }));
});
void test('static duplicates and compiled indexes outside key space are rejected', () => {
  bad(wire({ keys: [key(1), key(1), SYSTEM_PROGRAM] }));
  for (const index of [0, 3, 255])
    bad(
      wire({
        instructions: [{ programIdIndex: index, accountIndexes: [], data: [] }],
      }),
    );
  bad(
    wire({
      instructions: [{ programIdIndex: 2, accountIndexes: [3], data: [] }],
    }),
  );
});
void test('repeated instruction references are allowed without duplicated global accounts', () => {
  assert.deepEqual(
    parse(
      wire({
        instructions: [{ programIdIndex: 2, accountIndexes: [0, 0], data: [] }],
      }),
    ).instructions[0].accountIndexes,
    [0, 0],
  );
});
void test('new message versions are explicitly unsupported', () => {
  for (const version of [1, 2, 127])
    assert.throws(
      () => parse(wire({ version })),
      (e) => e.code === 'unsupported_transaction',
    );
});
void test('v0 lookup resolution uses all writable then all readonly across tables', () => {
  const result = parse(
    wire({
      version: 0,
      instructions: [
        { programIdIndex: 2, accountIndexes: [3, 4, 5, 6], data: [] },
      ],
      lookups: [
        { accountKey: key(30), writableIndexes: [1], readonlyIndexes: [2] },
        { accountKey: key(31), writableIndexes: [5], readonlyIndexes: [6] },
      ],
    }),
  );
  const accounts = resolveSerializedAccounts(
    result,
    [key(40), key(41)],
    [key(42), key(43)],
  );
  assert.deepEqual(
    accounts.slice(3).map((a) => [a.address, a.writable, a.signer]),
    [
      [key(40), true, false],
      [key(41), true, false],
      [key(42), false, false],
      [key(43), false, false],
    ],
  );
});
void test('v0 cannot invoke a loaded program or accept empty/duplicate lookup positions/tables', () => {
  const lookup = {
    accountKey: key(30),
    writableIndexes: [1],
    readonlyIndexes: [],
  };
  bad(
    wire({
      version: 0,
      lookups: [lookup],
      instructions: [{ programIdIndex: 3, accountIndexes: [], data: [] }],
    }),
  );
  for (const lookups of [
    [{ ...lookup, writableIndexes: [] }],
    [{ ...lookup, readonlyIndexes: [1] }],
    [{ ...lookup, writableIndexes: [1, 1] }],
    [lookup, lookup],
  ])
    bad(wire({ version: 0, lookups }));
});
void test('resolved ALT keys cannot alias static or other loaded accounts', () => {
  const parsed = parse(
    wire({
      version: 0,
      lookups: [
        { accountKey: key(30), writableIndexes: [1], readonlyIndexes: [2] },
      ],
    }),
  );
  for (const pair of [
    [[key(1)], [key(40)]],
    [[key(40)], [key(40)]],
    [[], [key(40)]],
    [['invalid'], [key(40)]],
  ])
    assert.throws(
      () => resolveSerializedAccounts(parsed, ...pair),
      SolanaError,
    );
});
void test('global keys, packet and instruction budgets reject overflow', () => {
  bad(
    wire({
      version: 0,
      lookups: [
        {
          accountKey: key(30),
          writableIndexes: Array.from({ length: 254 }, (_, i) => i),
          readonlyIndexes: [],
        },
      ],
    }),
  );
  bad(
    wire({
      instructions: Array.from({ length: 65 }, () => ({
        programIdIndex: 2,
        accountIndexes: [],
        data: [],
      })),
    }),
  );
  bad(
    wire({
      instructions: [
        { programIdIndex: 2, accountIndexes: [], data: Buffer.alloc(1232) },
      ],
    }),
  );
});
void test('first System advance is detected before simulation; malformed form stays ambiguous', () => {
  const keys = [
    key(1),
    key(2),
    'SysvarRecentB1ockHashes11111111111111111111',
    SYSTEM_PROGRAM,
  ];
  const ix = { programIdIndex: 3, accountIndexes: [1, 2, 0], data: u32(4) };
  const options = { keys, header: [1, 0, 2], instructions: [ix] };
  assert.deepEqual(detectDurableNonce(parse(wire(options))), {
    status: 'durable',
    accountIndex: 1,
  });
  for (const changed of [
    { ...ix, data: [4] },
    { ...ix, data: [...u32(4), 0] },
    { ...ix, accountIndexes: [1, 0, 2] },
    { ...ix, accountIndexes: [] },
  ])
    assert.equal(
      detectDurableNonce(parse(wire({ ...options, instructions: [changed] })))
        .status,
      'ambiguous',
    );
  assert.equal(
    detectDurableNonce(parse(wire({ ...options, header: [1, 0, 3] }))).status,
    'ambiguous',
  );
});
void test('later nonce advance never makes a transaction durable', () => {
  const result = parse(
    wire({
      instructions: [
        { programIdIndex: 2, accountIndexes: [], data: u32(2) },
        { programIdIndex: 2, accountIndexes: [], data: u32(4) },
      ],
    }),
  );
  assert.equal(detectDurableNonce(result).status, 'none');
});
void test('nonce with unloaded account remains ambiguous until exact resolution', () => {
  const parsed = parse(
    wire({
      version: 0,
      keys: [
        key(1),
        'SysvarRecentB1ockHashes11111111111111111111',
        SYSTEM_PROGRAM,
      ],
      header: [1, 0, 2],
      instructions: [
        { programIdIndex: 2, accountIndexes: [3, 1, 0], data: u32(4) },
      ],
      lookups: [
        { accountKey: key(30), writableIndexes: [0], readonlyIndexes: [] },
      ],
    }),
  );
  assert.equal(detectDurableNonce(parsed).status, 'ambiguous');
  assert.equal(
    detectDurableNonce(parsed, resolveSerializedAccounts(parsed, [key(40)], []))
      .status,
    'durable',
  );
});
