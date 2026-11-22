// Private Web Search: the seam between the chat path and a web search engine. The engine only ever sees the query
// text built from the caller's last message: no account, key, client IP, user agent or other request header.
// Queries and results are never logged or stored (they live in memory for one request).

import type { Pico } from "../../lib/money.ts";

/** One web result as the model and the caller see it. */
export type SearchResult = { title: string; url: string; snippet: string };

/** A web search engine. Implementations must not forward anything about the caller. */
export interface WebSearch {
  /** Search the web for `query`. Rejects on any failure (the caller answers 502 web_search_failed). */
  search(query: string, opts: { maxResults: number; signal: AbortSignal }): Promise<SearchResult[]>;
}

/** The configured web search for this deployment (ANONYMO_WEB_SEARCH). */
export type WebSearchService = {
  provider: string;
  client: WebSearch;
  /** Most results injected into a request (and the cap a caller's `max_results` is held to). */
  maxResults: number;
  /** Fixed price charged once per request that searched and was served. */
  price: Pico;
  /** The search call gives up after this long. */
  timeoutMs: number;
};
