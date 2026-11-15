import Link from 'next/link';
import { ReceiptStory } from '@/components/landing/receipt-story';
import { MaskGlyph } from '@/components/brand';
import { PublicPage } from '@/components/site-chrome';

const FLOOR = [
  'Any sexual content involving minors, including fully synthetic.',
  'Sexual images or “undressing” of real, identifiable people, and NSFW edits of uploaded photos.',
  'Cloning real people’s voices. Stock voices only.',
  'Real help building chemical, biological, radiological, nuclear or explosive weapons.',
];

const FAQ: [string, string][] = [
  ['Do I need an account?', 'No. You get a key, and the key is your account. No email, no name, no ID. Keep it somewhere safe: it can’t be recovered.'],
  ['What does it cost?', 'You pay for what you use, from a balance you top up. Each receipt shows exactly what that answer cost.'],
  ['Can I use it in my own app?', 'Yes. Anonymo speaks the OpenAI API, so most apps and code libraries work by changing the address and pasting your key.'],
  ['What is “sealed”?', 'anonymo-sealed only runs on hardware-attested GPU enclaves, and its receipt carries that attestation. If no attested route is up, it stops instead of falling back.'],
];

export default function Home() {
  return (
    <PublicPage bare>
      <main className="landing">
        <ReceiptStory />

        <section className="land-section land-split" data-reveal>
          <div>
            <p className="land-kicker">The floor</p>
            <h2>What stays blocked, for everyone.</h2>
            <p className="land-lede">
              No refusals for legal adult use. Four lines stay closed, checked outside the model. A blocked request is
              never rerouted and never charged.
            </p>
          </div>
          <ol className="land-list">
            {FLOOR.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </section>

        <section className="land-section land-split" data-reveal>
          <div>
            <p className="land-kicker">Questions</p>
            <h2>The short answers.</h2>
          </div>
          <dl className="land-faq">
            {FAQ.map(([q, a]) => (
              <div key={q}>
                <dt>{q}</dt>
                <dd>{a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="land-close" data-reveal>
          <h2>
            We don’t look. <MaskGlyph size={120} />
          </h2>
          <div className="story-actions">
            <Link className="btn btn-primary btn-lg btn-square" href="/dashboard/chat">
              Start chatting
            </Link>
            <Link className="story-link" href="/docs">
              Read the API docs
            </Link>
          </div>
        </section>
      </main>
    </PublicPage>
  );
}
