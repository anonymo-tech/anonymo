import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PublicPage } from '@/components/site-chrome';
import { DEMO_BY_DEFAULT } from '@/lib/anonymo/config';
import { updateOn } from '@/lib/anonymo/updates';

const line = "Your chats can't be auctioned. We never had them.";

export const metadata = { title: 'Lifeboat — Anonymo', description: line };

export default function LifeboatLandingPage() {
  if (!updateOn('lifeboat', DEMO_BY_DEFAULT)) notFound();
  return (
    <PublicPage>
      <div className="page-title">
        <span className="hero-kicker">Lifeboat</span>
        <h1>{line}</h1>
        <p>In the Anonymo web app, your chats stay on your device. When you send a message, text passes through our gateway to answer it. We don’t store your chats.</p>
      </div>
      <section className="panel">
        <h2>Bring your characters and chats</h2>
        <p>If you’re moving from another app, export your character cards or chat history and drop the files into Lifeboat. You can bring a ZIP of cards or paste a transcript.</p>
        <p>We check card text before it’s saved on this device and skip duplicate cards. Open the character to continue with memory from your imported chats.</p>
        <div className="row">
          <Link href="/dashboard/lifeboat" className="btn btn-primary">Open Lifeboat</Link>
        </div>
      </section>
    </PublicPage>
  );
}
