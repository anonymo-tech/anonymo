/** Fixed enum meanings only. No log parsing, network reads, or inferred balances. */
export type TransactionErrorDetail = {
  instructionIndex: number | null;
  kind: string;
  customCode?: number;
};
export type TransactionFailureReason = {
  instructionIndex: number | null;
  programName?: string;
  code?: number;
  name?: string;
  reason: string;
};

type ErrorTable = Readonly<
  Record<number, readonly [name: string, reason: string]>
>;
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const programNames: Readonly<Record<string, string>> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account',
  '11111111111111111111111111111111': 'System program',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  [JUPITER_V6]: 'Jupiter Aggregator v6',
};

// solana-labs/solana: sdk/program/src/instruction.rs (InstructionError)
// and sdk/src/transaction/error.rs (TransactionError).
const builtinReasons: Readonly<Record<string, string>> = {
  InsufficientFunds:
    'The program reported insufficient funds for the instruction.',
  InsufficientFundsForFee:
    'The network reported insufficient funds to pay the transaction fee.',
  InsufficientFundsForRent:
    'The network reported insufficient funds for an account’s rent requirement.',
  AccountNotFound: 'The network could not find a required account.',
  ProgramAccountNotFound:
    'The network could not find a required program account.',
  AccountInUse: 'The network reported that an account was already in use.',
  AccountAlreadyInUse:
    'The program reported that an account was already in use.',
  AccountAlreadyInitialized:
    'The program reported that an account was already initialized.',
  ComputationalBudgetExceeded: 'The instruction exceeded its compute budget.',
  ProgramFailedToComplete: 'The program did not complete execution.',
  ProgramFailedToCompile: 'The network could not compile the program.',
  InvalidAccountData: 'The program reported invalid account data.',
  InvalidInstructionData: 'The program reported invalid instruction data.',
  InvalidArgument: 'The program reported an invalid argument.',
  IncorrectProgramId: 'The instruction referenced an incorrect program ID.',
  MissingRequiredSignature:
    'The program reported a missing required signature.',
  UninitializedAccount:
    'The program reported an account that was not initialized.',
  NotEnoughAccountKeys: 'The instruction did not supply enough account keys.',
  InvalidSeeds: 'The program reported invalid address seeds.',
  MaxSeedLengthExceeded: 'An address seed exceeded the permitted length.',
  InvalidRealloc: 'The program reported an invalid account resize.',
  ArithmeticOverflow: 'The program reported arithmetic overflow.',
  IllegalOwner: 'The program reported an invalid account owner.',
  InvalidAccountOwner: 'The program reported an invalid account owner.',
  ReadonlyDataModified:
    'The program attempted to change read-only account data.',
  ReadonlyLamportChange:
    'The program attempted to change a read-only account’s lamports.',
  PrivilegeEscalation:
    'An invoked instruction requested privileges it was not granted.',
  CallDepth: 'The instruction exceeded the permitted program call depth.',
  BlockhashNotFound:
    'The network did not find the transaction’s recent blockhash.',
  AlreadyProcessed:
    'The network reported that this transaction was already processed.',
  SignatureFailure: 'The network could not verify a transaction signature.',
  InvalidProgramForExecution:
    'The network reported a program that cannot be executed.',
  DuplicateInstruction:
    'The transaction included a duplicate instruction that is not permitted.',
  InvalidLoadedAccountsDataSizeLimit:
    'The transaction requested an invalid loaded account data size limit.',
  MaxLoadedAccountsDataSizeExceeded:
    'The transaction exceeded its loaded account data size limit.',
};

// solana-program/token: program/src/error.rs, TokenError 0–19.
// solana-program/token-2022: program/src/error.rs preserves these same variants.
const tokenErrors: ErrorTable = {
  0: [
    'NotRentExempt',
    'The program reported that an account does not meet the rent-exempt minimum.',
  ],
  1: [
    'InsufficientFunds',
    'The program reported insufficient funds for the instruction.',
  ],
  2: ['InvalidMint', 'The program reported an invalid token mint.'],
  3: [
    'MintMismatch',
    'The program reported that the token mints do not match.',
  ],
  4: [
    'OwnerMismatch',
    'The program reported that the account owner does not match.',
  ],
  5: [
    'FixedSupply',
    'The program reported that this mint has no minting authority.',
  ],
  6: [
    'AlreadyInUse',
    'The program reported that an account was already in use.',
  ],
  7: [
    'InvalidNumberOfProvidedSigners',
    'The program reported an invalid number of provided signers.',
  ],
  8: [
    'InvalidNumberOfRequiredSigners',
    'The program reported an invalid number of required signers.',
  ],
  9: ['UninitializedState', 'The program reported uninitialized token state.'],
  10: [
    'NativeNotSupported',
    'The program reported that this operation does not support native SOL accounts.',
  ],
  11: [
    'NonNativeHasBalance',
    'The program reported that a non-native token account still has a balance.',
  ],
  12: [
    'InvalidInstruction',
    'The program reported an unsupported token instruction.',
  ],
  13: ['InvalidState', 'The program reported invalid token account state.'],
  14: ['Overflow', 'The program reported arithmetic overflow.'],
  15: [
    'AuthorityTypeNotSupported',
    'The program reported an unsupported authority type.',
  ],
  16: [
    'MintCannotFreeze',
    'The program reported that this mint cannot freeze accounts.',
  ],
  17: [
    'AccountFrozen',
    'The program reported that the token account is frozen.',
  ],
  18: [
    'MintDecimalsMismatch',
    'The program reported that the token decimals do not match the mint.',
  ],
  19: [
    'NonNativeNotSupported',
    'The program reported that this operation requires a native SOL account.',
  ],
};

// solana-labs/solana: sdk/program/src/system_instruction.rs, SystemError.
const systemErrors: ErrorTable = {
  0: [
    'AccountAlreadyInUse',
    'The program reported that an account was already in use.',
  ],
  1: [
    'ResultWithNegativeLamports',
    'The System program reported insufficient lamports for the operation.',
  ],
  2: ['InvalidProgramId', 'The System program reported an invalid program ID.'],
  3: [
    'InvalidAccountDataLength',
    'The System program reported an invalid account data length.',
  ],
  4: [
    'MaxSeedLengthExceeded',
    'An address seed exceeded the permitted length.',
  ],
  5: [
    'AddressWithSeedMismatch',
    'The System program reported that the derived address does not match.',
  ],
  6: [
    'NonceNoRecentBlockhashes',
    'The System program reported no recent blockhashes for the nonce.',
  ],
  7: [
    'NonceBlockhashNotExpired',
    'The System program reported that the nonce blockhash has not expired.',
  ],
  8: [
    'NonceUnexpectedBlockhashValue',
    'The System program reported an unexpected nonce blockhash.',
  ],
};

// solana-program/associated-token-account: program/src/error.rs, AssociatedTokenAccountError.
const associatedErrors: ErrorTable = {
  0: [
    'InvalidOwner',
    'The associated token account program reported an invalid owner.',
  ],
};

// coral-xyz/anchor: lang/src/error.rs, ErrorCode.
// Apply only to a recognized Anchor program; a numeric range alone is not proof of Anchor.
const anchorErrors: ErrorTable = {
  100: [
    'InstructionMissing',
    'The program reported a missing instruction discriminator.',
  ],
  101: [
    'InstructionFallbackNotFound',
    'The program reported an unrecognized instruction.',
  ],
  102: [
    'InstructionDidNotDeserialize',
    'The program could not deserialize the instruction.',
  ],
  103: [
    'InstructionDidNotSerialize',
    'The program could not serialize the instruction.',
  ],
  2000: [
    'ConstraintMut',
    'The program reported a failed constraint for account mutability.',
  ],
  2001: [
    'ConstraintHasOne',
    'The program reported a failed constraint for an account relationship.',
  ],
  2002: [
    'ConstraintSigner',
    'The program reported a failed constraint for a required signer.',
  ],
  2003: [
    'ConstraintRaw',
    'The program reported a failed constraint for a custom account condition.',
  ],
  2004: [
    'ConstraintOwner',
    'The program reported a failed constraint for account ownership.',
  ],
  2005: [
    'ConstraintRentExempt',
    'The program reported a failed constraint for rent exemption.',
  ],
  2006: [
    'ConstraintSeeds',
    'The program reported a failed constraint for address seeds.',
  ],
  2007: [
    'ConstraintExecutable',
    'The program reported a failed constraint for an executable account.',
  ],
  2008: [
    'ConstraintState',
    'The program reported a failed constraint for account state.',
  ],
  2009: [
    'ConstraintAssociated',
    'The program reported a failed constraint for an associated account.',
  ],
  2010: [
    'ConstraintAssociatedInit',
    'The program reported a failed constraint for associated account initialization.',
  ],
  2011: [
    'ConstraintClose',
    'The program reported a failed constraint for account closure.',
  ],
  2012: [
    'ConstraintAddress',
    'The program reported a failed constraint for an account address.',
  ],
  2013: [
    'ConstraintZero',
    'The program reported a failed constraint for a zeroed account discriminator.',
  ],
  2014: [
    'ConstraintTokenMint',
    'The program reported a failed constraint for a token mint.',
  ],
  2015: [
    'ConstraintTokenOwner',
    'The program reported a failed constraint for a token account owner.',
  ],
  2016: [
    'ConstraintMintMintAuthority',
    'The program reported a failed constraint for a mint authority.',
  ],
  2017: [
    'ConstraintMintFreezeAuthority',
    'The program reported a failed constraint for a freeze authority.',
  ],
  2018: [
    'ConstraintMintDecimals',
    'The program reported a failed constraint for mint decimals.',
  ],
  2019: [
    'ConstraintSpace',
    'The program reported a failed constraint for account space.',
  ],
  2020: [
    'ConstraintAccountIsNone',
    'The program reported a failed constraint for a required optional account.',
  ],
  3000: [
    'AccountDiscriminatorAlreadySet',
    'The program reported that an account discriminator was already set.',
  ],
  3001: [
    'AccountDiscriminatorNotFound',
    'The program reported that an account discriminator is missing.',
  ],
  3002: [
    'AccountDiscriminatorMismatch',
    'The program reported that an account discriminator does not match.',
  ],
  3003: [
    'AccountDidNotDeserialize',
    'The program reported that account data could not be deserialized.',
  ],
  3004: [
    'AccountDidNotSerialize',
    'The program reported that account data could not be serialized.',
  ],
  3005: [
    'AccountNotEnoughKeys',
    'The program reported that not enough account keys were supplied.',
  ],
  3006: [
    'AccountNotMutable',
    'The program reported that an account was not marked writable.',
  ],
  3007: [
    'AccountOwnedByWrongProgram',
    'The program reported that an account is owned by a different program.',
  ],
  3008: [
    'InvalidProgramId',
    'The program reported that a program ID does not match.',
  ],
  3009: [
    'InvalidProgramExecutable',
    'The program reported that a program account is not executable.',
  ],
  3010: [
    'AccountNotSigner',
    'The program reported that an account did not sign.',
  ],
  3011: [
    'AccountNotSystemOwned',
    'The program reported that an account is not owned by the System program.',
  ],
  3012: [
    'AccountNotInitialized',
    'The program reported that an account is not initialized.',
  ],
  3013: [
    'AccountNotProgramData',
    'The program reported that an account is not a program-data account.',
  ],
  3014: [
    'AccountNotAssociatedTokenAccount',
    'The program reported that an account is not the expected associated token account.',
  ],
  3015: [
    'AccountSysvarMismatch',
    'The program reported that a sysvar account does not match.',
  ],
  3016: [
    'AccountReallocExceedsLimit',
    'The program reported that an account resize exceeds the permitted limit.',
  ],
  3017: [
    'AccountDuplicateReallocs',
    'The program reported that an account was resized more than once in the instruction.',
  ],
  4100: [
    'DeclaredProgramIdMismatch',
    'The program reported that its declared program ID does not match.',
  ],
  5000: ['Deprecated', 'The program reported a deprecated operation.'],
};

// jup-ag/jupiter-cpi: idl.json, Jupiter v6 errors.
const jupiterErrors: ErrorTable = {
  6000: ['EmptyRoute', 'The program reported an empty swap route.'],
  6001: [
    'SlippageToleranceExceeded',
    'The program reported that the swap exceeded its slippage tolerance.',
  ],
  6008: [
    'NotEnoughAccountKeys',
    'The instruction did not supply enough account keys.',
  ],
  6014: [
    'IncorrectTokenProgramID',
    'The program reported an incorrect token program ID.',
  ],
  6017: [
    'ExactOutAmountNotMatched',
    'The program reported that the exact output amount was not matched.',
  ],
};

// solana-labs/solana: program-runtime/src/compute_budget_processor.rs.
// Compute Budget reports runtime variants (e.g. DuplicateInstruction and
// InvalidInstructionData), not a separate numbered custom-error enum.
const customTables: Readonly<Record<string, ErrorTable>> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: tokenErrors,
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: tokenErrors,
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: associatedErrors,
  '11111111111111111111111111111111': systemErrors,
  [JUPITER_V6]: { ...anchorErrors, ...jupiterErrors },
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uint = (value: unknown, max: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;

/** Keep only structured error fields, never arbitrary provider text or logs. */
export function normalizeTransactionError(
  error: unknown,
): TransactionErrorDetail | null {
  let instructionIndex: number | null = null;
  let detail = error;
  if (
    object(error) &&
    Object.keys(error).length === 1 &&
    Object.hasOwn(error, 'InstructionError')
  ) {
    const pair = error.InstructionError;
    if (!Array.isArray(pair) || pair.length !== 2 || !uint(pair[0], 255))
      return null;
    instructionIndex = pair[0];
    detail = pair[1];
  }
  if (typeof detail === 'string' && /^[A-Z][A-Za-z0-9]{0,79}$/.test(detail)) {
    // A custom program error is only meaningful with its numeric code; without one there is nothing to decode.
    if (detail === 'Custom') return null;
    return { instructionIndex, kind: detail };
  }
  if (!object(detail) || Object.keys(detail).length !== 1) return null;
  if (instructionIndex !== null && uint(detail.Custom, 0xffffffff)) {
    return { instructionIndex, kind: 'Custom', customCode: detail.Custom };
  }
  // These transaction variants carry account/instruction indexes, not program error codes.
  const kind = Object.keys(detail)[0];
  if (
    instructionIndex === null &&
    ((kind === 'DuplicateInstruction' && uint(detail[kind], 255)) ||
      (kind === 'InsufficientFundsForRent' &&
        object(detail[kind]) &&
        uint(detail[kind].account_index, 255)))
  ) {
    return { instructionIndex, kind };
  }
  return null;
}

/** Validate the minimal explanation field again at the client boundary. */
export function parseTransactionErrorDetail(
  value: unknown,
): TransactionErrorDetail | null {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !['instructionIndex', 'kind', 'customCode'].includes(key),
    ) ||
    (value.instructionIndex !== null && !uint(value.instructionIndex, 255)) ||
    typeof value.kind !== 'string' ||
    !/^[A-Z][A-Za-z0-9]{0,79}$/.test(value.kind)
  )
    return null;
  if (value.kind === 'Custom') {
    if (value.instructionIndex === null || !uint(value.customCode, 0xffffffff))
      return null;
  } else if (value.customCode !== undefined) return null;
  return {
    instructionIndex: value.instructionIndex,
    kind: value.kind,
    ...(value.customCode === undefined
      ? {}
      : { customCode: value.customCode as number }),
  };
}

export function decodeTransactionError(
  error: unknown,
  programId: string | null,
): TransactionFailureReason | null {
  const detail =
    parseTransactionErrorDetail(error) ?? normalizeTransactionError(error);
  if (!detail) return null;
  const programName =
    programId && Object.hasOwn(programNames, programId)
      ? programNames[programId]
      : undefined;
  if (detail.customCode !== undefined) {
    const table =
      programId && Object.hasOwn(customTables, programId)
        ? customTables[programId]
        : undefined;
    const known =
      table && Object.hasOwn(table, detail.customCode)
        ? table[detail.customCode]
        : undefined;
    return {
      instructionIndex: detail.instructionIndex,
      programName,
      code: detail.customCode,
      name: known?.[0],
      reason: known?.[1] ?? 'Custom program error {code} ({hex})',
    };
  }
  return {
    instructionIndex: detail.instructionIndex,
    programName,
    name: detail.kind,
    reason: Object.hasOwn(builtinReasons, detail.kind)
      ? builtinReasons[detail.kind]
      : 'The RPC reported an error without a recognized reason.',
  };
}
