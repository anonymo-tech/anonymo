import { Photo } from '@/components/photo';
import Link from 'next/link';
import { ArrowRight, Coins, Lock, ReceiptText, SendHorizontal, ShieldCheck } from 'lucide-react';
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

const FAQ: [string, string][] = [
  ['Do I need an account?', 'No. Your API key is your account. No email, no name, no KYC. Keep the key somewhere safe: it cannot be recovered.'],
  ['Are my conversations stored?', 'No. Prompts and replies are never kept. Receipts hold routes, hashes and costs only.'],
  ['What happens when a model refuses?', 'Anonymo reroutes to a different model family and refunds the refused attempt. You never pay for a refusal.'],
  ['How do I pay?', 'Stablecoins on Base, Arbitrum, Robinhood Chain, Solana and Tron, BTC and Lightning, or the coin. Unused stablecoin credit can be withdrawn to the wallet it came from.'],
];

/** A static preview of the chat screen: what the workspace looks like, with a sample exchange. */
function ChatPreview() {
  return (
    <figure className="preview" aria-label="A sample chat in the Anonymo workspace" style={{ margin: 0 }}>
      <div className="preview-top">
        <span className="chip" style={{ color: 'var(--text)', padding: '4px 12px' }}>
          <span className="dot" style={{ background: 'var(--amber)' }} aria-hidden="true" /> anonymo-1
        </span>
        <span className="chip chip-signal">Zero retention</span>
      </div>
      <p className="bubble-user">Help me write the opening of a noir story. A missing pianist, a rain-soaked city, one strange clue.</p>
      <div className="bubble-ai">
        <Photo src="/mascot/avatar.jpg" alt="" width={40} height={40} />
        <div style={{ display: 'grid', gap: 8 }}>
          <p>
            <strong>anonymo-1</strong>
            The rain had been working the city longer than I had. By midnight it had washed everything clean except the people.
          </p>
          <span className="receipt-link">
            <ReceiptText size={15} aria-hidden="true" /> Signed receipt
          </span>
        </div>
      </div>
      <div className="preview-input">
        <span>Where does the story go next?</span>
        <span className="send-mini" aria-hidden="true">
          <SendHorizontal size={17} />
        </span>
      </div>
      <figcaption className="faint" style={{ fontSize: 12.5 }}>
        Sample conversation. Nothing you type is stored.
      </figcaption>
    </figure>
  );
}

export default function Home() {
  return (
    <PublicPage wide>
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
            <Link className="btn btn-primary btn-lg" href="/dashboard/key">
              Create a key
            </Link>
            <Link className="btn btn-outline btn-lg" href="/dashboard/chat?demo=1">
              Try the demo
            </Link>
          </div>
          <span className="hero-note">No account. No email. No KYC.</span>
        </div>
        <ChatPreview />
      </section>

      <div className="grid-3">
        <div className="card feature">
          <span className="icon-box">
            <Lock size={20} aria-hidden="true" />
          </span>
          <div>
            <h3>Zero retention</h3>
            <p>Prompts and replies are never kept. anonymo-sealed runs in attested enclaves and proves it on the receipt.</p>
          </div>
        </div>
        <div className="card feature">
          <span className="icon-box icon-box-amber">
            <Coins size={20} aria-hidden="true" />
          </span>
          <div>
            <h3>Pay in crypto</h3>
            <p>Stablecoins, BTC or the coin. Unused stablecoin credit goes back to the wallet it came from.</p>
          </div>
        </div>
        <div className="card feature">
          <span className="icon-box icon-box-amber">
            <ReceiptText size={20} aria-hidden="true" />
          </span>
          <div>
            <h3>Signed receipts</h3>
            <p>Every call returns a receipt with its routes and cost, rolled into an hourly root posted on-chain.</p>
          </div>
        </div>
      </div>

      <section className="section">
        <div className="grid-2" style={{ alignItems: 'stretch' }}>
          <div className="card">
            <h2>One request. Any client.</h2>
            <p className="lede">It speaks the OpenAI API. Point your client at Anonymo and paste your key.</p>
            <div className="code-card">
              <header>
                <div className="tabs-mini">
                  <span>cURL</span>
                </div>
              </header>
              <pre className="code">
                <code>
                  {'curl https://api.anonymo.example/v1/chat/completions \\\n'}
                  {'  -H '}
                  <span className="s">{'"Authorization: Bearer anm_live_YOUR_KEY"'}</span>
                  {' \\\n  -H '}
                  <span className="s">{'"Content-Type: application/json"'}</span>
                  {' \\\n  -d '}
                  <span className="s">{`'{"model":"anonymo-1","messages":[{"role":"user","content":"Hello"}]}'`}</span>
                </code>
              </pre>
            </div>
            <Link className="link" href="/docs">
              Read the API docs <ArrowRight size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} />
            </Link>
          </div>
          <div className="card voice-card">
            <h2>Bring your character.</h2>
            <div className="photo">
              <Photo src="/mascot/pillow.jpg" alt="The Anonymo mascot napping in headphones" width={1200} height={900} />
            </div>
            <div className="chips">
              <span className="chip">SillyTavern</span>
              <span className="chip">JanitorAI</span>
              <span className="chip">Open WebUI</span>
              <Link className="link" href="/presets">
                All presets <ArrowRight size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Four model IDs</h2>
        <div className="grid-2">
          {MODELS.map((m) => (
            <div className="card" key={m.id}>
              <h3>
                <code>{m.id}</code>
              </h3>
              <p className="lede">{m.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="photo-band">
          <Photo src="/mascot/lamp.jpg" alt="The Anonymo mascot listening to music beside a lamp" width={1600} height={900} />
          <div>
            <h2>Proof, not promises.</h2>
            <p>
              anonymo-sealed is the only fully private tier, and its receipt carries the enclave attestation to show it. Every
              other route is zero retention: a policy we keep, not a proof.
            </p>
            <div className="row">
              <Link className="btn btn-outline" href="/leaderboard">
                Refusal leaderboard
              </Link>
              <Link className="btn btn-ghost" href="/manifest">
                Model manifest
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>No account. Crypto only.</h2>
        <div className="band">
          <div>
            <strong>Fund a key</strong>
            <span>USDC, USDT and USDG on Base, Arbitrum and Robinhood Chain. Solana, Tron, BTC and Lightning. x402 for agents.</span>
          </div>
          <div>
            <strong>Your credit stays yours</strong>
            <span>Withdraw unused stablecoin credit, only to the wallet it came from. Withdrawals are never paused.</span>
          </div>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
            <Link className="btn btn-primary" href="/dashboard/key">
              Create a key
            </Link>
            <span>Start with your API key</span>
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
        <h2>A few things, answered.</h2>
        <dl className="faq">
          {FAQ.map(([q, a]) => (
            <div key={q}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
        <p className="faint row" style={{ gap: 8 }}>
          <ShieldCheck size={16} aria-hidden="true" /> Adults only. You must be 18 or older, and of legal age where you live.
        </p>
      </section>
    </PublicPage>
  );
}
