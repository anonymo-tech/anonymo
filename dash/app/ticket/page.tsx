import { PublicPage } from '@/components/site-chrome';
import { TicketClaim } from '@/components/ticket-claim';

// A ticket's key rides in the link's fragment, so this page is the same for every ticket and holds nothing to index.
export const metadata = {
  title: 'Your ticket — Anonymo',
  description: 'A ticket is chat credit on Anonymo that someone gave you. No account and no wallet. Adults only.',
  robots: { index: false, follow: false },
};

export default function TicketPage() {
  return (
    <PublicPage>
      <TicketClaim />
    </PublicPage>
  );
}
