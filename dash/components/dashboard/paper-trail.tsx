'use client';
import { useEffect, useRef, useState } from 'react';
import type { PaperSource } from '../../lib/paper-trail';
export function PaperTrail({
  value,
  onChange,
}: {
  value: PaperSource | null;
  onChange: (source: PaperSource | null) => void;
}) {
  const file = useRef<HTMLInputElement>(null),
    controller = useRef<AbortController | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => () => controller.current?.abort(), []);
  async function read(input: File) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    try {
      const { readPdf } = await import('../../lib/pdf-reader');
      const source = await readPdf(input, abort.signal);
      if (!abort.signal.aborted) onChange(source);
    } catch (e) {
      if (!abort.signal.aborted)
        setError(e instanceof Error ? e.message : 'The PDF could not be read.');
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
      <button
        type="button"
        disabled={busy}
        onClick={() => file.current?.click()}
      >
        {busy ? 'Reading PDF…' : value ? 'Replace PDF' : 'Paper Trail'}
      </button>
      {value && (
        <>
          <span className="eu-note">
            {value.name} · {value.pages.length} pages
          </span>
          <button type="button" onClick={() => onChange(null)}>
            Remove PDF
          </button>
        </>
      )}
      {error && (
        <span role="alert" className="eu-error">
          {error}
        </span>
      )}
    </>
  );
}
