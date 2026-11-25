/** Verify an over-18 claim bound to this key, and return its canonical 32-byte nullifier on success. */
export interface AgeProofVerifier {
  verify(proof: string, keyHash: string): Promise<Uint8Array | null>;
}
