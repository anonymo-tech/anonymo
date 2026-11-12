import Link from 'next/link';
import type { ReactNode } from 'react';
import { AdultsOnly, VeniceBadge, Wordmark } from './brand';
import { DemoNotice } from './demo-notice';

const NAV = [
  { href: '/presets', label: 'Presets' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/manifest', label: 'Manifest' },
];

/** Header and footer for the public pages (landing, presets, manifest, leaderboard). */
export function PublicPage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="public">
      <header className="public-head">
        <Wordmark />
        <nav aria-label="Public pages">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
          <Link href="/dashboard" className="btn btn-primary btn-small">
            Open workspace
          </Link>
        </nav>
      </header>
      <DemoNotice />
      <main className={wide ? 'public-main public-main-wide' : 'public-main'}>{children}</main>
      <SiteFooter />
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <AdultsOnly />
      <span>No refusals for legal adult use. The floor stays on.</span>
      <span>No account, no email, no KYC.</span>
      <VeniceBadge />
    </footer>
  );
}
