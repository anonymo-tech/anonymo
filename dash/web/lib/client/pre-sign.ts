import bs58 from 'bs58';
import {
  EXPLANATION_FLAG_SEVERITY,
  type ExplainedInstruction,
  type ExplanationFlag,
} from '../solana/explanation.ts';
import {
  PRE_SIGN_LIMITS,
  PRE_SIGN_WARNING_SEVERITY,
  type PreSignInspection,
  type SimulatedAccount,
} from '../solana/pre-sign.ts';

export type { PreSignInspection } from '../solana/pre-sign.ts';
export class PreSignError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'PreSignError';
    this.code = code;
    this.status = status;
  }
}
const invalid = (): never => {
  throw new PreSignError(
    'INVALID_RESPONSE',
    'The inspection response could not be checked consistently. No result is shown.',
  );
};
function record(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const result = value as Record<string, unknown>;
  if (
    keys &&
    (Object.keys(result).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(result, key)))
  )
    return invalid();
  return result;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value.replace(/[\t\r\n]/g, ''))
  )
    return invalid();
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= max
    ? value
    : invalid();
}
function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}
function choice<const T extends string | number>(
  value: unknown,
  choices: readonly T[],
): T {
  return (typeof value === 'string' || typeof value === 'number') &&
    choices.includes(value as T)
    ? (value as T)
    : invalid();
}
function list<T>(
  value: unknown,
  max: number,
  parse: (value: unknown) => T,
): T[] {
  return Array.isArray(value) && value.length <= max
    ? value.map(parse)
    : invalid();
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}
function address(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return invalid();
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 32 && bs58.encode(bytes) === value
      ? value
      : invalid();
  } catch {
    return invalid();
  }
}
function hash(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ? value
    : invalid();
}
function exactAmount(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    return invalid();
  return value;
}
const severityRank = { info: 0, warning: 1, critical: 2 };
const requiredInstructionFlags: Record<string, ExplanationFlag['code'][]> = {
  stakeInitialize: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  stakeInitializeChecked: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  stakeAuthorize: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  stakeAuthorizeChecked: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  stakeSetLockup: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  stakeSetLockupChecked: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  stakeMerge: ['STAKE_CHANGE', 'SOL_TRANSFER', 'ACCOUNT_CLOSURE'],
  stakeSplit: ['STAKE_CHANGE', 'SOL_TRANSFER'],
  stakeWithdraw: ['STAKE_CHANGE', 'SOL_TRANSFER'],
  stakeMoveStake: ['STAKE_CHANGE', 'SOL_TRANSFER'],
  stakeMoveLamports: ['STAKE_CHANGE', 'SOL_TRANSFER'],
  stakeDelegate: ['STAKE_CHANGE'],
  stakeDeactivate: ['STAKE_CHANGE'],
  stakeDeactivateDelinquent: ['STAKE_CHANGE'],
  initializeMint: ['TOKEN_CONFIG_CHANGE'],
  initializeMint2: ['TOKEN_CONFIG_CHANGE'],
  initializeMultisig: ['TOKEN_CONFIG_CHANGE'],
  initializeMultisig2: ['TOKEN_CONFIG_CHANGE'],
  initializeMintCloseAuthority: ['TOKEN_CONFIG_CHANGE'],
  initializeNonTransferableMint: ['TOKEN_CONFIG_CHANGE'],
  malformed: ['MALFORMED_INSTRUCTION'],
  approve: ['TOKEN_APPROVAL'],
  approveChecked: ['TOKEN_APPROVAL'],
  setAuthority: ['AUTHORITY_CHANGE'],
  closeAccount: ['ACCOUNT_CLOSURE'],
  burn: ['TOKEN_BURN'],
  burnChecked: ['TOKEN_BURN'],
  mintTo: ['TOKEN_MINT'],
  mintToChecked: ['TOKEN_MINT'],
  freezeAccount: ['TOKEN_FREEZE'],
  thawAccount: ['TOKEN_FREEZE'],
  initializePermanentDelegate: [
    'TOKEN_CONFIG_CHANGE',
    'TOKEN_PERMANENT_DELEGATE',
  ],
  initializeTransferHook: ['TOKEN_CONFIG_CHANGE', 'TOKEN_TRANSFER_HOOK'],
  updateTransferHook: ['TOKEN_CONFIG_CHANGE', 'TOKEN_TRANSFER_HOOK'],
  initializePausableConfig: ['TOKEN_CONFIG_CHANGE', 'TOKEN_PAUSE'],
  pause: ['TOKEN_CONFIG_CHANGE', 'TOKEN_PAUSE'],
  resume: ['TOKEN_CONFIG_CHANGE', 'TOKEN_PAUSE'],
  systemAssign: ['AUTHORITY_CHANGE'],
  systemAssignWithSeed: ['AUTHORITY_CHANGE'],
  systemAllocateWithSeed: ['AUTHORITY_CHANGE'],
  systemInitializeNonce: ['NONCE_CHANGE', 'AUTHORITY_CHANGE'],
  systemAuthorizeNonce: ['NONCE_CHANGE', 'AUTHORITY_CHANGE'],
  systemAdvanceNonce: ['NONCE_CHANGE'],
  systemWithdrawFromNonce: ['NONCE_CHANGE'],
  systemUpgradeNonce: ['NONCE_CHANGE'],
  lookupTableFreeze: ['AUTHORITY_CHANGE'],
  lookupTableClose: ['ACCOUNT_CLOSURE'],
  associatedTokenRecoverNested: ['ACCOUNT_CLOSURE'],
};
function instructionFlag(value: unknown): ExplanationFlag {
  const entry = record(value);
  if (
    Object.keys(entry).some(
      (key) => !['code', 'severity', 'message', 'instruction'].includes(key),
    )
  )
    return invalid();
  if (
    typeof entry.code !== 'string' ||
    !Object.hasOwn(EXPLANATION_FLAG_SEVERITY, entry.code)
  )
    return invalid();
  const code = entry.code as ExplanationFlag['code'],
    severity = choice(entry.severity, ['info', 'warning', 'critical']);
  if (severityRank[severity] < severityRank[EXPLANATION_FLAG_SEVERITY[code]])
    return invalid();
  const location =
    entry.instruction === undefined ? undefined : text(entry.instruction, 8);
  if (
    location !== undefined &&
    !/^(?:[0-9]|[1-5][0-9]|6[0-3])(?:\.(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7]))?$/.test(
      location,
    )
  )
    return invalid();
  return {
    code,
    severity,
    message: text(entry.message, 1024),
    ...(location === undefined ? {} : { instruction: location }),
  };
}
function instruction(value: unknown): ExplainedInstruction {
  const entry = record(value, [
      'location',
      'programId',
      'kind',
      'description',
      'fields',
      'flags',
    ]),
    fields: Record<string, string> = {};
  const rawFields = record(entry.fields);
  if (Object.keys(rawFields).length > 16) return invalid();
  for (const [key, value] of Object.entries(rawFields)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key) ||
      ['constructor', 'prototype', '__proto__'].includes(key)
    )
      return invalid();
    fields[key] = text(value, 256);
  }
  const result: ExplainedInstruction = {
    location: text(entry.location, 8),
    programId: nullable(entry.programId, address),
    kind: text(entry.kind, 80),
    description: text(entry.description, 1024),
    fields,
    flags: list(entry.flags, 8, instructionFlag),
  };
  if (
    !/^(?:[0-9]|[1-5][0-9]|6[0-3])(?:\.(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7]))?$/.test(
      result.location,
    ) ||
    result.flags.some((flag) => flag.instruction !== result.location)
  )
    return invalid();
  if (
    result.kind === 'unknown' &&
    !result.flags.some((flag) =>
      [
        'UNKNOWN_PROGRAM',
        'UNSUPPORTED_INSTRUCTION',
        'UNSUPPORTED_TOKEN_PROGRAM',
        'MALFORMED_INSTRUCTION',
      ].includes(flag.code),
    )
  )
    return invalid();
  if (
    result.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' &&
    !result.flags.some((flag) => flag.code === 'TOKEN_2022_STATE_UNINSPECTED')
  )
    return invalid();
  if (
    (requiredInstructionFlags[result.kind] ?? []).some(
      (code) => !result.flags.some((flag) => flag.code === code),
    )
  )
    return invalid();
  if (result.kind === 'setAuthority') {
    const conditional: Record<string, ExplanationFlag['code']> = {
      permanentDelegate: 'TOKEN_PERMANENT_DELEGATE',
      transferHookProgramId: 'TOKEN_TRANSFER_HOOK',
      pause: 'TOKEN_PAUSE',
    };
    const required = conditional[result.fields.authorityType];
    if (required && !result.flags.some((flag) => flag.code === required))
      return invalid();
  }
  return result;
}

function simulatedAccount(value: unknown): SimulatedAccount {
  const entry = record(value, [
    'address',
    'exists',
    'owner',
    'executable',
    'lamports',
    'dataBytes',
    'dataStatus',
    'token',
  ]);
  const token =
    entry.token === null
      ? null
      : record(entry.token, [
          'mint',
          'owner',
          'amount',
          'state',
          'delegate',
          'delegatedAmount',
          'closeAuthority',
          'nativeReserve',
        ]);
  const result: SimulatedAccount = {
    address: address(entry.address),
    exists: bool(entry.exists),
    owner: nullable(entry.owner, address),
    executable: nullable(entry.executable, bool),
    lamports: nullable(entry.lamports, exactAmount),
    dataBytes: nullable(entry.dataBytes, integer),
    dataStatus: choice(entry.dataStatus, [
      'absent',
      'empty',
      'decoded',
      'unsupported',
      'too-large',
    ]),
    token:
      token === null
        ? null
        : {
            mint: address(token.mint),
            owner: address(token.owner),
            amount: exactAmount(token.amount),
            state: choice(token.state, ['initialized', 'frozen']),
            delegate: nullable(token.delegate, address),
            delegatedAmount: exactAmount(token.delegatedAmount),
            closeAuthority: nullable(token.closeAuthority, address),
            nativeReserve: nullable(token.nativeReserve, exactAmount),
          },
  };
  if (!result.exists) {
    if (
      result.owner !== null ||
      result.executable !== null ||
      result.lamports !== null ||
      result.dataBytes !== null ||
      result.dataStatus !== 'absent' ||
      result.token !== null
    )
      return invalid();
  } else {
    if (
      result.owner === null ||
      result.executable === null ||
      result.lamports === null ||
      result.dataBytes === null ||
      result.dataStatus === 'absent'
    )
      return invalid();
    if (result.dataStatus === 'empty' && result.dataBytes !== 0)
      return invalid();
    if (
      result.dataStatus === 'too-large' &&
      result.dataBytes <= PRE_SIGN_LIMITS.accountDataBytes
    )
      return invalid();
    if (
      result.dataStatus !== 'too-large' &&
      result.dataBytes > PRE_SIGN_LIMITS.accountDataBytes
    )
      return invalid();
    if ((result.dataStatus === 'decoded') !== (result.token !== null))
      return invalid();
    if (
      result.token &&
      (result.owner !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
        result.dataBytes !== 165 ||
        result.executable)
    )
      return invalid();
  }
  return result;
}

/** Check network, input binding and evidence relationships before rendering. */
export function parsePreSignInspection(
  value: unknown,
  expectedHash: string,
): PreSignInspection {
  const root = record(value, [
    'readerVersion',
    'cluster',
    'genesisHash',
    'transactionHash',
    'inspectedAt',
    'input',
    'accounts',
    'lookups',
    'instructions',
    'simulation',
    'limits',
    'warnings',
  ]);
  const network = choice(root.cluster, ['devnet', 'mainnet-beta']);
  const networks = {
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  };
  if (
    root.readerVersion !== '1' ||
    root.genesisHash !== networks[network] ||
    hash(root.transactionHash) !== hash(expectedHash)
  )
    return invalid();
  const inspectedAt = text(root.inspectedAt, 24);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(inspectedAt) ||
    !Number.isFinite(Date.parse(inspectedAt)) ||
    new Date(inspectedAt).toISOString() !== inspectedAt
  )
    return invalid();
  const limits = record(root.limits, Object.keys(PRE_SIGN_LIMITS));
  if (
    Object.entries(PRE_SIGN_LIMITS).some(
      ([key, expected]) => limits[key] !== expected,
    )
  )
    return invalid();
  const input = record(root.input, [
    'version',
    'byteLength',
    'recentBlockhash',
    'feePayer',
    'requiredSignatures',
    'presentSignatures',
    'signaturesVerified',
    'nonce',
  ]);
  if (input.signaturesVerified !== false) return invalid();
  const lookups = record(root.lookups, [
    'status',
    'contextSlot',
    'tables',
    'writable',
    'readonly',
    'simulationBinding',
  ]);
  const sim = record(root.simulation, [
    'status',
    'contextSlot',
    'commitment',
    'signatureVerification',
    'blockhashReplacementRequested',
    'replacementBlockhash',
    'unitsConsumed',
    'feeLamports',
    'error',
    'accounts',
    'requestedAccounts',
    'omittedWritableAccounts',
    'effectsComplete',
    'innerInstructions',
  ]);
  if (
    sim.commitment !== 'finalized' ||
    sim.signatureVerification !== false ||
    sim.effectsComplete !== false
  )
    return invalid();
  const replacement =
    sim.replacementBlockhash === null
      ? null
      : record(sim.replacementBlockhash, ['blockhash', 'lastValidBlockHeight']);
  const error =
    sim.error === null
      ? null
      : record(sim.error, [
          'category',
          'instructionIndex',
          'code',
          'customCode',
        ]);
  const result: PreSignInspection = {
    readerVersion: '1',
    cluster: network,
    genesisHash: networks[network],
    transactionHash: hash(root.transactionHash),
    inspectedAt,
    input: {
      version: choice(input.version, ['legacy', 0]),
      byteLength: integer(input.byteLength, 1232),
      recentBlockhash: address(input.recentBlockhash),
      feePayer: address(input.feePayer),
      requiredSignatures: integer(input.requiredSignatures, 18),
      presentSignatures: integer(input.presentSignatures, 18),
      signaturesVerified: false,
      nonce: choice(input.nonce, ['none', 'durable', 'ambiguous']),
    },
    accounts: list(root.accounts, 256, (value) => {
      const a = record(value, ['address', 'signer', 'writable']);
      return {
        address: address(a.address),
        signer: bool(a.signer),
        writable: bool(a.writable),
      };
    }),
    lookups: {
      status: choice(lookups.status, [
        'not-required',
        'resolved',
        'unavailable',
      ]),
      contextSlot: nullable(lookups.contextSlot, integer),
      tables: list(lookups.tables, 8, address),
      writable: list(lookups.writable, 256, address),
      readonly: list(lookups.readonly, 256, address),
      simulationBinding: choice(lookups.simulationBinding, [
        'not-required',
        'matched',
        'unverified',
      ]),
    },
    instructions: list(root.instructions, 64, instruction),
    simulation: {
      status: choice(sim.status, [
        'succeeded',
        'failed',
        'unavailable',
        'not-run',
      ]),
      contextSlot: nullable(sim.contextSlot, integer),
      commitment: 'finalized',
      signatureVerification: false,
      blockhashReplacementRequested: bool(sim.blockhashReplacementRequested),
      replacementBlockhash:
        replacement === null
          ? null
          : {
              blockhash: address(replacement.blockhash),
              lastValidBlockHeight: exactAmount(
                replacement.lastValidBlockHeight,
              ),
            },
      unitsConsumed: nullable(sim.unitsConsumed, exactAmount),
      feeLamports: nullable(sim.feeLamports, exactAmount),
      error:
        error === null
          ? null
          : {
              category: choice(error.category, [
                'instruction',
                'transaction',
                'unknown',
              ]),
              instructionIndex: nullable(error.instructionIndex, (value) =>
                integer(value, 63),
              ),
              code: choice(error.code, [
                'custom',
                'insufficient-funds',
                'invalid-instruction',
                'missing-account',
                'blockhash-not-found',
                'execution-failed',
              ]),
              customCode: nullable(error.customCode, exactAmount),
            },
      accounts: list(sim.accounts, 8, simulatedAccount),
      requestedAccounts: list(sim.requestedAccounts, 8, address),
      omittedWritableAccounts: integer(sim.omittedWritableAccounts, 256),
      effectsComplete: false,
      innerInstructions: choice(sim.innerInstructions, [
        'not-returned',
        'uninspected',
      ]),
    },
    limits: PRE_SIGN_LIMITS,
    warnings: list(
      root.warnings,
      Object.keys(PRE_SIGN_WARNING_SEVERITY).length,
      (value) => {
        const warning = record(value, ['code', 'severity', 'message']);
        if (
          typeof warning.code !== 'string' ||
          !Object.hasOwn(PRE_SIGN_WARNING_SEVERITY, warning.code)
        )
          return invalid();
        const code = warning.code as keyof typeof PRE_SIGN_WARNING_SEVERITY;
        if (warning.severity !== PRE_SIGN_WARNING_SEVERITY[code])
          return invalid();
        return {
          code,
          severity: PRE_SIGN_WARNING_SEVERITY[code],
          message: text(warning.message, 1024),
        };
      },
    ),
  };
  const codes = new Set(result.warnings.map((warning) => warning.code));
  const need = (...required: (keyof typeof PRE_SIGN_WARNING_SEVERITY)[]) => {
    if (required.some((code) => !codes.has(code))) return invalid();
  };
  if (codes.size !== result.warnings.length) return invalid();
  need(
    'SIGNATURES_UNCHECKED',
    'SIMULATION_NOT_SAFETY',
    'POST_STATE_ONLY',
    'ACCOUNTS_INCOMPLETE',
    'INNER_INSTRUCTIONS_UNINSPECTED',
  );
  const {
    accounts,
    instructions,
    simulation,
    input: transaction,
    lookups: lookup,
  } = result;
  if (
    transaction.byteLength < 134 ||
    transaction.requiredSignatures < 1 ||
    transaction.presentSignatures > transaction.requiredSignatures ||
    accounts.length < 1 ||
    accounts[0].address !== transaction.feePayer ||
    !accounts[0].signer ||
    !accounts[0].writable ||
    accounts.filter((a) => a.signer).length !==
      transaction.requiredSignatures ||
    new Set(accounts.map((a) => a.address)).size !== accounts.length
  )
    return invalid();
  if (
    instructions.some(
      (entry, index) =>
        entry.location !== String(index) ||
        (entry.programId !== null &&
          !accounts.some((a) => a.address === entry.programId)),
    )
  )
    return invalid();
  if (
    new Set(lookup.tables).size !== lookup.tables.length ||
    new Set([...lookup.writable, ...lookup.readonly]).size !==
      lookup.writable.length + lookup.readonly.length
  )
    return invalid();
  if (lookup.status === 'not-required') {
    if (
      lookup.tables.length ||
      lookup.writable.length ||
      lookup.readonly.length ||
      lookup.contextSlot !== null ||
      lookup.simulationBinding !== 'not-required'
    )
      return invalid();
  } else {
    if (
      transaction.version !== 0 ||
      !lookup.tables.length ||
      lookup.simulationBinding === 'not-required'
    )
      return invalid();
    if (lookup.status === 'resolved') {
      if (
        lookup.contextSlot === null ||
        accounts.length <= lookup.writable.length + lookup.readonly.length
      )
        return invalid();
      const loaded = accounts.slice(
        accounts.length - lookup.writable.length - lookup.readonly.length,
      );
      if (
        loaded.some(
          (a, index) =>
            a.signer ||
            a.address !== [...lookup.writable, ...lookup.readonly][index] ||
            a.writable !== index < lookup.writable.length,
        )
      )
        return invalid();
    } else {
      need('LOOKUP_UNAVAILABLE');
      if (
        lookup.writable.length ||
        lookup.readonly.length ||
        lookup.contextSlot !== null ||
        instructions.length ||
        lookup.simulationBinding !== 'unverified' ||
        simulation.status !== 'not-run'
      )
        return invalid();
    }
    if (lookup.simulationBinding === 'unverified')
      need('LOOKUP_BINDING_UNVERIFIED');
  }
  if (transaction.nonce === 'durable') need('DURABLE_NONCE');
  if (transaction.nonce === 'ambiguous') {
    need('NONCE_AMBIGUOUS');
    if (simulation.status !== 'not-run') return invalid();
  }
  if (transaction.nonce !== 'none' && simulation.blockhashReplacementRequested)
    return invalid();
  if (simulation.blockhashReplacementRequested) need('BLOCKHASH_REPLACED');
  if (simulation.replacementBlockhash !== null) {
    if (!simulation.blockhashReplacementRequested) return invalid();
    need('BLOCKHASH_REPLACED');
  }
  const completed =
    simulation.status === 'succeeded' || simulation.status === 'failed';
  if (completed) {
    if (
      simulation.contextSlot === null ||
      (lookup.status !== 'not-required' &&
        lookup.simulationBinding !== 'matched') ||
      (lookup.contextSlot !== null &&
        simulation.contextSlot < lookup.contextSlot)
    )
      return invalid();
    if ((simulation.status === 'failed') !== (simulation.error !== null))
      return invalid();
  } else if (
    simulation.contextSlot !== null ||
    simulation.error !== null ||
    simulation.accounts.length ||
    simulation.replacementBlockhash !== null ||
    simulation.unitsConsumed !== null ||
    simulation.feeLamports !== null ||
    simulation.innerInstructions !== 'not-returned'
  )
    return invalid();
  if (simulation.status === 'failed') need('SIMULATION_FAILED');
  if (simulation.status === 'unavailable') need('SIMULATION_UNAVAILABLE');
  if (
    simulation.status === 'not-run' &&
    lookup.status !== 'unavailable' &&
    transaction.nonce !== 'ambiguous'
  )
    return invalid();
  if (
    simulation.status === 'not-run' &&
    simulation.blockhashReplacementRequested
  )
    return invalid();
  if (simulation.error) {
    const failure = simulation.error;
    if (
      (failure.category === 'instruction') !==
        (failure.instructionIndex !== null) ||
      (failure.instructionIndex !== null &&
        failure.instructionIndex >= instructions.length) ||
      (failure.code === 'custom') !== (failure.customCode !== null) ||
      (failure.customCode !== null && BigInt(failure.customCode) > 4294967295n)
    )
      return invalid();
    if (failure.code === 'custom' && failure.category !== 'instruction')
      return invalid();
  }
  if (
    new Set(simulation.requestedAccounts).size !==
      simulation.requestedAccounts.length ||
    simulation.requestedAccounts.some(
      (key) => !accounts.some((a) => a.address === key && a.writable),
    )
  )
    return invalid();
  const writableAccounts = accounts
    .filter((account) => account.writable)
    .map((account) => account.address);
  const expectedRequested =
    simulation.status === 'not-run'
      ? []
      : writableAccounts.slice(0, PRE_SIGN_LIMITS.returnedAccounts);
  if (
    simulation.requestedAccounts.length !== expectedRequested.length ||
    simulation.requestedAccounts.some(
      (key, index) => key !== expectedRequested[index],
    ) ||
    simulation.omittedWritableAccounts !==
      (simulation.status === 'not-run'
        ? 0
        : Math.max(
            0,
            writableAccounts.length - PRE_SIGN_LIMITS.returnedAccounts,
          ))
  )
    return invalid();
  if (
    simulation.accounts.length > simulation.requestedAccounts.length ||
    simulation.accounts.some(
      (entry, index) => entry.address !== simulation.requestedAccounts[index],
    )
  )
    return invalid();
  if (
    simulation.omittedWritableAccounts > 0 ||
    (completed &&
      simulation.accounts.length < simulation.requestedAccounts.length)
  )
    need('ACCOUNTS_INCOMPLETE');
  if (simulation.innerInstructions === 'uninspected')
    need('INNER_INSTRUCTIONS_UNINSPECTED');
  if (
    instructions.some(
      (entry) =>
        entry.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ) ||
    simulation.accounts.some(
      (a) => a.owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    )
  )
    need('TOKEN_2022_STATE_UNINSPECTED');
  return result;
}

/** Canonical packet validation only; the server validates the complete wire structure. */
export function serializedTransaction(value: string): {
  encoded: string;
  bytes: Uint8Array<ArrayBuffer>;
} {
  try {
    if (typeof value !== 'string') throw new Error();
    const encoded = value.trim();
    if (
      !encoded ||
      encoded.length > 1644 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw new Error();
    const binary = atob(encoded),
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length < 134 || bytes.length > 1232 || btoa(binary) !== encoded)
      throw new Error();
    return { encoded, bytes };
  } catch {
    throw new PreSignError(
      'INVALID_TRANSACTION',
      'Paste one complete Solana legacy or v0 transaction encoded as base64. Do not enter a private key or recovery phrase.',
    );
  }
}
export async function serializedTransactionHash(
  value: string,
): Promise<string> {
  const { bytes } = serializedTransaction(value);
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export function preSignErrorMessage(error: unknown): string {
  return error instanceof PreSignError
    ? error.message
    : 'The inspection did not complete. Nothing was signed or submitted.';
}

const errorMessages: Record<string, string> = {
  RPC_UNAVAILABLE: 'A Solana RPC network is not configured for this workspace.',
  SOLANA_RPC_UNAVAILABLE:
    'The configured RPC could not complete this inspection. Nothing was signed or submitted.',
  SOLANA_RPC_TIMEOUT:
    'The RPC inspection timed out. Nothing was signed or submitted.',
  SOLANA_WRONG_CLUSTER:
    'The RPC reported a different network than the configured cluster. No result is shown.',
  SOLANA_INVALID_CONFIGURATION:
    'The Solana reader is not configured correctly.',
  SOLANA_INVALID_RESPONSE:
    'The RPC response could not be checked consistently. No result is shown.',
  SOLANA_UNSUPPORTED_TRANSACTION:
    'This transaction format is not supported. Only legacy and v0 transactions can be inspected.',
  SOLANA_INVALID_INPUT:
    'The transaction encoding or wire structure is invalid. Paste the complete base64 transaction.',
  SOLANA_INCOMPLETE_METADATA:
    'Required address-table or simulation evidence was unavailable. No complete result is shown.',
  SOLANA_SENSITIVE_INPUT:
    'Secret-like material was detected in the transaction payload. Remove it before inspection; it was not sent to the RPC.',
};

/** Explicit account-bound simulation only; no wallet request, storage or automatic retry. */
export async function readPreSignInspection(
  transaction: string,
  accountId: string,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PreSignInspection> {
  options.signal?.throwIfAborted();
  const { encoded } = serializedTransaction(transaction),
    expectedHash = await serializedTransactionHash(encoded);
  if (
    typeof accountId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      accountId,
    )
  )
    throw new PreSignError(
      'ACCOUNT_REQUIRED',
      'Sign in to inspect a transaction.',
      401,
    );
  options.signal?.throwIfAborted();
  const controller = new AbortController(),
    timeoutMs = options.timeoutMs ?? 40000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new PreSignError(
      'INVALID_TIMEOUT',
      'The inspection could not start.',
    );
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const cancel = () => reject(new DOMException('Aborted', 'AbortError'));
      if (controller.signal.aborted) {
        void promise.catch(() => {});
        cancel();
        return;
      }
      controller.signal.addEventListener('abort', cancel, { once: true });
      promise.then(
        (value) => {
          controller.signal.removeEventListener('abort', cancel);
          resolve(value);
        },
        (error) => {
          controller.signal.removeEventListener('abort', cancel);
          reject(error);
        },
      );
    });
  try {
    const response = await wait(
      (options.fetch ?? globalThis.fetch)('/api/pre-sign-inspections', {
        method: 'POST',
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Conclave-Account-Id': accountId,
        },
        body: JSON.stringify({ transaction: encoded }),
      }).then((response) => {
        if (controller.signal.aborted)
          void response.body?.cancel().catch(() => {});
        return response;
      }),
    );
    controller.signal.throwIfAborted();
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      throw new PreSignError(
        'ACCOUNT_REQUIRED',
        'Your account session changed or expired. Sign in again before inspecting a transaction.',
        401,
      );
    }
    const limit = response.ok ? 524288 : 16384;
    if (!response.body) return invalid();
    reader = response.body.getReader();
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^[0-9]+$/.test(declared) || Number(declared) > limit)
    )
      return invalid();
    if (
      response.redirected ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      return invalid();
    let encodedBody = '',
      bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      controller.signal.throwIfAborted();
      const part = await wait(reader.read());
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit)
        throw new PreSignError(
          'RESPONSE_TOO_LARGE',
          'The inspection response exceeded this view’s read limit. No result is shown.',
        );
      encodedBody += decoder.decode(part.value, { stream: true });
    }
    controller.signal.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = JSON.parse(encodedBody + decoder.decode());
    } catch {
      return invalid();
    }
    if (!response.ok) {
      const envelope =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      const error =
        envelope.error &&
        typeof envelope.error === 'object' &&
        !Array.isArray(envelope.error)
          ? (envelope.error as Record<string, unknown>)
          : {};
      const code =
        typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)
          ? error.code
          : 'REQUEST_FAILED';
      throw new PreSignError(
        code,
        response.status === 429
          ? 'Too many inspection requests. Wait a moment before trying again.'
          : (errorMessages[code] ??
              'The inspection did not complete. Nothing was signed or submitted.'),
        response.status,
      );
    }
    return parsePreSignInspection(
      record(parsed, ['inspection']).inspection,
      expectedHash,
    );
  } catch (failure) {
    if (options.signal?.aborted)
      throw new DOMException('Aborted', 'AbortError');
    if (timedOut)
      throw new PreSignError(
        'REQUEST_TIMEOUT',
        'The inspection timed out. Nothing was signed or submitted.',
      );
    if (failure instanceof PreSignError) throw failure;
    throw new PreSignError(
      'READ_UNAVAILABLE',
      'The inspection did not complete. Nothing was signed or submitted.',
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
