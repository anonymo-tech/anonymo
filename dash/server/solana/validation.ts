import bs58 from 'bs58';

export type SolanaCluster = 'devnet' | 'mainnet-beta';
export const SOLANA_NETWORKS = Object.freeze({
  devnet: Object.freeze({
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  }),
  'mainnet-beta': Object.freeze({
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  }),
});
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM =
  'ComputeBudget111111111111111111111111111111';
export const U64_MAX = (1n << 64n) - 1n;

export type SolanaErrorCode =
  | 'invalid_configuration'
  | 'invalid_input'
  | 'sensitive_input'
  | 'invalid_response'
  | 'wrong_cluster'
  | 'rpc_unavailable'
  | 'rpc_timeout'
  | 'cancelled'
  | 'response_too_large'
  | 'not_finalized'
  | 'transaction_failed'
  | 'unsupported_transaction'
  | 'unsupported_instruction'
  | 'ambiguous_deposit'
  | 'deposit_mismatch'
  | 'invalid_amount'
  | 'incomplete_metadata';

/** Messages deliberately omit endpoints, credentials and submitted wallet data. */
export class SolanaError extends Error {
  readonly code: SolanaErrorCode;
  constructor(code: SolanaErrorCode) {
    super(code);
    this.name = 'SolanaError';
    this.code = code;
  }
}

export function requireSolana(
  condition: unknown,
  code: SolanaErrorCode,
): asserts condition {
  if (!condition) throw new SolanaError(code);
}
export function record(value: unknown): Record<string, unknown> {
  requireSolana(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_response',
  );
  return value as Record<string, unknown>;
}
export function list(value: unknown, maximum = 256): unknown[] {
  requireSolana(
    Array.isArray(value) && value.length <= maximum,
    'invalid_response',
  );
  return value;
}
export function uint(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  requireSolana(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= maximum,
    'invalid_response',
  );
  return value;
}
export function base58Bytes(
  value: unknown,
  length: number,
): Uint8Array<ArrayBuffer> {
  requireSolana(
    typeof value === 'string' &&
      value.length >= length &&
      value.length <= Math.ceil(length * 1.38),
    'invalid_input',
  );
  try {
    const bytes = new Uint8Array(bs58.decode(value));
    requireSolana(
      bytes.length === length && bs58.encode(bytes) === value,
      'invalid_input',
    );
    return bytes;
  } catch {
    throw new SolanaError('invalid_input');
  }
}
export function address(value: unknown): string {
  base58Bytes(value, 32);
  return value as string;
}
export function signature(value: unknown): string {
  base58Bytes(value, 64);
  return value as string;
}
export function amount(value: unknown, positive = false): bigint {
  requireSolana(
    typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value),
    'invalid_amount',
  );
  const parsed = BigInt(value);
  requireSolana(
    parsed <= U64_MAX && (!positive || parsed > 0n),
    'invalid_amount',
  );
  return parsed;
}
export function cluster(value: unknown): SolanaCluster {
  requireSolana(
    value === 'devnet' || value === 'mainnet-beta',
    'invalid_configuration',
  );
  return value;
}
export function assertGenesis(network: SolanaCluster, hash: unknown): void {
  requireSolana(
    hash === SOLANA_NETWORKS[cluster(network)].genesisHash,
    'wrong_cluster',
  );
}
export function finalizedStatus(
  value: unknown,
  allowFailed = false,
): { slot: number } {
  requireSolana(value !== null, 'not_finalized');
  const status = record(value);
  requireSolana(
    Object.hasOwn(status, 'err') &&
      (status.err === null ||
        typeof status.err === 'string' ||
        (typeof status.err === 'object' && !Array.isArray(status.err))),
    'invalid_response',
  );
  requireSolana(
    status.confirmationStatus === 'finalized' && status.confirmations === null,
    'not_finalized',
  );
  const slot = uint(status.slot);
  // A failed result is definitive only after its finalized status is valid.
  if (!allowFailed) requireSolana(status.err === null, 'transaction_failed');
  return { slot };
}
