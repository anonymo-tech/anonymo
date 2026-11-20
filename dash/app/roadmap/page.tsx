import Link from 'next/link';
import { Publication, publicationMetadata } from '@/components/publication';

export const metadata = publicationMetadata('roadmap');

export default function Roadmap() {
  return (
    <Publication id="roadmap">
      <p>
        The web workspace, API reference and demo are public. The next milestone
        is a funded customer. Four steps show how to judge the business as paid
        usage begins.
      </p>
      <section>
        <h2>Open the paid path</h2>
        <p>
          Complete commercial licensing and independent contract review, then
          open deposits. Trace a wallet transfer through the credited balance,
          first paid answer and receipt.
        </p>
        <aside>
          <p>
            <strong>Evidence to look for</strong> · A reproducible paid flow
            with the amounts reconciled end to end.
          </p>
        </aside>
      </section>
      <section>
        <h2>Find who comes back</h2>
        <p>
          Start with roleplay and fiction users in compatible chat apps. Track
          funded keys through a first paid answer and a second week of paid use.
        </p>
        <aside>
          <p>
            <strong>Evidence to look for</strong> · Activation, week-two paid
            use and second deposits by cohort.
          </p>
        </aside>
      </section>
      <section>
        <h2>Price the second chance</h2>
        <p>
          Measure how often a retry recovers an answer, what each attempt costs
          and how much time it adds. Use those results to set prices and select
          model pairs.
        </p>
        <aside>
          <p>
            <strong>Evidence to look for</strong> · Recovered answers, margin
            after variable costs and retry latency.
          </p>
        </aside>
      </section>
      <section>
        <h2>Give funded users a reason to stay</h2>
        <p>
          The image studio and spending controls are visible in the workspace.
          Measure whether their users return more often. Open sealed inference
          when a real call can demonstrate hardware attestation.
        </p>
      </section>
      <section>
        <h2>Inspect what exists today</h2>
        <p>
          <Link href="/dashboard/chat?demo=1">Product demo</Link> ·{' '}
          <a href="https://api.anonymo.tech/manifest">Live route manifest</a> ·{' '}
          <Link href="/docs">Developer guide</Link>
        </p>
      </section>
    </Publication>
  );
}
