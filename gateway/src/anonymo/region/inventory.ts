import { rv } from "../../privacy/tables/common.ts";
import type { TableDoc } from "../../privacy/types.ts";

export const complianceTables: Record<string, TableDoc> = {
  region_policy: {
    category: "operations",
    purpose: "Operator policy for each region and the interval between AI disclosures.",
    request: "no",
    retention: "Kept until the operator removes the policy.",
    columns: {
      region: "ISO country or subdivision code for the policy.",
      mode: "One of allowed, blocked or proof required.",
      disclosure_interval_min: "AI disclosure interval in minutes, when configured.",
      updated_at: "Time the policy was created or updated.",
    },
  },
  age_proofs: {
    category: "keys",
    purpose: "Confirms that an over-18 claim was verified for a key.",
    request: "no",
    retention: "Kept to recognize the verified key and prevent reuse of the same nullifier.",
    columns: {
      nullifier: {
        purpose: "Canonical 32-byte nullifier returned by the age proof verifier.",
        review: rv(["type:binary"], "no-request-content", "A fixed-length verifier output used to prevent replay of an over-18 claim. The submitted proof and its identity data are discarded."),
      },
      key_hash: {
        purpose: "SHA-256 hash of the key that verified the proof.",
        review: rv(["type:binary"], "no-request-content", "Only the 32-byte hash of the authenticated key is retained to look up its verification."),
      },
      verified_at: "Time the proof was first accepted.",
    },
  },
};
