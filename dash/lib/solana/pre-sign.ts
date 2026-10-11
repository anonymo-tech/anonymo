import type { ExplainedInstruction } from './explanation.ts';

export const PRE_SIGN_READER_VERSION = '1' as const;
export const PRE_SIGN_LIMITS = {
  transactionBytes: 1232,
  accounts: 256,
  instructions: 64,
  lookupTables: 8,
  returnedAccounts: 8,
  accountDataBytes: 4096,
  rpcCalls: 3,
  deadlineMs: 25000,
} as const;
export const PRE_SIGN_WARNING_SEVERITY = {
  SIGNATURES_UNCHECKED: 'warning',
  SIMULATION_NOT_SAFETY: 'warning',
  POST_STATE_ONLY: 'info',
  BLOCKHASH_REPLACED: 'info',
  DURABLE_NONCE: 'warning',
  NONCE_AMBIGUOUS: 'warning',
  LOOKUP_UNAVAILABLE: 'warning',
  LOOKUP_BINDING_UNVERIFIED: 'warning',
  SIMULATION_UNAVAILABLE: 'warning',
  SIMULATION_FAILED: 'warning',
  ACCOUNTS_INCOMPLETE: 'warning',
  INNER_INSTRUCTIONS_UNINSPECTED: 'warning',
  TOKEN_2022_STATE_UNINSPECTED: 'warning',
} as const;
export type PreSignWarningCode = keyof typeof PRE_SIGN_WARNING_SEVERITY;
export type PreSignWarning = {
  code: PreSignWarningCode;
  severity: 'info' | 'warning';
  message: string;
};
export type PreSignAccount = {
  address: string;
  signer: boolean;
  writable: boolean;
};
export type SimulatedAccount = {
  address: string;
  exists: boolean;
  owner: string | null;
  executable: boolean | null;
  lamports: string | null;
  dataBytes: number | null;
  dataStatus: 'absent' | 'empty' | 'decoded' | 'unsupported' | 'too-large';
  token: null | {
    mint: string;
    owner: string;
    amount: string;
    state: 'initialized' | 'frozen';
    delegate: string | null;
    delegatedAmount: string;
    closeAuthority: string | null;
    nativeReserve: string | null;
  };
};
export type PreSignSimulationError = {
  category: 'instruction' | 'transaction' | 'unknown';
  instructionIndex: number | null;
  code:
    | 'custom'
    | 'insufficient-funds'
    | 'invalid-instruction'
    | 'missing-account'
    | 'blockhash-not-found'
    | 'execution-failed';
  customCode: string | null;
};
/** No raw transaction bytes, logs, arbitrary errors, or unverified balance deltas. */
export type PreSignInspection = {
  readerVersion: typeof PRE_SIGN_READER_VERSION;
  cluster: 'devnet' | 'mainnet-beta';
  genesisHash: string;
  transactionHash: string;
  inspectedAt: string;
  input: {
    version: 'legacy' | 0;
    byteLength: number;
    recentBlockhash: string;
    feePayer: string;
    requiredSignatures: number;
    presentSignatures: number;
    signaturesVerified: false;
    nonce: 'none' | 'durable' | 'ambiguous';
  };
  accounts: PreSignAccount[];
  lookups: {
    status: 'not-required' | 'resolved' | 'unavailable';
    contextSlot: number | null;
    tables: string[];
    writable: string[];
    readonly: string[];
    simulationBinding: 'not-required' | 'matched' | 'unverified';
  };
  instructions: ExplainedInstruction[];
  simulation: {
    status: 'succeeded' | 'failed' | 'unavailable' | 'not-run';
    contextSlot: number | null;
    commitment: 'finalized';
    signatureVerification: false;
    blockhashReplacementRequested: boolean;
    replacementBlockhash: null | {
      blockhash: string;
      lastValidBlockHeight: string;
    };
    unitsConsumed: string | null;
    feeLamports: string | null;
    error: PreSignSimulationError | null;
    accounts: SimulatedAccount[];
    requestedAccounts: string[];
    omittedWritableAccounts: number;
    effectsComplete: false;
    innerInstructions: 'not-returned' | 'uninspected';
  };
  limits: typeof PRE_SIGN_LIMITS;
  warnings: PreSignWarning[];
};
