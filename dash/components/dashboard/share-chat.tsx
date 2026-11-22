'use client';

// Update "share": Sealed Share. The Share button in the chat and its dialog. The link is made in this browser
// (lib/anonymo/share.ts): nothing here talks to the gateway, and the chat is never sent anywhere.

import { Link2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CopyButton } from '../copy-button';
import type { Turn } from './chat-types';
import { VaultModal } from './vault-controls';
import {
  checkPassphrase,
  createShareLink,
  messagesFrom,
  newShareSecret,
  shareableTurns,
  titleFor,
  type ShareSecret,
  type SharedMessage,
} from '@/lib/anonymo/share';
import '../share.css';

export function ShareChat({ turns, disabled }: { turns: Turn[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ready = shareableTurns(turns).length > 0;
  return (
    <>
      <button
        type="button"
        className="tool"
        disabled={disabled || !ready}
        title={ready ? 'Share this chat as a sealed link' : 'Share works once a reply has finished'}
        onClick={() => setOpen(true)}
      >
        <Link2 size={14} aria-hidden="true" />
        Share
      </button>
      {open && <ShareDialog turns={turns} close={() => setOpen(false)} />}
    </>
  );
}

type Outcome =
  | { kind: 'link'; link: string; messages: number; total: number; passphrase: boolean }
  | { kind: 'too_long'; secret: ShareSecret; messages: SharedMessage[]; fitsFrom: number | null }
  | { kind: 'error'; message: string };

const excerpt = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 40 ? `${one.slice(0, 40).trimEnd()}…` : one || '(empty)';
};

function ShareDialog({ turns, close }: { turns: Turn[]; close: () => void }) {
  const shareable = useMemo(() => shareableTurns(turns), [turns]);
  const [title, setTitle] = useState(() => titleFor(turns));
  const [upTo, setUpTo] = useState(shareable.length);
  const [locked, setLocked] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const passphraseProblem = locked ? checkPassphrase(passphrase) : null;

  // Any change to what is shared makes the last link stale.
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOutcome(null);
  };

  async function seal(messages: SharedMessage[], secret: ShareSecret, total: number) {
    const made = await createShareLink(window.location.origin, title, messages, secret);
    if (made.ok) setOutcome({ kind: 'link', link: made.link, messages: made.messages, total, passphrase: secret.mode === 'passphrase' });
    else if (made.reason === 'too_long') setOutcome({ kind: 'too_long', secret, messages, fitsFrom: made.fitsFrom });
    else setOutcome({ kind: 'error', message: 'There is nothing to share yet.' });
  }

  async function create() {
    if (busy || passphraseProblem) return;
    setBusy(true);
    setOutcome(null);
    try {
      const messages = messagesFrom(shareable.slice(0, upTo));
      await seal(messages, await newShareSecret(locked ? passphrase : null), messages.length);
    } catch {
      setOutcome({ kind: 'error', message: 'This browser couldn’t make the link. Try again, or try another browser.' });
    } finally {
      setBusy(false);
    }
  }

  async function shareRecent(o: Extract<Outcome, { kind: 'too_long' }>) {
    if (busy || o.fitsFrom === null) return;
    setBusy(true);
    try {
      await seal(o.messages.slice(o.fitsFrom), o.secret, o.messages.length);
    } catch {
      setOutcome({ kind: 'error', message: 'This browser couldn’t make the link. Try again, or try another browser.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VaultModal title="Share this chat" close={close} busy={busy}>
      <div className="sh-dialog">
        <p className="sh-lede">
          The chat is sealed in this browser. The key is the part of the link after #, which browsers never send to a server, so
          Anonymo can’t read it.
        </p>
        <p className="sh-note">Images and attachments are left out. Only the messages, the model and the character name go in.</p>

        <label className="field">
          <span>Title</span>
          <input className="input" value={title} maxLength={120} onChange={(e) => change(setTitle)(e.target.value)} data-vault-focus />
        </label>

        {shareable.length > 1 && (
          <label className="field">
            <span>Share</span>
            <select className="select" value={upTo} onChange={(e) => change(setUpTo)(Number(e.target.value))}>
              <option value={shareable.length}>The whole chat</option>
              {shareable.slice(0, -1).map((t, i) => (
                <option key={t.id} value={i + 1}>
                  Up to message {i + 1}: {excerpt(t.prompt)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="checkbox">
          <input type="checkbox" checked={locked} onChange={(e) => change(setLocked)(e.target.checked)} />
          <span>Lock with a passphrase</span>
        </label>
        {locked && (
          <label className="field">
            <span>Passphrase</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => change(setPassphrase)(e.target.value)}
              aria-describedby="sh-passphrase-help"
            />
            <span id="sh-passphrase-help" className="sh-note">
              {passphraseProblem ?? 'The link won’t hold the key. Send the passphrase a different way. It can’t be recovered.'}
            </span>
          </label>
        )}

        {outcome?.kind === 'link' ? (
          <output className="sh-result">
            {outcome.messages < outcome.total && (
              <p className="sh-note">This link holds the most recent {outcome.messages} of {outcome.total} messages.</p>
            )}
            <label className="field">
              <span>Link</span>
              <input className="input mono" readOnly value={outcome.link} onFocus={(e) => e.target.select()} />
            </label>
            <div className="row">
              <CopyButton text={outcome.link} label="Copy link" className="btn-primary" />
            </div>
            <p className="sh-note">
              {outcome.passphrase ? 'Anyone with the link and the passphrase can read this chat.' : 'Anyone with the whole link can read this chat.'} A
              link can’t be taken back: Anonymo keeps no copy, so there is nothing to delete.
            </p>
          </output>
        ) : outcome?.kind === 'too_long' ? (
          <output className="notice notice-amber sh-result">
            {outcome.fitsFrom === null ? (
              <p>The last message alone is too long for a link. Choose an earlier message to share up to.</p>
            ) : (
              <>
                <p>
                  This chat is too long for one link. The most recent {outcome.messages.length - outcome.fitsFrom} of {outcome.messages.length}{' '}
                  messages fit.
                </p>
                <div className="row">
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => void shareRecent(outcome)}>
                    Share the most recent part
                  </button>
                </div>
              </>
            )}
          </output>
        ) : outcome?.kind === 'error' ? (
          <p className="notice notice-rose" role="alert">
            {outcome.message}
          </p>
        ) : null}

        {outcome?.kind !== 'link' && (
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || !!passphraseProblem} onClick={() => void create()}>
              {busy ? 'Sealing…' : 'Create link'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </VaultModal>
  );
}
