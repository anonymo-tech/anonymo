import { eq } from "drizzle-orm";
import { keccak256, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import { picoToUsdString, type Pico } from "../lib/money.ts";
import { canonicalBytes, type ReceiptSigner } from "./signer.ts";
import { anonymoReceipts } from "../db/anonymo-receipts.ts";
import { attestationQuoteHash } from "../anonymo/trust/sealed.ts";
import { familyOf, weightsHashOf } from "../anonymo/trust/families.ts";

// Anonymo receipt (Backend §8): one per served call, signed by the gateway's receipt key, returned in the
// `x-anonymo-receipt` response header and at GET /v1/receipts/{id}.
//
//   { request_id, model_id, routes[], weights_hash[], attestation_quote_hash?, tokens, cost, refused, ts, ... }
//
// leaf = keccak256(canonical_json(receipt)), the exact bytes the signature covers. Every closed hour's leaves become a
// Merkle root (services/anchor.ts runAnonymoRoots) posted to ReceiptRoots; GET /v1/receipts/{id}/proof returns the path.
// A receipt holds ids, route names, hashes, token counts and amounts. It never holds prompt or output text.

export const RECEIPT_VERSION = "anonymo-receipt/1";
export const RECEIPT_HEADER = "x-anonymo-receipt";

export type RouteRole = "single" | "retry" | "proposer" | "aggregator" | "judge";
export type RouteStatus = "ok" | "refused" | "late" | "failed";

/** One route the request touched, in the order it was used. */
export type ReceiptRoute = {
  /** `<provider>:<model>` */
  route: string;
  role: RouteRole;
  provider: string | null;
  model: string;
  family: string;
  quant: string | null;
  /** True only when the router held a fresh, verified attestation for the provider when the call was made. */
  attested: boolean;
  /** sha256 of the served weights when the route record carries it (WS04), else null. */
  weights_hash: string | null;
  /** Sealed calls only: the hash of the enclave quote the router verified for this route. */
  attestation_quote_hash?: string;
  tokens: { in: number; out: number };
  /** USD charged for this route (0 for a refused, late or failed attempt). */
  cost: string;
  refused: boolean;
  status: RouteStatus;
  /** The per-call signed receipt (GET /api/v1/receipts/{id}) when one was issued for this route. */
  call_receipt_id?: string | null;
};

export type AnonymoReceipt = {
  v: typeof RECEIPT_VERSION;
  request_id: string;
  model_id: string;
  routes: ReceiptRoute[];
  weights_hash: (string | null)[];
  attestation_quote_hash?: string;
  tokens: { in: number; out: number };
  cost: string;
  cost_details?: Record<string, string>;
  refused: boolean;
  sealed: boolean;
  council?: Record<string, unknown>;
  ts: string;
};

export type SignedReceipt = { payload: AnonymoReceipt; sig: string; key_id: string; alg: "Ed25519"; leaf: Hex };

/** A route entry from a catalog candidate: family, quant, weights hash and attestation as the router records them. */
export function receiptRoute(o: {
  candidate: { providerId: string; quant?: string | null; family?: unknown; provider: { attestationHash?: string | null } } & Record<string, unknown>;
  model: { id: string; name?: string | null; hfRepo?: string | null; family?: unknown };
  role: RouteRole;
  status: RouteStatus;
  attested: boolean;
  sealed: boolean;
  tokens?: { in: number; out: number };
  charged?: Pico;
  callReceiptId?: string | null;
  /** The route's weights hash when the caller knows more than the route record (e.g. a declared weights digest). */
  weightsHash?: string | null;
}): ReceiptRoute {
  const quote = o.sealed && o.attested ? (o.candidate.provider.attestationHash ?? null) : null;
  return {
    route: `${o.candidate.providerId}:${o.model.id}`,
    role: o.role,
    provider: o.candidate.providerId,
    model: o.model.id,
    family: familyOf(o.model, o.candidate),
    quant: o.candidate.quant ?? null,
    attested: o.attested,
    weights_hash: o.weightsHash !== undefined ? o.weightsHash : weightsHashOf(o.candidate, o.model as Record<string, unknown>),
    ...(quote ? { attestation_quote_hash: quote } : {}),
    tokens: o.tokens ?? { in: 0, out: 0 },
    cost: picoToUsdString(o.charged ?? 0n),
    refused: o.status === "refused",
    status: o.status,
    ...(o.callReceiptId !== undefined ? { call_receipt_id: o.callReceiptId } : {}),
  };
}

/** Build the receipt for a call from its routes. Totals are summed from the routes; `charged` is the request's total. */
export function buildAnonymoReceipt(o: {
  requestId: string;
  modelId: string;
  routes: ReceiptRoute[];
  charged: Pico;
  costDetails?: Record<string, string>;
  refused: boolean;
  sealed: boolean;
  council?: Record<string, unknown>;
  ts?: Date;
}): AnonymoReceipt {
  const used = o.routes.filter((r) => r.status === "ok" || r.status === "refused");
  const quote = o.sealed ? attestationQuoteHash(used.map((r) => r.attestation_quote_hash ?? "")) : null;
  if (o.sealed && !quote) throw new Error("a sealed receipt needs a verified quote hash for every route it used");
  return {
    v: RECEIPT_VERSION,
    request_id: o.requestId,
    model_id: o.modelId,
    routes: o.routes,
    weights_hash: o.routes.map((r) => r.weights_hash),
    ...(quote ? { attestation_quote_hash: quote } : {}),
    tokens: { in: o.routes.reduce((s, r) => s + r.tokens.in, 0), out: o.routes.reduce((s, r) => s + r.tokens.out, 0) },
    cost: picoToUsdString(o.charged),
    ...(o.costDetails ? { cost_details: o.costDetails } : {}),
    refused: o.refused,
    sealed: o.sealed,
    ...(o.council ? { council: o.council } : {}),
    ts: (o.ts ?? new Date()).toISOString(),
  };
}

/** keccak256 over the canonical JSON bytes of the receipt: the Merkle leaf. */
export const anonymoLeaf = (payload: AnonymoReceipt): Hex => keccak256(canonicalBytes(payload));

export function signAnonymoReceipt(signer: Pick<ReceiptSigner, "sign">, payload: AnonymoReceipt): SignedReceipt {
  const s = signer.sign(payload);
  return { payload, sig: s.sig, key_id: s.keyId, alg: "Ed25519", leaf: keccak256(s.bytes) };
}

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

/** Header form: `<base64url(canonical receipt)>.<base64url(signature)>.<key id>`. */
export function receiptHeader(r: SignedReceipt): string {
  return `${b64url(canonicalBytes(r.payload))}.${b64url(Buffer.from(r.sig, "base64"))}.${r.key_id}`;
}

/** Read an `x-anonymo-receipt` header back into the receipt, signature and key id (nothing is checked here). */
export function parseReceiptHeader(h: string): { payload: AnonymoReceipt; sig: string; key_id: string } {
  const [p, s, k] = h.split(".");
  if (!p || !s || !k) throw new Error("malformed receipt header");
  return { payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")), sig: Buffer.from(s, "base64url").toString("base64"), key_id: k };
}

export async function verifyAnonymoReceipt(ctx: Pick<Ctx, "signer">, r: { payload: unknown; sig: string; key_id: string }): Promise<boolean> {
  try {
    return await ctx.signer.verify(r.payload, r.sig, r.key_id);
  } catch {
    return false;
  }
}

/** Sign, store and return a receipt with its header value. The row joins the next hourly root. */
export async function issueAnonymoReceipt(ctx: Pick<Ctx, "db" | "signer">, payload: AnonymoReceipt): Promise<SignedReceipt & { header: string }> {
  const signed = signAnonymoReceipt(ctx.signer, payload);
  await ctx.db.insert(anonymoReceipts).values({
    id: payload.request_id,
    modelId: payload.model_id,
    payload,
    sig: signed.sig,
    keyId: signed.key_id,
    leaf: signed.leaf,
    issuedAt: new Date(payload.ts),
  });
  return { ...signed, header: receiptHeader(signed) };
}

export async function loadAnonymoReceipt(ctx: Pick<Ctx, "db">, id: string) {
  const [row] = await ctx.db.select().from(anonymoReceipts).where(eq(anonymoReceipts.id, id));
  return row ?? null;
}
