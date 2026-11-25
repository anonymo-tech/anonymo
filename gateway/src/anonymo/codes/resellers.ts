import { z } from "zod";

const credentials = z.record(z.uuid().transform((id) => id.toLowerCase()), z.string().regex(/^[a-fA-F0-9]{64}$/));

/** The operator provisions UUIDs and SHA-256 hex digests. The gateway never needs the original reseller tokens. */
export function resellerCredentials(raw: string | undefined): ReadonlyMap<string, string> {
  if (!raw) return new Map();
  let input: unknown;
  try { input = JSON.parse(raw); } catch { /* Report the same error without copying config values. */ }
  const parsed = credentials.safeParse(input);
  if (!parsed.success) throw new Error("ANONYMO_CODES_RESELLER_HASHES must map reseller UUIDs to SHA-256 hex digests.");
  const resellers = new Map<string, string>();
  for (const [id, hash] of Object.entries(parsed.data)) {
    const digest = hash.toLowerCase();
    if (resellers.has(digest)) throw new Error("Each reseller must have a distinct token hash.");
    resellers.set(digest, id);
  }
  return resellers;
}
