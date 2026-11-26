'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Ellipsis, Wallet, X } from 'lucide-react';
import { useAnonymo } from '../anonymo-provider';
import { AdultsOnly, VeniceBadge, Wordmark } from '../brand';
import { DemoNotice } from '../demo-notice';
import { VaultMemorySync } from './vault-memory-state';
import { WipeDevice } from './chat-history';
import { useVanishWorkspace } from './panic-key';
import { VaultTopBar } from './vault-controls';
import { updateOn } from '@/lib/anonymo/updates';
import { formatUsdAmount } from '@/lib/anonymo/money';
import { setupReturn } from '@/lib/anonymo/setup-return';
import {
  account,
  accountTabs,
  area,
  available,
  characters,
  chat,
  extras,
  settings,
  settingsTabs,
  sidebarCurrent,
  tabCurrent,
  tools,
  type Destination,
} from './workspace-sections';

const shortcuts = [chat, characters, account];
const folds = ['more'] as const;
type Fold = (typeof folds)[number];

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
  const listed = (links: Destination[]) => available(links, demo)
    .filter((item) => !close || !shortcuts.some((shortcut) => shortcut.href === item.href));
  const link = ({ href, label, icon: Icon }: Destination) => (
    <Link
      key={href}
      href={href}
      aria-current={sidebarCurrent(pathname, href) ? 'page' : undefined}
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
  );
  const main = listed(tools);
  const more = listed(extras);
  const active = more.some(({ href }) => sidebarCurrent(pathname, href));
  const open = navGroups.isOpen('more', active);
  return (
    <nav className="ws-nav" aria-label="Workspace">
      {main.length > 0 && <div className="nav-group">{main.map((item) => link(item))}</div>}
      {more.length > 0 && (
        <details
          className="nav-fold"
          open={open}
          onToggle={(event) => {
            const next = event.currentTarget.open;
            if (next !== open) navGroups.setOpen('more', next, active);
          }}
        >
          <summary className="nav-label">
            More
            <ChevronRight size={13} aria-hidden="true" />
          </summary>
          <div className="nav-group">{more.map((item) => link(item))}</div>
        </details>
      )}
      <div className="nav-group nav-foot">
        {!close && link(account)}
        {link(settings)}
      </div>
    </nav>
  );
}

/** The tab row shared by the pages of one area, or the setup steps when a tool sent someone here to get set up. */
function AreaTabs({ pathname, demo }: { pathname: string; demo: boolean }) {
  const target = setupReturn(useSearchParams().get('returnTo'));
  const { key } = useAnonymo();
  const which = area(pathname);
  if (target && (pathname === '/dashboard/key' || pathname === '/dashboard/funds')) {
    const steps = [
      { label: 'Your key', done: !!key, here: pathname === '/dashboard/key' },
      ...(target.needsCredit ? [{ label: 'Add funds', done: false, here: pathname === '/dashboard/funds' }] : []),
      { label: target.href.split('?')[0] === '/dashboard/chat' ? 'Back to chat' : `Back to ${target.label}`, done: false, here: false },
    ];
    return (
      <ol className="ws-steps" aria-label="Setup">
        {steps.map((step, i) => (
          <li key={step.label} aria-current={step.here ? 'step' : undefined} data-done={step.done && !step.here}>
            <span className="ws-step-dot" aria-hidden="true">{step.done && !step.here ? <Check size={12} /> : i + 1}</span>
            {step.label}
          </li>
        ))}
      </ol>
    );
  }
  if (!which) return null;
  const tabs = available(which === 'account' ? accountTabs : settingsTabs, demo);
  return (
    <nav className="ws-tabs" aria-label={which === 'account' ? 'Account' : 'Settings'}>
      {tabs.map(({ href, label }) => (
        <Link key={href} href={href} aria-current={tabCurrent(pathname, href) ? 'page' : undefined}>
          {label}
        </Link>
      ))}
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
            aria-current={sidebarCurrent(pathname, href) ? 'page' : undefined}
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
            !shortcuts.some((item) => sidebarCurrent(pathname, item.href)) || open
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
  const inAccount = area(pathname) === 'account';
  const group = area(pathname);
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
            {group && (
              <>
                <Link href={group === 'account' ? account.href : settings.href}>{group === 'account' ? 'Account' : 'Settings'}</Link>
                <span aria-hidden="true">/</span>
              </>
            )}
            <span>{section}</span>
          </div>
          <span className="ws-mobile-brand">
            <Wordmark href="/" />
          </span>
          <div className="ws-top-right">
            <AdultsOnly compact />
            {ready && key && !inAccount && <Purse />}
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
          <Suspense fallback={null}>
            <AreaTabs pathname={pathname} demo={ready && demo} />
          </Suspense>
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
