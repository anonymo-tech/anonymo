'use client';

// Feature 01 "Mask my details": the review card above the composer. It shows exactly what will be sent, with
// detected details masked on this device. Tap a masked detail to unmask it, tap an underlined suggestion (or, in
// "Mask more" mode, any word) to mask it, and undo either. The original stays on this device and is shown only here.

import { Lock, Send, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { placeholderParts, wordAt, type Mask, type MaskSegment, type MaskVault } from '@/lib/anonymo/masking';
import './chat-inputs.css';

const KIND_LABEL: Record<Mask['kind'], string> = {
  name: 'name', email: 'email address', phone: 'phone number', card: 'card number', account: 'account number',
  address: 'address', reference: 'reference', detail: 'detail',
};

export function MaskReview({ segments, masks, busy, canUndo, onToggle, onMaskRange, onUndo, onSend, onEdit, original, extra }: {
  segments: MaskSegment[];
  masks: Mask[];
  busy: boolean;
  canUndo: boolean;
  onToggle: (index: number) => void;
  onMaskRange: (start: number, end: number) => void;
  onUndo: () => void;
  onSend: () => void;
  onEdit: () => void;
  /** The draft before masking. Shown on request, on this device only. */
  original: string;
  /** Anything else sent with the text, such as an approved image crop. */
  extra?: React.ReactNode;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [more, setMore] = useState(false);
  const masked = masks.filter((m) => m.on).length;
  const offered = masks.length - masked;
  const starts = segments.reduce<number[]>((acc, s, i) => [...acc, i ? acc[i - 1] + segments[i - 1].text.length : 0], []);
  return (
    <section className="mask-review" aria-label="Review before sending">
      <div className="mask-review-head">
        <span className="chip mask-badge"><Lock size={13} aria-hidden="true" /> Masked on device</span>
        <button type="button" className="link-button" aria-pressed={showOriginal} onClick={() => setShowOriginal((s) => !s)}>
          {showOriginal ? 'Hide original' : 'View original'}
        </button>
      </div>
      <p className="mask-review-text" aria-label="What will be sent">
        {segments.map((segment, i) => {
          const start = starts[i];
          if (segment.mask !== null) {
            const mask = masks[segment.mask];
            const label = KIND_LABEL[mask.kind];
            return segment.placeholder ? (
              <button key={i} type="button" className="mask-chip" aria-label={`Masked ${label}, ${segment.placeholder}. Unmask`} onClick={() => onToggle(segment.mask!)}>
                {segment.placeholder}
              </button>
            ) : (
              <button key={i} type="button" className="mask-suggest" aria-label={`Not masked: ${label} ${segment.text}. Mask it`} onClick={() => onToggle(segment.mask!)}>
                {segment.text}
              </button>
            );
          }
          if (!more) return <span key={i}>{segment.text}</span>;
          // "Mask more": every word is a button, so a missed detail can be masked by tap or keyboard.
          const parts: React.ReactNode[] = [];
          let cursor = 0;
          for (const m of segment.text.matchAll(/\S+/g)) {
            const word = wordAt(segment.text, m.index);
            if (!word) continue;
            if (word.start > cursor) parts.push(segment.text.slice(cursor, word.start));
            const value = segment.text.slice(word.start, word.end);
            parts.push(
              <button key={`${i}-${word.start}`} type="button" className="mask-word" aria-label={`Mask ${value}`}
                onClick={() => onMaskRange(start + word.start, start + word.end)}>{value}</button>,
            );
            cursor = word.end;
          }
          if (cursor < segment.text.length) parts.push(segment.text.slice(cursor));
          return <span key={i}>{parts}</span>;
        })}
      </p>
      {extra}
      {showOriginal && (
        <div className="mask-original">
          <p className="faint">Original · only on this device, never sent</p>
          <p>{original}</p>
        </div>
      )}
      <output className="faint mask-hint">
        {masked} {masked === 1 ? 'detail' : 'details'} masked{offered ? ` · ${offered} not masked` : ''}.{' '}
        {more ? 'Tap any word to mask it.' : offered ? 'Tap an underlined reference to mask it too.' : 'Tap a masked detail to unmask it.'}
      </output>
      <div className="mask-actions">
        <button type="button" className="btn btn-small btn-ghost" onClick={onUndo} disabled={!canUndo}>
          <Undo2 size={14} aria-hidden="true" /> Undo
        </button>
        <button type="button" className="btn btn-small btn-ghost" aria-pressed={more} onClick={() => setMore((m) => !m)}>
          {more ? 'Done masking' : 'Mask more'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onEdit}>Edit</button>
      </div>
      <button type="button" className="btn btn-primary mask-send" onClick={onSend} disabled={busy}>
        <Send size={16} aria-hidden="true" /> {masked ? 'Send masked message' : 'Send message'}
      </button>
    </section>
  );
}

/** A sent prompt with its placeholders as chips. "View original" restores known values on this device only. */
export function MaskedPrompt({ text, vault }: { text: string; vault: MaskVault }) {
  const [open, setOpen] = useState(false);
  const parts = placeholderParts(text);
  if (!parts.some((p) => p.placeholder)) return <p className="prompt">{text}</p>;
  const restorable = parts.some((p) => p.placeholder && vault.original(p.text) !== undefined);
  return (
    <div className="prompt masked-prompt">
      <p>
        {parts.map((p, i) => (p.placeholder ? (
          <span key={i} className="mask-chip mask-chip-static" title={open ? 'Original, shown on this device only' : 'Masked on this device'}>
            {open ? (vault.original(p.text) ?? p.text) : p.text}
          </span>
        ) : <span key={i}>{p.text}</span>))}
      </p>
      {restorable && (
        <button type="button" className="link-button masked-prompt-toggle" aria-pressed={open} onClick={() => setOpen((o) => !o)}>
          <Lock size={12} aria-hidden="true" /> {open ? 'Hide original' : 'View original'}
        </button>
      )}
    </div>
  );
}
