import Link from 'next/link';
import { Publication, publicationMetadata } from '@/components/publication';

export const metadata = publicationMetadata('whitepaper');

export default function Whitepaper() {
  return (
    <Publication id="whitepaper">
      <p>
        Anonymo offers one prepaid, OpenAI-compatible key for multiple model
        providers. Its distinguishing decision happens mid-request, when a
        provider declines something the service allows.
      </p>
      <section>
        <h2>How a call settles</h2>
        <dl>
          <dt>Check the request</dt>
          <dd>
            The gateway evaluates its content rules before contacting a
            provider. A blocked request ends here with no charge. A permitted
            request moves to model selection.
          </dd>
          <dt>Try a different family</dt>
          <dd>
            If a provider refuses and a retry is available, the router can send
            the permitted request to a different model family. Refused attempts
            cost the customer zero, including when both families decline.
          </dd>
          <dt>Issue the receipt</dt>
          <dd>
            The gateway records the routes, outcomes, token usage and charge.
            Its signature lets a reader check who issued those details and
            whether they changed.
          </dd>
        </dl>
      </section>
      <aside>
        <h3>A worked example</h3>
        <p>
          Suppose the first family declines an allowed request and a second
          family answers. The first attempt costs the customer $0. The receipt
          records both routes and the charge for the completed answer. The{' '}
          <Link href="/docs#receipts">receipt reference</Link> explains the fields.
        </p>
      </aside>
      <section>
        <h2>One key across model families</h2>
        <p>
          Writers can keep characters in their favorite chat apps. Developers
          can switch an OpenAI-compatible integration by changing its base URL
          and key. The public manifest on 20 November 2026 listed 373 entries
          across 58 families, with zero attested routes. The snapshot did not
          list the branded model IDs. A listing alone cannot establish
          availability.
        </p>
      </section>
      <section>
        <h2>What stays private</h2>
        <p>
          The gateway excludes normal prompts and replies from storage and keeps
          accounting metadata. Ordinary providers still process the text. Sealed
          mode requires current hardware attestation and fails if no eligible
          route is available.
        </p>
      </section>
      <section>
        <h2>What a better router could learn</h2>
        <p>
          Route outcomes and costs could reveal which model pairs recover more
          permitted requests per dollar. With enough repeat traffic, Anonymo
          could test a better retry order without retaining anyone’s
          conversation.
        </p>
      </section>
      <aside>
        <h3>An illustrative margin test</h3>
        <p>
          Suppose $1.15 of usage brings $1.00 in completed-call costs and $0.05
          in refused attempts. That leaves $0.10 before payment and
          infrastructure costs. Actual margins require paid usage data.
        </p>
      </aside>
      <section>
        <h2>Product references</h2>
        <p>
          <a href="https://api.anonymo.tech/manifest">Live route manifest</a> ·{' '}
          <a href="https://api.anonymo.tech/keep/inventory.json">
            Data inventory
          </a>{' '}
          · <Link href="/docs#receipts">Receipt reference</Link>
        </p>
      </section>
    </Publication>
  );
}
