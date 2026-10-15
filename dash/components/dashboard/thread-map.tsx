'use client';

import { useRef } from 'react';
import { readPaperPrompt } from '../../lib/paper-trail';
import { fomoPromptPresentation } from '../../lib/second-look/fomo-presentation';
import type { Turn } from './canvas-state';

export function ThreadMap({ turns, onJump, hasEarlier, loading, onLoadEarlier }: {
  turns: Turn[]; onJump: (id: string) => void; hasEarlier?: boolean; loading?: boolean; onLoadEarlier?: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  if (!turns.length) return null;
  function jump(id: string) {
    if (menu.current) menu.current.open = false;
    onJump(id);
  }
  return <div className="cw-thread-map">
    <details ref={menu}>
      <summary>Jump to question <span>{turns.length}</span></summary>
      <nav aria-label="Questions in this conversation">
        <ol>{turns.map((turn, index) => {
          const question = readPaperPrompt(turn.prompt)?.question ?? fomoPromptPresentation(turn.prompt)?.title ?? turn.prompt;
          return <li key={turn.id}><button type="button" onClick={() => jump(turn.id)}><span>{index + 1}</span>{question.slice(0, 150)}{question.length > 150 ? '…' : ''}</button></li>;
        })}</ol>
        {hasEarlier && onLoadEarlier && <button type="button" disabled={loading} onClick={onLoadEarlier}>{loading ? 'Loading…' : 'Load earlier questions'}</button>}
      </nav>
    </details>
    <button type="button" onClick={() => jump(turns[turns.length - 1].id)}>Latest question ↓</button>
  </div>;
}
