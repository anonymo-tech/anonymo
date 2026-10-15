'use client';
import { useState } from 'react';
import { citedPages, type PaperSource } from '../../lib/paper-trail';
import { EverydayDialog } from './everyday-dialog';
export function PaperSources({
  source,
  text,
}: {
  source: PaperSource;
  text: string;
}) {
  const [page, setPage] = useState<number | null>(null);
  const citations = citedPages(text, source);
  return (
    <>
      <div className="eu-controls" aria-label="Document references">
        {citations.map((number) => (
          <button key={number} onClick={() => setPage(number)}>
            View page {number}
          </button>
        ))}
        <button onClick={() => setPage(1)}>Source document</button>
      </div>
      {page !== null && (
        <EverydayDialog title={source.name} onClose={() => setPage(null)}>
          <div className="eu-controls">
            <label>
              Page{' '}
              <select
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
              >
                {source.pages.map((p) => (
                  <option key={p.number} value={p.number}>
                    {p.number}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="eu-note">
            Extracted source text. Check whether it supports the model’s answer.
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              font: 'inherit',
            }}
          >
            {source.pages.find((p) => p.number === page)?.text}
          </pre>
        </EverydayDialog>
      )}
    </>
  );
}
