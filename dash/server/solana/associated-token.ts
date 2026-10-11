import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {
  address,
  base58Bytes,
  cluster,
  requireSolana,
  SolanaError,
  SOLANA_NETWORKS,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  type SolanaCluster,
} from './validation.ts';

// Offline Associated Token Account derivation. Pure: no RPC, environment,
// file or signing access. Deriving an address never proves the account exists
// on chain or who controls it; that stays a separate, owner-approved check.

export const ASSOCIATED_TOKEN_PROGRAM =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MAX_SEEDS = 16;
const MAX_SEED_LENGTH = 32;
const PDA_MARKER = 'ProgramDerivedAddress';

export type AssociatedTokenInput = {
  owner: string;
  mint: string;
  tokenProgram: string;
};
export type ProgramAddress = { address: string; bump: number };

/** Solana's find_program_address: SHA-256(seeds, bump, program, marker), off curve. */
export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: string,
): ProgramAddress {
  requireSolana(
    seeds.length > 0 &&
      seeds.length <= MAX_SEEDS &&
      seeds.every((seed) => seed.length <= MAX_SEED_LENGTH),
    'invalid_input',
  );
  const program = base58Bytes(programId, 32);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash('sha256');
    for (const seed of seeds) hash.update(seed);
    const digest = new Uint8Array(
      hash
        .update(new Uint8Array([bump]))
        .update(program)
        .update(PDA_MARKER)
        .digest(),
    );
    if (!onCurve(digest)) return { address: bs58.encode(digest), bump };
  }
  throw new SolanaError('invalid_input');
}

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

/** Canonical ATA: seeds [owner, tokenProgram, mint] under the ATA program. */
export function associatedTokenAddress(input: AssociatedTokenInput): string {
  const owner = base58Bytes(input.owner, 32);
  const mint = base58Bytes(input.mint, 32);
  requireSolana(
    input.tokenProgram === TOKEN_PROGRAM ||
      input.tokenProgram === TOKEN_2022_PROGRAM,
    'invalid_input',
  );
  const tokenProgram = base58Bytes(input.tokenProgram, 32);
  return findProgramAddress(
    [owner, tokenProgram, mint],
    ASSOCIATED_TOKEN_PROGRAM,
  ).address;
}

/** The treasury wallet's native-USDC ATA for a cluster, derived offline only. */
export function treasuryUsdcTokenAccount(
  network: SolanaCluster,
  wallet: string,
): string {
  return associatedTokenAddress({
    owner: address(wallet),
    mint: SOLANA_NETWORKS[cluster(network)].usdcMint,
    tokenProgram: TOKEN_PROGRAM,
  });
}
