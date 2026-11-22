'use client';

// Update "search": the "Search the web" toggle in the chat composer, and the sources a searched answer cites, shown as
// numbered links under it. Links are http(s) only (lib/anonymo/search.ts) and open in a new tab without a referrer.

import { Globe } from 'lucide-react';
import { formatUsdAmount } from '@/lib/anonymo/money';
import { canSearch, hostOf, WEB_SEARCH_PRICE_USD, type Citation } from '@/lib/anonymo/search';

export function SearchToggle({ model, on, onToggle, disabled }: { model: string; on: boolean; onToggle: () => void; disabled?: boolean }) {
  const allowed = canSearch(model);
  return (
    <button
      type="button"
      className="tool"
      aria-pressed={allowed && on}
      disabled={disabled || !allowed}
      title={allowed
        ? `Looks things up on the web before answering and shows the sources. ${formatUsdAmount(WEB_SEARCH_PRICE_USD)} per search. Only the question is sent to the search engine.`
        : 'Sealed, council and private models do not search the web. The search engine would see the question.'}
      onClick={onToggle}
    >
      <Globe size={14} aria-hidden="true" />
      Search the web: {allowed && on ? 'on' : 'off'}
    </button>
  );
}

export function WebSources({ citations }: { citations?: Citation[] }) {
  if (!citations?.length) return null;
  return (
    <aside className="web-sources" aria-label="Sources">
      <p className="faint">Sources from the web</p>
      <ol>
        {citations.map((c) => (
          <li key={c.url}>
            <a href={c.url} target="_blank" rel="noreferrer noopener">{c.title}</a>{' '}
            <span className="faint">{hostOf(c.url)}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
