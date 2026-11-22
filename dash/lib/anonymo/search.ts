// Update "search": Private Web Search. The chat composer's "Search the web" toggle sends the model as `<model>:online`;
// the gateway runs one search with no account data attached, gives the model numbered sources, and returns them as
// `url_citation` annotations. Sealed, council and `:private` models never search: the search engine would see the query.

/** The gateway's default price for one search (ANONYMO_WEB_SEARCH `priceUsd`). */
export const WEB_SEARCH_PRICE_USD = '0.005';
export const ONLINE_SUFFIX = ':online';
/** Most citations shown under one answer. */
export const MAX_CITATIONS = 10;

export type Citation = { url: string; title: string };

/** Whether a model may search: not sealed, not the council, not a `:private` route. */
export function canSearch(model: string): boolean {
  if (!model || model === 'anonymo-sealed' || model === 'anonymo-council') return false;
  return !model.split(':').slice(1).includes('private');
}

/** `<model>:online` when searching is on and allowed, else the model unchanged. */
export function onlineModel(model: string, on: boolean): string {
  if (!on || !canSearch(model) || stripOnline(model).online) return model;
  return `${model}${ONLINE_SUFFIX}`;
}

/** `a/b:online` → `{ model: 'a/b', online: true }`, wherever `:online` sits among the suffixes. */
export function stripOnline(model: string): { model: string; online: boolean } {
  const parts = model.split(':');
  const kept = [parts[0], ...parts.slice(1).filter((p) => p !== 'online')];
  return { model: kept.join(':'), online: kept.length !== parts.length };
}

/** A link the answer may show: http(s) only, so a `javascript:` URL never becomes a link. */
export function safeLink(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2000) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The citations in an `annotations` array (OpenAI / OpenRouter `url_citation`), deduplicated, in order. */
export function citationsOf(annotations: unknown, into: Citation[] = []): Citation[] {
  const out = [...into];
  if (!Array.isArray(annotations)) return out;
  for (const a of annotations) {
    const c = a && typeof a === 'object' ? (a as { type?: unknown; url_citation?: { url?: unknown; title?: unknown } }) : null;
    if (c?.type !== 'url_citation' || !c.url_citation) continue;
    const url = safeLink(c.url_citation.url);
    if (!url || out.some((x) => x.url === url)) continue;
    const title = typeof c.url_citation.title === 'string' && c.url_citation.title.trim() ? c.url_citation.title.trim().slice(0, 200) : new URL(url).hostname;
    out.push({ url, title });
    if (out.length >= MAX_CITATIONS) break;
  }
  return out;
}

/** The host name shown next to a citation. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Demo mode: fake results for a query, so the toggle and the citations can be tried without a key or a search engine. */
export function demoResults(query: string): { title: string; url: string; snippet: string }[] {
  const topic = query.replace(/\s+/g, ' ').trim().slice(0, 60) || 'your question';
  return [
    { title: `Overview: ${topic}`, url: 'https://example.org/overview', snippet: 'A demo source. Real results come from the web when the gateway has search set up.' },
    { title: `Notes on ${topic}`, url: 'https://example.net/notes', snippet: 'Another demo source, numbered so the answer can cite it.' },
    { title: 'Background reading', url: 'https://example.com/background', snippet: 'A third demo source.' },
  ];
}
