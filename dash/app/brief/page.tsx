import Link from 'next/link';
import { Publication, publicationMetadata } from '@/components/publication';

export const metadata = publicationMetadata('brief');

export default function InvestorBrief() {
  return (
    <Publication id="brief">
      <p>
        A fiction writer asks for a darker ending. One model declines. With
        Anonymo, another model family can pick up the same request. The writer
        keeps working. The receipt shows what the answer cost.
      </p>
      <aside>
        <p>
          <strong>$0 for a refused attempt.</strong> The receipt shows which
          route declined, which one answered, and what Anonymo billed.
        </p>
      </aside>
      <section>
        <h2>Where customers start</h2>
        <p>
          Roleplay users and fiction writers already spend time in characters
          and chat histories. Anonymo’s presets let them try a new model backend
          inside familiar tools such as SillyTavern and Open WebUI.
        </p>
      </section>
      <section>
        <h2>How usage can pay</h2>
        <p>
          Anonymo plans to earn a spread on completed calls. A recovered
          conversation can lead to another paid turn. Every upstream attempt
          counts against margin, including a refusal billed to the user at zero.
        </p>
      </section>
      <section>
        <h2>The next commercial milestone</h2>
        <p>
          Follow a first-time user from a real deposit to a paid answer and a
          matching receipt. Then measure how many funded keys return the
          following week. Funding new keys is the next launch milestone.
        </p>
      </section>
      <section>
        <h2>Explore the product</h2>
        <p>
          <Link href="/dashboard/chat?demo=1">Open the product demo</Link> ·{' '}
          <Link href="/docs">Developer guide</Link> ·{' '}
          <Link href="/presets">Client presets</Link>
        </p>
      </section>
    </Publication>
  );
}
