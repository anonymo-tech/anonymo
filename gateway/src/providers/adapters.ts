// WS04 · Per-upstream adapters. Every Anonymo upstream speaks the OpenAI chat API, so upstream.ts makes the call and
// classifies failures for all of them. An adapter only adds what one kind of upstream needs on top:
//   - request body tweaks (Venice: never prepend Venice's own system prompt to our callers' conversations)
//   - where its prepaid wallet balance is read, and how (src/providers/balance.ts runs the alarm)
//
// Balance endpoints are the documented account endpoints as of this writing. None has been called with a live key from
// this repository, so each one can be overridden in config/upstreams.yaml (balance.url / method / auth / path).

import type { UpstreamKind } from "../anonymo/models.ts";

export type BalanceEndpoint = {
  /** Absolute URL, or a path resolved against the origin of the upstream's base URL. */
  url: string;
  method: "GET" | "POST";
  auth: "bearer" | "x-api-key" | "none";
  /** Dotted path to the USD balance in the JSON reply. */
  path: string;
};

export type UpstreamAdapter = {
  /** Change the upstream request body in place (after router-only fields were removed). */
  body?: (out: Record<string, unknown>) => void;
  /** Where the prepaid balance is read when the config does not say. Null: the config must give a URL. */
  balance: BalanceEndpoint | null;
};

export const ADAPTERS: Readonly<Record<UpstreamKind, UpstreamAdapter>> = Object.freeze({
  venice: {
    body: (out) => {
      const vp = out.venice_parameters && typeof out.venice_parameters === "object" ? (out.venice_parameters as Record<string, unknown>) : {};
      out.venice_parameters = { ...vp, include_venice_system_prompt: false };
    },
    balance: { url: "/api/v1/api_keys/rate_limits", method: "GET", auth: "bearer", path: "data.balances.USD" },
  },
  nanogpt: { balance: { url: "/api/check-balance", method: "POST", auth: "x-api-key", path: "usd_balance" } },
  chutes: { balance: { url: "https://api.chutes.ai/users/me", method: "GET", auth: "bearer", path: "balance" } },
  // Phala's confidential API, self-hosted GPU markets and Featherless (a flat subscription) have no default: a prepaid
  // one must name its balance endpoint in the config.
  phala: { balance: null },
  selfhost: { balance: null },
  featherless: { balance: null },
});

export const adapterFor = (kind: string | null | undefined): UpstreamAdapter | null => (kind && kind in ADAPTERS ? ADAPTERS[kind as UpstreamKind] : null);

/** Read a dotted path from a JSON value. Numbers and numeric strings count; anything else is null. */
export function readUsd(json: unknown, path: string): number | null {
  let v: unknown = json;
  for (const k of path.split(".")) {
    if (v === null || typeof v !== "object") return null;
    v = (v as Record<string, unknown>)[k];
  }
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
