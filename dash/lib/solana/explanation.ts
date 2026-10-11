/** Deterministic decoder warnings shared by the server and its validating client. */
export const SOLANA_DECODER_VERSION = '2' as const;

export const EXPLANATION_FLAG_SEVERITY = {
  SOL_TRANSFER: 'info',
  TOKEN_TRANSFER: 'info',
  TOKEN_APPROVAL: 'critical',
  AUTHORITY_CHANGE: 'critical',
  ACCOUNT_CLOSURE: 'critical',
  TOKEN_BURN: 'critical',
  TOKEN_MINT: 'critical',
  TOKEN_FREEZE: 'critical',
  TOKEN_CONFIG_CHANGE: 'critical',
  TOKEN_REVOKE: 'info',
  TOKEN_2022_STATE_UNINSPECTED: 'warning',
  TOKEN_CONFIDENTIAL: 'warning',
  TOKEN_TRANSFER_FEE: 'warning',
  TOKEN_TRANSFER_HOOK: 'critical',
  TOKEN_PERMANENT_DELEGATE: 'critical',
  TOKEN_SCALED_AMOUNT: 'warning',
  TOKEN_PAUSE: 'critical',
  ACCOUNT_CREATION: 'info',
  ACCOUNT_ALLOCATION: 'warning',
  NONCE_CHANGE: 'warning',
  STAKE_CHANGE: 'warning',
  ADDRESS_LOOKUP_TABLE: 'warning',
  COMPUTE_BUDGET: 'info',
  MEMO: 'info',
  UNKNOWN_PROGRAM: 'warning',
  UNSUPPORTED_INSTRUCTION: 'warning',
  UNSUPPORTED_TOKEN_PROGRAM: 'warning',
  MALFORMED_INSTRUCTION: 'warning',
  TRANSACTION_FAILED: 'warning',
  FINALITY_UNVERIFIED: 'warning',
  INCOMPLETE_METADATA: 'warning',
} as const;

export type ExplanationFlag = {
  code: keyof typeof EXPLANATION_FLAG_SEVERITY;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  instruction?: string;
};

export type ExplainedInstruction = {
  location: string;
  programId: string | null;
  kind: string;
  description: string;
  fields: Record<string, string>;
  flags: ExplanationFlag[];
};
