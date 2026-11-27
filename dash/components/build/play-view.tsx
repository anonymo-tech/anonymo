'use client';

// Update "build": a shared app. The app is read from the link's fragment (never sent to a server) and runs in the same
// sealed frame as in the studio: no network, no access to this site.

import Link from 'next/link';
import { Expand, Hammer, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AppFrame, type AppFrameHandle } from './app-frame';
import { decodeShare } from '@/lib/anonymo/build';
import './build.css';

export function PlayView() {
  const [app, setApp] = useState<{ title: string; html: string } | null | 'loading'>('loading');
  const frame = useRef<AppFrameHandle>(null);
  useEffect(() => {
    const read = () => void decodeShare(location.hash).then(setApp);
    read();
    addEventListener('hashchange', read);
    return () => removeEventListener('hashchange', read);
  }, []);

  if (app === 'loading') return null;
  if (!app) {
    return (
      <section className="play-missing">
        <h1>This link has no app in it</h1>
        <p className="faint">It may have been cut off when it was copied. Ask for the link again.</p>
        <Link className="btn btn-primary" href="/dashboard/build">
          <Hammer size={16} aria-hidden="true" /> Build your own
        </Link>
      </section>
    );
  }
  return (
    <section className="play">
      <div className="play-bar">
        <h1>{app.title}</h1>
        <button type="button" className="btn btn-small" onClick={() => frame.current?.restart()}>
          <RotateCcw size={14} aria-hidden="true" /> Restart
        </button>
        <button type="button" className="btn btn-small" onClick={() => frame.current?.fullscreen()}>
          <Expand size={14} aria-hidden="true" /> Full screen
        </button>
        <Link className="btn btn-primary btn-small" href="/dashboard/build">
          <Hammer size={14} aria-hidden="true" /> Make your own
        </Link>
      </div>
      <AppFrame ref={frame} html={app.html} title={app.title} className="play-frame" />
      <p className="faint play-note">Made by someone with Anonymo Build. It runs sealed off in your browser: it can’t go online or see anything else. Never type a password into it.</p>
    </section>
  );
}
