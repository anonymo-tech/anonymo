'use client';

// The page a Sealed Share link opens (update "share"). The sealed chat and its key arrive in the link's fragment, which
// the browser keeps to itself, so no server ever sees them. The chat is opened here, in memory, and shown read-only.
// Nothing is saved, nothing is sent, and the chat is never added to this browser's own chats.

import Link from 'next/link';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useAnonymo } from './anonymo-provider';
import { needsPassphrase, openShareFragment, ShareLinkError, SHARE_ERROR_TEXT, type ShareErrorCode, type SharedChat } from '@/lib/anonymo/share';
import './share.css';

type View =
  | { state: 'reading' }
  | { state: 'opening' }
  | { state: 'locked'; wrong: boolean }
  | { state: 'error'; code: ShareErrorCode }
  | { state: 'open'; chat: SharedChat };

const codeOf = (e: unknown): ShareErrorCode => (e instanceof ShareLinkError ? e.code : 'garbled');

export function ShareView() {
  const { ready } = useAnonymo();
  const [fragment, setFragment] = useState<string | null>(null);
  const [view, setView] = useState<View>({ state: 'reading' });
  const round = useRef(0);

  useEffect(() => {
    const read = () => setFragment(window.location.hash);
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  // Opening a link always works: the switch decides who can make links, not who can read one they were sent.
  const on = ready;
  useEffect(() => {
    if (!on || fragment === null) return;
    const mine = ++round.current;
    const done = (next: View) => {
      if (mine === round.current) setView(next);
    };
    try {
      if (needsPassphrase(fragment)) return done({ state: 'locked', wrong: false });
    } catch (e) {
      return done({ state: 'error', code: codeOf(e) });
    }
    done({ state: 'opening' });
    openShareFragment(fragment).then(
      (chat) => done({ state: 'open', chat }),
      (e) => done({ state: 'error', code: codeOf(e) }),
    );
  }, [on, fragment]);

  async function unlock(passphrase: string) {
    if (fragment === null) return;
    const mine = ++round.current;
    setView({ state: 'opening' });
    try {
      const chat = await openShareFragment(fragment, passphrase);
      if (mine === round.current) setView({ state: 'open', chat });
    } catch (e) {
      if (mine !== round.current) return;
      const code = codeOf(e);
      setView(code === 'wrong_passphrase' ? { state: 'locked', wrong: true } : { state: 'error', code });
    }
  }

  if (!ready || fragment === null) return null;
  if (view.state === 'reading' || view.state === 'opening')
    return (
      <div className="sh-view">
        <h1>Opening the chat…</h1>
        <output className="sh-lede">This happens in your browser.</output>
      </div>
    );
  if (view.state === 'error')
    return (
      <div className="sh-view">
        <h1>{view.code === 'empty' ? 'No chat here.' : 'This link can’t be opened.'}</h1>
        <p className="sh-lede" role="alert">
          {view.code === 'empty' ? 'A shared chat link ends in # and a long code. Open the whole link you were given.' : SHARE_ERROR_TEXT[view.code]}
        </p>
        <StartYourOwn />
      </div>
    );
  if (view.state === 'locked') return <Locked wrong={view.wrong} onUnlock={(p) => void unlock(p)} />;

  const { chat } = view;
  const when = new Date(chat.createdAt);
  return (
    <article className="sh-view">
      <header className="sh-head">
        <p className="sh-kicker">A shared chat</p>
        <h1>{chat.title}</h1>
        <p className="sh-note">
          {chat.messages.length} messages{Number.isNaN(when.getTime()) ? '' : ` · shared ${when.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`}. Read-only. It
          opened in this tab and was not saved anywhere.
        </p>
        <p className="sh-note">Replies were written by AI models.</p>
      </header>
      <ol className="sh-thread">
        {chat.messages.map((m, i) => (
          <li key={i} className={m.role === 'user' ? 'sh-msg sh-user' : 'sh-msg sh-ai'}>
            <div className="sh-who">
              {m.role === 'user' ? 'User' : (m.name ?? 'AI')}
              {m.role === 'assistant' && m.model && <span className="sh-model mono">{m.model}</span>}
            </div>
            <p className="sh-text">{m.text}</p>
          </li>
        ))}
      </ol>
      <StartYourOwn />
    </article>
  );
}

function Locked({ wrong, onUnlock }: { wrong: boolean; onUnlock: (passphrase: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (value) onUnlock(value);
  };
  return (
    <div className="sh-view">
      <h1>This chat is locked.</h1>
      <p className="sh-lede">Type the passphrase you were given. It is checked here, in your browser.</p>
      <form className="sh-unlock" onSubmit={submit}>
        <label className="field">
          <span>Passphrase</span>
          <input className="input" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {wrong && (
          <p className="notice notice-rose" role="alert">
            {SHARE_ERROR_TEXT.wrong_passphrase} If it is right, the link may have been changed.
          </p>
        )}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!value}>
            Open the chat
          </button>
        </div>
      </form>
    </div>
  );
}

function StartYourOwn() {
  return (
    <div className="row sh-cta">
      <Link className="btn btn-primary" href="/dashboard/chat">
        Start your own chat
      </Link>
      <Link className="btn btn-ghost" href="/">
        What is Anonymo?
      </Link>
    </div>
  );
}
