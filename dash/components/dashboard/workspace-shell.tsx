'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AudioLines,
  Archive,
  BarChart3,
  BookOpen,
  ChevronRight,
  Columns3,
  Drama,
  Ellipsis,
  Headphones,
  IdCard,
  ImageIcon,
  Images,
  KeyRound,
  LayoutGrid,
  ListTree,
  MessageSquare,
  MessageCircleQuestion,
  PackageOpen,
  Link2,
  Plug,
  ShieldCheck,
  ReceiptText,
  Rocket,
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
import { VaultMemorySync } from './vault-memory-state';
import { WipeDevice } from './chat-history';
import { useVanishWorkspace } from './panic-key';
import { VaultTopBar } from './vault-controls';
import { updateOn, type UpdateId } from '@/lib/anonymo/updates';
import { formatUsdAmount } from '@/lib/anonymo/money';

type Destination = {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  feature?: UpdateId;
};
const overview = { href: '/dashboard', label: 'Overview', icon: LayoutGrid };
const chat = { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare };
const funds = { href: '/dashboard/funds', label: 'Balance', icon: Wallet };
const shortcuts = [overview, chat, funds];
const folds = ['more', 'developers'] as const;
type Fold = (typeof folds)[number];
const groups: { title: string; fold?: Fold; links: Destination[] }[] = [
  {
    title: 'Workspace',
    links: [
      overview,
      chat,
      { href: '/dashboard/ask', label: 'Ask Mo', icon: MessageCircleQuestion, feature: 'askmo' },
      { href: '/dashboard/characters', label: 'Characters', icon: Drama },
      { href: '/dashboard/key', label: 'API key', icon: KeyRound },
      funds,
      { href: '/dashboard/receipts', label: 'History', icon: ReceiptText },
    ],
  },
  {
    title: 'More',
    fold: 'more',
    links: [
      { href: '/dashboard/story', label: 'Story Studio', icon: BookOpen, feature: 'story' },
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
      { href: '/dashboard/move-in', label: 'Move in', icon: PackageOpen, feature: 'movein' },
      { href: '/dashboard/memory', label: 'Memory', icon: Archive, feature: 'vaultsync' },
      { href: '/dashboard/about-you', label: 'About you', icon: IdCard, feature: 'aboutyou' },
      { href: '/dashboard/ventures', label: 'Ventures', icon: Rocket, feature: 'ventures' },
      { href: '/dashboard/tickets', label: 'Tickets', icon: Ticket, feature: 'tickets' },
      {
        href: '/dashboard/usage',
        label: 'Usage & limits',
        icon: BarChart3,
        feature: 'usage',
      },
      { href: '/dashboard/wallet-review', label: 'Wallet request', icon: ShieldCheck, feature: 'walletreview' },
    ],
  },
  {
    title: 'For developers',
    fold: 'developers',
    links: [
      { href: '/dashboard/presets', label: 'Frontend presets', icon: Plug },
      { href: '/dashboard/connect', label: 'Pair a coding tool', icon: Link2, feature: 'connect' },
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
    path === href || (path === '/dashboard/move-in' && href === '/dashboard/lifeboat') || (href !== overview.href && path.startsWith(href + '/'))
  );
}

function useNavGroups(pathname: string) {
  const [preferences, setPreferences] = useState<Partial<Record<Fold, boolean>>>({});
  const [foldedHere, setFoldedHere] = useState<Fold | null>(null);

  useEffect(() => {
    const saved: Partial<Record<Fold, boolean>> = {};
    try {
      for (const fold of folds) {
        saved[fold] = localStorage.getItem(`anonymo:workspace-nav:${fold}`) === 'open';
      }
    } catch {
      // The menu still works when browser storage is blocked.
    }
    setPreferences(saved);
  }, []);

  // Reopen the current page's group on navigation without changing the saved choice.
  useEffect(() => setFoldedHere(null), [pathname]);

  return {
    isOpen: (fold: Fold, active: boolean) => !!preferences[fold] || (active && foldedHere !== fold),
    setOpen(fold: Fold, open: boolean, active: boolean) {
      setPreferences((previous) => ({ ...previous, [fold]: open }));
      if (active) setFoldedHere(open ? null : fold);
      try {
        localStorage.setItem(`anonymo:workspace-nav:${fold}`, open ? 'open' : 'closed');
      } catch {
        // Keep the choice in memory for this page.
      }
    },
  };
}

function WorkspaceNav({
  pathname,
  demo,
  navGroups,
  close,
}: {
  pathname: string;
  demo: boolean;
  navGroups: ReturnType<typeof useNavGroups>;
  close?: (href: string) => void;
}) {
  return (
    <nav className="ws-nav" aria-label="Workspace">
      {groups.map(({ title, fold, links }) => {
        const visible = links
          .filter((item) => !close || !shortcuts.some((shortcut) => shortcut.href === item.href))
          .filter((item) => !item.feature || updateOn(item.feature, demo))
          .map((item) => item.feature === 'movein' && updateOn('lifeboat', demo)
            ? { ...item, href: '/dashboard/lifeboat', label: 'Lifeboat' }
            : item);
        if (!visible.length) return null;
        const items = visible.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={matches(pathname, href) ? 'page' : undefined}
            replace={!!close}
            onClick={(event) => {
              if (!close || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              if (href === pathname) event.preventDefault();
              close(href);
            }}
          >
            <Icon size={16} strokeWidth={1.65} aria-hidden="true" />
            {label}
          </Link>
        ));
        if (!fold) {
          return (
            <div className="nav-group" key={title}>
              <span className="nav-label">{title}</span>
              {items}
            </div>
          );
        }
        const active = visible.some(({ href }) => matches(pathname, href));
        const open = navGroups.isOpen(fold, active);
        return (
          <details
            className="nav-fold"
            key={fold}
            open={open}
            onToggle={(event) => {
              const next = event.currentTarget.open;
              if (next !== open) navGroups.setOpen(fold, next, active);
            }}
          >
            <summary className="nav-label">
              {title}
              <ChevronRight size={13} aria-hidden="true" />
            </summary>
            <div className="nav-group">{items}</div>
          </details>
        );
      })}
    </nav>
  );
}

function MobileNav({ pathname, demo, navGroups }: {
  pathname: string;
  demo: boolean;
  navGroups: ReturnType<typeof useNavGroups>;
}) {
  const menu = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const followingLink = useRef(false);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 901px)');
    const resize = () => {
      if (desktop.matches) menu.current?.close();
    };
    const restoreMenu = () => {
      if (!desktop.matches && history.state?.workspaceMenu === pathname) {
        if (!menu.current?.open) menu.current?.showModal();
        setOpen(true);
      } else {
        menu.current?.close();
        setOpen(false);
      }
    };
    restoreMenu();
    window.addEventListener('popstate', restoreMenu);
    desktop.addEventListener('change', resize);
    return () => {
      window.removeEventListener('popstate', restoreMenu);
      desktop.removeEventListener('change', resize);
    };
  }, [pathname]);
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
            history.pushState({ workspaceMenu: pathname }, '', window.location.href);
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
        onClose={() => {
          setOpen(false);
          if (!followingLink.current && history.state?.workspaceMenu === pathname) history.back();
          followingLink.current = false;
        }}
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
            navGroups={navGroups}
            close={(href) => {
              followingLink.current = href !== pathname;
              menu.current?.close();
            }}
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
  const navGroups = useNavGroups(pathname);
  const inFunds = pathname === '/dashboard/funds';
  const { ready, demo, key } = useAnonymo();
  if (useVanishWorkspace()) return null;
  return (
    <div className="ws">
      {ready && updateOn('vaultsync', demo) && <VaultMemorySync demo={demo} />}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="ws-side">
        <Wordmark href="/" />
        <WorkspaceNav pathname={pathname} demo={ready && demo} navGroups={navGroups} />
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
            {!inFunds && <ContractAddressChip />}
            <AdultsOnly compact />
            {ready && key && !inFunds && <Purse />}
            {ready && updateOn('vault', demo) && <VaultTopBar />}
            {ready && (updateOn('history', demo) || updateOn('vault', demo) || updateOn('faces', demo) || updateOn('aboutyou', demo)) && <WipeDevice />}
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
      <MobileNav pathname={pathname} demo={ready && demo} navGroups={navGroups} />
    </div>
  );
}

function Purse() {
  const { balance } = useAnonymo();
  return (
    <Link className="ws-purse" href="/dashboard/funds">
      <Wallet size={15} aria-hidden="true" />
      <span className="sr-only">Balance </span>
      {balance === null ? 'Unavailable' : formatUsdAmount(balance.available_usd)}
    </Link>
  );
}
