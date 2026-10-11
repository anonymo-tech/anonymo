import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  parseSerializedTransaction,
  resolveSerializedAccounts,
} from '../server/solana/serialized.ts';
import { explainRawInstructions } from '../server/solana/explain-raw.ts';
import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
} from '../server/solana/validation.ts';

const key = (n) => bs58.encode(Buffer.alloc(32, n));
const pk = (value) => Buffer.from(bs58.decode(value));
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const seed = (text) =>
  Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
const short = (n) => {
  const bytes = [];
  do {
    let b = n & 127;
    n >>>= 7;
    if (n) b |= 128;
    bytes.push(b);
  } while (n);
  return Buffer.from(bytes);
};
const STAKE = 'Stake11111111111111111111111111111111111111',
  LOOKUP = 'AddressLookupTab1e1111111111111111111111111';
const RENT = 'SysvarRent111111111111111111111111111111111',
  RECENT = 'SysvarRecentB1ockHashes11111111111111111111',
  CLOCK = 'SysvarC1ock11111111111111111111111111111111',
  HISTORY = 'SysvarStakeHistory1111111111111111111111111',
  CONFIG = 'StakeConfig11111111111111111111111111111111';
const [payer, account, mint, owner, destination, delegate] = [
  1, 2, 3, 4, 5, 6,
].map(key);
function decode(program, data, refs) {
  data = Buffer.from(data);
  const keys = [
    ...new Set([payer, ...refs.filter((v) => v !== program), program]),
  ];
  const wire = Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    Buffer.from([1, 0, 1]),
    short(keys.length),
    ...keys.map(pk),
    Buffer.alloc(32, 90),
    Buffer.from([1, keys.indexOf(program)]),
    short(refs.length),
    Buffer.from(refs.map((v) => keys.indexOf(v))),
    short(data.length),
    data,
  ]);
  const parsed = parseSerializedTransaction(wire.toString('base64'));
  return explainRawInstructions(
    parsed,
    resolveSerializedAccounts(parsed, [], []),
  )[0];
}
const flags = (value) => value.flags.map((f) => f.code);
const has = (value, code) =>
  assert.ok(
    flags(value).includes(code),
    `${code} missing from ${JSON.stringify(value)}`,
  );
const sensitive = (value, code) =>
  assert.equal(value.flags.find((f) => f.code === code)?.severity, 'critical');
const system = (tag, bytes, refs) =>
  decode(SYSTEM_PROGRAM, Buffer.concat([u32(tag), Buffer.from(bytes)]), refs);
const token = (tag, bytes, refs, program = TOKEN_PROGRAM) =>
  decode(
    program,
    Buffer.concat([Buffer.from([tag]), Buffer.from(bytes)]),
    refs,
  );

void test('System transfer reads exact u64 from real Buffer offset, without JS precision loss', () => {
  const result = system(2, u64('18446744073709551615'), [payer, destination]);
  assert.equal(result.kind, 'systemTransfer');
  assert.equal(result.fields.lamports, '18446744073709551615');
  assert.equal(result.fields.destination, destination);
  has(result, 'SOL_TRANSFER');
});
void test('System creation, assignment, allocation and seeded encoding bind fields', () => {
  assert.equal(
    system(0, Buffer.concat([u64(12), u64(8), pk(owner)]), [payer, account])
      .kind,
    'systemCreateAccount',
  );
  const assigned = system(1, pk(owner), [account]);
  sensitive(assigned, 'AUTHORITY_CHANGE');
  assert.equal(assigned.fields.owner, owner);
  assert.equal(system(8, u64(100), [account]).fields.space, '100');
  const created = system(
    3,
    Buffer.concat([pk(payer), seed('seed'), u64(1), u64(64), pk(owner)]),
    [payer, account],
  );
  assert.equal(created.kind, 'systemCreateAccountWithSeed');
  const allocated = system(
    9,
    Buffer.concat([pk(payer), seed('seed'), u64(99), pk(owner)]),
    [account, payer],
  );
  assert.equal(allocated.fields.space, '99');
  sensitive(allocated, 'AUTHORITY_CHANGE');
  assert.equal(
    system(10, Buffer.concat([pk(payer), seed('seed'), pk(owner)]), [
      account,
      payer,
    ]).kind,
    'systemAssignWithSeed',
  );
  assert.equal(
    system(11, Buffer.concat([u64(5), seed('seed'), pk(owner)]), [
      account,
      payer,
      destination,
    ]).kind,
    'systemTransferWithSeed',
  );
});
void test('seed byte length, UTF8, account base binding and trailing bytes fail visibly', () => {
  for (const bytes of [
    Buffer.concat([pk(owner), seed('x'), u64(1), u64(1), pk(owner)]),
    Buffer.concat([pk(payer), seed('x'.repeat(33)), u64(1), u64(1), pk(owner)]),
    Buffer.concat([
      pk(payer),
      u64(1),
      Buffer.from([255]),
      u64(1),
      u64(1),
      pk(owner),
    ]),
  ])
    assert.equal(system(3, bytes, [payer, account]).kind, 'malformed');
  assert.equal(
    system(2, Buffer.concat([u64(1), Buffer.from([0])]), [payer, destination])
      .kind,
    'malformed',
  );
});
void test('nonce control operations preserve exact accounts and critical authority warnings', () => {
  assert.equal(
    system(4, [], [account, RECENT, payer]).kind,
    'systemAdvanceNonce',
  );
  assert.equal(
    system(5, u64(2), [account, destination, RECENT, RENT, payer]).fields
      .lamports,
    '2',
  );
  sensitive(system(6, pk(owner), [account, RECENT, RENT]), 'AUTHORITY_CHANGE');
  const result = system(7, pk(owner), [account, payer]);
  assert.equal(result.fields.newAuthorized, owner);
  sensitive(result, 'AUTHORITY_CHANGE');
  assert.equal(system(12, [], [account]).kind, 'systemUpgradeNonce');
  assert.equal(system(4, [], [account, owner, payer]).kind, 'malformed');
});
void test('truncated bincode critical opcodes keep risks before any fields decode', () => {
  for (const [program, tag, code] of [
    [SYSTEM_PROGRAM, 1, 'AUTHORITY_CHANGE'],
    [SYSTEM_PROGRAM, 7, 'AUTHORITY_CHANGE'],
    [STAKE, 7, 'ACCOUNT_CLOSURE'],
    [STAKE, 10, 'AUTHORITY_CHANGE'],
    [LOOKUP, 4, 'ACCOUNT_CLOSURE'],
    [LOOKUP, 1, 'AUTHORITY_CHANGE'],
  ]) {
    for (let length = 1; length <= 4; length++) {
      const result = decode(program, u32(tag).subarray(0, length), []);
      assert.equal(result.kind, 'malformed');
      sensitive(result, code);
      has(result, 'MALFORMED_INSTRUCTION');
      assert.deepEqual(result.fields, {});
    }
  }
});
void test('common Token transfers, approvals, mints and burns bind raw amounts and accounts', () => {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    for (const [tag, kind, refs, code] of [
      [3, 'transfer', [account, destination, payer], 'TOKEN_TRANSFER'],
      [4, 'approve', [account, delegate, payer], 'TOKEN_APPROVAL'],
      [7, 'mintTo', [mint, account, payer], 'TOKEN_MINT'],
      [8, 'burn', [account, mint, payer], 'TOKEN_BURN'],
      [
        12,
        'transferChecked',
        [account, mint, destination, payer],
        'TOKEN_TRANSFER',
      ],
      [
        13,
        'approveChecked',
        [account, mint, delegate, payer],
        'TOKEN_APPROVAL',
      ],
      [14, 'mintToChecked', [mint, account, payer], 'TOKEN_MINT'],
      [15, 'burnChecked', [account, mint, payer], 'TOKEN_BURN'],
    ]) {
      const result = token(
        tag,
        Buffer.concat([
          u64('18446744073709551615'),
          ...(tag >= 12 ? [Buffer.from([6])] : []),
        ]),
        refs,
        program,
      );
      assert.equal(result.kind, kind);
      assert.equal(result.fields.amountRaw, '18446744073709551615');
      has(result, code);
      if (tag >= 12) assert.equal(result.fields.decimals, '6');
      if (program === TOKEN_2022_PROGRAM)
        has(result, 'TOKEN_2022_STATE_UNINSPECTED');
    }
  }
});
void test('multisig authority arrays remain bounded and retain all eleven signers', () => {
  const signers = Array.from({ length: 11 }, (_, i) => key(20 + i));
  const result = token(4, u64(12), [account, delegate, owner, ...signers]);
  assert.equal(result.kind, 'approve');
  assert.equal(result.fields.signerCount, '11');
  assert.ok(Object.values(result.fields).join().includes(signers[10]));
  assert.ok(Object.values(result.fields).every((v) => v.length <= 256));
  assert.equal(
    token(4, u64(12), [account, delegate, owner, ...signers, key(40)]).kind,
    'malformed',
  );
});
void test('revoke, close, freeze, thaw, sync and authority option are exact', () => {
  assert.equal(token(5, [], [account, payer]).kind, 'revoke');
  sensitive(token(9, [], [account, destination, payer]), 'ACCOUNT_CLOSURE');
  for (const tag of [10, 11])
    sensitive(token(tag, [], [account, mint, payer]), 'TOKEN_FREEZE');
  assert.equal(token(17, [], [account]).kind, 'syncNative');
  const cleared = token(6, [2, 0], [account, payer]);
  assert.equal(cleared.kind, 'setAuthority');
  assert.equal(cleared.fields.newAuthority, 'none');
  sensitive(cleared, 'AUTHORITY_CHANGE');
  const changed = token(6, Buffer.concat([Buffer.from([0, 1]), pk(owner)]), [
    mint,
    payer,
  ]);
  assert.equal(changed.fields.newAuthority, owner);
  for (const bytes of [
    [2, 2],
    [2, 0, 0],
    [2, 1],
  ]) {
    const result = token(6, bytes, [account, payer]);
    assert.equal(result.kind, 'malformed');
    sensitive(result, 'AUTHORITY_CHANGE');
  }
});
void test('all common token initialization layouts decode and validate threshold/rent', () => {
  for (const tag of [0, 20])
    assert.equal(
      token(
        tag,
        Buffer.concat([Buffer.from([6]), pk(owner), Buffer.from([0])]),
        tag === 0 ? [mint, RENT] : [mint],
      ).kind,
      tag === 0 ? 'initializeMint' : 'initializeMint2',
    );
  assert.equal(
    token(1, [], [account, mint, owner, RENT]).kind,
    'initializeAccount',
  );
  assert.equal(
    token(16, pk(owner), [account, mint, RENT]).kind,
    'initializeAccount2',
  );
  assert.equal(
    token(18, pk(owner), [account, mint]).kind,
    'initializeAccount3',
  );
  for (const tag of [2, 19]) {
    const refs = [account, ...(tag === 2 ? [RENT] : []), payer, owner];
    assert.equal(
      token(tag, [2], refs).kind,
      tag === 2 ? 'initializeMultisig' : 'initializeMultisig2',
    );
    assert.equal(token(tag, [3], refs).kind, 'malformed');
  }
  assert.equal(
    token(0, Buffer.concat([Buffer.from([6]), pk(owner), Buffer.from([0])]), [
      mint,
      destination,
    ]).kind,
    'malformed',
  );
});
void test('malformed critical token opcodes never lose critical warnings', () => {
  for (const [tag, code] of [
    [4, 'TOKEN_APPROVAL'],
    [13, 'TOKEN_APPROVAL'],
    [6, 'AUTHORITY_CHANGE'],
    [7, 'TOKEN_MINT'],
    [8, 'TOKEN_BURN'],
    [9, 'ACCOUNT_CLOSURE'],
    [10, 'TOKEN_FREEZE'],
    [11, 'TOKEN_FREEZE'],
  ]) {
    const result = token(tag, [], [], TOKEN_2022_PROGRAM);
    assert.equal(result.kind, 'malformed');
    sensitive(result, code);
    has(result, 'TOKEN_2022_STATE_UNINSPECTED');
  }
});
void test('Token-2022 permanent delegate and close authority exact payloads decode', () => {
  const permanent = token(35, pk(delegate), [mint], TOKEN_2022_PROGRAM);
  assert.equal(permanent.kind, 'initializePermanentDelegate');
  assert.equal(permanent.fields.delegate, delegate);
  sensitive(permanent, 'TOKEN_PERMANENT_DELEGATE');
  const close = token(25, [0], [mint], TOKEN_2022_PROGRAM);
  assert.equal(close.kind, 'initializeMintCloseAuthority');
  assert.equal(close.fields.newAuthority, 'none');
  assert.equal(
    token(32, [], [mint], TOKEN_2022_PROGRAM).kind,
    'initializeNonTransferableMint',
  );
  assert.equal(token(35, pk(delegate), [mint]).kind, 'unknown');
});
void test('unsupported Token-2022 extension payloads retain distinct risk categories', () => {
  for (const [tag, code] of [
    [26, 'TOKEN_TRANSFER_FEE'],
    [27, 'TOKEN_CONFIDENTIAL'],
    [36, 'TOKEN_TRANSFER_HOOK'],
    [37, 'TOKEN_CONFIDENTIAL'],
    [42, 'TOKEN_CONFIDENTIAL'],
    [43, 'TOKEN_SCALED_AMOUNT'],
    [44, 'TOKEN_PAUSE'],
    [46, 'TOKEN_BURN'],
  ]) {
    const result = token(tag, [255], [], TOKEN_2022_PROGRAM);
    has(result, code);
    has(result, 'TOKEN_CONFIG_CHANGE');
    has(result, 'UNSUPPORTED_INSTRUCTION');
    has(result, 'TOKEN_2022_STATE_UNINSPECTED');
    assert.equal(result.kind, 'unknown');
    assert.ok(result.flags.length <= 8);
  }
  const empty = decode(TOKEN_2022_PROGRAM, [], []);
  has(empty, 'TOKEN_2022_STATE_UNINSPECTED');
  has(empty, 'MALFORMED_INSTRUCTION');
});
void test('extension authority type warns before malformed replacement payload', () => {
  for (const [tag, code] of [
    [8, 'TOKEN_PERMANENT_DELEGATE'],
    [10, 'TOKEN_TRANSFER_HOOK'],
    [16, 'TOKEN_PAUSE'],
  ]) {
    const result = token(6, [tag, 1], [mint, payer], TOKEN_2022_PROGRAM);
    sensitive(result, code);
    sensitive(result, 'AUTHORITY_CHANGE');
    assert.equal(result.kind, 'malformed');
  }
});
void test('Stake common layouts support legacy sysvars and exact current account layouts', () => {
  const s = (tag, data, refs) =>
    decode(STAKE, Buffer.concat([u32(tag), Buffer.from(data)]), refs);
  for (const refs of [
    [account, destination, payer],
    [account, destination, CLOCK, HISTORY, CONFIG, payer],
  ])
    assert.equal(s(2, [], refs).kind, 'stakeDelegate');
  for (const refs of [
    [account, payer],
    [account, CLOCK, payer],
  ])
    assert.equal(s(5, [], refs).kind, 'stakeDeactivate');
  for (const refs of [
    [account, destination, payer],
    [account, destination, CLOCK, HISTORY, payer],
  ]) {
    const result = s(7, [], refs);
    assert.equal(result.kind, 'stakeMerge');
    sensitive(result, 'ACCOUNT_CLOSURE');
  }
  for (const refs of [
    [account, destination, payer],
    [account, destination, CLOCK, HISTORY, payer],
  ])
    assert.equal(s(4, u64(25), refs).fields.lamports, '25');
  for (const tag of [3, 16, 17])
    assert.equal(
      s(tag, u64(12), [account, destination, payer]).fields.lamports,
      '12',
    );
  assert.equal(
    s(14, [], [account, mint, destination]).kind,
    'stakeDeactivateDelinquent',
  );
  const query = s(13, [], []);
  assert.equal(query.kind, 'stakeGetMinimumDelegation');
  assert.ok(!flags(query).includes('STAKE_CHANGE'));
});
void test('Stake authority/lockup decodes never claim account state or current authorization', () => {
  const s = (tag, data, refs) =>
    decode(STAKE, Buffer.concat([u32(tag), Buffer.from(data)]), refs);
  for (const refs of [
    [account, payer],
    [account, CLOCK, payer],
  ]) {
    const result = s(1, Buffer.concat([pk(owner), u32(1)]), refs);
    assert.equal(result.kind, 'stakeAuthorize');
    assert.equal(result.fields.authorityType, 'Withdrawer');
    sensitive(result, 'AUTHORITY_CHANGE');
  }
  const checked = s(10, u32(0), [account, payer, owner]);
  assert.equal(checked.fields.newAuthority, owner);
  const init = s(
    0,
    Buffer.concat([pk(payer), pk(owner), u64(0), u64(3), pk(delegate)]),
    [account, RENT],
  );
  assert.equal(init.fields.lockupEpoch, '3');
  sensitive(init, 'AUTHORITY_CHANGE');
  assert.equal(
    s(9, [], [account, payer, owner]).kind,
    'stakeInitializeChecked',
  );
  assert.equal(s(6, [0, 0, 0], [account, payer]).kind, 'stakeSetLockup');
  assert.equal(
    s(12, [0, 0], [account, payer, owner]).fields.lockupCustodian,
    owner,
  );
  const malformed = s(1, Buffer.concat([pk(owner), u32(2)]), [account, payer]);
  assert.equal(malformed.kind, 'malformed');
  sensitive(malformed, 'AUTHORITY_CHANGE');
  const unsupported = s(8, [], []);
  has(unsupported, 'UNSUPPORTED_INSTRUCTION');
  sensitive(unsupported, 'AUTHORITY_CHANGE');
});
void test('ALT binary creates/extends/freezes/deactivates/closes with exact account mapping', () => {
  const l = (tag, data, refs) =>
    decode(LOOKUP, Buffer.concat([u32(tag), Buffer.from(data)]), refs);
  const created = l(0, Buffer.concat([u64(123), Buffer.from([255])]), [
    account,
    owner,
    payer,
    SYSTEM_PROGRAM,
  ]);
  assert.equal(created.kind, 'lookupTableCreate');
  assert.equal(created.fields.recentSlot, '123');
  const extended = l(2, Buffer.concat([u64(2), pk(mint), pk(destination)]), [
    account,
    owner,
  ]);
  assert.equal(extended.fields.newAddressCount, '2');
  assert.ok(Object.values(extended.fields).join().includes(destination));
  sensitive(l(1, [], [account, owner]), 'AUTHORITY_CHANGE');
  assert.equal(l(3, [], [account, owner]).kind, 'lookupTableDeactivate');
  sensitive(l(4, [], [account, owner, destination]), 'ACCOUNT_CLOSURE');
  assert.equal(
    l(2, u64('18446744073709551615'), [account, owner]).kind,
    'malformed',
  );
});
void test('Compute, ATA and Memo raw adapters work without RPC program labels', () => {
  const compute = decode(
    COMPUTE_BUDGET_PROGRAM,
    Buffer.concat([Buffer.from([3]), u64('18446744073709551615')]),
    [],
  );
  assert.equal(
    compute.fields.microLamportsPerComputeUnit,
    '18446744073709551615',
  );
  has(compute, 'COMPUTE_BUDGET');
  const ata = decode(
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    [1],
    [payer, account, owner, mint, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM],
  );
  assert.equal(ata.kind, 'associatedTokenCreateIdempotent');
  has(ata, 'TOKEN_2022_STATE_UNINSPECTED');
  const memo = decode(
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    Buffer.from('<script>example</script>'),
    [],
  );
  assert.equal(memo.fields.memo, '"<script>example</script>"');
  has(memo, 'MEMO');
  const unknown = decode(key(99), [4, 1], []);
  has(unknown, 'UNKNOWN_PROGRAM');
  assert.deepEqual(unknown.fields, {});
});
void test('all discriminators remain bounded and unknown or malformed forms never throw', () => {
  for (const program of [
    SYSTEM_PROGRAM,
    STAKE,
    LOOKUP,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
  ])
    for (let tag = 0; tag <= 255; tag++) {
      const result = decode(
        program,
        program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM
          ? [tag]
          : u32(tag),
        [],
      );
      assert.ok(result.flags.length <= 8);
      assert.ok(Object.keys(result.fields).length <= 16);
      assert.ok(result.flags.every((flag) => flag.message.length <= 512));
    }
});
