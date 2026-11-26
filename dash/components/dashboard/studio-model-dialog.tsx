'use client';

import { ArrowUpRight, Check, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './image-studio.css';

export type StudioChoice = { id: string; name: string; description: string; mark: ReactNode; price?: string };
export type StudioDialogActions = {
  selected: string; loading: boolean; error: string | null; busy: boolean;
  onRetry: () => void; onPick: (id: string) => void; onClose: () => void;
};

export function StudioModelDialog({ kind, subtitle, choices, selected, loading, error, busy, onRetry, onPick, onClose }:
  StudioDialogActions & { kind: 'image' | 'video'; subtitle: string; choices: StudioChoice[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    node?.querySelector('h2')?.focus();
    return () => node?.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="image-model-dialog" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header>
      <button type="button" aria-label={`Close ${kind} model chooser`} disabled={busy} onClick={onClose}><X size={19} /></button>
      <h2 id={title} tabIndex={-1}>Choose your {kind} model</h2><p>{subtitle}</p>
    </header>
    {error && <p role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></p>}
    {loading ? <p role="status">Loading {kind} models…</p> : <ul aria-label={`${kind === 'image' ? 'Image' : 'Video'} models`}>
      {choices.map(choice => <li key={choice.id}><button type="button" disabled={busy} onClick={() => onPick(choice.id)}>
        {choice.mark}<span><strong>{choice.name}</strong><small>{choice.description}</small></span>
        {choice.price && <small>{choice.price}</small>}
        {selected === choice.id ? <Check size={16} /> : <ArrowUpRight size={16} />}
      </button></li>)}
    </ul>}
    {!loading && !error && !choices.length && <p role="status">No {kind} models are available right now.</p>}
    {busy && <p role="status">Preparing your studio…</p>}
  </dialog>, document.body);
}
