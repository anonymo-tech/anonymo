'use client';

// The public receipt check behind every receipt's verify link (/verify?r=<receipt id>). No key needed: it shows the
// signed receipt's routes, what each cost (a refused attempt shows as refunded and billed $0) and whether the
// signature is valid. Without an id it asks for one.

import { useEffect, useState } from 'react';
import { ReceiptViewer } from './dashboard/receipts';

export function VerifyReceipt() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get('r')?.trim() ?? '');
  }, []);
  if (id === null) return <p className="muted">Loading…</p>;
  if (id) return <ReceiptViewer id={id} />;
  return (
    <form className="panel row" method="get" action="/verify">
      <label className="field" style={{ flex: 1 }}>
        <span>Receipt id</span>
        <input name="r" required placeholder="gen-…" autoComplete="off" spellCheck={false} />
      </label>
      <button className="btn btn-primary" type="submit">
        Verify
      </button>
    </form>
  );
}
