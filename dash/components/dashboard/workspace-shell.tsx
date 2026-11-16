'use client';

// The workspace frame: a left sidebar with the sections and the mascot card, a top bar with the breadcrumb, the purse
// and the chat button, and the page itself. The chat page puts its composer in a sticky bar at the bottom.

import { Photo } from '@/components/photo';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Drama,
  KeyRound,
  LayoutGrid,
  ListTree,
  MessageSquare,
  Plug,
  ReceiptText,
  Trophy,
  Wallet,
} from 'lucide-react';
import { useAnonymo } from '../anonymo-provider';
import { AdultsOnly, VeniceBadge, Wordmark } from '../brand';
import { DemoNotice } from '../demo-notice';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutGrid },
  { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard/characters', label: 'Characters', icon: Drama },
  { href: '/dashboard/presets', label: 'Frontend presets', icon: Plug },
  { href: '/dashboard/key', label: 'API key', icon: KeyRound },
  { href: '/dashboard/funds', label: 'Funds', icon: Wallet },
  { href: '/dashboard/receipts', label: 'Receipts', icon: ReceiptText },
];

const PUBLIC_NAV = [
  { href: '/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/manifest', label: 'Model manifest', icon: ListTree },
  { href: '/docs', label: 'Docs', icon: BookOpen },
];

export function WorkspaceShell({
  section,
  title,
  lede,
  children,
  composer,
}: {
  section: string;
  title?: string;
  lede?: string;
  children: ReactNode;
  composer?: ReactNode;
  /** Kept for callers from the earlier layout; every page now uses the full width. */
  wide?: boolean;
}) {
  const pathname = usePathname();
  const active = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname === href || pathname.startsWith(`${href}/`);
  const onChat = active('/dashboard/chat');
  return (
    <div className="ws">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="ws-side">
        <Wordmark href="/" />
        <nav className="ws-nav" aria-label="Workspace">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined}>
              <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
              {label}
            </Link>
          ))}
          <hr />
          {PUBLIC_NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href}>
              <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="ws-side-spacer" />
        <div className="promo">
          <Photo src="/mascot/headphones.jpg" alt="" width={640} height={640} />
          <strong>
            Your key.
            <br />
            Your voice.
          </strong>
          {!onChat && (
            <Link className="btn btn-primary btn-small" href="/dashboard/chat">
              <MessageSquare size={16} aria-hidden="true" /> Open chat
            </Link>
          )}
        </div>
        <Status />
      </aside>

      <div className="ws-body">
        <header className="ws-top">
          <div className="crumbs">
            <Link href="/dashboard" className="crumbs-root">
              Workspace
            </Link>
            <span className="crumbs-root" aria-hidden="true">
              /
            </span>
            <strong>{section}</strong>
          </div>
          <div className="ws-top-right">
            <AdultsOnly compact />
            <Purse />
            <Link className="btn btn-ghost btn-small ws-top-docs" href="/docs">
              <BookOpen size={16} aria-hidden="true" />
              <span className="btn-label">Documentation</span>
            </Link>
            {!onChat && (
              <Link className="btn btn-primary btn-small" href="/dashboard/chat">
                <MessageSquare size={16} aria-hidden="true" />
                <span className="btn-label">Open chat</span>
              </Link>
            )}
          </div>
        </header>
        <main id="main" tabIndex={-1} className={composer ? 'ws-main ws-main-chat' : 'ws-main'}>
          <DemoNotice />
          {title && (
            <div className="ws-head">
              <h1>{title}</h1>
              {lede && <p>{lede}</p>}
            </div>
          )}
          {children}
        </main>
        {composer ? (
          <div className="ws-composer">{composer}</div>
        ) : (
          <footer className="ws-foot">
            <AdultsOnly />
            <span>No refusals for legal adult use. The floor stays on.</span>
            <VeniceBadge />
            <span className="spacer" />
            <span>Private by design.</span>
          </footer>
        )}
      </div>
    </div>
  );
}

function Status() {
  const { ready, key, demo } = useAnonymo();
  if (!ready) return <div className="ws-status" aria-hidden="true" />;
  return (
    <div className="ws-status">
      <span className={key ? 'dot' : 'dot dot-off'} aria-hidden="true" />
      {key ? (demo ? 'Demo key connected' : 'API key connected') : 'No key on this device'}
    </div>
  );
}

function Purse() {
  const { ready, key, client, balanceVersion } = useAnonymo();
  const [available, setAvailable] = useState<number | null>(null);
  useEffect(() => {
    if (!ready || !key) return;
    const controller = new AbortController();
    client.balance(controller.signal).then(
      (b) => setAvailable(usdToMusd(b.available_usd)),
      () => setAvailable(null),
    );
    return () => controller.abort();
  }, [ready, key, client, balanceVersion]);
  if (!ready) return <span className="ws-purse" aria-hidden="true" />;
  if (!key)
    return (
      <Link className="ws-purse" href="/dashboard/key">
        <span className="dot dot-off" aria-hidden="true" />
        Create a key
      </Link>
    );
  return (
    <Link className="ws-purse" href="/dashboard/funds" title={available === 0 ? 'No credit left. Add funds to chat.' : undefined}>
      <span className={available === null ? 'dot dot-off' : available === 0 ? 'dot dot-low' : 'dot'} aria-hidden="true" />
      <span className="sr-only">Balance: </span>
      {available === null ? '—' : formatUsd(available)}
    </Link>
  );
}
