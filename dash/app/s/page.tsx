import { PublicPage } from '@/components/site-chrome';
import { ShareView } from '@/components/share-view';

// A shared chat rides sealed in the link's fragment, so this page is the same for every link and holds nothing to index.
export const metadata = {
  title: 'A shared chat — Anonymo',
  description: 'A chat someone shared from Anonymo. It opens in your browser, and Anonymo can’t read it. Adults only.',
  robots: { index: false, follow: false },
};

export default function SharePage() {
  return (
    <PublicPage>
      <ShareView />
    </PublicPage>
  );
}
