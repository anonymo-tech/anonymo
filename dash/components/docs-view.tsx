'use client';

// The API reference: what a developer needs to call Anonymo from their own code. Every path, header and field here
// is one the dashboard's own client uses (lib/anonymo/client.ts, lib/anonymo/types.ts).

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { adultStore } from '@/lib/anonymo/prefs';
import { useAnonymo } from './anonymo-provider';
import { CopyButton } from './copy-button';
import { API_BASE, publicApiBase } from '@/lib/anonymo/config';
import { updateOn } from '@/lib/anonymo/updates';
import { AUTO_EXPLAINER, AUTO_HEADER, AUTO_MODEL } from '@/lib/anonymo/auto';
import { WEB_SEARCH_PRICE_USD } from '@/lib/anonymo/search';

const samples = (BASE: string) => ({
  cURL: `curl ${BASE}/v1/chat/completions \\
  -H "Authorization: Bearer $ANONYMO_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "anonymo-1",
    "messages": [
      { "role": "user", "content": "Hello" }
    ]
  }'`,
  Python: `import os
from openai import OpenAI

client = OpenAI(
    base_url="${BASE}/v1",
    api_key=os.environ["ANONYMO_KEY"],
)

reply = client.chat.completions.create(
    model="anonymo-1",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)`,
  JavaScript: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${BASE}/v1',
  apiKey: process.env.ANONYMO_KEY,
});

const reply = await client.chat.completions.create({
  model: 'anonymo-1',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(reply.choices[0].message.content);`,
});
type Lang = 'cURL' | 'Python' | 'JavaScript';
const LANGS: Lang[] = ['cURL', 'Python', 'JavaScript'];

const RESPONSE = `{
  "id": "req_demo",
  "object": "chat.completion",
  "model": "anonymo-1",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hey. What's on your mind?" },
    "finish_reason": "stop"
  }],
  "anonymo_receipt": {
    "payload": {
      "request_id": "req_demo",
      "model_id": "anonymo-1",
      "routes": [ … ],
      "tokens": { "in": 12, "out": 9 },
      "cost": "0.000021",
      "refused": false,
      "sealed": false
    },
    "alg": "Ed25519",
    "sig": "…",
    "key_id": "…"
  }
}`;

const SECTIONS = [
  { id: 'start', label: 'Getting started' },
  { id: 'auth', label: 'Authentication' },
  { id: 'chat', label: 'Chat completions' },
  { id: 'search', label: 'Web search' },
  { id: 'models', label: 'Model IDs' },
  { id: 'auto', label: 'Auto model' }, // update "auto"
  { id: 'receipts', label: 'Receipts' },
  { id: 'errors', label: 'Errors' },
  { id: 'payments', label: 'Keys and payments' },
];

export function DocsView() {
  const { ready, demo } = useAnonymo();
  const autoOn = ready && updateOn('auto', demo);
  const sections = SECTIONS.filter((s) => s.id !== 'auto' || autoOn);
  const base = ready ? publicApiBase(demo) : API_BASE || 'https://api.anonymo.example';
  const REQUEST = samples(base);
  const [lang, setLang] = useState<Lang>('cURL');
  const docsRoot = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const root = docsRoot.current;
    const header = root?.closest('.public')?.querySelector<HTMLElement>('.public-head');
    if (!root || !header) return;
    const measure = () => root.style.setProperty('--docs-header-height', `${header.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const canRead = useDeviceStore(adultStore);
  useEffect(() => {
    const hash = window.location.hash;
    const section = document.getElementById(hash.slice(1));
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!canRead || navigation?.type === 'back_forward' || !section?.matches('.docs-body section')) return;

    // WebKit may position a document fragment before the sticky header and webfont settle.
    // Only repair the initial jump. Input and history navigation return control to the reader.
    const controller = new AbortController();
    const options = { once: true, passive: true, signal: controller.signal };
    const cancel = () => controller.abort();
    for (const event of ['keydown', 'pointerdown', 'wheel', 'touchstart', 'popstate', 'hashchange']) {
      window.addEventListener(event, cancel, options);
    }
    const align = async () => {
      await document.fonts.ready;
      requestAnimationFrame(() => {
        if (controller.signal.aborted || location.hash !== hash) return;
        section.scrollIntoView({ block: 'start', behavior: 'instant' });
        cancel();
      });
    };
    if (document.readyState === 'complete') void align();
    else window.addEventListener('load', align, options);
    return cancel;
  }, [canRead]);
  return (
    <main ref={docsRoot} className="docs" id="main" tabIndex={-1}>
      <nav className="docs-nav" aria-label="Documentation">
        <h4>Documentation</h4>
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.label}
          </a>
        ))}
        <h4>Resources</h4>
        <Link href="/manifest">Model manifest</Link>
        <Link href="/leaderboard">Refusal leaderboard</Link>
        <Link href="/presets">Frontend presets</Link>
      </nav>

      <div className="docs-body">
        <section id="start">
          <span className="hero-kicker">API reference</span>
          <h1>Anonymo API</h1>
          <p>
            Anonymo speaks the OpenAI API. Any client or SDK that lets you set a base URL works: point it at Anonymo, use your
            key, and pick one of the four model IDs.
          </p>
          <div className="notice notice-amber">
            <strong>Your conversations stay yours.</strong> Prompts and replies are never stored. Each reply carries a signed
            receipt instead.
          </div>
        </section>

        <section id="auth">
          <h2>Authentication</h2>
          <p>
            Send your key as a Bearer token: <code>Authorization: Bearer anm_live_…</code>. There is no account behind it. The
            gateway keeps only a hash of the key, so a lost key cannot be recovered. Create one in the{' '}
            <Link className="link" href="/dashboard/key">
              workspace
            </Link>{' '}
            or with <code>POST /keys</code>.
          </p>
        </section>

        <section id="chat">
          <h2>Chat completions</h2>
          <span className="endpoint">
            <b>POST</b> /v1/chat/completions
          </span>
          <p>The OpenAI chat completions request and response, with an Anonymo receipt added to the reply.</p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>model</code></td>
                  <td>string · required</td>
                  <td>One of the model IDs below.</td>
                </tr>
                <tr>
                  <td><code>messages</code></td>
                  <td>array · required</td>
                  <td>The conversation, as <code>role</code> and <code>content</code> pairs.</td>
                </tr>
                <tr>
                  <td><code>stream</code></td>
                  <td>boolean</td>
                  <td>Stream tokens as server-sent events. The last event carries the receipt. Not for anonymo-council.</td>
                </tr>
                <tr>
                  <td><code>max_tokens</code></td>
                  <td>number</td>
                  <td>Upper limit on the reply length.</td>
                </tr>
                <tr>
                  <td><code>temperature</code></td>
                  <td>number</td>
                  <td>Sampling temperature.</td>
                </tr>
                <tr>
                  <td><code>council.mode</code></td>
                  <td>merge · select</td>
                  <td>anonymo-council only: merge the replies, or have a judge pick one (cheaper).</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>Optional headers:</p>
          <ul>
            <li>
              <code>x-anonymo-refusal-catch: off</code> turns off the refusal catch, which holds back the first tokens to catch a
              refusal and reroute it. Off streams sooner. A real one, from production:{' '}
              <Link href="/verify?r=gen-1795224820-Vfcw47tjO8Q7zw">this receipt</Link> shows Hunyuan refusing a legal adult
              request, the attempt refunded and the call billed $0.
            </li>
            <li>
              <code>x-anonymo-sealed: required</code> sends the request only to hardware-attested routes, or fails with 409.
            </li>
          </ul>
        </section>

        <section id="search">
          <h2>Web search</h2>
          <p>
            Any model can look things up on the web and cite its sources. Add <code>:online</code> to the model ID, for example{' '}
            <code>anonymo-1:online</code>. The OpenRouter forms work too: <code>{'"plugins": [{ "id": "web" }]'}</code> or{' '}
            <code>web_search_options</code>.
          </p>
          <p>
            The gateway checks your prompt first. Then it sends one query, your last message, to the search engine. It sends no
            key, account, IP address or headers with it. The model gets the results as numbered sources. The reply carries them as{' '}
            <code>url_citation</code> annotations on the message (on a stream, in a delta just before the receipt).
          </p>
          <p>
            Each search costs ${WEB_SEARCH_PRICE_USD}, charged once per answered request and shown in <code>usage</code> and the
            receipt. A failed search costs nothing. Queries and results are never stored.
          </p>
          <p>
            Sealed, attested and <code>:private</code> requests cannot search, because the search engine would see the query. They
            get 409 <code>web_search_private</code>. Council mode and <code>/v1/completions</code> cannot search yet.
          </p>
        </section>

        <section id="models">
          <h2>Model IDs</h2>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr>
                  <td><code>anonymo-1</code></td>
                  <td>The best uncensored route for each request. Refusals reroute to a different family and are refunded.</td>
                </tr>
                <tr>
                  <td><code>anonymo-rp</code></td>
                  <td>Long-context roleplay on self-hosted models, with character cards. Not live yet.</td>
                </tr>
                <tr>
                  <td><code>anonymo-council</code></td>
                  <td>Several model families answer and check each other; one reply comes back. Priced at 4–5×.</td>
                </tr>
                <tr>
                  <td><code>anonymo-sealed</code></td>
                  <td>Hardware-attested enclaves only. Fails instead of downgrading. Not live yet.</td>
                </tr>
                {autoOn && (
                  <tr>
                    <td><code>{AUTO_MODEL}</code></td>
                    <td>Picks a model for each request and names the one that answered. <a className="link" href="#auto">How it chooses</a>.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p>
            <code>GET /v1/models</code> lists the ones that are live right now; a model that is not live answers 404{' '}
            <code>model_not_found</code>. The{' '}
            <Link className="link" href="/manifest">
              manifest
            </Link>{' '}
            shows every route behind each ID.
          </p>
        </section>

        {autoOn && (
          <section id="auto">
            <h2>Auto model</h2>
            <p>
              Send <code>{'"model": "' + AUTO_MODEL + '"'}</code> and Anonymo picks a model for each request. {AUTO_EXPLAINER}
            </p>
            <ul>
              <li>No extra model call: the request is classified from what it contains, and the same request with the same counts picks the same model.</li>
              <li>
                The reply&apos;s <code>model</code> field and its receipt name the model that answered. The <code>{AUTO_HEADER}</code> header
                says which kind of request it read: <code>code</code>, <code>roleplay</code>, <code>reasoning</code>, <code>vision</code> or <code>general</code>.
              </li>
              <li>
                Your price limits apply (<code>provider.max_price</code>, key caps and model lists). With <code>x-anonymo-sealed: required</code>,
                only attested routes count, or the request fails with 409 <code>sealed_unavailable</code>.
              </li>
              <li>If the picked model refuses, the refusal catch retries on the next model from another family, and the refused attempt is billed $0.</li>
            </ul>
          </section>
        )}

        <section id="receipts">
          <h2>Receipts</h2>
          <span className="endpoint">
            <b className="get">GET</b> /v1/receipts/:id
          </span>
          <p>
            Every reply carries <code>anonymo_receipt</code>: the routes that ran, token counts, cost, and an Ed25519 signature.
            Once a Merkle root is published, <code>GET /v1/receipts/:id/proof</code> returns an inclusion proof for the receipt.
          </p>
        </section>

        <section id="errors">
          <h2>Errors</h2>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr>
                  <td className="mono">451</td>
                  <td><code>floor_blocked</code></td>
                  <td>
                    Falls under one of the four blocked lines. A blocked prompt is never sent to a model. A reply that crosses a line is withheld
                    (<code>metadata.stage</code> is <code>reply</code>; on a stream it arrives as an error event after the text already checked).
                    Never rerouted, never charged.
                  </td>
                </tr>
                <tr>
                  <td className="mono">503</td>
                  <td><code>floor_unavailable</code></td>
                  <td>The safety check could not run, so nothing was served. Nothing was charged; try again shortly.</td>
                </tr>
                <tr>
                  <td className="mono">409</td>
                  <td><code>sealed_unavailable</code></td>
                  <td>No attested route is up. Nothing was sent or charged.</td>
                </tr>
                <tr>
                  <td className="mono">501 · 502</td>
                  <td><code>web_search_unavailable</code> · <code>web_search_failed</code></td>
                  <td>Web search is not set up on this gateway, or the search failed. Nothing was sent to a model or charged.</td>
                </tr>
                <tr>
                  <td className="mono">402</td>
                  <td><code>insufficient_balance</code></td>
                  <td>Open Balance to see your credit and the deposit methods available for your key.</td>
                </tr>
                <tr>
                  <td className="mono">429</td>
                  <td className="faint">—</td>
                  <td>Too many requests for this key right now.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="payments">
          <h2>Keys and payments</h2>
          <ul>
            <li>
              <code>POST /keys</code> creates a key and returns it once, with its deposit instructions. Optional caps: daily,
              monthly and lifetime spend, a model allowlist, an IP allowlist, sealed only and an expiry. Check{' '}
              <Link href="/dashboard/funds">Balance</Link> for the tokens and networks currently available for your key.
            </li>
            <li>
              <code>GET /balance</code> shows available, held and usage-only credit.
            </li>
            <li>
              <code>GET /deposits</code> lists deposits. <code>POST /withdraw</code> sends unused stablecoin credit back to the
              wallet it came from, and needs an <code>Idempotency-Key</code> header.
            </li>
          </ul>
        </section>
      </div>

      <aside className="docs-code" aria-label="Code samples">
        <div className="code-card">
          <header>
            <div className="tabs" role="tablist" aria-label="Language">
              {LANGS.map((l) => (
                <button key={l} type="button" role="tab" aria-selected={lang === l} onClick={() => setLang(l)}>
                  {l}
                </button>
              ))}
            </div>
            <CopyButton text={REQUEST[lang]} />
          </header>
          <pre className="code">
            <code>{REQUEST[lang]}</code>
          </pre>
        </div>
        <div className="code-card">
          <header>
            <span className="code-label">Response</span>
            <span className="chip chip-signal">200 OK</span>
          </header>
          <pre className="code">
            <code>{RESPONSE}</code>
          </pre>
        </div>
      </aside>
    </main>
  );
}
