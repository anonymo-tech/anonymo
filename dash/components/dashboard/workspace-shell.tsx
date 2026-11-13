'use client';

// The workspace frame, kept from Conclave's layout: a top bar (section on the left, wordmark in the middle, purse on
// the right), a centred thread, and a floating dock with the tools on the left and the composer on the right.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ChartBar, Drama, KeyRound, ListTree, MessageSquare, Plug, ReceiptText, Wallet } from 'lucide-react';
import { useAnonymo } from '../anonymo-provider';
import { AdultsOnly, VeniceBadge, Wordmark } from '../brand';
import { DemoNotice } from '../demo-notice';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';

const NAV = [
  { href: '/dashboard', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard/key', label: 'Key', icon: KeyRound },
  { href: '/dashboard/funds', label: 'Balance & deposits', icon: Wallet },
  { href: '/dashboard/receipts', label: 'Receipts', icon: ReceiptText },
  { href: '/dashboard/characters', label: 'Characters', icon: Drama },
  { href: '/dashboard/presets', label: 'Presets', icon: Plug },
  { href: '/leaderboard', label: 'Refusal leaderboard', icon: ChartBar },
  { href: '/manifest', label: 'Model manifest', icon: ListTree },
];

export function WorkspaceShell({
  section,
  children,
  composer,
  wide = false,
}: {
  section: string;
  children: ReactNode;
  composer?: ReactNode;
  wide?: boolean;
}) {
  const pathname = usePathname();
  const active = (href: string) =>
    href === '/dashboard' ? pathname === '/dashboard' : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <div className="ws">
      <header className="ws-top">
        <div className="ws-top-left">
          <span className="ws-section">{section}</span>
        </div>
        <Wordmark href="/" />
        <div className="ws-top-right">
          <AdultsOnly compact />
          <Purse />
        </div>
      </header>
      <DemoNotice />
      <main className={wide ? 'ws-main ws-main-wide' : 'ws-main'}>{children}</main>
      {!composer && (
        <footer className="ws-foot">
          <AdultsOnly />
          <span>No refusals for legal adult use. The floor stays on.</span>
          <VeniceBadge />
        </footer>
      )}
      <div className={composer ? 'dock' : 'dock dock-compact'}>
        <nav className="dock-nav" aria-label="Workspace">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined} aria-label={label}>
              <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
              <span className="tip" aria-hidden="true">
                {label}
              </span>
            </Link>
          ))}
        </nav>
        {composer}
      </div>
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
    <Link className="ws-purse" href="/dashboard/funds" aria-label="Balance">
      <span className="dot" aria-hidden="true" />
      {available === null ? '—' : formatUsd(available)}
    </Link>
  );
}
