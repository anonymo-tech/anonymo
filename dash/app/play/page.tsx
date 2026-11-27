import { PublicPage } from '@/components/site-chrome';
import { PlayView } from '@/components/build/play-view';

// A shared app rides compressed in the link's fragment, so this page is the same for every link and holds nothing to index.
export const metadata = {
  title: 'Play an app — Anonymo',
  description: 'An app or game someone made with Anonymo Build. It runs in your browser, sealed off from everything else.',
  robots: { index: false, follow: false },
};

export default function PlayPage() {
  return (
    <PublicPage>
      <PlayView />
    </PublicPage>
  );
}
