'use client';

// The page a ticket opens (update "tickets"). The ticket's key arrives in the link's fragment, which the browser keeps
// to itself, so no server ever sees it. This page reads the key, takes it out of the address bar at once, and holds it
// in memory only, until the person chooses to start chatting. Then it is kept the way any key is (lib/anonymo/key-store).
// The key is never logged, never put in a path or a query, and nothing on this page loads from another origin.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnonymo } from './anonymo-provider';
import { CopyButton } from './copy-button';
import { keyRefusal, useTicketClient } from './dashboard/ticket-client';
import { TicketPrinter } from './dashboard/ticket-printer';
import { describeError } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { maskKey } from '@/lib/anonymo/key-store';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';
import { adultStore } from '@/lib/anonymo/prefs';
import { ticketDate } from '@/lib/anonymo/ticket-art';
import { keyFromFragment } from '@/lib/anonymo/tickets';
import { updateOn } from '@/lib/anonymo/updates';
import './dashboard/tickets.css';

/**
 * Reads the key from the address bar's fragment and removes the fragment, whatever it held, so the key does not stay
 * in the address bar, in this tab's history entry or in a bookmark made later.
 */
function takeKeyFromAddress(): string | null {
  const { hash, pathname, search } = window.location;
  if (!hash) return null;
  const key = keyFromFragment(hash);
  try {
    window.history.replaceState(window.history.state, '', pathname + search);
  } catch {
    // the address could not be rewritten; the key is still only in this browser
  }
  return key;
}

type Found =
  | { state: 'checking' }
  | { state: 'ok'; leftMusd: number; expiresAt: string | null }
  | { state: 'empty'; funded: boolean }
  | { state: 'held' }
  | { state: 'expired' }
  | { state: 'unknown' }
  | { state: 'error'; message: string };

export function TicketClaim() {
  const { ready, demo } = useAnonymo();
  // `key` is undefined until the address has been read, and null when it held no ticket. `opened` counts the links
  // opened in this tab, so opening one again starts the page afresh.
  const [link, setLink] = useState<{ key: string | null | undefined; opened: number }>({ key: undefined, opened: 0 });
  const taken = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Read once, even if this effect runs twice: the second time the fragment is already gone.
    if (taken.current === undefined) taken.current = takeKeyFromAddress();
    setLink((was) => ({ key: taken.current, opened: was.opened }));
    // A ticket link pasted into this tab changes only the fragment: take that one too.
    const onHash = () => {
      if (!window.location.hash) return;
      taken.current = takeKeyFromAddress();
      setLink((was) => ({ key: taken.current, opened: was.opened + 1 }));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const ticketKey = link.key;

  if (!ready || ticketKey === undefined) return null;
  if (!updateOn('tickets', demo))
    return (
      <div className="notice row">
        <span style={{ flex: 1 }}>This isn’t switched on yet. It’s coming soon.</span>
        <Link className="btn btn-small" href="/">
          Back to Anonymo
        </Link>
      </div>
    );
  if (ticketKey === null)
    return (
      <Shell printer={null} title="No ticket here.">
        <p className="tk-claim-lede">
          A ticket link ends in <code>#k=</code> and a long key. Open the whole link you were given, or scan the code on the ticket.
        </p>
        <Elsewhere />
      </Shell>
    );
  return <Opened key={`${link.opened}:${ticketKey}`} ticketKey={ticketKey} />;
}

function Opened({ ticketKey }: { ticketKey: string }) {
  const { demo, key: deviceKey, client: deviceClient, setKey } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const clientFor = useTicketClient();
  const router = useRouter();
  const [found, setFound] = useState<Found>({ state: 'checking' });
  const [round, setRound] = useState(0);
  const [remember, setRemember] = useState(true);
  const [kept, setKept] = useState(false);
  const [deviceLeft, setDeviceLeft] = useState<number | null>(null);
  const other = deviceKey !== null && deviceKey !== ticketKey;

  // Nothing is asked of the gateway until the 18+ notice has been answered.
  useEffect(() => {
    if (!adult) return;
    const controller = new AbortController();
    const client = clientFor(ticketKey);
    const done = (next: Found) => !controller.signal.aborted && setFound(next);
    void (async () => {
      try {
        const balance = await client.balance(controller.signal);
        const left = usdToMusd(balance.available_usd);
        if (left > 0) {
          // The expiry is one of the key's caps. If it cannot be read the ticket still works; it is just not shown.
          const expiresAt = await client.keyInfo().then(
            (info) => info.caps.expires_at,
            () => null,
          );
          return done({ state: 'ok', leftMusd: left, expiresAt });
        }
        const rows = (await client.deposits(controller.signal)).data;
        const funded = rows.some((r) => r.status === 'credited');
        done(!funded && rows.some((r) => r.status === 'held') ? { state: 'held' } : { state: 'empty', funded });
      } catch (e) {
        const refusal = keyRefusal(e);
        done(refusal === 'key_expired' ? { state: 'expired' } : refusal === 'key_unknown' ? { state: 'unknown' } : { state: 'error', message: describeError(e) });
      }
    })();
    return () => controller.abort();
  }, [adult, clientFor, ticketKey, round]);

  // What the key already on this device holds, so the choice below is an informed one.
  useEffect(() => {
    if (!adult || !other) return;
    const controller = new AbortController();
    deviceClient.balance(controller.signal).then(
      (b) => !controller.signal.aborted && setDeviceLeft(usdToMusd(b.available_usd)),
      () => undefined,
    );
    return () => controller.abort();
  }, [adult, other, deviceClient]);

  const again = useCallback(() => {
    setFound({ state: 'checking' });
    setRound((r) => r + 1);
  }, []);

  function start() {
    setKey(ticketKey, remember);
    router.push('/dashboard/chat');
  }

  if (found.state === 'checking')
    return (
      <Shell printer={null} title="Checking your ticket…">
        <output className="tk-claim-lede">One moment.</output>
      </Shell>
    );
  if (found.state === 'expired')
    return (
      <Shell printer={null} title="This ticket has expired.">
        <p className="tk-claim-lede">Its date has passed, so its key no longer works. Ask whoever gave it to you for a new one, or get a key of your own.</p>
        <Elsewhere />
      </Shell>
    );
  if (found.state === 'unknown')
    return (
      <Shell printer={null} title="This ticket isn’t valid.">
        <p className="tk-claim-lede">Anonymo does not know its key. Check that the whole link came through, up to its last character.</p>
        <Elsewhere />
      </Shell>
    );
  if (found.state === 'held')
    return (
      <Shell printer={null} title="This ticket is on hold.">
        <p className="tk-claim-lede">Its payment arrived but is being held for review, so it can’t be used yet.</p>
        <div className="row">
          <button type="button" className="btn" onClick={again}>
            Check again
          </button>
        </div>
      </Shell>
    );
  if (found.state === 'empty')
    return found.funded ? (
      <Shell printer={null} title="This ticket is used up.">
        <p className="tk-claim-lede">Its credit has been spent or taken back, so there is nothing left on it.</p>
        <Elsewhere />
      </Shell>
    ) : (
      <Shell printer={null} title="This ticket has no credit yet.">
        <p className="tk-claim-lede">If it was made a moment ago, its payment may still be on the way. Try again in a minute.</p>
        <div className="row">
          <button type="button" className="btn" onClick={again}>
            Check again
          </button>
        </div>
      </Shell>
    );
  if (found.state === 'error')
    return (
      <Shell printer={null} title="The ticket couldn’t be checked.">
        <p className="tk-claim-lede">{found.message} The ticket itself is untouched.</p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={again}>
            Try again
          </button>
        </div>
      </Shell>
    );

  const amount = formatUsd(found.leftMusd);
  return (
    <Shell
      printer={{ amountMusd: found.leftMusd, expiresAt: found.expiresAt, link: null, stamp: 'VALID' }}
      title={
        <>
          Someone gave you <em>{amount}</em>. No account. No wallet.
        </>
      }
    >
      <p className="tk-claim-lede">
        It is credit to chat with on Anonymo, a private AI chat for adults. There is nothing to sign up for: the ticket is a key, and it
        is already paid for.
      </p>
      {deviceKey === ticketKey ? (
        <div className="tk-claim-box">
          <p>This ticket is already the key on this device.</p>
          <div className="row">
            <Link className="btn btn-primary btn-lg" href="/dashboard/chat">
              Open the chat
            </Link>
          </div>
        </div>
      ) : other && kept ? (
        <div className="tk-claim-box" role="status">
          <p>
            <strong>Nothing changed.</strong> Your own key is still the one on this device. The ticket still works: open its link in
            another browser or a private window to use it there.
          </p>
          <div className="row">
            <Link className="btn" href="/dashboard/chat">
              Go to the chat with your key
            </Link>
          </div>
        </div>
      ) : (
        <div className="tk-claim-box">
          {other && deviceKey && (
            <div className="notice notice-amber panel-stack">
              <p>
                <strong>This device already has a key</strong> (<span className="mono">{maskKey(deviceKey)}</span>
                {deviceLeft !== null && <>, with {formatUsd(deviceLeft)} on it</>}). Using the ticket here puts the ticket’s key in its
                place. Anonymo can’t show a key again, so if yours holds credit and you have no copy, copy it first.
              </p>
              <div className="row">
                <CopyButton text={deviceKey} label="Copy my current key" />
              </div>
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>
              Remember on this device
              <br />
              <span className="tk-claim-note">
                Keeps the ticket’s key in this browser, so it is still here tomorrow. Unticked, it lasts for this tab only. Either
                way the link you were given is the only other copy, so keep it somewhere safe.
              </span>
            </span>
          </label>
          <div className="row">
            <button type="button" className="btn btn-primary btn-lg" onClick={start}>
              {other ? 'Use the ticket on this device' : 'Start chatting'}
            </button>
            {other && (
              <button type="button" className="btn btn-lg" onClick={() => setKept(true)}>
                Keep my key
              </button>
            )}
          </div>
        </div>
      )}
      <ul className="tk-claim-facts">
        <li>
          <strong>{found.expiresAt ? `Good until ${ticketDate(found.expiresAt)}.` : 'No expiry date.'}</strong> It runs out sooner if the credit is spent.
        </li>
        <li>
          <strong>Zero retention.</strong> What you type and what comes back is not stored.
        </li>
        <li>
          <strong>It is credit to use, nothing else.</strong> It can’t be cashed out by you. Whoever gave it to you can take back what
          you have not spent.
        </li>
        <li>
          <strong>Adults only.</strong> 18 or older, like everything on Anonymo.
        </li>
      </ul>

      <p className="tk-claim-note">Anyone who has the link can spend this ticket. Don’t pass it on unless you mean to give it away.</p>
    </Shell>
  );
}

function Shell({ printer, title, children }: { printer: Parameters<typeof TicketPrinter>[0]['ticket']; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="tk-claim">
      <div className="tk-claim-text">
        <h1>{title}</h1>
        {children}
      </div>
      <TicketPrinter ticket={printer} feed={printer ? 'ticket' : 'none'} />
    </div>
  );
}

function Elsewhere() {
  return (
    <div className="row">
      <Link className="btn btn-primary" href="/dashboard/key">
        Get a key of your own
      </Link>
      <Link className="btn btn-ghost" href="/">
        What is Anonymo?
      </Link>
    </div>
  );
}
