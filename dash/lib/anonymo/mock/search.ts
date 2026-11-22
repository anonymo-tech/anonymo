// Update "search" in demo mode: `<model>:online` (or `plugins: [{ id: "web" }]` / `web_search_options`) answers with
// fake sources and `url_citation` annotations, charged the gateway's default search price, so the toggle and the
// citations can be tried without a key or a search engine. The rules match the gateway: sealed, council and :private
// never search.

import { usdToMusd } from '../money.ts';
import { canSearch, demoResults, stripOnline, WEB_SEARCH_PRICE_USD } from '../search.ts';

export const DEMO_SEARCH_MUSD = usdToMusd(WEB_SEARCH_PRICE_USD);

type Body = { model: string; plugins?: unknown; web_search_options?: unknown };

/** The model without `:online`, and whether the request asked for a search. */
export function demoSearchAsk(body: Body): { model: string; searching: boolean } {
  const { model, online } = stripOnline(body.model);
  const plugin = Array.isArray(body.plugins) && body.plugins.some((p) => p && typeof p === 'object' && (p as { id?: unknown; enabled?: unknown }).id === 'web' && (p as { enabled?: unknown }).enabled !== false);
  return { model, searching: online || plugin || body.web_search_options != null };
}

/** Why this request may not search, as the gateway answers it, or null. */
export function demoSearchRefusal(model: string, sealed: boolean): { status: number; type: string; message: string } | null {
  if (sealed || model.split(':').slice(1).includes('private'))
    return { status: 409, type: 'web_search_private', message: 'Web search is off for sealed, attested and private requests: the search engine would see the query. Nothing was sent or charged.' };
  if (!canSearch(model)) return { status: 400, type: 'web_search_unsupported', message: 'Web search does not work with council mode yet. Nothing was sent or charged.' };
  return null;
}

/** The demo answer with numbered citations, and its annotations. */
export function demoSearchReply(text: string, query: string) {
  const results = demoResults(query);
  const reply = `${text} The demo sources agree on the basics [1], and one adds more detail [2].`;
  const annotations = results.map((r, i) => {
    const marker = `[${i + 1}]`;
    const at = reply.indexOf(marker);
    return { type: 'url_citation' as const, url_citation: { url: r.url, title: r.title, ...(at >= 0 ? { start_index: at, end_index: at + marker.length } : {}) } };
  });
  return { text: reply, annotations };
}
