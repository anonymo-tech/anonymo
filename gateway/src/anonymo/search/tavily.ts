// Tavily Search API client (POST https://api.tavily.com/search). It sends the query, a result count, the basic search
// depth (1 credit) and the safe-search switch, with the API key as a bearer token. Nothing about the caller goes with it:
// no IP, user agent, cookies, account or key. No answer, raw page content or images are asked for. Errors carry the
// HTTP status only, never the query or the body (432 means the plan's monthly credits are used up).

import { MAX_QUERY_CHARS, plainText, RESULT_LIMITS, safeUrl, WebSearchError } from "./brave.ts";
import type { SearchResult, WebSearch } from "./types.ts";

export const TAVILY_ENDPOINT = "https://api.tavily.com/search";

export type TavilyOptions = {
  apiKey: string;
  /** Tavily has one switch: "off" sends safe_search false, "moderate" and "strict" send true. */
  safesearch?: "off" | "moderate" | "strict";
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  endpoint?: string;
};

export function tavilySearch(o: TavilyOptions): WebSearch {
  const doFetch = o.fetch ?? fetch;
  const endpoint = o.endpoint ?? TAVILY_ENDPOINT;
  return {
    async search(query, { maxResults, signal }) {
      const body = {
        query: query.slice(0, MAX_QUERY_CHARS),
        max_results: Math.max(1, Math.min(20, maxResults)),
        search_depth: "basic",
        topic: "general",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        safe_search: (o.safesearch ?? "moderate") !== "off",
      };
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          // Only what the API needs. No caller header is ever copied here.
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
          body: JSON.stringify(body),
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
      const raw = Array.isArray(json?.results) ? json.results : [];
      const out: SearchResult[] = [];
      const seen = new Set<string>();
      for (const r of raw) {
        const link = safeUrl(r?.url);
        if (!link || seen.has(link)) continue;
        seen.add(link);
        out.push({ title: plainText(r?.title, RESULT_LIMITS.TITLE_MAX) || link, url: link, snippet: plainText(r?.content, RESULT_LIMITS.SNIPPET_MAX) });
        if (out.length >= maxResults) break;
      }
      return out;
    },
  };
}
