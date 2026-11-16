'use client';

import { ChevronDown, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AnonymoModelId } from '@/lib/anonymo/types';

export const MODEL_CHOICES: { id: AnonymoModelId; summary: string }[] = [
  {
    id: 'anonymo-1',
    summary: 'The best uncensored route for the request. Refusals reroute to another model family and are refunded.',
  },
  { id: 'anonymo-rp', summary: 'Cheap long-context roleplay with character cards and lorebooks.' },
  {
    id: 'anonymo-council',
    summary: 'Three model families answer and check each other, then merge into one reply. Slower, priced at 4–5×.',
  },
  {
    id: 'anonymo-sealed',
    summary: 'Hardware-attested enclaves only. Fails instead of downgrading; the receipt carries the attestation.',
  },
];

export function ModelPicker({
  value,
  onChange,
  live,
}: {
  value: AnonymoModelId;
  onChange: (id: AnonymoModelId) => void;
  live: ReadonlySet<string> | null;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="picker" ref={root}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {value === 'anonymo-sealed' && <ShieldCheck size={14} aria-hidden="true" />}
        {value}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="picker-menu" role="menu" aria-label="Model">
          {MODEL_CHOICES.map((m) => {
            const off = live !== null && !live.has(m.id);
            return (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === value}
              aria-disabled={off || undefined}
              disabled={off}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="name">
                <span className="id">{m.id}</span>
                {m.id === 'anonymo-sealed' && <span className="chip chip-signal">attested</span>}
                {m.id === 'anonymo-council' && <span className="chip">4–5×</span>}
                {off && <span className="chip">not live yet</span>}
              </span>
              <span className="desc">{m.summary}</span>
            </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
