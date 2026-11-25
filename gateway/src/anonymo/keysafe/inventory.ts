import type { ColumnDoc, ExternalDoc, TableDoc } from "../../privacy/types.ts";

const binary = (purpose: string, why: string): ColumnDoc => ({
  purpose,
  review: { covers: ["type:binary"], verdict: "no-request-content", why },
});

export const keySafeTables: Record<string, TableDoc> = {
  key_safes: {
    category: "keys",
    request: "no",
    purpose: "Optional passkey backups, encrypted on the device with a key derived from the passkey.",
    retention: "Kept until the holder deletes the backup using its safe ID.",
    columns: {
      safe_id: binary("Random deletion and lookup ID.", "Sixteen random bytes chosen on the device, independent of the API key."),
      credential_id: binary("Discoverable passkey credential ID.", "A WebAuthn credential identifier, independent of the API key and its hash."),
      ciphertext: binary("Wrapped API key and optional memory secret.", "AES-GCM ciphertext produced on the device. The passkey PRF output is never uploaded."),
      nonce: binary("AES-GCM nonce for this backup.", "Twelve random bytes chosen on the device for each backup."),
      created_at: "When the backup was first stored.",
    },
  },
};

const file = "src/anonymo/keysafe/routes.ts";
export const keySafeAddressReader: ExternalDoc["addressReaders"][number] = {
  file,
  reads: "The caller's address for the key safe rate limits.",
  then: "Counts operations using a short-lived, keyed digest of the address.",
  kept: "Only a minute-scoped HMAC digest in the rate limiter.",
  evidence: [{ file, contains: "const bucket = createHmac" }],
};
export const keySafeBodyReader: ExternalDoc["bodyReaders"][number] = {
  file,
  carries: "settings",
  reads: "Backup identifiers and, for saves, wrapped bytes and the nonce.",
  then: "Saves, looks up and deletes opaque passkey backups.",
  kept: "Only the identifiers, nonce and client-encrypted backup in key_safes.",
  evidence: [{ file, contains: "const parsed = backup.safeParse" }],
};
