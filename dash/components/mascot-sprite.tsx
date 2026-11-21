'use client';

import { useEffect, useRef, useState } from 'react';
import { useAnonymo } from './anonymo-provider';

export type MascotMood =
  | 'roam'
  | 'listen'
  | 'greet'
  | 'think'
  | 'reply'
  | 'joy'
  | 'puzzled'
  | 'carried';

/** Only react to a reply that actually finished while this tab was watching it. Opening history is quiet. */
export function useMascotReaction(): MascotMood | null {
  const { turns } = useAnonymo();
  const last = turns.at(-1);
  const pending = useRef<string | null>(null);
  const [celebrated, setCelebrated] = useState<string | null>(null);
  const id = last?.id;
  const status = last?.status;
  useEffect(() => {
    if (status === 'streaming' && id) {
      pending.current = id;
      return;
    }
    const finished = id && pending.current === id && status === 'done';
    pending.current = null;
    if (!finished) return;
    const frame = requestAnimationFrame(() => setCelebrated(id));
    return () => cancelAnimationFrame(frame);
  }, [id, status]);
  useEffect(() => {
    if (!celebrated) return;
    const timer = window.setTimeout(() => setCelebrated(null), 1800);
    return () => clearTimeout(timer);
  }, [celebrated]);
  if (status === 'streaming') return last?.content ? 'reply' : 'think';
  if (status === 'error') return 'puzzled';
  return id && celebrated === id ? 'joy' : null;
}

export function MascotSprite({ mood }: { mood: MascotMood }) {
  return <span aria-hidden="true" className="mascot-sprite" data-mood={mood} />;
}
