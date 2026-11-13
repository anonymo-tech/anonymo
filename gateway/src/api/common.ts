import { derivedClientIp } from "../hardening/client.ts";
import type { Context } from "hono";
import type { Config } from "../config.ts";
import { fail } from "../lib/errors.ts";

export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) fail(413, "Request body is too large (16 MB max).", "payload_too_large");
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) fail(413, "Request body is too large (16 MB max).", "payload_too_large");
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(400, "Request body must be valid JSON.", "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Request body must be a JSON object.", "invalid_json");
  return body as Record<string, unknown>;
}

/** Client address for rate limits. X-Forwarded-For is spoofable, so it is only read behind a trusted
 *  proxy (TRUST_PROXY=true), counting TRUST_PROXY_HOPS from the right. A valid enabled origin lock permits CF-Connecting-IP. */
export function clientIp(c: Context, trustProxy = false) {
  return derivedClientIp(c, trustProxy, c.get("hardening"));
}

/** Who a per-address rate limit counts a request against. */
export type AddressBucket = {
  /** The client address. */
  id: string;
  /** The limit this bucket gets where one address would get `limit`. */
  scale: (limit: number) => number;
};

/** The bucket for per-address rate limits (unauthenticated calls, new keys and the like). Keyed calls are limited per key. */
export function addressBucket(c: Context, cfg: Pick<Config, "trustProxy">): AddressBucket {
  return { id: clientIp(c, cfg.trustProxy), scale: (limit) => limit };
}

export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Headers every chat, completion and embeddings response carries once a generation id exists:
 *   X-Generation-Id / X-Receipt-Id  the generation id, which is also the id of its signed receipt (GET /api/v1/receipts/{id})
 *   Inference-Id                     the same id, under the name Hugging Face inference clients read
 *   X-Anonymo-Lane                  the lane the request was served under: public or attested
 *   X-Anonymo-Policy-Hash           only when the serving endpoint's fresh attestation bound a classifier policy hash
 * Browsers can read all of them (CORS Access-Control-Expose-Headers, see app.ts).
 */
export function generationHeaders(id: string, lane: string, policyHash?: string | null): Record<string, string> {
  return { "x-generation-id": id, "x-receipt-id": id, "inference-id": id, "x-anonymo-lane": lane, ...(policyHash ? { "x-anonymo-policy-hash": policyHash } : {}) };
}

/** The response headers listed above plus the others a browser client may read. */
export const EXPOSED_RESPONSE_HEADERS = ["x-generation-id", "x-receipt-id", "inference-id", "x-anonymo-lane", "x-anonymo-policy-hash", "x-payment-required", "x-payment-response", "payment-required", "payment-response", "x-anonymo-disclosure", "x-anonymo-cache", "x-anonymo-character", "x-anonymo-character-lane", "x-anonymo-character-note", "x-anonymo-character-session", "x-anonymo-default-route", "retry-after", "x-anonymo-receipt", "x-anonymo-council-mode", "x-anonymo-refusal", "x-anonymo-request-id", "x-anonymo-cost-usd", "x-anonymo-provenance"];

/** The policy hash a header may state for a response that stands for several calls: only one they all share. */
export const sharedPolicyHash = (hashes: (string | null | undefined)[]): string | null => (hashes.length && hashes.every((h) => h && h === hashes[0]) ? hashes[0]! : null);
