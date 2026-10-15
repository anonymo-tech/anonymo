import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { FEATURE_SWITCHES } from '../components/dashboard/feature-switches.ts';
import { explainParsedTransaction } from '../server/solana/explain.ts';
import {
  ExplainerError,
  parseExplanation,
  readTransactionExplanation,
} from '../lib/client/solana.ts';
import {
  decodeTransactionError,
  normalizeTransactionError,
  parseTransactionErrorDetail,
} from '../lib/solana/transaction-errors.ts';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM = '11111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const UNKNOWN = 'BPFLoaderUpgradeab1e11111111111111111111111';
const custom = (code, program = TOKEN) =>
  decodeTransactionError({ InstructionError: [2, { Custom: code }] }, program);

const signature = bs58.encode(new Uint8Array(64).fill(9));
function explanation(err, programId = JUPITER) {
  const result = explainParsedTransaction({
    slot: 1,
    transaction: {
      signatures: [signature],
      message: { instructions: [{ programId, accounts: [], data: '' }] },
    },
    meta: { err, innerInstructions: [], logMessages: ['provider-only text'] },
  });
  return {
    ...result,
    cluster: 'devnet',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    finality: 'finalized',
    flags: result.flags.filter((flag) => flag.code !== 'FINALITY_UNVERIFIED'),
  };
}

void test('structured failures survive server JSON and the client read/parser without provider logs', async () => {
  const original = { ...FEATURE_SWITCHES };
  try {
    FEATURE_SWITCHES.explainer = true;
    FEATURE_SWITCHES.failureReasons = true;
    for (const [err, programId, name] of [
      [
        { InstructionError: [0, { Custom: 6001 }] },
        JUPITER,
        'SlippageToleranceExceeded',
      ],
      [{ InstructionError: [0, { Custom: 1 }] }, TOKEN, 'InsufficientFunds'],
      [
        { InstructionError: [0, 'InvalidAccountData'] },
        TOKEN,
        'InvalidAccountData',
      ],
      ['AccountNotFound', JUPITER, 'AccountNotFound'],
    ]) {
      const wire = explanation(err, programId);
      const result = await readTransactionExplanation(
        signature,
        '00000000-0000-4000-8000-000000000001',
        { fetch: async () => Response.json({ explanation: wire }) },
      );
      assert.deepEqual(result.executionError, normalizeTransactionError(err));
      assert.equal(
        decodeTransactionError(result.executionError, programId).name,
        name,
      );
      assert.ok(!JSON.stringify(result).includes('provider-only'));
    }
    for (const err of [
      null,
      undefined,
      { InstructionError: [1, 'InvalidArgument'] },
    ])
      assert.equal(explanation(err).executionError, undefined);
  } finally {
    Object.assign(FEATURE_SWITCHES, original);
  }
});

void test('client rejects malformed or inconsistent optional failure details, while older responses still parse', () => {
  const original = { ...FEATURE_SWITCHES };
  try {
    FEATURE_SWITCHES.explainer = true;
    FEATURE_SWITCHES.failureReasons = true;
    const wire = explanation({ InstructionError: [0, { Custom: 6001 }] });
    for (const executionError of [
      null,
      { instructionIndex: 0, kind: 'Custom' },
      { instructionIndex: 0, kind: 'Custom', customCode: -1 },
      { instructionIndex: 1, kind: 'Custom', customCode: 6001 },
      { ...wire.executionError, logs: 'provider-only text' },
    ])
      assert.throws(
        () => parseExplanation({ ...wire, executionError }, signature),
        ExplainerError,
      );
    const older = { ...wire };
    delete older.executionError;
    assert.equal(parseExplanation(older, signature).executionError, undefined);
    assert.throws(
      () => parseExplanation({ ...wire, execution: 'succeeded' }, signature),
      ExplainerError,
    );
    for (const switchName of ['failureReasons', 'explainer']) {
      FEATURE_SWITCHES[switchName] = false;
      assert.equal(
        explanation({ InstructionError: [0, { Custom: 6001 }] }).executionError,
        undefined,
      );
      assert.equal(
        parseExplanation({ ...wire, executionError: 'ignored' }, signature)
          .executionError,
        undefined,
      );
      FEATURE_SWITCHES[switchName] = true;
    }
  } finally {
    Object.assign(FEATURE_SWITCHES, original);
  }
});

void test('built-in instruction and transaction variants retain their scope', () => {
  for (const kind of [
    'InsufficientFunds',
    'ComputationalBudgetExceeded',
    'ProgramFailedToComplete',
    'InvalidAccountData',
    'AccountAlreadyInUse',
    'MissingRequiredSignature',
  ]) {
    const result = decodeTransactionError(
      { InstructionError: [0, kind] },
      TOKEN,
    );
    assert.equal(result.instructionIndex, 0);
    assert.equal(result.name, kind);
    assert.ok(!result.reason.includes('unrecognized'));
  }
  const missing = decodeTransactionError('AccountNotFound', null);
  assert.equal(missing.instructionIndex, null);
  assert.equal(
    missing.reason,
    'The network could not find a required account.',
  );
  assert.equal(
    decodeTransactionError({ DuplicateInstruction: 1 }, null).name,
    'DuplicateInstruction',
  );
  assert.equal(
    decodeTransactionError(
      { InsufficientFundsForRent: { account_index: 3 } },
      null,
    ).name,
    'InsufficientFundsForRent',
  );
});

void test('SPL Token codes 0–19 also retain their meanings for Token-2022', () => {
  assert.equal(custom(1).name, 'InsufficientFunds');
  assert.equal(
    custom(17).reason,
    'The program reported that the token account is frozen.',
  );
  assert.equal(custom(19).name, 'NonNativeNotSupported');
  for (let code = 0; code <= 19; code++) {
    assert.ok(custom(code).name);
    assert.equal(custom(code).reason, custom(code, TOKEN_2022).reason);
  }
  assert.equal(custom(20, TOKEN_2022).name, undefined);
});

void test('System and ATA codes use separate program-specific tables', () => {
  assert.equal(custom(1, SYSTEM).name, 'ResultWithNegativeLamports');
  assert.equal(custom(0, ATA).name, 'InvalidOwner');
  assert.equal(custom(1, ATA).name, undefined);
});

void test('Jupiter v6 slippage and known Anchor framework codes are decoded', () => {
  assert.equal(custom(6001, JUPITER).name, 'SlippageToleranceExceeded');
  assert.equal(
    custom(6001, JUPITER).reason,
    'The program reported that the swap exceeded its slippage tolerance.',
  );
  assert.equal(custom(2006, JUPITER).name, 'ConstraintSeeds');
  assert.equal(custom(3012, JUPITER).name, 'AccountNotInitialized');
  assert.equal(
    custom(2006, UNKNOWN).name,
    undefined,
    'A number alone does not identify an Anchor program',
  );
});

void test('unknown custom errors preserve the unsigned decimal code without guessing', () => {
  const result = custom(4294967295, UNKNOWN);
  assert.equal(result.code, 4294967295);
  assert.equal(result.programName, undefined);
  assert.equal(result.name, undefined);
  assert.equal(result.reason, 'Custom program error {code} ({hex})');
  assert.equal(custom(1, UNKNOWN).name, undefined);
  assert.equal(custom(6001, TOKEN).name, undefined);
});

void test('normalization drops text, logs, malformed codes and ambiguous error shapes', () => {
  const detail = normalizeTransactionError({
    InstructionError: [2, { Custom: 6001 }],
  });
  assert.deepEqual(detail, {
    instructionIndex: 2,
    kind: 'Custom',
    customCode: 6001,
  });
  assert.deepEqual(parseTransactionErrorDetail(detail), detail);
  assert.equal(
    decodeTransactionError(detail, JUPITER).name,
    'SlippageToleranceExceeded',
  );
  for (const value of [
    null,
    [],
    {},
    '<script>provider text</script>',
    { InstructionError: [-1, 'InvalidArgument'] },
    { InstructionError: [256, 'InvalidArgument'] },
    { InstructionError: [0, { Custom: -1 }] },
    { InstructionError: [0, { Custom: 1.5 }] },
    { InstructionError: [0, { Custom: 4294967296 }] },
    { InstructionError: [0, { Custom: '1' }] },
    { InstructionError: [0, { Custom: 1, logs: 'untrusted' }] },
    { InstructionError: [0, 'InvalidArgument'], logs: 'untrusted' },
  ])
    assert.equal(normalizeTransactionError(value), null);
  for (const value of [
    { instructionIndex: null, kind: 'Custom', customCode: 1 },
    { instructionIndex: 0, kind: 'InvalidArgument', customCode: 1 },
    { instructionIndex: 0, kind: 'Custom', customCode: 1, logs: 'untrusted' },
  ])
    assert.equal(parseTransactionErrorDetail(value), null);
  assert.equal(
    decodeTransactionError('NewRuntimeVariant', null).reason,
    'The RPC reported an error without a recognized reason.',
  );
  assert.equal(decodeTransactionError('constructor', 'constructor'), null);
});

void test('every decoder reason has a Simplified Chinese translation', async () => {
  const { default: zh } = await import('../lib/i18n/zh/failure-reasons.ts');
  const source = readFileSync(
    new URL('../lib/solana/transaction-errors.ts', import.meta.url),
    'utf8',
  );
  const reasons = [
    ...source.matchAll(
      /"([^"\n]*(?:reported|program|instruction|transaction|network|account|budget)[^"\n]*)"/g,
    ),
  ].map((match) => match[1]);
  for (const reason of reasons)
    assert.ok(zh[reason], `Missing translation: ${reason}`);
});

test('a custom error without a numeric code yields no detail, so the explanation still parses', () => {
  assert.equal(normalizeTransactionError({ InstructionError: [0, 'Custom'] }), null);
});
