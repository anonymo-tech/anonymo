import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { decodeCoreInstruction } from '../server/solana/explain-core.ts';
import { explainParsedTransaction } from '../server/solana/explain.ts';
import { parseExplanation } from '../lib/client/solana.ts';
import {
  COMPUTE_BUDGET_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  SOLANA_NETWORKS,
} from '../server/solana/validation.ts';

const key = (n) => bs58.encode(new Uint8Array(32).fill(n));
const keys = Array.from({ length: 80 }, (_, i) => key(i + 1));
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const STAKE = 'Stake11111111111111111111111111111111111111';
const ALT = 'AddressLookupTab1e1111111111111111111111111';
const MEMOS = [
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH',
];
const parsed = (programId, type, info) => ({
  programId,
  program: 'untrusted-label',
  parsed: { type, info },
});
function decode(raw) {
  const result = {
    location: '0',
    programId: raw.programId,
    kind: 'unknown',
    description: 'Not decoded.',
    fields: {},
    flags: [],
  };
  return { recognized: decodeCoreInstruction(raw, result), ...result };
}
function explain(raw) {
  return explainParsedTransaction({
    slot: 1,
    version: 0,
    transaction: {
      signatures: [bs58.encode(new Uint8Array(64).fill(9))],
      message: { instructions: [raw] },
    },
    meta: { err: null, innerInstructions: [] },
  }).instructions[0];
}
function hasFlag(result, code, severity) {
  return result.flags.some(
    (flag) => flag.code === code && (!severity || flag.severity === severity),
  );
}
function malformed(raw, flag) {
  const result = explain(raw);
  assert.equal(result.kind, 'unknown');
  assert.deepEqual(result.fields, {});
  assert.ok(hasFlag(result, 'MALFORMED_INSTRUCTION'));
  if (flag) assert.ok(hasFlag(result, flag));
  return result;
}
const addresses = (names) =>
  Object.fromEntries(names.map((name, i) => [name, keys[i]]));
const systemTransfer = { source: keys[0], destination: keys[1], lamports: 25 };

void test('dispatch trusts only exact program IDs, never the RPC display label', () => {
  assert.equal(
    decode({
      ...parsed(keys[0], 'transfer', systemTransfer),
      program: 'system',
    }).recognized,
    false,
  );
  assert.equal(
    decode(parsed(SYSTEM_PROGRAM, 'transfer', systemTransfer)).kind,
    'systemTransfer',
  );
  for (const type of ['constructor', 'toString', 'newVariant']) {
    const result = decode(parsed(SYSTEM_PROGRAM, type, {}));
    assert.equal(result.recognized, true);
    assert.ok(hasFlag(result, 'UNSUPPORTED_INSTRUCTION'));
  }
  malformed(
    parsed(SYSTEM_PROGRAM, { toString: () => 'transfer' }, systemTransfer),
  );
});

void test('System transfer amounts are exact; rounded numbers and coercions fail visibly', () => {
  for (const [input, expected] of [
    [0, '0'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    ['18446744073709551615', '18446744073709551615'],
  ]) {
    const result = decode(
      parsed(SYSTEM_PROGRAM, 'transfer', {
        ...systemTransfer,
        lamports: input,
      }),
    );
    assert.equal(result.fields.lamports, expected);
    assert.ok(hasFlag(result, 'SOL_TRANSFER'));
  }
  for (const lamports of [
    Number.MAX_SAFE_INTEGER + 1,
    1.25,
    -1,
    '18446744073709551616',
    '01',
    '+1',
    '-0',
    '',
    null,
    true,
    {},
    '1e6',
  ])
    malformed(
      parsed(SYSTEM_PROGRAM, 'transfer', { ...systemTransfer, lamports }),
      'SOL_TRANSFER',
    );
});

void test('System seeded transfer preserves the requested seed and required authority base', () => {
  const info = {
    ...systemTransfer,
    sourceBase: keys[2],
    sourceOwner: keys[3],
    sourceSeed: 'é'.repeat(16),
  };
  const result = decode(parsed(SYSTEM_PROGRAM, 'transferWithSeed', info));
  assert.equal(result.kind, 'systemTransferWithSeed');
  assert.equal(result.fields.sourceSeed, JSON.stringify(info.sourceSeed));
  malformed(
    parsed(SYSTEM_PROGRAM, 'transferWithSeed', {
      ...info,
      sourceBase: undefined,
    }),
    'SOL_TRANSFER',
  );
  malformed(
    parsed(SYSTEM_PROGRAM, 'transferWithSeed', {
      ...info,
      sourceSeed: 'é'.repeat(17),
    }),
    'SOL_TRANSFER',
  );
  malformed(
    parsed(SYSTEM_PROGRAM, 'transferWithSeed', {
      ...info,
      sourceSeed: '\ud800',
    }),
    'SOL_TRANSFER',
  );
});

void test('System create, assign, allocate and prefunded account forms have distinct effects', () => {
  const common = {
    ...addresses(['source', 'newAccount', 'account', 'owner', 'base']),
    lamports: '9007199254740992',
    space: '18446744073709551615',
    seed: 'seed',
  };
  for (const type of [
    'createAccount',
    'createAccountWithSeed',
    'allocate',
    'allocateWithSeed',
    'assign',
    'assignWithSeed',
  ]) {
    const result = decode(parsed(SYSTEM_PROGRAM, type, common));
    assert.notEqual(result.kind, 'unknown');
    if (type.startsWith('assign') || type === 'allocateWithSeed')
      assert.ok(hasFlag(result, 'AUTHORITY_CHANGE', 'critical'));
    if (type.startsWith('allocate'))
      assert.equal(result.fields.space, common.space);
  }
  const info = { newAccount: keys[0], owner: keys[1], space: 100 };
  const unfunded = decode(
    parsed(SYSTEM_PROGRAM, 'createAccountAllowPrefund', info),
  );
  assert.equal(unfunded.fields.lamports, undefined);
  assert.equal(unfunded.fields.source, undefined);
  assert.equal(hasFlag(unfunded, 'SOL_TRANSFER'), false);
  assert.equal(
    decode(
      parsed(SYSTEM_PROGRAM, 'createAccountAllowPrefund', {
        ...info,
        source: keys[2],
        lamports: '2',
      }),
    ).fields.lamports,
    '2',
  );
  malformed(
    parsed(SYSTEM_PROGRAM, 'createAccountAllowPrefund', {
      ...info,
      source: keys[2],
    }),
    'SOL_TRANSFER',
  );
  assert.ok(
    hasFlag(
      malformed(
        parsed(SYSTEM_PROGRAM, 'assign', { account: keys[0], owner: 123 }),
        'AUTHORITY_CHANGE',
      ),
      'AUTHORITY_CHANGE',
      'critical',
    ),
  );
});

void test('durable nonce actions preserve change and authority warnings before malformed info', () => {
  const info = {
    ...addresses([
      'nonceAccount',
      'recentBlockhashesSysvar',
      'rentSysvar',
      'nonceAuthority',
      'newAuthorized',
      'destination',
    ]),
    lamports: '18446744073709551615',
  };
  for (const type of [
    'advanceNonce',
    'withdrawFromNonce',
    'initializeNonce',
    'authorizeNonce',
    'upgradeNonce',
  ]) {
    const result = decode(parsed(SYSTEM_PROGRAM, type, info));
    assert.ok(hasFlag(result, 'NONCE_CHANGE'));
    assert.notEqual(result.kind, 'unknown');
  }
  const result = malformed(
    parsed(SYSTEM_PROGRAM, 'authorizeNonce', null),
    'NONCE_CHANGE',
  );
  assert.ok(hasFlag(result, 'AUTHORITY_CHANGE', 'critical'));
  malformed(
    parsed(SYSTEM_PROGRAM, 'withdrawFromNonce', {
      ...info,
      nonceAuthority: undefined,
    }),
    'SOL_TRANSFER',
  );
});

function compute(tag, value, width = tag === 3 ? 8 : 4) {
  const bytes = new Uint8Array(width + 1);
  bytes[0] = tag;
  if (width === 8)
    new DataView(bytes.buffer).setBigUint64(1, BigInt(value), true);
  else new DataView(bytes.buffer).setUint32(1, value, true);
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: bs58.encode(bytes),
  };
}
void test('raw Compute Budget decodes exact little-endian u32 and u64 fields', () => {
  const expectations = [
    [1, 32768, 'heapBytes'],
    [2, 1400000, 'computeUnits'],
    [3, 18446744073709551615n, 'microLamportsPerComputeUnit'],
    [4, 0xffffffff, 'loadedAccountBytes'],
  ];
  for (const [tag, value, name] of expectations) {
    const result = decode(compute(tag, value));
    assert.equal(result.fields[name], String(value));
    assert.ok(hasFlag(result, 'COMPUTE_BUDGET'));
    assert.equal(hasFlag(result, 'UNSUPPORTED_INSTRUCTION'), false);
  }
});

void test('Compute Budget rejects truncated/trailing fields and retains unsupported variants', () => {
  const valid = compute(3, 1n);
  const bytes = bs58.decode(valid.data);
  malformed(
    { ...valid, data: bs58.encode(bytes.slice(0, 8)) },
    'COMPUTE_BUDGET',
  );
  malformed(
    { ...valid, data: bs58.encode(new Uint8Array([...bytes, 0])) },
    'COMPUTE_BUDGET',
  );
  malformed({ ...valid, data: '0OIl' }, 'COMPUTE_BUDGET');
  for (const tag of [0, 5, 255])
    assert.ok(
      hasFlag(
        decode({ ...valid, data: bs58.encode(Uint8Array.of(tag)) }),
        'UNSUPPORTED_INSTRUCTION',
      ),
    );
  assert.ok(
    hasFlag(
      decode(
        parsed(COMPUTE_BUDGET_PROGRAM, 'setComputeUnitPrice', {
          microLamports: 1,
        }),
      ),
      'UNSUPPORTED_INSTRUCTION',
    ),
  );
});

const ataInfo = {
  ...addresses(['source', 'account', 'wallet', 'mint']),
  systemProgram: SYSTEM_PROGRAM,
  tokenProgram: TOKEN_PROGRAM,
};
void test('ATA parsed, raw and deprecated empty create forms use exact account positions', () => {
  const accounts = Object.values(ataInfo);
  for (const data of [
    '',
    bs58.encode(Uint8Array.of(0)),
    bs58.encode(Uint8Array.of(1)),
  ]) {
    const result = decode({
      programId: ATA,
      accounts: [...accounts, keys[20]],
      data,
    });
    assert.equal(result.fields.account, ataInfo.account);
    assert.equal(result.fields.wallet, ataInfo.wallet);
    assert.equal(result.fields.mint, ataInfo.mint);
    assert.ok(hasFlag(result, 'ACCOUNT_CREATION'));
  }
  assert.equal(
    decode(parsed(ATA, 'createIdempotent', ataInfo)).kind,
    'associatedTokenCreateIdempotent',
  );
  assert.ok(
    hasFlag(
      decode(
        parsed(ATA, 'create', { ...ataInfo, tokenProgram: TOKEN_2022_PROGRAM }),
      ),
      'TOKEN_2022_STATE_UNINSPECTED',
    ),
  );
  assert.ok(
    hasFlag(
      decode(parsed(ATA, 'create', { ...ataInfo, tokenProgram: keys[10] })),
      'UNSUPPORTED_TOKEN_PROGRAM',
    ),
  );
  malformed(
    parsed(ATA, 'create', { ...ataInfo, systemProgram: keys[11] }),
    'ACCOUNT_CREATION',
  );
});

void test('ATA nested recovery shows closure and transfers even when accounts or bytes are malformed', () => {
  const info = {
    ...addresses([
      'nestedSource',
      'nestedMint',
      'destination',
      'nestedOwner',
      'ownerMint',
      'wallet',
    ]),
    tokenProgram: TOKEN_PROGRAM,
  };
  const raw = {
    programId: ATA,
    data: bs58.encode(Uint8Array.of(2)),
    accounts: Object.values(info),
  };
  const result = decode(raw);
  assert.equal(result.kind, 'associatedTokenRecoverNested');
  assert.deepEqual(result.fields, info);
  assert.ok(hasFlag(result, 'ACCOUNT_CLOSURE', 'critical'));
  malformed({ ...raw, accounts: [] }, 'ACCOUNT_CLOSURE');
  malformed(
    { ...raw, data: bs58.encode(Uint8Array.of(2, 0)) },
    'ACCOUNT_CLOSURE',
  );
  malformed(parsed(ATA, 'recoverNested', {}), 'ACCOUNT_CLOSURE');
});

void test('Stake initialization validates signed timestamps and exact lockup values', () => {
  const info = {
    stakeAccount: keys[0],
    authorized: { staker: keys[1], withdrawer: keys[2] },
    lockup: {
      unixTimestamp: '-9223372036854775808',
      epoch: '18446744073709551615',
      custodian: keys[3],
    },
  };
  const result = decode(parsed(STAKE, 'initialize', info));
  assert.equal(result.fields.lockupUnixTimestamp, '-9223372036854775808');
  assert.equal(result.fields.lockupEpoch, '18446744073709551615');
  assert.equal(result.fields.staker, keys[1]);
  assert.ok(hasFlag(result, 'AUTHORITY_CHANGE', 'critical'));
  for (const unixTimestamp of [
    '-9223372036854775809',
    '9223372036854775808',
    Number.MAX_SAFE_INTEGER + 1,
    '-0',
    true,
  ])
    malformed(
      parsed(STAKE, 'initialize', {
        ...info,
        lockup: { ...info.lockup, unixTimestamp },
      }),
      'AUTHORITY_CHANGE',
    );
});

void test('Stake exact authority enum and seed forms reject object/incorrect-case coercions', () => {
  const info = {
    ...addresses([
      'stakeAccount',
      'authority',
      'newAuthority',
      'authorityBase',
      'newAuthorized',
      'authorityOwner',
    ]),
    authoritySeed: 'seed',
    authorityType: 'Withdrawer',
  };
  for (const type of [
    'authorize',
    'authorizeChecked',
    'authorizeWithSeed',
    'authorizeCheckedWithSeed',
  ]) {
    const result = decode(parsed(STAKE, type, info));
    assert.equal(result.fields.authorityType, 'Withdrawer');
    assert.ok(hasFlag(result, 'AUTHORITY_CHANGE', 'critical'));
    malformed(
      parsed(STAKE, type, { ...info, authorityType: 'withdrawer' }),
      'AUTHORITY_CHANGE',
    );
    malformed(
      parsed(STAKE, type, {
        ...info,
        authorityType: { toString: () => 'Withdrawer' },
      }),
      'AUTHORITY_CHANGE',
    );
  }
});

void test('Stake account operations cover current layouts without inferring omitted authorities', () => {
  const info = {
    ...addresses([
      'stakeAccount',
      'staker',
      'withdrawer',
      'voteAccount',
      'referenceVoteAccount',
      'newSplitAccount',
      'newStakeAccount',
      'stakeConfigAccount',
      'source',
      'destination',
      'stakeAuthority',
      'withdrawAuthority',
    ]),
    lamports: '9007199254740992',
  };
  for (const type of [
    'initializeChecked',
    'delegate',
    'split',
    'withdraw',
    'deactivate',
    'merge',
    'deactivateDelinquent',
    'moveStake',
    'moveLamports',
  ]) {
    const result = decode(parsed(STAKE, type, info));
    assert.notEqual(result.kind, 'unknown');
    assert.ok(hasFlag(result, 'STAKE_CHANGE'));
  }
  const minimal = {
    stakeAccount: keys[0],
    voteAccount: keys[1],
    stakeAuthority: keys[2],
  };
  assert.equal(
    decode(parsed(STAKE, 'delegate', minimal)).kind,
    'stakeDelegate',
  );
  malformed(
    parsed(STAKE, 'delegate', { ...minimal, stakeAuthority: undefined }),
    'STAKE_CHANGE',
  );
  const delinquent = decode(
    parsed(STAKE, 'deactivateDelinquent', {
      stakeAccount: keys[0],
      voteAccount: keys[1],
      referenceVoteAccount: keys[2],
    }),
  );
  assert.equal(delinquent.fields.stakeAuthority, undefined);
  assert.ok(
    hasFlag(
      decode(parsed(STAKE, 'redelegate', info)),
      'UNSUPPORTED_INSTRUCTION',
    ),
  );
});

void test('Stake lockup updates and minimum-delegation queries avoid fabricated results', () => {
  for (const type of ['setLockup', 'setLockupChecked']) {
    const info = {
      stakeAccount: keys[0],
      custodian: keys[1],
      lockup: { unixTimestamp: -100, epoch: '9', custodian: keys[2] },
    };
    const result = decode(parsed(STAKE, type, info));
    assert.equal(result.fields.lockupCustodian, keys[2]);
    assert.equal(result.fields.custodian, keys[1]);
    assert.equal(result.fields.lockupUnixTimestamp, '-100');
    assert.notEqual(
      decode(parsed(STAKE, type, { ...info, lockup: {} })).kind,
      'unknown',
    );
  }
  for (const info of [undefined, null]) {
    const result = decode(parsed(STAKE, 'getMinimumDelegation', info));
    assert.equal(result.kind, 'stakeGetMinimumDelegation');
    assert.deepEqual(result.fields, {});
  }
});

void test('ALT create/freeze/deactivate/close bind the exact authority and recipient', () => {
  const info = {
    lookupTableAccount: keys[0],
    lookupTableAuthority: keys[1],
    payerAccount: keys[2],
    systemProgram: SYSTEM_PROGRAM,
    recentSlot: '9007199254740992',
    bumpSeed: 255,
    recipient: keys[3],
  };
  for (const type of [
    'createLookupTable',
    'freezeLookupTable',
    'deactivateLookupTable',
    'closeLookupTable',
  ]) {
    const result = decode(parsed(ALT, type, info));
    assert.ok(hasFlag(result, 'ADDRESS_LOOKUP_TABLE'));
    assert.notEqual(result.kind, 'unknown');
  }
  assert.equal(
    decode(parsed(ALT, 'createLookupTable', info)).fields.recentSlot,
    info.recentSlot,
  );
  assert.ok(
    hasFlag(
      malformed(parsed(ALT, 'freezeLookupTable', {}), 'AUTHORITY_CHANGE'),
      'AUTHORITY_CHANGE',
      'critical',
    ),
  );
  assert.ok(
    hasFlag(
      malformed(parsed(ALT, 'closeLookupTable', {}), 'ACCOUNT_CLOSURE'),
      'ACCOUNT_CLOSURE',
      'critical',
    ),
  );
  malformed(
    parsed(ALT, 'createLookupTable', { ...info, bumpSeed: 256 }),
    'ADDRESS_LOOKUP_TABLE',
  );
});

void test('ALT extension displays bounded complete addresses or explicitly reports omission', () => {
  const info = {
    lookupTableAccount: keys[0],
    lookupTableAuthority: keys[1],
    newAddresses: keys.slice(2, 52),
  };
  const result = decode(parsed(ALT, 'extendLookupTable', info));
  assert.equal(result.fields.newAddressCount, '50');
  assert.equal(
    Object.values(result.fields)
      .filter((v) => v.includes('\n'))
      .join('\n'),
    info.newAddresses.join('\n'),
  );
  const long = decode(
    parsed(ALT, 'extendLookupTable', {
      ...info,
      newAddresses: keys.slice(2, 53),
    }),
  );
  assert.equal(long.fields.newAddressCount, '51');
  assert.ok(hasFlag(long, 'INCOMPLETE_METADATA'));
  assert.equal(long.fields.newAddresses1, undefined);
  malformed(
    parsed(ALT, 'extendLookupTable', { ...info, newAddresses: [null] }),
    'ADDRESS_LOOKUP_TABLE',
  );
  malformed(
    parsed(ALT, 'extendLookupTable', { ...info, payerAccount: keys[6] }),
    'ADDRESS_LOOKUP_TABLE',
  );
  for (const output of [result, long]) {
    assert.ok(Object.keys(output.fields).length <= 16);
    assert.ok(
      Object.values(output.fields).every((value) => value.length <= 256),
    );
  }
});

void test('Memo supports current and legacy program IDs, strict UTF-8, and literal text', () => {
  const memo = '<img src=x> invoice\nnot proof';
  for (const programId of MEMOS) {
    for (const raw of [
      { programId, parsed: memo },
      {
        programId,
        accounts: [keys[0]],
        data: bs58.encode(new TextEncoder().encode(memo)),
      },
    ]) {
      const result = decode(raw);
      assert.equal(result.fields.memo, JSON.stringify(memo));
      assert.equal(result.kind, 'memo');
      assert.equal(result.fields.signer, undefined);
      assert.ok(hasFlag(result, 'MEMO'));
    }
  }
  malformed(
    { programId: MEMOS[1], data: bs58.encode(Uint8Array.of(0xc0, 0xaf)) },
    'MEMO',
  );
  malformed({ programId: MEMOS[1], parsed: 'unsafe\u0000text' }, 'MEMO');
  malformed(
    { programId: MEMOS[1], parsed: { type: 'memo', info: memo } },
    'MEMO',
  );
  const oversized = decode({ programId: MEMOS[1], parsed: 'a'.repeat(257) });
  assert.equal(oversized.fields.memo, undefined);
  assert.ok(hasFlag(oversized, 'UNSUPPORTED_INSTRUCTION'));
});

void test('unsupported raw programs and unknown types never claim full deterministic coverage', () => {
  for (const programId of [SYSTEM_PROGRAM, STAKE, ALT]) {
    const result = decode({ programId, accounts: [], data: '1' });
    assert.equal(result.recognized, true);
    assert.equal(result.kind, 'unknown');
    assert.ok(hasFlag(result, 'UNSUPPORTED_INSTRUCTION'));
  }
  for (const programId of [STAKE, ALT, ATA])
    assert.ok(
      hasFlag(
        decode(parsed(programId, 'futureVariant', {})),
        'UNSUPPORTED_INSTRUCTION',
      ),
    );
});

void test('empty and whitespace text round-trips through the real client as explicit quoted literals', () => {
  for (const value of ['', ' ', '\t\n\r', '"\\']) {
    const rawInstructions = [
      parsed(SYSTEM_PROGRAM, 'assignWithSeed', {
        account: keys[0],
        base: keys[1],
        owner: keys[2],
        seed: value,
      }),
      { programId: MEMOS[1], parsed: value },
    ];
    const signature = bs58.encode(new Uint8Array(64).fill(20));
    const output = explainParsedTransaction({
      slot: 1,
      transaction: {
        signatures: [signature],
        message: { instructions: rawInstructions },
      },
      meta: { err: null, innerInstructions: [] },
    });
    const checked = parseExplanation(
      {
        ...output,
        cluster: 'devnet',
        genesisHash: SOLANA_NETWORKS.devnet.genesisHash,
        finality: 'finalized',
        flags: output.flags.filter(
          (flag) => flag.code !== 'FINALITY_UNVERIFIED',
        ),
      },
      signature,
    );
    assert.equal(checked.instructions[0].fields.seed, JSON.stringify(value));
    assert.equal(checked.instructions[1].fields.memo, JSON.stringify(value));
  }
});

void test('Memo quoted expansion never exceeds the public field bound or truncates its content', () => {
  const accepted = decode({ programId: MEMOS[1], parsed: 'a'.repeat(254) });
  assert.equal(accepted.fields.memo.length, 256);
  for (const value of ['a'.repeat(255), '\n'.repeat(128), '"'.repeat(128)]) {
    const output = decode({ programId: MEMOS[1], parsed: value });
    assert.equal(output.fields.memo, undefined);
    assert.ok(hasFlag(output, 'UNSUPPORTED_INSTRUCTION'));
  }
});
