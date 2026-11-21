'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AudioLines,
  BarChart3,
  BookOpen,
  Columns3,
  Drama,
  Ellipsis,
  Headphones,
  ImageIcon,
  Images,
  KeyRound,
  LayoutGrid,
  ListTree,
  MessageSquare,
  PackageOpen,
  Plug,
  ReceiptText,
  Ticket,
  Trophy,
  Video,
  Wallet,
  X,
} from 'lucide-react';
import { useAnonymo } from '../anonymo-provider';
import { AdultsOnly, VeniceBadge, Wordmark } from '../brand';
import { DemoNotice } from '../demo-notice';
import { ContractAddressChip } from '../contract-address';
import { WipeDevice } from './chat-history';
import { useVanishWorkspace } from './panic-key';
import { VaultTopBar } from './vault-controls';
import { updateOn, type UpdateId } from '@/lib/anonymo/updates';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';

type Destination = {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  feature?: UpdateId;
};
const overview = { href: '/dashboard', label: 'Overview', icon: LayoutGrid };
const chat = { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare };
const funds = { href: '/dashboard/funds', label: 'Funds', icon: Wallet };
const shortcuts = [overview, chat, funds];
const groups: { title: string; links: Destination[] }[] = [
  {
    title: 'Workspace',
    links: [
      overview,
      chat,
      { href: '/dashboard/call', label: 'Night Call', icon: Headphones, feature: 'voice' },
      { href: '/dashboard/side-by-side', label: 'Side by side', icon: Columns3, feature: 'sidebyside' },
      {
        href: '/dashboard/images',
        label: 'Image studio',
        icon: ImageIcon,
        feature: 'images',
      },
      { href: '/dashboard/video', label: 'Video studio', icon: Video, feature: 'video' },
      { href: '/dashboard/library', label: 'Library', icon: Images, feature: 'vault' },
      { href: '/dashboard/characters', label: 'Characters', icon: Drama },
      { href: '/dashboard/move-in', label: 'Move in', icon: PackageOpen, feature: 'movein' },
    ],
  },
  {
    title: 'Account',
    links: [
      { href: '/dashboard/key', label: 'API key', icon: KeyRound },
      funds,
      { href: '/dashboard/tickets', label: 'Tickets', icon: Ticket, feature: 'tickets' },
      {
        href: '/dashboard/usage',
        label: 'Usage & limits',
        icon: BarChart3,
        feature: 'usage',
      },
      { href: '/dashboard/receipts', label: 'Receipts', icon: ReceiptText },
    ],
  },
  {
    title: 'Resources',
    links: [
      { href: '/dashboard/presets', label: 'Frontend presets', icon: Plug },
      { href: '/manifest', label: 'Model manifest', icon: ListTree },
      { href: '/leaderboard', label: 'Leaderboard', icon: Trophy },
      { href: '/docs', label: 'Docs', icon: BookOpen },
      {
        href: '/status',
        label: 'Service status',
        icon: AudioLines,
        feature: 'status',
      },
    ],
  },
];

function matches(path: string, href: string) {
  return (
    path === href || (href !== overview.href && path.startsWith(href + '/'))
  );
}

function WorkspaceNav({
  pathname,
  demo,
  close,
}: {
  pathname: string;
  demo: boolean;
  close?: () => void;
}) {
  return (
    <nav className="ws-nav" aria-label="Workspace">
      {groups.map(({ title, links }) => (
        <div className="nav-group" key={title}>
          <span className="nav-label">{title}</span>
          {links
            .filter((item) => !item.feature || updateOn(item.feature, demo))
            .map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={matches(pathname, href) ? 'page' : undefined}
                onClick={close}
              >
                <Icon size={16} strokeWidth={1.65} aria-hidden="true" />
                {label}
              </Link>
            ))}
        </div>
      ))}
    </nav>
  );
}

function MobileNav({ pathname, demo }: { pathname: string; demo: boolean }) {
  const menu = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 901px)');
    const resize = () => {
      if (desktop.matches) menu.current?.close();
    };
    desktop.addEventListener('change', resize);
    return () => desktop.removeEventListener('change', resize);
  }, []);
  return (
    <>
      <nav className="ws-mobile-nav" aria-label="Quick navigation">
        {shortcuts.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={matches(pathname, href) ? 'page' : undefined}
          >
            <Icon size={18} aria-hidden="true" />
            {label}
          </Link>
        ))}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-controls="workspace-menu"
          aria-expanded={open}
          data-active={
            !shortcuts.some((item) => matches(pathname, item.href)) || open
          }
          onClick={() => {
            menu.current?.showModal();
            setOpen(true);
          }}
        >
          <Ellipsis size={18} aria-hidden="true" />
          More
        </button>
      </nav>
      <dialog
        ref={menu}
        id="workspace-menu"
        className="ws-sheet"
        aria-labelledby="menu-title"
        onClose={() => setOpen(false)}
        closedby="any"
      >
        <div className="ws-sheet-inner">
          <header>
            <h2 id="menu-title">Workspace menu</h2>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="Close menu"
              onClick={() => menu.current?.close()}
            >
              <X size={20} />
            </button>
          </header>
          <WorkspaceNav
            pathname={pathname}
            demo={demo}
            close={() => menu.current?.close()}
          />
        </div>
      </dialog>
    </>
  );
}

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
  wide?: boolean;
}) {
  const pathname = usePathname();
  const { ready, demo, key } = useAnonymo();
  if (useVanishWorkspace()) return null;
  return (
    <div className="ws">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="ws-side">
        <Wordmark href="/" />
        <WorkspaceNav pathname={pathname} demo={ready && demo} />
      </aside>
      <div className="ws-body">
        <header className="ws-top">
          <div className="ws-context">
            <LayoutGrid size={15} aria-hidden="true" />
            <Link href="/dashboard">Workspace</Link>
            {section !== 'Overview' && (
              <>
                <span aria-hidden="true">/</span>
                <span>{section}</span>
              </>
            )}
          </div>
          <span className="ws-mobile-brand">
            <Wordmark href="/" />
          </span>
          <div className="ws-top-right">
            <ContractAddressChip />
            <AdultsOnly compact />
            {ready && key && <Purse key={key} />}
            {ready && updateOn('vault', demo) && <VaultTopBar />}
            {ready && (updateOn('history', demo) || updateOn('vault', demo) || updateOn('faces', demo)) && <WipeDevice />}
          </div>
        </header>
        <main
          id="main"
          tabIndex={-1}
          className={composer ? 'ws-main ws-main-chat' : 'ws-main'}
        >
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
            <VeniceBadge />
          </footer>
        )}
      </div>
      <MobileNav pathname={pathname} demo={ready && demo} />
    </div>
  );
}

function Purse() {
  const { client, balanceVersion } = useAnonymo();
  const [available, setAvailable] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client.balance(controller.signal).then(
      (b) => {
        if (!controller.signal.aborted)
          setAvailable(usdToMusd(b.available_usd));
      },
      () => {
        if (!controller.signal.aborted) setAvailable(null);
      },
    );
    return () => controller.abort();
  }, [client, balanceVersion]);
  return (
    <Link className="ws-purse" href="/dashboard/funds">
      <Wallet size={15} aria-hidden="true" />
      <span className="sr-only">Balance </span>
      {available === null ? 'Unavailable' : formatUsd(available)}
    </Link>
  );
}
