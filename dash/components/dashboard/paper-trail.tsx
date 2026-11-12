'use client';

import { FileText, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PaperSource } from '@/lib/paper-trail';

/** Composer tool: attach a text PDF, read in the browser with pdf.js. */
export function PaperTrail({ value, onChange }: { value: PaperSource | null; onChange: (source: PaperSource | null) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => controller.current?.abort(), []);

  async function read(input: File) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    try {
      const { readPdf } = await import('@/lib/pdf-reader');
      const source = await readPdf(input, abort.signal);
      if (!abort.signal.aborted) onChange(source);
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'The PDF could not be read.');
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={file}
        type="file"
        hidden
        accept="application/pdf,.pdf"
        onChange={(e) => {
          const input = e.target.files?.[0];
          e.target.value = '';
          if (input) void read(input);
        }}
      />
      {value ? (
        <button type="button" className="tool" aria-pressed="true" onClick={() => onChange(null)} title="Remove PDF">
          <FileText size={14} aria-hidden="true" />
          {value.name} · {value.pages.length} pages
          <X size={13} aria-label="Remove" />
        </button>
      ) : (
        <button type="button" className="tool" disabled={busy} onClick={() => file.current?.click()}>
          <FileText size={14} aria-hidden="true" />
          {busy ? 'Reading PDF…' : 'Paper Trail'}
        </button>
      )}
      {error && (
        <span role="alert" className="error-text">
          {error}
        </span>
      )}
    </>
  );
}
