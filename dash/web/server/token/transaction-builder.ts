import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { ServiceError, requireCondition } from '../core/errors.ts';
import {
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  U64_MAX,
  base58Bytes,
} from '../solana/validation.ts';
import {
  requireWriteCapableToken,
  type PlatformTokenConfig,
  type PlatformTokenUnavailable,
} from './config.ts';

// Minimal legacy Solana transaction builder and Ed25519 signer for the token
// executor. It covers exactly what the burn path needs: SPL Token
// BurnChecked/TransferChecked (identical layouts for spl-token and token-2022)
// and the optional ComputeBudget instructions. No address lookup tables, no
// durable nonces, no partial signing with external wallets. Everything is
// integer and bounded; the wire form is checked against the packet limit.

/** Solana packet limit: a serialized transaction may not exceed this many bytes. */
export const TRANSACTION_SIZE_LIMIT = 1232;

export type TokenKeypair = {
  /** Base58 public key. */
  address: string;
  publicKey: Uint8Array;
  /** 32-byte Ed25519 seed. Never logged, never serialized to JSON. */
  secretKey: Uint8Array;
};

export type InstructionAccount = {
  address: string;
  signer: boolean;
  writable: boolean;
};

export type Instruction = {
  programId: string;
  accounts: InstructionAccount[];
  data: Uint8Array;
};

export type CompiledMessage = {
  bytes: Uint8Array;
  header: {
    numRequiredSignatures: number;
    numReadonlySignedAccounts: number;
    numReadonlyUnsignedAccounts: number;
  };
  accountKeys: string[];
  recentBlockhash: string;
};

export type SignedTransaction = {
  /** Base64 wire bytes: shortvec(signature count) + signatures + message. */
  base64: string;
  /** Base58 of the payer's signature: the transaction id. */
  signature: string;
  byteLength: number;
};

function failInput(message: string): never {
  throw new ServiceError(400, 'TOKEN_TRANSACTION_INVALID', message);
}

/** Compact-u16 length prefix used throughout the Solana wire format. */
export function shortvecEncode(value: number): Uint8Array {
  requireCondition(
    Number.isSafeInteger(value) && value >= 0 && value <= 0xffff,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'A length prefix is out of range.',
  );
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Uint8Array.from(bytes);
}

/** Decodes a compact-u16 at an offset; returns the value and the bytes used. */
export function shortvecDecode(
  bytes: Uint8Array,
  offset = 0,
): { value: number; length: number } {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) failInput('A length prefix is truncated.');
    if (i === 2 && byte > 3) failInput('A length prefix is out of range.');
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      if (i > 0 && byte === 0) failInput('A length prefix is not minimal.');
      return { value, length: i + 1 };
    }
  }
  return failInput('A length prefix is too long.');
}

function u64le(value: bigint): Uint8Array {
  requireCondition(
    typeof value === 'bigint' && value >= 0n && value <= U64_MAX,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'A 64-bit amount is out of range.',
  );
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function u32le(value: number): Uint8Array {
  requireCondition(
    Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'A 32-bit value is out of range.',
  );
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function decimalsByte(decimals: number): number {
  requireCondition(
    Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 9,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'The token decimals are invalid.',
  );
  return decimals;
}

function tokenProgramId(programId: string): string {
  requireCondition(
    programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'The token program is not supported.',
  );
  return programId;
}

function checkedAddress(value: string): string {
  try {
    base58Bytes(value, 32);
  } catch {
    failInput('An account address is invalid.');
  }
  return value;
}

function checkedBlockhash(value: string): Uint8Array {
  try {
    return base58Bytes(value, 32);
  } catch {
    return failInput('The recent blockhash is invalid.');
  }
}

// --- Keypairs ---------------------------------------------------------------

/** Derives a keypair from a 32-byte Ed25519 seed. */
export function keypairFromSeed(seed: Uint8Array): TokenKeypair {
  requireCondition(
    seed instanceof Uint8Array && seed.length === 32,
    400,
    'TOKEN_KEYPAIR_INVALID',
    'The signing key is invalid.',
  );
  const secretKey = Uint8Array.from(seed);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { address: bs58.encode(publicKey), publicKey, secretKey };
}

/** A fresh random keypair; used by the localnet rehearsal for throwaway wallets. */
export function generateKeypair(): TokenKeypair {
  return keypairFromSeed(ed25519.utils.randomSecretKey());
}

/** The standard 64-byte JSON array (seed || public key) written by the Solana CLI. */
export function keypairFromJsonArray(text: string): TokenKeypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceError(
      503,
      'TOKEN_KEYPAIR_INVALID',
      'The signing key file is unreadable.',
    );
  }
  requireCondition(
    Array.isArray(parsed) &&
      parsed.length === 64 &&
      parsed.every(
        (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
      ),
    503,
    'TOKEN_KEYPAIR_INVALID',
    'The signing key file is invalid.',
  );
  const bytes = Uint8Array.from(parsed as number[]);
  const keypair = keypairFromSeed(bytes.subarray(0, 32));
  // The stored public half must match the seed; a mismatch means a damaged file.
  requireCondition(
    keypair.publicKey.every((byte, index) => byte === bytes[32 + index]),
    503,
    'TOKEN_KEYPAIR_INVALID',
    'The signing key file is inconsistent.',
  );
  bytes.fill(0);
  return keypair;
}

/**
 * Loads a local signing key. Allowed only when the configured cluster may send
 * token transactions (localnet/devnet); on mainnet-beta this throws before the
 * file is touched. Key bytes never appear in errors or logs.
 */
export function loadLocalKeypair(
  path: string,
  config: PlatformTokenConfig | PlatformTokenUnavailable,
): TokenKeypair {
  requireWriteCapableToken(config);
  requireCondition(
    typeof path === 'string' && path.length > 0 && path.length <= 4096,
    503,
    'TOKEN_KEYPAIR_INVALID',
    'The signing key path is invalid.',
  );
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ServiceError(
      503,
      'TOKEN_KEYPAIR_INVALID',
      'The signing key file is unreadable.',
    );
  }
  return keypairFromJsonArray(text);
}

// --- Instructions -----------------------------------------------------------

/** SPL Token `BurnChecked` (index 15): u64 LE amount, u8 decimals. */
export function burnCheckedInstruction(input: {
  programId: string;
  tokenAccount: string;
  mint: string;
  owner: string;
  amountRaw: bigint;
  decimals: number;
}): Instruction {
  requireCondition(
    input.amountRaw > 0n,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'A burn amount must be positive.',
  );
  return {
    programId: tokenProgramId(input.programId),
    accounts: [
      { address: checkedAddress(input.tokenAccount), signer: false, writable: true },
      { address: checkedAddress(input.mint), signer: false, writable: true },
      { address: checkedAddress(input.owner), signer: true, writable: false },
    ],
    data: Uint8Array.from([
      15,
      ...u64le(input.amountRaw),
      decimalsByte(input.decimals),
    ]),
  };
}

/** SPL Token `TransferChecked` (index 12): u64 LE amount, u8 decimals. */
export function transferCheckedInstruction(input: {
  programId: string;
  source: string;
  mint: string;
  destination: string;
  owner: string;
  amountRaw: bigint;
  decimals: number;
}): Instruction {
  requireCondition(
    input.amountRaw > 0n,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'A transfer amount must be positive.',
  );
  return {
    programId: tokenProgramId(input.programId),
    accounts: [
      { address: checkedAddress(input.source), signer: false, writable: true },
      { address: checkedAddress(input.mint), signer: false, writable: false },
      { address: checkedAddress(input.destination), signer: false, writable: true },
      { address: checkedAddress(input.owner), signer: true, writable: false },
    ],
    data: Uint8Array.from([
      12,
      ...u64le(input.amountRaw),
      decimalsByte(input.decimals),
    ]),
  };
}

/** ComputeBudget `SetComputeUnitLimit` (index 2): u32 LE units. */
export function setComputeUnitLimitInstruction(units: number): Instruction {
  requireCondition(
    Number.isSafeInteger(units) && units > 0 && units <= 1_400_000,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'The compute unit limit is out of range.',
  );
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: Uint8Array.from([2, ...u32le(units)]),
  };
}

/** ComputeBudget `SetComputeUnitPrice` (index 3): u64 LE micro-lamports per unit. */
export function setComputeUnitPriceInstruction(
  microLamports: bigint,
): Instruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: Uint8Array.from([3, ...u64le(microLamports)]),
  };
}

// --- Message compilation ----------------------------------------------------

/**
 * Compiles a legacy message. Account keys are ordered payer first, then other
 * signer-writable, signer-readonly, non-signer-writable and non-signer-readonly
 * keys; within a class, first appearance wins. Program ids are non-signer
 * readonly. Flags for an address that appears more than once are merged.
 */
export function compileLegacyMessage(input: {
  payer: string;
  instructions: Instruction[];
  recentBlockhash: string;
}): CompiledMessage {
  const payer = checkedAddress(input.payer);
  requireCondition(
    Array.isArray(input.instructions) &&
      input.instructions.length >= 1 &&
      input.instructions.length <= 64,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'A transaction needs between 1 and 64 instructions.',
  );
  const blockhash = checkedBlockhash(input.recentBlockhash);
  const flags = new Map<string, { signer: boolean; writable: boolean }>();
  const order: string[] = [];
  const note = (address: string, signer: boolean, writable: boolean) => {
    const existing = flags.get(address);
    if (existing) {
      existing.signer ||= signer;
      existing.writable ||= writable;
    } else {
      flags.set(address, { signer, writable });
      order.push(address);
    }
  };
  note(payer, true, true);
  for (const instruction of input.instructions) {
    for (const account of instruction.accounts)
      note(checkedAddress(account.address), account.signer, account.writable);
    note(checkedAddress(instruction.programId), false, false);
    requireCondition(
      instruction.data instanceof Uint8Array &&
        instruction.data.length <= TRANSACTION_SIZE_LIMIT,
      400,
      'TOKEN_TRANSACTION_INVALID',
      'An instruction payload is invalid.',
    );
  }
  for (const instruction of input.instructions) {
    const program = flags.get(instruction.programId)!;
    // A program may not be invoked as a signer or writable account in the same message.
    requireCondition(
      !program.signer && !program.writable,
      400,
      'TOKEN_TRANSACTION_INVALID',
      'A program account may not be a signer or writable.',
    );
  }
  const classOf = (address: string) => {
    const flag = flags.get(address)!;
    if (address === payer) return 0;
    if (flag.signer) return flag.writable ? 1 : 2;
    return flag.writable ? 3 : 4;
  };
  const accountKeys = order
    .map((address, index) => ({ address, index, rank: classOf(address) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.address);
  requireCondition(
    accountKeys.length <= 256,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'Too many accounts.',
  );
  const indexOf = new Map(accountKeys.map((address, index) => [address, index]));
  const signers = accountKeys.filter((address) => flags.get(address)!.signer);
  const header = {
    numRequiredSignatures: signers.length,
    numReadonlySignedAccounts: signers.filter(
      (address) => !flags.get(address)!.writable,
    ).length,
    numReadonlyUnsignedAccounts: accountKeys.filter(
      (address) => !flags.get(address)!.signer && !flags.get(address)!.writable,
    ).length,
  };
  const parts: Uint8Array[] = [
    Uint8Array.from([
      header.numRequiredSignatures,
      header.numReadonlySignedAccounts,
      header.numReadonlyUnsignedAccounts,
    ]),
    shortvecEncode(accountKeys.length),
    ...accountKeys.map((address) => base58Bytes(address, 32)),
    blockhash,
    shortvecEncode(input.instructions.length),
  ];
  for (const instruction of input.instructions) {
    const accountIndexes = instruction.accounts.map(
      (account) => indexOf.get(account.address)!,
    );
    parts.push(
      Uint8Array.from([indexOf.get(instruction.programId)!]),
      shortvecEncode(accountIndexes.length),
      Uint8Array.from(accountIndexes),
      shortvecEncode(instruction.data.length),
      instruction.data,
    );
  }
  return {
    bytes: concat(parts),
    header,
    accountKeys,
    recentBlockhash: input.recentBlockhash,
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Signs a compiled message with every required signer and serializes the
 * transaction. Every account the header marks as a signer must have a keypair;
 * extra keypairs are rejected so a stray key cannot sign by accident.
 */
export function signCompiledMessage(
  message: CompiledMessage,
  signers: TokenKeypair[],
): SignedTransaction {
  const required = message.accountKeys.slice(
    0,
    message.header.numRequiredSignatures,
  );
  const byAddress = new Map(signers.map((keypair) => [keypair.address, keypair]));
  requireCondition(
    byAddress.size === signers.length && signers.length === required.length,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'The signer set does not match the message.',
  );
  const signatures = required.map((address) => {
    const keypair = byAddress.get(address);
    requireCondition(
      keypair !== undefined,
      400,
      'TOKEN_TRANSACTION_INVALID',
      'A required signer is missing.',
    );
    return ed25519.sign(message.bytes, keypair.secretKey);
  });
  const bytes = concat([
    shortvecEncode(signatures.length),
    ...signatures,
    message.bytes,
  ]);
  requireCondition(
    bytes.length <= TRANSACTION_SIZE_LIMIT,
    400,
    'TOKEN_TRANSACTION_INVALID',
    'The transaction exceeds the packet size limit.',
  );
  return {
    base64: Buffer.from(bytes).toString('base64'),
    signature: bs58.encode(signatures[0]!),
    byteLength: bytes.length,
  };
}

/** Compile, sign and serialize in one step; the first signer is the fee payer. */
export function buildSignedTransaction(input: {
  payer: TokenKeypair;
  instructions: Instruction[];
  recentBlockhash: string;
  additionalSigners?: TokenKeypair[];
}): SignedTransaction {
  const message = compileLegacyMessage({
    payer: input.payer.address,
    instructions: input.instructions,
    recentBlockhash: input.recentBlockhash,
  });
  return signCompiledMessage(message, [
    input.payer,
    ...(input.additionalSigners ?? []),
  ]);
}

/** Verifies that a signature over a message was produced by the given address. */
export function verifyMessageSignature(
  message: Uint8Array,
  signature: Uint8Array,
  address: string,
): boolean {
  try {
    return ed25519.verify(signature, message, base58Bytes(address, 32));
  } catch {
    return false;
  }
}
