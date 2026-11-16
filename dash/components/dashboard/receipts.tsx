'use client';

// Receipts (Backend §8): the receipt ids this device has seen, a lookup by id, and a viewer that fetches the signed
// receipt and its inclusion proof and checks the Merkle path in the browser.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { describeError } from '@/lib/anonymo/client';
import { formatUsdAmount } from '@/lib/anonymo/money';
import { rootFromProof } from '@/lib/anonymo/proof';
import type { ProofView, ReceiptView } from '@/lib/anonymo/types';

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
          Every call returns a signed receipt (the <code>x-anonymo-receipt</code> header, or <code>anonymo_receipt</code> on the
          last stream event). Its <code>request_id</code> opens it here. Receipts are public by id and hold no prompt or output text.
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

type Loaded = { view: ReceiptView; proof: ProofView | null; proofError: string | null };

export function ReceiptViewer({ id }: { id: string }) {
  const { ready, client, demo } = useAnonymo();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ready) return;
    let live = true;
    void (async () => {
      try {
        const view = await client.receipt(id);
        let proof: ProofView | null = null;
        let proofError: string | null = null;
        try {
          proof = await client.receiptProof(id);
        } catch (e) {
          proofError = describeError(e);
        }
        if (live) setData({ view, proof, proofError });
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
        <h1 className="panel-title">Receipt not found</h1>
        <p className="notice notice-rose">{error}</p>
        <Link href="/dashboard/receipts">All receipts</Link>
      </section>
    );
  if (!data) return <p className="muted">Loading receipt…</p>;

  const { view } = data;
  const r = view.receipt;
  const proof = data.proof?.rooted ? data.proof : null;
  const reached = proof ? rootFromProof(proof.leaf, proof.proof) : null;
  const verified = proof !== null && reached !== null && reached === proof.root.toLowerCase() && proof.leaf.toLowerCase() === view.leaf.toLowerCase();
  const refusedRoutes = r.routes.filter((x) => x.status === 'refused');

  return (
    <div className="panel-stack">
      <section className="panel" aria-labelledby="receipt-title">
        <header>
          <h1 id="receipt-title" className="panel-title">
            Receipt
          </h1>
          <div className="row">
            {r.sealed && r.attestation_quote_hash ? (
              <span className="chip chip-signal">Attested enclave</span>
            ) : (
              <span className="chip">Zero retention (policy)</span>
            )}
            {refusedRoutes.length > 0 && <span className="chip chip-amber">{r.refused ? 'Refused twice' : 'Refusal rerouted'}</span>}
            {view.signature_valid ? (
              <span className="chip chip-signal">Signature valid</span>
            ) : demo ? (
              <span className="chip" title="The demo gateway does not hold a signing key, so demo receipts are unsigned.">
                Demo · not signed
              </span>
            ) : (
              <span className="chip chip-rose">Signature not valid</span>
            )}
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
              {formatUsdAmount(r.cost)}
              {refusedRoutes.length > 0 && <span className="faint"> · refused attempts billed $0</span>}
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
                  <li key={`${route.route}-${i}`}>
                    <span>{i + 1}</span>
                    <div>
                      <div className="mono">
                        {route.route}
                        <span className="chip" style={{ marginLeft: 8 }}>
                          {route.role}
                        </span>
                        {route.status !== 'ok' && (
                          <span className="chip chip-amber" style={{ marginLeft: 8 }}>
                            {route.status} · billed {formatUsdAmount(route.cost)}
                          </span>
                        )}
                        {route.attested && (
                          <span className="chip chip-signal" style={{ marginLeft: 8 }}>
                            attested
                          </span>
                        )}
                      </div>
                      <div className="faint">
                        {route.family}
                        {route.quant ? ` · ${route.quant}` : ''} · {route.tokens.in.toLocaleString()} in · {route.tokens.out.toLocaleString()} out ·{' '}
                        {formatUsdAmount(route.cost)}
                      </div>
                      <div className="hash">weights {route.weights_hash ?? 'not published for this route'}</div>
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
            <dt>Signer key</dt>
            <dd className="hash">
              {view.key_id} · {view.alg}
            </dd>
          </div>
          <div>
            <dt>Signature</dt>
            <dd className="hash">{view.sig}</dd>
          </div>
          <div>
            <dt>Leaf</dt>
            <dd className="hash">{view.leaf}</dd>
          </div>
        </dl>
        <div className="row">
          <CopyButton text={JSON.stringify(view, null, 2)} label="Copy receipt JSON" />
        </div>
        <p className="faint">
          The signature is checked by the gateway against its receipt keys ({view.keys}); this page shows that answer. The receipt
          JSON above is what was signed.
        </p>
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
          <p className="notice">
            {data.proof && !data.proof.rooted ? data.proof.hint : (data.proofError ?? 'No proof yet. Receipts roll into an hourly root.')}
          </p>
        ) : (
          <>
            <p className="lede">
              Leaf {proof.leaf_index + 1} of {proof.leaf_count} hashes up through {proof.proof.length} sibling{proof.proof.length === 1 ? '' : 's'}{' '}
              (sorted-pair keccak256) to the hourly root for ReceiptRoots on Robinhood Chain.
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
                  {proof.proof.length === 0 ? (
                    <span className="faint">Empty: this receipt is the only leaf in its hour, so the leaf is the root.</span>
                  ) : (
                    <ol className="path">
                      {proof.proof.map((p, i) => (
                        <li key={`${p}-${i}`}>
                          <span>{i + 1}</span>
                          <span className="hash">{p}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </dd>
              </div>
              <div>
                <dt>Root</dt>
                <dd className="hash">{proof.root}</dd>
              </div>
              <div>
                <dt>Anchor</dt>
                <dd>
                  <span className={proof.posted ? 'chip chip-signal' : 'chip'}>{proof.posted ? 'posted on-chain' : proof.status}</span>
                  {proof.tx_hash && <div className="hash">tx {proof.tx_hash}</div>}
                </dd>
              </div>
            </dl>
            <p className="faint">
              Checked here: the path from the leaf reaches the root. Not checked in the browser: that the root matches
              ReceiptRoots.rootOf(hour) on-chain{proof.posted ? '' : ', which it can only once the root is posted'}.
            </p>
          </>
        )}
      </section>
      <Link href="/dashboard/receipts">All receipts</Link>
    </div>
  );
}
