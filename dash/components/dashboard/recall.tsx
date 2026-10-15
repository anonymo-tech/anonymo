'use client';
import { useEffect, useRef, useState } from 'react';
import { EverydayDialog } from './everyday-dialog';
import { findExcerpt, type RecallHit } from '../../lib/recall';
import type { Room } from './canvas-state';
export function Recall({
  accountId,
  rooms,
  onOpen,
  onClose,
}: {
  accountId: string | null;
  rooms: Room[];
  onOpen: (hit: RecallHit) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(''),
    [hits, setHits] = useState<RecallHit[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [scanned, setScanned] = useState(0);
  const controller = useRef<AbortController | null>(null),
    [previousQuery,setPreviousQuery] = useState('');
  useEffect(() => () => controller.current?.abort(), []);
  async function search(more = false) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const phrase = query.trim();
    if (phrase.length < 2) return;
    setBusy(true);
    setError('');
    if (!more) {
      setHits([]);
      setScanned(0);
      setCursor(null);
    }
    setPreviousQuery(phrase);
    try {
      if (!accountId) {
        const result: RecallHit[] = [];
        for (const room of rooms)
          for (const turn of room.turns) {
            const excerpt =
              findExcerpt(turn.prompt, phrase) ??
              turn.answers
                .map((answer) =>
                  findExcerpt(answer.paragraphs.join('\n'), phrase),
                )
                .find(Boolean);
            if (excerpt)
              result.push({
                projectId: room.id,
                projectTitle: room.name,
                comparisonId: turn.id,
                prompt: turn.prompt,
                excerpt,
              });
          }
        setHits(result);
        setScanned(rooms.reduce((sum, room) => sum + room.turns.length, 0));
        return;
      }
      const response = await fetch('/api/history/search', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Conclave-Account-Id': accountId,
        },
        body: JSON.stringify({ query: phrase, cursor: more ? cursor : null }),
        signal: abort.signal,
      });
      if (!response.ok)
        throw new Error('Search could not be completed. Try again.');
      const page = (await response.json()) as {
        hits: RecallHit[];
        scanned: number;
        nextCursor: string | null;
      };
      if (abort.signal.aborted) return;
      setHits((old) => (more ? [...old, ...page.hits] : page.hits));
      setScanned((old) => (more ? old : 0) + page.scanned);
      setCursor(page.nextCursor);
    } catch (e) {
      if (!abort.signal.aborted)
        setError(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <EverydayDialog title="Recall" onClose={onClose}>
      <form
        className="eu-controls"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
                    aria-label="Search questions and answers"
          placeholder="A phrase, an idea, a detail…"
          value={query}
          maxLength={120}
          onChange={(e) => {
            controller.current?.abort();
            setBusy(false);
            setCursor(null);
            setQuery(e.target.value);
          }}
        />
        <button disabled={busy || query.trim().length < 2}>Search</button>
      </form>
      <p className="eu-note">
        Search questions and full answers in your projects.
      </p>
      {hits.map((hit) => (
        <button
          className="eu-result"
          key={hit.comparisonId}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onOpen(hit)
              .then(onClose)
              .catch(() => {
                setError('This exchange could not be opened.');
                setBusy(false);
              });
          }}
        >
          <strong>{hit.projectTitle}</strong>
          <span>{hit.excerpt}</span>
        </button>
      ))}
      <output className="eu-note">
        {busy
          ? 'Searching…'
          : `${hits.length} matches · ${scanned} exchanges searched${cursor ? ' · older history remains' : ''}`}
      </output>
      {cursor && query.trim() === previousQuery && (
        <button disabled={busy} onClick={() => void search(true)}>
          Search older history
        </button>
      )}
      {error && (
        <p role="alert" className="eu-error">
          {error}
        </p>
      )}
    </EverydayDialog>
  );
}
