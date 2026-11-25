import type { ExternalDoc, TableDoc, Touchpoint } from "../../privacy/types.ts";

export const codesTables: Record<string, TableDoc> = {
  codes: {
    category: "billing",
    purpose: "Issued Anonymo Codes and their single-use redemption records.",
    request: "no",
    retention: "Codes never expire. Redemption records prevent reuse.",
    columns: {
      code_hash: {
        purpose: "SHA-256 of the canonical, hyphenated voucher code.",
        review: { covers: ["type:binary"], verdict: "digest-only", why: "Only the fixed-length SHA-256 digest of the formatted voucher is stored." },
      },
      face_usd: "The voucher's fixed face value in USD.",
      batch_id: "Random UUID of the issuance batch.",
      reseller_id: "Operator-assigned UUID of the reseller that issued the batch. Token hashes live in operator configuration.",
      redeemed_by: {
        purpose: "SHA-256 of the Anonymo key credited when the voucher was redeemed.",
        review: { covers: ["type:binary"], verdict: "digest-only", why: "Only the fixed-length SHA-256 digest of the credited API key is stored." },
      },
      redeemed_at: "When the code was redeemed, in UTC.",
    },
  },
};

const file = "src/anonymo/codes/routes.ts";
export const codesAddressReader: Touchpoint = {
  file,
  reads: "The caller address selected by the shared ingress helper.",
  then: "Derives a keyed digest for voucher redemption and reseller batch-list limits.",
  kept: "Only the keyed digest is retained in the short-lived limiter.",
  evidence: [{ file, contains: 'createHmac("sha256", ctx.cfg.appSecret)' }],
};
export const codesBodyReader: ExternalDoc["bodyReaders"][number] = {
  file,
  reads: "A voucher code or the face value and count of a batch to issue.",
  carries: "payment-or-signature",
  then: "Validates the input and hashes each voucher before storing or looking it up.",
  kept: "Only voucher digests and batch or redemption metadata are stored.",
  evidence: [{ file, contains: "redeemBody.safeParse(" }],
};
