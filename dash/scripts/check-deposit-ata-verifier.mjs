import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { verifyUsdcDeposit } from '../server/solana/deposit.ts';
import { associatedTokenAddress, ASSOCIATED_TOKEN_PROGRAM } from '../server/solana/associated-token.ts';
import { SOLANA_NETWORKS, SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, SolanaError } from '../server/solana/validation.ts';

const key = (n) => bs58.encode(new Uint8Array(32).fill(n));
const encoded = (bytes) => bs58.encode(new Uint8Array(bytes));
const systemData = (opcode, numbers, owner) => {
  const bytes = new Uint8Array(4 + numbers.length * 8 + (owner ? 32 : 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, opcode, true);
  numbers.forEach((n, i) => view.setBigUint64(4 + i * 8, BigInt(n), true));
  if (owner) bytes.set(bs58.decode(owner), 4 + numbers.length * 8);
  return encoded(bytes);
};
const instruction = (programIdIndex, accounts, data) => ({ programIdIndex, accounts, data, stackHeight: 2 });
const transferData = () => {
  const bytes = new Uint8Array(10);
  bytes[0] = 12; bytes[9] = 6;
  new DataView(bytes.buffer).setBigUint64(1, 1_000_000n, true);
  return encoded(bytes);
};
function fixture({ existing = false, dust = false, funded = false } = {}) {
  const mint = SOLANA_NETWORKS['mainnet-beta'].usdcMint;
  const sourceWallet = key(1), source = key(2), recipientWallet = key(3), reference = key(4);
  const recipientTokenAccount = associatedTokenAddress({ owner: recipientWallet, mint, tokenProgram: TOKEN_PROGRAM });
  const signature = bs58.encode(new Uint8Array(64).fill(8));
  const balance = (accountIndex, owner, amount) => ({
    accountIndex, owner, mint, programId: TOKEN_PROGRAM,
    uiTokenAmount: { decimals: 6, amount, uiAmount: null },
  });
  const creation = dust
    ? [
        ...(!funded ? [instruction(7, [0, 2], systemData(2, [2039280]))] : []),
        instruction(7, [2], systemData(8, [165])),
        instruction(7, [2], systemData(1, [], TOKEN_PROGRAM)),
      ]
    : [instruction(7, [0, 2], systemData(0, [2039280, 165], TOKEN_PROGRAM))];
  return {
    policy: { cluster: 'mainnet-beta', recipientWallet, recipientTokenAccount, usdcMint: mint },
    intent: { id: 'test_intent', sourceWallet, reference, amountRaw: '1000000', createdAtMs: 1760000000000, expiresAtMs: 1760000060000 },
    evidence: {
      cluster: 'mainnet-beta', genesisHash: SOLANA_NETWORKS['mainnet-beta'].genesisHash, signature,
      status: { slot: 123, confirmations: null, err: null, confirmationStatus: 'finalized' },
      transaction: {
        version: 'legacy', slot: 123, blockTime: 1760000001,
        meta: {
          err: null, loadedAddresses: { writable: [], readonly: [] },
          preTokenBalances: [balance(1, sourceWallet, '2000000'), ...(existing ? [balance(2, recipientWallet, '500000')] : [])],
          postTokenBalances: [balance(1, sourceWallet, '1000000'), balance(2, recipientWallet, existing ? '1500000' : '1000000')],
          innerInstructions: existing ? [] : [{ index: 0, instructions: [
            instruction(5, [3], encoded([21, 7, 0])),
            ...creation,
            instruction(5, [2], encoded([22])),
            instruction(5, [2, 3], encoded([18, ...bs58.decode(recipientWallet)])),
          ] }],
        },
        transaction: {
          signatures: [signature],
          message: {
            header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 6 },
            accountKeys: [sourceWallet, source, recipientTokenAccount, mint, reference, TOKEN_PROGRAM, recipientWallet, SYSTEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM],
            instructions: [
              { programIdIndex: 8, accounts: [0, 2, 6, 3, 7, 5], data: encoded([1]) },
              { programIdIndex: 5, accounts: [1, 3, 2, 0, 4], data: transferData() },
            ],
          },
        },
      },
    },
  };
}
const tx = (f) => f.evidence.transaction;
const message = (f) => tx(f).transaction.message;
const inner = (f) => tx(f).meta.innerInstructions[0].instructions;

for (const [name, options] of [
  ['new recipient ATA', {}],
  ['idempotent already-existing recipient ATA', { existing: true }],
  ['system-owned dusted ATA needing rent top-up', { dust: true }],
  ['system-owned dusted ATA already rent funded', { dust: true, funded: true }],
]) test(`credits exactly one verified transfer after ${name}`, () => {
  const f = fixture(options);
  const before = structuredClone(f);
  const verified = verifyUsdcDeposit(f);
  assert.equal(verified.amountRaw, '1000000');
  assert.equal(verified.instructionIndex, 1);
  assert.equal(verified.innerInstructionIndex, null);
  assert.equal(verified.eventId, `solana:mainnet-beta:${f.evidence.signature}:1`);
  assert.equal(verified.recipientWallet, f.policy.recipientWallet);
  assert.equal(verified.recipientTokenAccount, f.policy.recipientTokenAccount);
  assert.deepEqual(f, before);
});

const rejected = [
  ['wrong network', (f) => { f.evidence.cluster = 'devnet'; }],
  ['unfinalized transaction', (f) => { f.evidence.status.confirmationStatus = 'confirmed'; }],
  ['failed transaction', (f) => { tx(f).meta.err = { InstructionError: [0, 'InvalidArgument'] }; }],
  ['wrong block time', (f) => { tx(f).blockTime += 100; }],
  ['wrong signature', (f) => { f.evidence.signature = bs58.encode(new Uint8Array(64).fill(7)); }],
  ['wrong recipient ATA derivation', (f) => { f.policy.recipientTokenAccount = message(f).accountKeys[2] = key(9); }],
  ['wrong owner account', (f) => { message(f).accountKeys[6] = key(9); }],
  ['wrong token program', (f) => { message(f).accountKeys[5] = TOKEN_2022_PROGRAM; }],
  ['different ATA program', (f) => { message(f).accountKeys[8] = key(9); }],
  ['non-idempotent create', (f) => { message(f).instructions[0].data = encoded([0]); }],
  ['nested recovery instead of create', (f) => { message(f).instructions[0].data = encoded([2]); }],
  ['extra create data', (f) => { message(f).instructions[0].data = encoded([1, 0]); }],
  ['different rent payer', (f) => { message(f).instructions[0].accounts[0] = 6; }],
  ['different initialization mint', (f) => { message(f).instructions[0].accounts[3] = 4; }],
  ['extra create account', (f) => { message(f).instructions[0].accounts.push(4); }],
  ['recipient made readonly', (f) => { message(f).header.numReadonlyUnsignedAccounts = 7; }],
  ['extra writable privileges', (f) => { message(f).header.numReadonlyUnsignedAccounts = 5; }],
  ['extra signer', (f) => { message(f).header.numRequiredSignatures = 2; tx(f).transaction.signatures.push(f.evidence.signature); }],
  ['additional outer instruction', (f) => { message(f).instructions.splice(1, 0, structuredClone(message(f).instructions[0])); }],
  ['create after transfer', (f) => { message(f).instructions.reverse(); }],
  ['missing creation evidence', (f) => { tx(f).meta.innerInstructions = []; }],
  ['unavailable inner metadata', (f) => { tx(f).meta.innerInstructions = null; }],
  ['duplicate inner parent', (f) => { tx(f).meta.innerInstructions.push(structuredClone(tx(f).meta.innerInstructions[0])); }],
  ['inner calls under transfer', (f) => { tx(f).meta.innerInstructions[0].index = 1; }],
  ['unexpected nested CPI', (f) => { inner(f)[0].stackHeight = 3; }],
  ['wrong size-query mint', (f) => { inner(f)[0].accounts = [4]; }],
  ['unsupported size-query extension', (f) => { inner(f)[0].data = encoded([21, 1, 0]); }],
  ['different System create target', (f) => { inner(f)[1].accounts = [0, 1]; }],
  ['different System create owner', (f) => { inner(f)[1].data = systemData(0, [2039280, 165], key(9)); }],
  ['different account size', (f) => { inner(f)[1].data = systemData(0, [2039280, 166], TOKEN_PROGRAM); }],
  ['zero funded create', (f) => { inner(f)[1].data = systemData(0, [0, 165], TOKEN_PROGRAM); }],
  ['arbitrary System transfer replacing create', (f) => { inner(f)[1].data = systemData(2, [2039280]); }],
  ['mutable-owner initialization omitted', (f) => { inner(f).splice(2, 1); }],
  ['initialization of source token account', (f) => { inner(f)[2].accounts = [1]; }],
  ['wrong initialized wallet owner', (f) => { inner(f)[3].data = encoded([18, ...bs58.decode(key(9))]); }],
  ['extra inner transfer', (f) => { inner(f).push(instruction(5, [1, 3, 2, 0, 4], transferData())); }],
  ['recipient post owner mismatch', (f) => { tx(f).meta.postTokenBalances[1].owner = key(9); }],
  ['recipient post mint mismatch', (f) => { tx(f).meta.postTokenBalances[1].mint = key(9); }],
  ['recipient post decimals mismatch', (f) => { tx(f).meta.postTokenBalances[1].uiTokenAmount.decimals = 9; }],
  ['recipient post program mismatch', (f) => { tx(f).meta.postTokenBalances[1].programId = TOKEN_2022_PROGRAM; }],
  ['wrong recipient amount', (f) => { tx(f).meta.postTokenBalances[1].uiTokenAmount.amount = '999999'; }],
  ['wrong source debit', (f) => { tx(f).meta.postTokenBalances[0].uiTokenAmount.amount = '1000001'; }],
  ['source pre balance missing', (f) => { tx(f).meta.preTokenBalances = []; }],
  ['recipient post balance missing', (f) => { tx(f).meta.postTokenBalances.pop(); }],
  ['extra token balance', (f) => { tx(f).meta.preTokenBalances.push({ ...tx(f).meta.preTokenBalances[0], accountIndex: 4 }); }],
];
for (const [name, mutate] of rejected) test(`rejects ${name}`, () => {
  const f = fixture();
  mutate(f);
  assert.throws(() => verifyUsdcDeposit(f), (error) => error instanceof SolanaError);
});

test('an existing recipient balance cannot be combined with initialization CPI', () => {
  const f = fixture();
  tx(f).meta.preTokenBalances.push({ ...tx(f).meta.postTokenBalances[1], uiTokenAmount: { amount: '0', decimals: 6 } });
  assert.throws(() => verifyUsdcDeposit(f), SolanaError);
});

test('missing pre-recipient balance is never treated as zero without a create prefix', () => {
  const f = fixture();
  message(f).instructions.shift();
  tx(f).meta.innerInstructions = [];
  assert.throws(() => verifyUsdcDeposit(f), SolanaError);
});

test('dusted-account allocation/assignment accepts no substituted owner, target, or surplus call', () => {
  for (const change of [
    (f) => { inner(f)[2].accounts = [1]; },
    (f) => { inner(f)[2].data = systemData(8, [166]); },
    (f) => { inner(f)[3].data = systemData(1, [], key(9)); },
    (f) => { inner(f)[3].accounts = [1]; },
    (f) => { inner(f).push(instruction(7, [0, 2], systemData(2, [1]))); },
  ]) {
    const f = fixture({ dust: true });
    change(f);
    assert.throws(() => verifyUsdcDeposit(f), SolanaError);
  }
});
