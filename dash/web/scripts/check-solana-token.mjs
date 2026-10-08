import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { decodeTokenInstruction } from '../server/solana/explain-token.ts';
import { explainParsedTransaction } from '../server/solana/explain.ts';
import {
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  SolanaError,
} from '../server/solana/validation.ts';

const key = (n) => bs58.encode(new Uint8Array(32).fill(n));
const [
  account,
  mint,
  owner,
  source,
  destination,
  delegate,
  authority,
  rentSysvar,
  programId,
  registry,
] = Array.from({ length: 10 }, (_, i) => key(i + 1));
const tokenAmount = {
  amount: '18446744073709551615',
  decimals: 6,
  uiAmount: null,
  uiAmountString: 'not authoritative',
};
const ciphertext = Buffer.alloc(36, 1).toString('base64');
const pubkey = Buffer.alloc(32, 2).toString('base64');
const raw = (type, info, tokenProgram = TOKEN_2022_PROGRAM) => ({
  programId: tokenProgram,
  parsed: { type, info },
});
function decode(type, info, tokenProgram = TOKEN_2022_PROGRAM) {
  const result = {
    location: '0',
    programId: tokenProgram,
    kind: 'unknown',
    description: 'Not decoded.',
    fields: {},
    flags: [],
  };
  assert.equal(
    decodeTokenInstruction(raw(type, info, tokenProgram), result),
    true,
  );
  return result;
}
function explanation(instruction) {
  return explainParsedTransaction({
    slot: 123,
    transaction: {
      signatures: [bs58.encode(new Uint8Array(64).fill(7))],
      message: { instructions: [instruction] },
    },
    meta: { err: null, innerInstructions: [] },
  }).instructions[0];
}
const codes = (value) => value.flags.map((f) => f.code);
const bad = (type, info, program = TOKEN_2022_PROGRAM) =>
  assert.throws(() => decode(type, info, program), SolanaError);
// Synthetic accounts; field names follow the official Agave parsed JSON shapes.
const common = [
  [
    'transfer',
    { source, destination, authority, amount: '18446744073709551615' },
  ],
  ['transferChecked', { source, destination, mint, authority, tokenAmount }],
  ['approve', { source, delegate, owner, amount: '50' }],
  ['approveChecked', { source, delegate, mint, owner, tokenAmount }],
  ['mintTo', { account, mint, mintAuthority: authority, amount: '42' }],
  ['mintToChecked', { account, mint, mintAuthority: authority, tokenAmount }],
  ['burn', { account, mint, authority, amount: '42' }],
  ['burnChecked', { account, mint, authority, tokenAmount }],
  ['revoke', { source, owner }],
  [
    'setAuthority',
    { mint, authority, authorityType: 'mintTokens', newAuthority: null },
  ],
  ['closeAccount', { account, destination, owner }],
  ['freezeAccount', { account, mint, freezeAuthority: authority }],
  ['thawAccount', { account, mint, freezeAuthority: authority }],
  [
    'initializeMint',
    { mint, mintAuthority: authority, decimals: 6, rentSysvar },
  ],
  [
    'initializeMint2',
    { mint, mintAuthority: authority, decimals: 6, freezeAuthority: owner },
  ],
  ['initializeAccount', { account, mint, owner, rentSysvar }],
  ['initializeAccount2', { account, mint, owner, rentSysvar }],
  ['initializeAccount3', { account, mint, owner }],
  [
    'initializeMultisig',
    { multisig: account, m: 2, signers: [owner, authority], rentSysvar },
  ],
  [
    'initializeMultisig2',
    { multisig: account, m: 1, signers: [owner, authority] },
  ],
  ['syncNative', { account }],
];
const extensions = [
  [
    'transferCheckedWithFee',
    {
      source,
      destination,
      mint,
      authority,
      tokenAmount: { amount: '10000', decimals: 6 },
      feeAmount: { amount: '100', decimals: 6 },
    },
  ],
  [
    'initializeTransferFeeConfig',
    { mint, transferFeeBasisPoints: 25, maximumFee: 5000 },
  ],
  [
    'setTransferFee',
    {
      mint,
      transferFeeBasisPoints: 25,
      maximumFee: '18446744073709551615',
      transferFeeConfigAuthority: authority,
    },
  ],
  [
    'withdrawWithheldTokensFromMint',
    { mint, feeRecipient: destination, withdrawWithheldAuthority: authority },
  ],
  [
    'withdrawWithheldTokensFromAccounts',
    {
      mint,
      feeRecipient: destination,
      withdrawWithheldAuthority: authority,
      sourceAccounts: [source, account],
    },
  ],
  ['harvestWithheldTokensToMint', { mint, sourceAccounts: [source, account] }],
  ['initializeTransferHook', { mint }],
  ['updateTransferHook', { mint, authority, programId }],
  ['initializePermanentDelegate', { mint, delegate }],
  ['initializeMintCloseAuthority', { mint, newAuthority: null }],
  ['initializeNonTransferableMint', { mint }],
  ['initializeImmutableOwner', { account }],
  ['initializeDefaultAccountState', { mint, accountState: 'frozen' }],
  [
    'updateDefaultAccountState',
    { mint, accountState: 'initialized', freezeAuthority: authority },
  ],
  ...[
    'enableCpiGuard',
    'disableCpiGuard',
    'enableRequiredMemoTransfers',
    'disableRequiredMemoTransfers',
  ].map((type) => [type, { account, owner }]),
  [
    'initializeScaledUiAmountConfig',
    { mint, authority: null, multiplier: '1.5' },
  ],
  [
    'updateMultiplier',
    {
      mint,
      authority,
      newMultiplier: '1.1',
      newMultiplierTimestamp: 1700000000,
    },
  ],
  ['initializePausableConfig', { mint, authority: null }],
  ['pause', { mint, authority }],
  ['resume', { mint, authority }],
  [
    'initializeConfidentialTransferMint',
    { mint, autoApproveNewAccounts: false, auditorElGamalPubkey: null },
  ],
  [
    'updateConfidentialTransferMint',
    {
      mint,
      confidentialTransferMintAuthority: authority,
      autoApproveNewAccounts: true,
      auditorElGamalPubkey: pubkey,
    },
  ],
  [
    'approveConfidentialTransferAccount',
    { account, mint, confidentialTransferAuditorAuthority: authority },
  ],
  ['configureConfidentialAccountWithRegistry', { account, mint, registry }],
  [
    'configureConfidentialTransferAccount',
    {
      account,
      mint,
      owner,
      decryptableZeroBalance: ciphertext,
      maximumPendingBalanceCreditCounter: 65536,
      proofInstructionOffset: 0,
      proofContextStateAccount: registry,
    },
  ],
  [
    'emptyConfidentialTransferAccount',
    {
      account,
      owner,
      proofInstructionOffset: -1,
      instructionsSysvar: registry,
    },
  ],
  [
    'depositConfidentialTransfer',
    { account, mint, owner, amount: 123, decimals: 6 },
  ],
  [
    'withdrawConfidentialTransfer',
    {
      account,
      mint,
      owner,
      amount: 123,
      decimals: 6,
      newDecryptableAvailableBalance: ciphertext,
      equalityProofInstructionOffset: 0,
      equalityProofContextStateAccount: registry,
      rangeProofInstructionOffset: -1,
      instructionsSysvar: rentSysvar,
    },
  ],
  [
    'confidentialTransfer',
    {
      source,
      mint,
      destination,
      owner,
      newSourceDecryptableAvailableBalance: ciphertext,
      equalityProofInstructionOffset: -3,
      ciphertextValidityProofInstructionOffset: -2,
      rangeProofInstructionOffset: -1,
      instructionsSysvar: registry,
    },
  ],
  [
    'confidentialTransferWithFee',
    {
      source,
      mint,
      destination,
      owner,
      newSourceDecryptableAvailableBalance: ciphertext,
      equalityProofInstructionOffset: -5,
      transferAmountCiphertextValidityProofInstructionOffset: -4,
      feeSigmaProofInstructionOffset: -3,
      feeCiphertextValidityProofInstructionOffset: -2,
      rangeProofInstructionOffset: -1,
      instructionsSysvar: registry,
    },
  ],
  [
    'applyPendingConfidentialTransferBalance',
    {
      account,
      owner,
      newDecryptableAvailableBalance: ciphertext,
      expectedPendingBalanceCreditCounter: 3,
    },
  ],
  ...[
    'enableConfidentialTransferConfidentialCredits',
    'disableConfidentialTransferConfidentialCredits',
    'enableConfidentialTransferNonConfidentialCredits',
    'disableConfidentialTransferNonConfidentialCredits',
  ].map((type) => [type, { account, owner }]),
];

void test('21 common instruction shapes decode on both token programs', () => {
  for (const [type, info] of common)
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const result = decode(type, info, program);
      assert.equal(result.kind, type);
      assert.ok(!codes(result).includes('UNSUPPORTED_INSTRUCTION'));
      assert.equal(
        codes(result).includes('TOKEN_2022_STATE_UNINSPECTED'),
        program === TOKEN_2022_PROGRAM,
      );
    }
});
void test('38 extension instruction shapes preserve state warning and response display bounds', () => {
  assert.equal(extensions.length, 38);
  for (const [type, info] of extensions) {
    const result = decode(type, info);
    assert.equal(result.kind, type, type);
    assert.ok(codes(result).includes('TOKEN_2022_STATE_UNINSPECTED'), type);
    assert.ok(!codes(result).includes('UNSUPPORTED_INSTRUCTION'), type);
    assert.ok(Object.keys(result.fields).length <= 16, type);
    assert.ok(
      Object.values(result.fields).every(
        (v) => typeof v === 'string' && v.length <= 256,
      ),
      type,
    );
    assert.ok(result.flags.length <= 8, type);
  }
});
void test('unknown, unparsed and malformed Token-2022 instructions remain visibly uninspected', () => {
  for (const instruction of [
    raw('futureInstruction', {}),
    { programId: TOKEN_2022_PROGRAM, data: 'opaque' },
    raw('pause', null),
    raw('transfer', {}),
  ]) {
    const result = explanation(instruction);
    assert.equal(result.kind, 'unknown');
    assert.ok(codes(result).includes('TOKEN_2022_STATE_UNINSPECTED'));
    assert.ok(
      codes(result).some(
        (c) => c === 'MALFORMED_INSTRUCTION' || c === 'UNSUPPORTED_INSTRUCTION',
      ),
    );
  }
});
void test('spoofed program labels cannot select the token decoder', () => {
  const result = {
    location: '0',
    programId: key(90),
    kind: 'unknown',
    description: '',
    fields: {},
    flags: [],
  };
  assert.equal(
    decodeTokenInstruction(
      {
        ...raw('transfer', common[0][1]),
        programId: key(90),
        program: 'spl-token',
      },
      result,
    ),
    false,
  );
  assert.deepEqual(result.flags, []);
});
void test('critical warnings survive invalid info, missing fields and malformed authorities', () => {
  for (const [type, code] of [
    ['approve', 'TOKEN_APPROVAL'],
    ['approveChecked', 'TOKEN_APPROVAL'],
    ['setAuthority', 'AUTHORITY_CHANGE'],
    ['closeAccount', 'ACCOUNT_CLOSURE'],
    ['burn', 'TOKEN_BURN'],
    ['burnChecked', 'TOKEN_BURN'],
    ['mintTo', 'TOKEN_MINT'],
    ['freezeAccount', 'TOKEN_FREEZE'],
    ['thawAccount', 'TOKEN_FREEZE'],
    ['initializePermanentDelegate', 'TOKEN_PERMANENT_DELEGATE'],
    ['updateTransferHook', 'TOKEN_TRANSFER_HOOK'],
    ['pause', 'TOKEN_PAUSE'],
    ['setTransferFee', 'TOKEN_CONFIG_CHANGE'],
  ])
    for (const info of [null, {}, { owner: 'invalid' }]) {
      const result = explanation(raw(type, info));
      assert.equal(result.kind, 'unknown');
      assert.deepEqual(result.fields, {});
      assert.equal(
        result.flags.find((f) => f.code === code)?.severity,
        'critical',
        type,
      );
      assert.ok(codes(result).includes('MALFORMED_INSTRUCTION'));
    }
});
void test('legacy extension names never assert Token-2022 protections', () => {
  for (const [type, info] of [
    ['initializeImmutableOwner', { account }],
    ['pause', { mint, authority }],
  ])
    assert.ok(
      codes(decode(type, info, TOKEN_PROGRAM)).includes(
        'UNSUPPORTED_INSTRUCTION',
      ),
    );
});
void test('known unsupported configuration changes still retain critical classification', () => {
  for (const type of [
    'initializeConfidentialTransferFeeConfig',
    'enableConfidentialTransferFeeHarvestToMint',
    'disableConfidentialTransferFeeHarvestToMint',
    'initializeInterestBearingConfig',
    'updateInterestBearingConfigRate',
  ]) {
    const result = decode(type, {});
    assert.equal(result.kind, 'unknown');
    assert.ok(codes(result).includes('UNSUPPORTED_INSTRUCTION'));
    assert.equal(
      result.flags.find((flag) => flag.code === 'TOKEN_CONFIG_CHANGE')
        ?.severity,
      'critical',
    );
  }
});
void test('raw u64 text is exact and UI amounts cannot override it', () => {
  assert.equal(
    decode('transferChecked', common[1][1]).fields.amountRaw,
    '18446744073709551615',
  );
  for (const amount of [
    '18446744073709551616',
    '-1',
    '01',
    '1e6',
    1000,
    9007199254740992,
  ])
    bad('transfer', { source, destination, authority, amount });
  for (const decimals of [-1, 256, 6.5, '6'])
    bad('transferChecked', {
      ...common[1][1],
      tokenAmount: { amount: '1', decimals },
    });
});
void test('numeric extension amounts reject precision loss; string amounts retain full u64', () => {
  const info = {
    mint,
    transferFeeBasisPoints: 25,
    maximumFee: '18446744073709551615',
  };
  assert.equal(
    decode('initializeTransferFeeConfig', info).fields.maximumFeeRaw,
    info.maximumFee,
  );
  for (const maximumFee of [
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    0.1,
    '18446744073709551616',
    '001',
  ])
    bad('initializeTransferFeeConfig', { ...info, maximumFee });
  bad('initializeTransferFeeConfig', {
    ...info,
    transferFeeBasisPoints: 10001,
  });
});
void test('multisig form requires bounded unique signers, displayed in bounded groups', () => {
  const info = {
    source,
    delegate,
    amount: '1',
    multisigOwner: owner,
    signers: Array.from({ length: 11 }, (_, i) => key(i + 20)),
  };
  const result = decode('approve', info);
  assert.equal(result.fields.signerCount, '11');
  assert.equal(result.fields.signers11to11, key(30));
  assert.ok(Object.values(result.fields).every((v) => v.length <= 256));
  for (const change of [
    { owner },
    { signers: [] },
    { signers: [owner, owner] },
    { signers: Array.from({ length: 12 }, (_, i) => key(i + 20)) },
    { signers: [123] },
  ])
    bad('approve', { ...info, ...change });
  bad('approve', {
    source,
    delegate,
    owner,
    amount: '1',
    signers: [authority],
  });
});
void test('official transfer-fee multisig spelling is used without alias guessing', () => {
  const info = {
    mint,
    maximumFee: 100,
    transferFeeBasisPoints: 10,
    multisigtransferFeeConfigAuthority: authority,
    signers: [owner],
  };
  assert.equal(
    decode('setTransferFee', info).fields.multisigtransferFeeConfigAuthority,
    authority,
  );
  const { multisigtransferFeeConfigAuthority, ...rest } = info;
  bad('setTransferFee', {
    ...rest,
    multisigTransferFeeConfigAuthority: multisigtransferFeeConfigAuthority,
  });
});
void test('authority targets, null removal and enum primitive types are enforced', () => {
  assert.equal(
    decode('setAuthority', {
      account,
      authority,
      authorityType: 'accountOwner',
      newAuthority: null,
    }).fields.newAuthority,
    'none',
  );
  assert.equal(
    decode('setAuthority', {
      mint,
      authority,
      authorityType: 'permanentDelegate',
      newAuthority: delegate,
    }).flags.find((f) => f.code === 'TOKEN_PERMANENT_DELEGATE')?.severity,
    'critical',
  );
  bad('setAuthority', {
    account,
    authority,
    authorityType: 'mintTokens',
    newAuthority: null,
  });
  const poisoned = {
    toString() {
      throw new Error('must not coerce');
    },
  };
  bad('setAuthority', {
    mint,
    authority,
    authorityType: poisoned,
    newAuthority: null,
  });
  bad('updateDefaultAccountState', {
    mint,
    freezeAuthority: authority,
    accountState: poisoned,
  });
});
void test('expected fees require matching decimals and cannot exceed transferred amount', () => {
  const info = extensions[0][1];
  assert.equal(
    decode('transferCheckedWithFee', info).fields.feeAmountRaw,
    '100',
  );
  bad('transferCheckedWithFee', {
    ...info,
    feeAmount: { amount: '10001', decimals: 6 },
  });
  bad('transferCheckedWithFee', {
    ...info,
    feeAmount: { amount: '1', decimals: 9 },
  });
});
void test('source account truncation is explicit, and all omitted addresses are validated', () => {
  const accounts = Array.from({ length: 12 }, (_, i) => key(i + 20));
  const result = decode('harvestWithheldTokensToMint', {
    mint,
    sourceAccounts: accounts,
  });
  assert.equal(result.fields.sourceAccountCount, '12');
  assert.equal(result.fields.additionalSourceAccounts, '7');
  assert.equal(result.fields.sourceAccountsPreview.split(', ').length, 5);
  assert.ok(codes(result).includes('INCOMPLETE_METADATA'));
  bad('harvestWithheldTokensToMint', {
    mint,
    sourceAccounts: [...accounts, 'invalid'],
  });
  bad('harvestWithheldTokensToMint', {
    mint,
    sourceAccounts: Array(257).fill(account),
  });
});
void test('optional hook fields describe the instruction only; updates still need authority', () => {
  const result = decode('initializeTransferHook', { mint });
  assert.equal(result.fields.programId, 'none');
  assert.equal(result.fields.authority, 'none');
  assert.ok(codes(result).includes('TOKEN_2022_STATE_UNINSPECTED'));
  bad('updateTransferHook', { mint, programId });
  bad('initializeTransferHook', { mint, programId: 'https://example.com' });
});
void test('display scaling preserves values without claiming a raw or scaled balance', () => {
  const result = decode('updateMultiplier', {
    mint,
    authority,
    newMultiplier: '1.2345678901234567',
    newMultiplierTimestamp: '-9223372036854775808',
  });
  assert.equal(result.fields.newMultiplier, '1.2345678901234567');
  assert.equal(result.fields.newMultiplierTimestamp, '-9223372036854775808');
  assert.equal(result.fields.amountRaw, undefined);
  for (const multiplier of [0, '0', '-1', 'NaN', 'Infinity', '1e999', '1\n'])
    bad('initializeScaledUiAmountConfig', {
      mint,
      authority: null,
      multiplier,
    });
  bad('updateMultiplier', {
    mint,
    authority,
    newMultiplier: '2',
    newMultiplierTimestamp: 9007199254740992,
  });
});
void test('confidential deposit uses current account+mint semantics, not older ambiguous parser output', () => {
  const result = decode('depositConfidentialTransfer', {
    account,
    mint,
    owner,
    amount: 1,
    decimals: 6,
  });
  assert.equal(result.fields.account, account);
  assert.equal(result.fields.source, undefined);
  assert.match(result.description, /same token account/);
  bad('depositConfidentialTransfer', {
    source: account,
    destination: mint,
    mint: owner,
    owner,
    amount: 1,
    decimals: 6,
  });
});
void test('proof offsets are primitive i8 numbers with exclusive context or sysvar references', () => {
  const zero = {
    account,
    owner,
    proofInstructionOffset: 0,
    proofContextStateAccount: registry,
  };
  assert.equal(
    decode('emptyConfidentialTransferAccount', zero).kind,
    'emptyConfidentialTransferAccount',
  );
  for (const proofInstructionOffset of ['0', '1', -129, 128, 0.1, null])
    bad('emptyConfidentialTransferAccount', {
      ...zero,
      proofInstructionOffset,
    });
  bad('emptyConfidentialTransferAccount', {
    ...zero,
    instructionsSysvar: rentSysvar,
  });
  bad('emptyConfidentialTransferAccount', {
    account,
    owner,
    proofInstructionOffset: 0,
  });
  bad('emptyConfidentialTransferAccount', {
    ...zero,
    proofInstructionOffset: -1,
    instructionsSysvar: rentSysvar,
  });
  assert.equal(
    decode('emptyConfidentialTransferAccount', {
      account,
      owner,
      proofInstructionOffset: 127,
      instructionsSysvar: rentSysvar,
    }).kind,
    'emptyConfidentialTransferAccount',
  );
});
void test('confidential transfer amounts remain unknown and opaque ciphertext is not exposed', () => {
  for (const [type, info] of extensions.filter(
    ([n]) =>
      n === 'confidentialTransfer' || n === 'confidentialTransferWithFee',
  )) {
    const result = decode(type, info);
    assert.equal(result.fields.amount, 'confidential; not decoded');
    assert.equal(result.fields.amountRaw, undefined);
    assert.ok(!JSON.stringify(result).includes(ciphertext));
    assert.ok(codes(result).includes('TOKEN_CONFIDENTIAL'));
    bad(type, { ...info, newSourceDecryptableAvailableBalance: 'malformed' });
  }
});
void test('confidential-account approval is critical configuration, not an ordinary delegate allowance', () => {
  const result = decode('approveConfidentialTransferAccount', {
    account,
    mint,
    confidentialTransferAuditorAuthority: authority,
  });
  assert.equal(
    result.flags.find((f) => f.code === 'TOKEN_CONFIG_CHANGE')?.severity,
    'critical',
  );
  assert.ok(!codes(result).includes('TOKEN_APPROVAL'));
  bad('initializeConfidentialTransferMint', {
    mint,
    autoApproveNewAccounts: 'false',
    auditorElGamalPubkey: null,
  });
});
void test('unknown fields and missing account fields reject rather than produce partial explanations', () => {
  for (const [type, info] of [...common, ...extensions]) {
    bad(type, { ...info, unexpectedAuthority: key(44) });
    const required = ['source', 'account', 'mint', 'multisig'].find((n) =>
      Object.hasOwn(info, n),
    );
    const missing = { ...info };
    delete missing[required];
    bad(type, missing);
  }
});
void test('outer decoder retains inner locations, critical warnings and failed execution', () => {
  const result = explainParsedTransaction({
    slot: 123,
    transaction: {
      signatures: [bs58.encode(new Uint8Array(64).fill(7))],
      message: { instructions: [raw('pause', { mint, authority })] },
    },
    meta: {
      err: { InstructionError: [0, 'InvalidArgument'] },
      innerInstructions: [
        { index: 0, instructions: [raw('approve', null, TOKEN_PROGRAM)] },
      ],
    },
  });
  assert.equal(result.execution, 'failed');
  assert.equal(result.instructions[1].location, '0.0');
  assert.equal(
    result.instructions[1].flags.find((f) => f.code === 'TOKEN_APPROVAL')
      ?.severity,
    'critical',
  );
  assert.ok(result.flags.some((f) => f.code === 'TRANSACTION_FAILED'));
});
