import { keccak_256 } from '@noble/hashes/sha3.js';

// Verifies a receipt inclusion proof the way the gateway builds it (gateway/src/receipts/merkle.ts): an
// OpenZeppelin MerkleProof-compatible tree with commutative (sorted-pair) keccak256 hashing.

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function bytes(hex: string): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const toHex = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

export function hashPair(a: string, b: string): string {
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const joined = new Uint8Array(64);
  joined.set(bytes(lo), 0);
  joined.set(bytes(hi), 32);
  return toHex(keccak_256(joined));
}

/** Walks the path from the leaf and returns the root it reaches, or null if any input is malformed. */
export function rootFromProof(leaf: string, proof: readonly string[]): string | null {
  if (!HEX32.test(leaf) || !proof.every((p) => HEX32.test(p))) return null;
  let node = leaf.toLowerCase();
  for (const sibling of proof) node = hashPair(node, sibling.toLowerCase());
  return node;
}

export function verifyInclusion(leaf: string, proof: readonly string[], root: string): boolean {
  const reached = rootFromProof(leaf, proof);
  return reached !== null && HEX32.test(root) && reached === root.toLowerCase();
}

export const keccakHex = (data: Uint8Array) => toHex(keccak_256(data));
