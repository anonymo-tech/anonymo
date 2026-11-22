// ANONYMO_WEB_SEARCH: the web search engine for `:online`, `plugins: [{ id: "web" }]` and `web_search_options`.
//
//   ANONYMO_WEB_SEARCH='{"provider":"brave","apiKey":"<brave subscription token>","maxResults":5}'
//
// Optional fields: `priceUsd` (charged once per served request that searched, default "0.005"), `timeoutMs` (default
// 4000), `safesearch` ("off" | "moderate" | "strict", default "moderate"). Unset or empty: web search is off and a
// request asking for it gets 501 web_search_unavailable with nothing held or charged. A malformed value stops startup;
// the error names the field, never the value.

import { z } from "zod";
import { usdToPico } from "../../lib/money.ts";
import { braveSearch } from "./brave.ts";
import type { WebSearchService } from "./types.ts";

export const WEB_SEARCH_ENV = "ANONYMO_WEB_SEARCH";
export const DEFAULT_WEB_SEARCH_PRICE_USD = "0.005";

const schema = z.object({
  provider: z.literal("brave"),
  apiKey: z.string().trim().min(1),
  maxResults: z.number().int().min(1).max(10).default(5),
  priceUsd: z.string().regex(/^\d+(\.\d{1,12})?$/).default(DEFAULT_WEB_SEARCH_PRICE_USD),
  timeoutMs: z.number().int().min(500).max(15_000).default(4_000),
  safesearch: z.enum(["off", "moderate", "strict"]).default("moderate"),
});

export type WebSearchConfig = z.infer<typeof schema>;

/** Parse the env value. Never echoes the input (it holds the API key). */
export function parseWebSearchConfig(raw: unknown): WebSearchConfig | null {
  if (raw == null || (typeof raw === "string" && !raw.trim())) return null;
  let json: unknown;
  try {
    json = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error(`${WEB_SEARCH_ENV} must be JSON like {"provider":"brave","apiKey":"…","maxResults":5}.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
    throw new Error(`${WEB_SEARCH_ENV} is invalid at: ${fields}.`);
  }
  return parsed.data;
}

/** The deployment's web search, or null when ANONYMO_WEB_SEARCH is unset. `fetchImpl` is for tests. */
export function createWebSearch(env: Record<string, unknown>, fetchImpl?: typeof fetch): WebSearchService | null {
  const cfg = parseWebSearchConfig(env[WEB_SEARCH_ENV]);
  if (!cfg) return null;
  return {
    provider: cfg.provider,
    client: braveSearch({ apiKey: cfg.apiKey, safesearch: cfg.safesearch, fetch: fetchImpl }),
    maxResults: cfg.maxResults,
    price: usdToPico(cfg.priceUsd),
    timeoutMs: cfg.timeoutMs,
  };
}
