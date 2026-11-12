'use client';

// Receipts (Backend §8): the receipt ids this device has seen, a lookup by id, and a viewer that fetches the signed
// receipt and its inclusion proof and checks the Merkle path in the browser.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { describeError } from '@/lib/anonymo/client';
import { formatUsd } from '@/lib/anonymo/money';
import { rootFromProof } from '@/lib/anonymo/proof';
import type { InclusionProof, SignedReceipt } from '@/lib/anonymo/types';

export function ReceiptsList() {
  const { ready, receipts, forgetReceipts } = useAnonymo();
  const router = useRouter();
  const [lookup, setLookup] = useState('');
  return (
    <div className="panel-stack">
      <section className="panel">
        <header>
          <h2>Look up a receipt</h2>
        </header>
        <p className="lede">
          Every call returns its receipt id in the <code>x-anonymo-receipt</code> header. Receipts are public by id and hold no
          prompt or output text.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const id = lookup.trim();
            if (id) router.push(`/dashboard/receipts/${encodeURIComponent(id)}`);
          }}
        >
          <label className="sr-only" htmlFor="receipt-id">
            Receipt id
          </label>
          <input
            id="receipt-id"
            className="input mono"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="Receipt id"
            spellCheck={false}
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
          />
          <button type="submit" className="btn">
            Open
          </button>
        </form>
      </section>
      <section className="panel">
        <header>
          <h2>On this device</h2>
          {receipts.length > 0 && (
            <button type="button" className="btn btn-small btn-ghost" onClick={forgetReceipts}>
              Clear list
            </button>
          )}
        </header>
        {!ready ? null : receipts.length === 0 ? (
          <p className="lede">Receipts from your chats appear here. Only the id, model and time are kept, in this browser.</p>
        ) : (
          <ul className="list">
            {receipts.map((r) => (
              <li key={r.id}>
                <Link className="mono" href={`/dashboard/receipts/${encodeURIComponent(r.id)}`}>
                  {r.id.slice(0, 18)}…
                </Link>
                <span className="chip">{r.model}</span>
                <span className="faint">{new Date(r.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Loaded = { signed: SignedReceipt; proof: InclusionProof | null; proofError: string | null };

export function ReceiptView({ id }: { id: string }) {
  const { ready, client } = useAnonymo();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ready) return;
    let live = true;
    void (async () => {
      try {
        const signed = await client.receipt(id);
        let proof: InclusionProof | null = null;
        let proofError: string | null = null;
        try {
          proof = await client.receiptProof(id);
        } catch (e) {
          proofError = describeError(e);
        }
        if (live) setData({ signed, proof, proofError });
      } catch (e) {
        if (live) setError(describeError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ready, client, id]);

  if (error)
    return (
      <section className="panel">
        <h2>Receipt not found</h2>
        <p className="notice notice-rose">{error}</p>
        <Link href="/dashboard/receipts">All receipts</Link>
      </section>
    );
  if (!data) return <p className="muted">Loading receipt…</p>;

  const { receipt: r, signer, signature, leaf } = data.signed;
  const proof = data.proof;
  const reached = proof ? rootFromProof(proof.leaf, proof.proof) : null;
  const verified = proof !== null && reached !== null && reached === proof.root.toLowerCase() && proof.leaf.toLowerCase() === leaf.toLowerCase();

  return (
    <div className="panel-stack">
      <section className="panel" aria-labelledby="receipt-title">
        <header>
          <h2 id="receipt-title">Receipt</h2>
          <div className="row">
            {r.attestation_quote_hash ? (
              <span className="chip chip-signal">Attested enclave</span>
            ) : (
              <span className="chip">Zero retention (policy)</span>
            )}
            {r.refused && <span className="chip chip-amber">Refusal rerouted</span>}
          </div>
        </header>
        <dl className="kv">
          <div>
            <dt>Request</dt>
            <dd className="mono">{r.request_id}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd className="mono">{r.model_id}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd>{new Date(r.ts).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd className="mono">
              {formatUsd(r.cost_musd)}
              {r.refund_musd > 0 && <span className="faint"> · refused attempt refunded {formatUsd(r.refund_musd)}</span>}
            </dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd className="mono">
              {r.tokens.in.toLocaleString()} in · {r.tokens.out.toLocaleString()} out
            </dd>
          </div>
          <div>
            <dt>Routes</dt>
            <dd>
              <ul className="path">
                {r.routes.map((route, i) => (
                  <li key={`${route}-${i}`}>
                    <span>{i + 1}</span>
                    <div>
                      <div className="mono">
                        {route}
                        {r.refused_routes.includes(route) && <span className="chip chip-amber" style={{ marginLeft: 8 }}>refused · billed 0</span>}
                      </div>
                      <div className="hash">weights {r.weights_hash[i] ?? 'not published by this upstream'}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt>Attestation quote</dt>
            <dd className="hash">{r.attestation_quote_hash ?? 'None. Only anonymo-sealed runs on attested enclaves.'}</dd>
          </div>
          <div>
            <dt>Signer</dt>
            <dd className="hash">{signer}</dd>
          </div>
          <div>
            <dt>Signature</dt>
            <dd className="hash">{signature}</dd>
          </div>
          <div>
            <dt>Leaf</dt>
            <dd className="hash">{leaf}</dd>
          </div>
        </dl>
        <div className="row">
          <CopyButton text={JSON.stringify(data.signed, null, 2)} label="Copy receipt JSON" />
        </div>
      </section>

      <section className="panel" aria-labelledby="proof-title">
        <header>
          <h2 id="proof-title">Inclusion proof</h2>
          {proof &&
            (verified ? (
              <span className="chip chip-signal">Path verified in your browser</span>
            ) : (
              <span className="chip chip-rose">Path does not reach the root</span>
            ))}
        </header>
        {!proof ? (
          <p className="notice">{data.proofError ?? 'No proof yet. Receipts roll into an hourly root.'}</p>
        ) : (
          <>
            <p className="lede">
              The leaf hashes up through {proof.proof.length} sibling{proof.proof.length === 1 ? '' : 's'} (sorted-pair keccak256)
              to the hourly root posted to ReceiptRoots on Robinhood Chain.
            </p>
            <dl className="kv">
              <div>
                <dt>Hour</dt>
                <dd>
                  {new Date(proof.hour * 3_600_000).toISOString().slice(0, 13).replace('T', ' ')}:00 UTC{' '}
                  <span className="faint mono">({proof.hour})</span>
                </dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd>
                  <ol className="path">
                    {proof.proof.map((p, i) => (
                      <li key={`${p}-${i}`}>
                        <span>{i + 1}</span>
                        <span className="hash">{p}</span>
                      </li>
                    ))}
                  </ol>
                </dd>
              </div>
              <div>
                <dt>Root</dt>
                <dd className="hash">{proof.root}</dd>
              </div>
              <div>
                <dt>Anchor</dt>
                <dd>
                  <span className={proof.anchor.status === 'anchored' ? 'chip chip-signal' : 'chip'}>{proof.anchor.status}</span>{' '}
                  <span className="hash">ReceiptRoots {proof.anchor.contract}</span>
                  {proof.anchor.tx_hash && <div className="hash">tx {proof.anchor.tx_hash}</div>}
                </dd>
              </div>
            </dl>
            <p className="faint">
              Checked here: the path from the leaf reaches the root. Not checked in the browser: the gateway signature, and that
              the root matches ReceiptRoots.rootOf(hour) on-chain.
            </p>
          </>
        )}
      </section>
      <Link href="/dashboard/receipts">All receipts</Link>
    </div>
  );
}
