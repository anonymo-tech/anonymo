import Link from 'next/link';
import { PublicPage } from '@/components/site-chrome';

const MODELS = [
  {
    id: 'anonymo-1',
    text: 'The best uncensored route for each request. Venice first, warm backups behind it. Refusals reroute to a different model family and are refunded.',
  },
  {
    id: 'anonymo-rp',
    text: 'Cheap long-context roleplay on self-hosted 24–27B models, with character-card import and lorebooks. For JanitorAI, SillyTavern, Chub and Agnai.',
  },
  {
    id: 'anonymo-council',
    text: 'Two or three model families answer and check each other, then a strong model merges them into one reply. Slower, priced at 4–5×.',
  },
  {
    id: 'anonymo-sealed',
    text: 'Runs only on hardware-attested GPU enclaves. If no attested route is up, it fails instead of downgrading.',
  },
];

const FLOOR = [
  'Any sexual content involving minors, including fully synthetic.',
  'Sexual imagery or “undressing” of real, identifiable people, and NSFW edits of uploaded photos.',
  'Cloning real people’s voices. Stock voices only.',
  'Meaningful help building chemical, biological, radiological, nuclear or explosive weapons.',
];

/** A sample receipt, drawn as a printed slip: what every call returns, and what it leaves out. */
function ReceiptSlip() {
  const rows: [string, string, string?][] = [
    ['model', 'anonymo-1'],
    ['route 1', 'venice:venice-uncensored', 'refused · billed 0'],
    ['route 2', 'selfhost:deepseek-v4.1-flash'],
    ['tokens', '412 in · 655 out'],
    ['cost', '$0.00137'],
    ['refund', '+$0.00011'],
  ];
  return (
    <figure className="slip" aria-label="Example receipt">
      <div className="slip-head">
        <span>ANONYMO · RECEIPT</span>
        <span>sample</span>
      </div>
      <div className="slip-row">
        <span>prompt</span>
        <span>
          <span className="slip-redact" aria-hidden="true">
            ████████████
          </span>{' '}
          not stored
        </span>
      </div>
      {rows.map(([k, v, flag]) => (
        <div className="slip-row" key={k}>
          <span>{k}</span>
          <span>
            {v}
            {flag && <em>{flag}</em>}
          </span>
        </div>
      ))}
      <div className="slip-rule" />
      <div className="slip-row">
        <span>proof</span>
        <span>leaf → root · 5 siblings ✓</span>
      </div>
      <div className="slip-row">
        <span>anchor</span>
        <span>ReceiptRoots · hourly</span>
      </div>
      <figcaption>Every call returns one of these. The prompt and the reply are never kept.</figcaption>
    </figure>
  );
}

export default function Home() {
  return (
    <PublicPage>
      <section className="hero hero-split">
        <div className="hero-copy">
          <span className="hero-kicker">Uncensored models · one key · adults only</span>
          <h1>
            Ask anything. <span>Get an answer.</span> <span>One key.</span>
          </h1>
          <p>
            Anonymo is one OpenAI-compatible API key, plus this workspace, that serves only uncensored and low-refusal models.
            No refusals for legal adult use: if a model refuses, Anonymo reroutes to a different model family and refunds the
            refused attempt.
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary" href="/dashboard/key">
              Create a key
            </Link>
            <Link className="btn" href="/dashboard?demo=1">
              Try the demo
            </Link>
            <Link className="btn btn-ghost" href="/presets">
              Frontend presets
            </Link>
          </div>
        </div>
        <ReceiptSlip />
      </section>

      <section className="section">
        <h2>Four model IDs</h2>
        <div className="grid-2">
          {MODELS.map((m) => (
            <div className="tile" key={m.id}>
              <h3>
                <code>{m.id}</code>
              </h3>
              <p>{m.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Proof, not promises</h2>
        <div className="grid-2">
          <div className="tile">
            <h3>A receipt on every call</h3>
            <p>
              Each response carries a signed receipt listing the routes that ran, the model hashes and the cost. Receipts roll
              into an hourly Merkle root posted on-chain, and you can check the path yourself.
            </p>
          </div>
          <div className="tile">
            <h3>Private you can prove</h3>
            <p>
              anonymo-sealed is the only fully private tier, and its receipt carries the enclave attestation to show it. Every
              other route is zero retention: a policy we keep, not a proof.
            </p>
          </div>
          <div className="tile">
            <h3>
              <Link href="/leaderboard">Refusal leaderboard</Link>
            </h3>
            <p>How often each route refused a legal request in the last 30 days. Counts only, no text.</p>
          </div>
          <div className="tile">
            <h3>
              <Link href="/manifest">Model manifest</Link>
            </h3>
            <p>Every route behind each model ID, with its family, quantization, weights hash and attestation.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>No account. Crypto only.</h2>
        <div className="grid-2">
          <div className="tile">
            <h3>Fund a key</h3>
            <p>
              USDC, USDT and USDG on Base, Arbitrum and Robinhood Chain. USDC and USDT on Solana. USDT on Tron. BTC and
              Lightning through BTCPay. Agents can pay per call with x402.
            </p>
          </div>
          <div className="tile">
            <h3>Your credit stays yours</h3>
            <p>
              Unused credit can always be withdrawn, only back to the wallet it came from. Withdrawals are never paused. No
              email, no name, no KYC.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>The floor that stays on</h2>
        <p className="muted">
          Uncensored means no refusals for legal adult use, with a floor that stays on. Four lines are blocked everywhere, by checks that sit
          outside the model. A blocked request is never rerouted and never charged.
        </p>
        <ol className="floor-list">
          {FLOOR.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </section>

      <section className="section">
        <h2>Two lines to start</h2>
        <pre className="snippet">
          <code>{`curl https://api.anonymo.example/v1/chat/completions \\
  -H "Authorization: Bearer anm_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"anonymo-1","messages":[{"role":"user","content":"Hello"}]}'`}</code>
        </pre>
      </section>
    </PublicPage>
  );
}
