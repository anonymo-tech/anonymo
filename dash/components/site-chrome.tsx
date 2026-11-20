'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdultsOnly, VeniceBadge, Wordmark } from './brand';
import { DemoNotice } from './demo-notice';
import { useAnonymo } from './anonymo-provider';
import { updateOn } from '@/lib/anonymo/updates';

const NAV = [
  { href: '/docs', label: 'Docs' },
  { href: '/presets', label: 'Presets' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/manifest', label: 'Manifest' },
];

/** Header and footer for the public pages (landing, docs, presets, manifest, leaderboard). */
export function PublicPage({ children, wide = false, bare = false }: { children: ReactNode; wide?: boolean; bare?: boolean }) {
  return (
    <div className="public">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <PublicHeader />
      <DemoNotice />
      {bare ? children : <main id="main" tabIndex={-1} className={wide ? 'public-main public-main-wide' : 'public-main'}>{children}</main>}
      <SiteFooter />
    </div>
  );
}

/** The public links, with Status when update "status" is on. */
function useNav() {
  const { ready, demo } = useAnonymo();
  return ready && updateOn('status', demo) ? [...NAV, { href: '/status', label: 'Status' }] : NAV;
}

export function PublicHeader() {
  const pathname = usePathname();
  const nav = useNav();
  return (
    <header className="public-head">
      <Wordmark />
      <nav aria-label="Public pages">
        {nav.map((item) => (
          <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
      <Link href="/dashboard" className="btn btn-outline btn-small btn-square public-head-cta">
        Open app
      </Link>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="foot-brand">
        <Wordmark />
        <span>Private by design.</span>
      </div>
      <div className="foot-col">
        <strong>Product</strong>
        <Link href="/dashboard/chat">Chat</Link>
        <Link href="/dashboard/characters">Characters</Link>
        <Link href="/presets">Presets</Link>
      </div>
      <div className="foot-col">
        <strong>Developers</strong>
        <Link href="/docs">API docs</Link>
        <Link href="/manifest">Model manifest</Link>
      </div>
      <div className="foot-col">
        <strong>Trust</strong>
        <Link href="/leaderboard">Refusal leaderboard</Link>
        <StatusLink />
        <Link href="/dashboard/receipts">Receipts</Link>
      </div>
      <div className="foot-note">
        <AdultsOnly />
        <VeniceBadge />
      </div>
      <div className="foot-legal">
        <span>No refusals for legal adult use. The floor stays on.</span>
        <span>No account, no email, no KYC.</span>
      </div>
    </footer>
  );
}

function StatusLink() {
  const { ready, demo } = useAnonymo();
  return ready && updateOn('status', demo) ? <Link href="/status">Status</Link> : null;
}
