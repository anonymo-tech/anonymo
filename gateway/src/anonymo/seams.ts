// Anonymo seams: the small interfaces every workstream codes against, so streams can be built in parallel.
// Each stub here is a safe placeholder that the owning workstream replaces (see HANDOFF.md at the repo root).
// Rule: change a signature only through WS0 (the contracts owner) and update every caller in the same PR.

import type { Pico } from "../lib/money.ts";

// ---- WS2 · Floor gate ----------------------------------------------------------------------------------------------
// Runs before routing on every prompt and every upload. A block returns HTTP 451 and is NEVER rerouted.
export type FloorCategory = "minor" | "real_person" | "voice_clone" | "cbrn";
export type FloorInput = { text: string; modality: "text" | "image" | "video" | "audio"; hasUpload: boolean };
export type FloorVerdict = { ok: true } | { ok: false; category: FloorCategory };
export interface FloorGate {
  check(input: FloorInput, signal?: AbortSignal): Promise<FloorVerdict>;
}
/** Placeholder that passes everything. With `required` (ANONYMO_FLOOR_REQUIRED=1, which every real deployment sets)
 *  it fails CLOSED instead, so nothing can serve traffic without WS02's real gate. */
export const floorGateStub = (required: boolean): FloorGate => ({
  async check() {
    if (required) throw new Error("floor gate not configured");
    return { ok: true };
  },
});

// ---- WS3 · Refusal catch -------------------------------------------------------------------------------------------
// Reads the prompt and the first ~160 buffered tokens of a reply. Runs only after the floor gate passed.
export interface RefusalClassifier {
  isRefusal(prompt: string, head: string): Promise<boolean>;
}
const REFUSAL_OPENERS = [/\bI can(?:'|no)t help with\b/i, /\bas an AI\b/i, /\bI(?:'m| am) (?:not able|unable) to\b/i];
export const phraseRefusalStub: RefusalClassifier = {
  async isRefusal(_prompt, head) {
    return REFUSAL_OPENERS.some((r) => r.test(head.slice(0, 600)));
  },
};

// ---- WS5 · Deposits ------------------------------------------------------------------------------------------------
// Every chain watcher reports confirmed deposits through this one call. Idempotent on `ref` (ledger.ref is UNIQUE).
// "coin" is an ANMO payment through CoinPay: burned on-chain, credited at the market price, usage only (never withdrawn).
export type DepositChain = "base" | "arbitrum" | "rhc" | "solana" | "tron" | "btc" | "ln" | "x402" | "coin";
export type ConfirmedDeposit = {
  keyHash: string;
  chain: DepositChain;
  amount: Pico; // already converted to USD (stablecoins 1:1, BTC at the BTCPay quote)
  ref: string; // `${chain}:${txHash}:${logIndex}` or the BTCPay invoice id
  sourceAddr: string; // where refunds/withdrawals go back to
};
export interface DepositSink {
  credit(d: ConfirmedDeposit): Promise<{ credited: boolean }>; // false = already recorded
}
export interface SanctionsScreen {
  isBlocked(chain: DepositChain, address: string): Promise<boolean>;
}

// ---- WS6 · Media ---------------------------------------------------------------------------------------------------
export type MediaVerdict = { ok: true } | { ok: false; reason: "nsfw_minor" | "nsfw_real_person" | "unscored" };
export interface MediaGate {
  check(bytes: Uint8Array, mime: string): Promise<MediaVerdict>; // fails closed: an unscored output is a block
}
export interface Provenance {
  stamp(bytes: Uint8Array, mime: string, meta: { requestId: string; model: string }): Promise<Uint8Array>; // C2PA + watermark
}

// ---- Region rules (WS2) --------------------------------------------------------------------------------------------
export type RegionPolicy = { blocked: boolean; explicitMediaAllowed: boolean };
export interface RegionRules {
  forCountry(iso2: string | null): RegionPolicy; // edge passes the country only; the IP is never stored
}
