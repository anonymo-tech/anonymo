import type { TableDoc, Touchpoint } from "../../privacy/types.ts";

export const freeTables: Record<string, TableDoc> = {
  free_tokens: {
    category: "request",
    request: "aggregate",
    purpose: "Daily free chat allowance and proof-of-work difficulty for each device token.",
    retention: "One row per device token. The next admitted message after a UTC day change replaces the previous day's counters.",
    columns: {
      device_token: {
        purpose: "SHA-256 digest of the random device token.",
        review: {
          covers: ["name:network", "type:binary"],
          verdict: "digest-only",
          why: "The server hashes a randomly generated token. The original token, network address and chat text are never written to the table.",
        },
      },
      day: "UTC day the counters belong to.",
      used: "Number of admitted messages and the replay guard for that UTC day.",
      pow_difficulty: "Difficulty in bits of the most recently accepted proof of work.",
    },
  },
};

export const freeAddressReader: Touchpoint = {
  file: "src/anonymo/freetier/routes.ts",
  reads: "The caller address used for free chat abuse limits.",
  then: "Combines the address and UTC day with a server-keyed HMAC before using the result as a rate-limit key.",
  kept: "Only the digest and counter, for one minute plus one second in Redis.",
  evidence: [{ file: "src/anonymo/freetier/routes.ts", contains: 'createHmac("sha256", ctx.cfg.appSecret).update(`free-address:' }],
};
