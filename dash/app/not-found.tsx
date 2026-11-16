import Link from 'next/link';
import { Photo } from '@/components/photo';
import { PublicPage } from '@/components/site-chrome';

export const metadata = { title: 'Page not found — Anonymo' };

export default function NotFound() {
  return (
    <PublicPage>
      <div className="lost">
        <Photo src="/mascot/pillow-sm.jpg" alt="" width={480} height={360} />
        <div>
          <p className="land-kicker">Error 404</p>
          <h1>Nothing printed here.</h1>
          <p>This page doesn’t exist, or it moved. Nothing about your visit was kept.</p>
          <div className="lost-actions">
            <Link className="btn btn-primary btn-square" href="/">
              Back to the start
            </Link>
            <Link className="story-link" href="/docs">
              Read the docs
            </Link>
          </div>
        </div>
      </div>
    </PublicPage>
  );
}
