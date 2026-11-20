'use client';

// The workspace home: the balance, the key on this device, the receipts this device has seen, and where to go next.

import { Photo } from '@/components/photo';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Drama,
  Eye,
  EyeOff,
  ListTree,
  Plug,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { maskKey } from '@/lib/anonymo/key-store';
import { API_BASE } from '@/lib/anonymo/config';
import { workspaceStage } from '@/lib/anonymo/workspace-guide';
import { formatUsdAmount, usdToMusd } from '@/lib/anonymo/money';
import type { Balance } from '@/lib/anonymo/types';

export function Overview() {
  const { ready, key } = useAnonymo();
  if (!ready)
    return (
      <output className="workspace-loading">
        Loading workspace…
      </output>
    );
  return <WorkspaceOverview key={key ?? 'new'} />;
}

function WorkspaceOverview() {
  const { key, client, receipts, balanceVersion } = useAnonymo();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [error, setError] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    client.balance(controller.signal).then(
      (b) => {
        if (controller.signal.aborted) return;
        setBalance(b);
        setError(false);
      },
      () => {
        if (!controller.signal.aborted) {
          setBalance(null);
          setError(true);
        }
      },
    );
    return () => controller.abort();
  }, [key, client, balanceVersion]);

  const stage = workspaceStage(
    !!key,
    balance ? usdToMusd(balance.available_usd) : null,
    receipts.length > 0,
  );
  const guide = <WorkspaceGuide stage={stage} error={error} />;
  if (!key)
    return (
      <>
        {guide}
        <Explore />
      </>
    );

  const usageOnly = balance?.usage_only_usd
    ? usdToMusd(balance.usage_only_usd)
    : 0;

  return (
    <>
      {guide}
      <div className="overview">
        <section className="card span-6" aria-labelledby="balance-title">
          <h2 id="balance-title">Available balance</h2>
          <div className="balance-line">
            <span className="big-num">
              {balance ? (
                formatUsdAmount(balance.available_usd)
              ) : error ? (
                '—'
              ) : (
                <span
                  className="skeleton"
                  style={{ width: 150, height: 40 }}
                  aria-label="Loading"
                />
              )}
            </span>
          </div>
          {balance && (
            <p className="faint">
              {usageOnly > 0 && (
                <>{formatUsdAmount(balance.usage_only_usd)} usage-only · </>
              )}
              {formatUsdAmount(balance.held_usd)} held for requests in flight
            </p>
          )}
          {stage !== 'funds' && (
            <Link className="link" href="/dashboard/funds">
              Manage funds
            </Link>
          )}
        </section>

        <section className="card span-6" aria-labelledby="key-title">
          <h2 id="key-title">Your API key</h2>
          <div className="key-field">
            <input
              className="input"
              readOnly
              value={shown ? key : maskKey(key)}
              aria-label="API key"
            />
            <button
              type="button"
              className="btn"
              onClick={() => setShown((s) => !s)}
              aria-label={shown ? 'Hide key' : 'Show key'}
            >
              {shown ? (
                <EyeOff size={17} aria-hidden="true" />
              ) : (
                <Eye size={17} aria-hidden="true" />
              )}
            </button>
            <CopyButton text={key} label="Copy" />
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <Link className="link" href="/dashboard/key">
              Manage key
            </Link>
          </div>
        </section>

        <section className="card span-12" aria-labelledby="recent-title">
          <header>
            <h2 id="recent-title">Recent receipts</h2>
            {receipts.length > 0 && (
              <Link className="link" href="/dashboard/receipts">
                View all receipts{' '}
                <ArrowRight
                  size={14}
                  aria-hidden="true"
                  style={{ verticalAlign: '-2px' }}
                />
              </Link>
            )}
          </header>
          {receipts.length === 0 ? (
            <p className="lede">Your first chat receipt will appear here.</p>
          ) : (
            <div
              className="table-wrap"
              style={{ border: 0, background: 'transparent' }}
            >
              <table className="data">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Model</th>
                    <th>Receipt</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.slice(0, 6).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className="row" style={{ gap: 8 }}>
                          <span className="dot" aria-hidden="true" /> Signed
                        </span>
                      </td>
                      <td className="mono">{r.model}</td>
                      <td>
                        <Link
                          className="hash"
                          href={`/dashboard/receipts/${encodeURIComponent(r.id)}`}
                        >
                          {r.id.length > 18
                            ? `${r.id.slice(0, 10)}…${r.id.slice(-6)}`
                            : r.id}
                        </Link>
                      </td>
                      <td className="faint">{timeAgo(r.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="faint row" style={{ gap: 8 }}>
            <ShieldCheck size={16} aria-hidden="true" /> Receipts hold ids,
            routes and costs only. No prompt or reply text is kept.
          </p>
        </section>
      </div>
    </>
  );
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(t).toLocaleDateString();
}

const GUIDE = {
  key: {
    title: 'Your private workspace',
    text: 'Connect an API key to pay for conversations and see what each answer cost.',
    action: 'Set up your key',
    href: '/dashboard/key',
  },
  funds: {
    title: 'Fund your key',
    text: 'Your key is connected. Check which deposit methods are available before starting a paid chat.',
    action: 'View funding options',
    href: '/dashboard/funds',
  },
  'first-chat': {
    title: 'Start your first chat',
    text: 'Your key has credit. Choose a model and send a message to get your first signed receipt.',
    action: 'Open chat',
    href: '/dashboard/chat',
  },
  returning: {
    title: 'Back to chat',
    text: 'Open your conversation or check the receipts from your recent requests below.',
    action: 'Open chat',
    href: '/dashboard/chat',
  },
  unknown: {
    title: 'Your workspace',
    text: 'Checking the available credit on your key…',
    action: 'View funds',
    href: '/dashboard/funds',
  },
} as const;

function WorkspaceGuide({
  stage,
  error,
}: {
  stage: keyof typeof GUIDE;
  error: boolean;
}) {
  const item = GUIDE[stage];
  const step = stage === 'key' ? 0 : stage === 'first-chat' ? 2 : 1;
  return (
    <section className="guide" aria-labelledby="guide-title">
      <div className="guide-cover">
        <Photo
          src="/mascot/pillow.jpg"
          alt=""
          width={1200}
          height={900}
          loading="eager"
        />
        <div className="guide-copy">
          <h1 id="guide-title">{item.title}</h1>
          <p>
            {error && stage === 'unknown'
              ? 'Your balance could not be loaded. Open Funds to check again.'
              : item.text}
          </p>
          <Link className="btn btn-primary guide-action" href={item.href}>
            {item.action}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </div>
      {stage !== 'returning' && stage !== 'unknown' && (
        <ol className="guide-steps" aria-label="Workspace setup">
          {['Connect a key', 'Add credit', 'Send a message'].map((label, i) => (
            <li
              key={label}
              data-state={i < step ? 'done' : i === step ? 'current' : 'later'}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="step-mark" aria-hidden="true">
                {i < step ? <Check size={13} /> : i + 1}
              </span>
              {i < step && <span className="sr-only">Complete: </span>}
              {label}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Explore() {
  const links = [
    {
      href: '/manifest',
      title: 'Model manifest',
      detail: 'See which models and routes are available.',
      icon: ListTree,
    },
    {
      href: '/dashboard/presets',
      title: 'Frontend presets',
      detail: 'Connect a chat app you already use.',
      icon: Plug,
    },
    {
      href: '/dashboard/characters',
      title: 'Characters',
      detail: 'Import a character card for your chats.',
      icon: Drama,
    },
  ];
  return (
    <section className="explore" aria-labelledby="explore-title">
      <h2 id="explore-title">Explore</h2>
      <div className="explore-links">
        {links.map(({ href, title, detail, icon: Icon }) => (
          <Link href={href} key={href}>
            <Icon size={19} aria-hidden="true" />
            <span>
              <strong>{title}</strong>
              <small>{detail}</small>
            </span>
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        ))}
      </div>
      {!API_BASE && (
        <Link className="link demo-chat-link" href="/dashboard/chat?demo=1">
          Try demo chat
        </Link>
      )}
    </section>
  );
}
