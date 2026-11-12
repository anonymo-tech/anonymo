import type { TableDoc } from "../types.ts";
import { CREATED, KEPT, rv } from "./common.ts";

// WS09: Anonymo receipts (Backend §8) and their hourly roots. Ids, route names, hashes, token counts and amounts only.

export const anonymoReceiptTables: Record<string, TableDoc> = {
  anonymo_receipts: {
    category: "receipts",
    purpose: "One signed Anonymo receipt per served call: the routes it touched, their families, weights hashes, costs and whether each refused, so anyone can check which models ran.",
    request: "yes",
    retention: KEPT,
    columns: {
      id: "The request id, also the X-Receipt-Id of the response.",
      model_id: "The model id the caller asked for (anonymo-council, anonymo-sealed, ...).",
      payload: {
        purpose:
          "The signed receipt: request id, model id, routes (provider, model, family, quant, attested, weights hash, token counts, cost, status, per-call receipt id), weights hashes, the enclave quote hash for sealed calls, totals, refused, sealed, council mode and outcome, and the time. Fixed fields chosen by the router.",
        review: rv(["name:content", "type:json"], "no-request-content", "Built only from route records, counts, amounts and hashes by receipts/anonymo.ts; no request or answer text is copied into it."),
      },
      sig: "The router's Ed25519 signature over the canonical receipt.",
      key_id: "Which receipt signing key signed it.",
      leaf: "keccak256 of the canonical receipt: its Merkle leaf.",
      issued_at: "When the receipt was signed.",
      root_hour: "The hour whose root includes this receipt, once rooted.",
      leaf_index: "The receipt's position among that root's leaves.",
    },
  },
  anonymo_receipt_roots: {
    category: "receipts",
    purpose: "The Merkle root over one hour's Anonymo receipts, and the ReceiptRoots transaction that posted it.",
    request: "aggregate",
    retention: KEPT,
    columns: {
      hour: "Unix hour number the root covers.",
      root: "The Merkle root (32 bytes, hex).",
      count: "How many receipts the root covers.",
      status: "local (no poster configured), pending, posted or failed.",
      tx_hash: "The chain transaction that posted the root.",
      created_at: CREATED,
      posted_at: "When the root was posted.",
    },
  },
};
