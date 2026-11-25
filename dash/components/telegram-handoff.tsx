'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { describeError } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { saveTelegramSession } from '@/lib/anonymo/key-store';
import { adultStore } from '@/lib/anonymo/prefs';
import { handoffFromFragment, takeTelegramFragment, TELEGRAM_SESSION } from '@/lib/anonymo/telegram';
import { useAnonymo } from './anonymo-provider';

export function TelegramHandoff() {
  const { ready, demo, key, client } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const router = useRouter();
  const token = useRef<string | null | undefined>(undefined);
  const started = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (token.current === undefined) token.current = handoffFromFragment(takeTelegramFragment(window.location, window.history));
    if (!ready || !adult || started.current) return;
    started.current = true;
    if (demo) { router.replace('/dashboard/chat'); return; }
    if (!token.current) { setError('Open a fresh link from the Anonymo bot or Mini App.'); return; }
    const submitted = token.current;
    token.current = null;
    void (async () => {
      const opened = await client.telegramHandoff(submitted);
      const digest = key && !TELEGRAM_SESSION.test(key)
        ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))),
          (byte) => byte.toString(16).padStart(2, '0')).join('')
        : null;
      if (digest !== opened.key_hash) saveTelegramSession(opened.key, opened.expires_at);
      router.replace('/dashboard/chat');
    })().catch((error) => setError(describeError(error)));
  }, [adult, client, demo, key, ready, router]);

  return (
    <main className="telegram-page panel">
      <h1 className="panel-title">Open the full app</h1>
      {error ? <>
        <p className="error-text" role="alert">{error}</p>
        <Link className="btn" href="/dashboard/chat">Open chat</Link>
      </> : <p className="muted" role="status">Opening workspace chat…</p>}
    </main>
  );
}
