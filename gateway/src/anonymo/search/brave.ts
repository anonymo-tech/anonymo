// Brave Search API client (https://api.search.brave.com/res/v1/web/search). It sends the query, a result count and a
// safesearch level, with the subscription token. Nothing about the caller goes with it: no IP, user agent, cookies,
// account or key. Errors carry the HTTP status only, never the query or the body.

import type { SearchResult, WebSearch } from "./types.ts";

export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Brave accepts at most 400 characters and 50 words in `q`. */
export const MAX_QUERY_CHARS = 400;
export const MAX_QUERY_WORDS = 50;

const TITLE_MAX = 200;
const URL_MAX = 500;
const SNIPPET_MAX = 600;

export type BraveOptions = {
  apiKey: string;
  safesearch?: "off" | "moderate" | "strict";
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  endpoint?: string;
};

export class WebSearchError extends Error {
  constructor(readonly reason: string) {
    super(`web search failed: ${reason}`);
  }
}

const decodeEntities = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27|apos|nbsp);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", apos: "'", nbsp: " " })[e] ?? "");

/** Plain text from a result field: tags dropped (Brave marks matches with <strong>), entities decoded, spaces collapsed. */
export function plainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return decodeEntities(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Only http(s) URLs are kept: a result is a link the caller may click. */
export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > URL_MAX) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function braveSearch(o: BraveOptions): WebSearch {
  const doFetch = o.fetch ?? fetch;
  const endpoint = o.endpoint ?? BRAVE_ENDPOINT;
  return {
    async search(query, { maxResults, signal }) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query.slice(0, MAX_QUERY_CHARS));
      url.searchParams.set("count", String(Math.max(1, Math.min(20, maxResults))));
      url.searchParams.set("safesearch", o.safesearch ?? "moderate");
      url.searchParams.set("text_decorations", "false");
      let res: Response;
      try {
        res = await doFetch(url.toString(), {
          method: "GET",
          // Only what the API needs. No caller header is ever copied here.
          headers: { accept: "application/json", "x-subscription-token": o.apiKey },
          redirect: "error",
          signal,
        });
      } catch (e) {
        throw new WebSearchError((e as Error)?.name === "TimeoutError" || signal.aborted ? "timeout" : "network");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new WebSearchError(`status ${res.status}`);
      }
      let json: any;
      try {
        json = await res.json();
      } catch {
        throw new WebSearchError("unreadable response");
      }
      const raw = Array.isArray(json?.web?.results) ? json.web.results : [];
      const out: SearchResult[] = [];
      const seen = new Set<string>();
      for (const r of raw) {
        const link = safeUrl(r?.url);
        if (!link || seen.has(link)) continue;
        seen.add(link);
        out.push({ title: plainText(r?.title, TITLE_MAX) || link, url: link, snippet: plainText(r?.description, SNIPPET_MAX) });
        if (out.length >= maxResults) break;
      }
      return out;
    },
  };
}

export const RESULT_LIMITS = { TITLE_MAX, URL_MAX, SNIPPET_MAX };
