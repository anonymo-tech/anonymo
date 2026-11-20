'use client';

// Update "history": chats kept in this browser (opt-in), and "Wipe this device". See lib/anonymo/history.ts.

import {
  Download,
  Flame,
  History,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnonymo } from '../anonymo-provider';
import type { Turn } from './chat-types';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import {
  chatsStore,
  deleteAllChats,
  deleteChat,
  fileNameOf,
  keepStore,
  renameChat,
  setKeep,
  toJson,
  toMarkdown,
  wipeDevice,
  type SavedChat,
} from '@/lib/anonymo/history';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { tokenLabel } from '@/lib/anonymo/catchup';
import { keyStore } from '@/lib/anonymo/key-store';
import { adultStore, modelStore, receiptsStore } from '@/lib/anonymo/prefs';

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const when = (iso: string) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

/** Overlays render at the end of <body>: the top bar would otherwise contain (and clip) a fixed layer. */
const Layer = ({ children }: { children: ReactNode }) =>
  typeof document === 'undefined'
    ? null
    : createPortal(children, document.body);

const toTurn = (t: SavedChat['turns'][number]): Turn => ({
  ...t,
  receipt: null,
  council: null,
});

export type CatchUpBar = { onCatchUp: () => void; busy: boolean; ready: boolean; suggest: boolean; tokens: number };

/** The bar above the thread: saved chats and a new chat (update "history"), "Catch me up" (update "catchup"). */
export function ChatBar({ history, onOpen, catchUp }: { history: boolean; onOpen: () => void; catchUp: CatchUpBar | null }) {
  const { demo, turns, openChat } = useAnonymo();
  const keep = useDeviceStore(keepStore);
  const chats = useDeviceStore(chatsStore(demo));
  return (
    <div className="chat-bar chat-col">
      {history && (
        <button type="button" className="btn btn-ghost btn-small" onClick={onOpen}>
          <History size={16} aria-hidden="true" /> Chats
          {keep && chats.length ? ` · ${chats.length}` : ''}
        </button>
      )}
      {turns.length > 0 && (
        <button type="button" className="btn btn-ghost btn-small" onClick={() => openChat(null)}>
          <Plus size={16} aria-hidden="true" /> New chat
        </button>
      )}
      {catchUp && catchUp.ready && (
        <button
          type="button"
          className={catchUp.suggest ? 'btn btn-small catchup-btn is-suggested' : 'btn btn-ghost btn-small catchup-btn'}
          disabled={catchUp.busy}
          title="Sum up this chat and continue from the recap in a fresh one: replies stay sharp and cost less."
          onClick={catchUp.onCatchUp}
        >
          <Sparkles size={16} aria-hidden="true" /> Catch me up
        </button>
      )}
      <span className="chat-bar-chips">
        {catchUp && turns.length > 0 && (
          <span className={catchUp.suggest ? 'chip chip-amber' : 'chip'} title="Every reply resends the whole thread, so long chats cost more each turn.">
            {tokenLabel(catchUp.tokens)}
            {catchUp.suggest ? ' · getting long' : ''}
          </span>
        )}
        {history && <span className={keep ? 'chip chip-signal' : 'chip'}>{keep ? 'Saved on this device' : 'Not saved'}</span>}
      </span>
    </div>
  );
}

/** The saved-chats drawer. */
export function ChatHistoryPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { demo, chatId, openChat } = useAnonymo();
  const keep = useDeviceStore(keepStore);
  const chats = useDeviceStore(chatsStore(demo));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <Layer>
      <div className="drawer-back" onClick={onClose}>
        <aside
          className="drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-title"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="drawer-head">
            <h2 id="history-title">Chats</h2>
            <button
              ref={close}
              type="button"
              className="icon-btn"
              aria-label="Close"
              onClick={onClose}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>

          <label className="switch-row">
            <input
              type="checkbox"
              role="switch"
              aria-label="Keep chats on this device"
              checked={keep}
              onChange={(e) => setKeep(e.target.checked)}
            />
            <span>
              <strong>Keep chats on this device</strong>
              <small>
                Saved in this browser only, never sent to Anonymo. Turning this
                off deletes them.
              </small>
            </span>
          </label>

          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => {
              openChat(null);
              onClose();
            }}
          >
            <Plus size={16} aria-hidden="true" /> New chat
          </button>

          {!keep ? (
            <p className="muted drawer-empty">
              Chats live in this tab only and are gone when you close it. Turn
              on keeping to find them here later.
            </p>
          ) : chats.length === 0 ? (
            <p className="muted drawer-empty">
              No saved chats yet. Finished replies are saved as you go.
            </p>
          ) : (
            <ul className="history-list">
              {chats.map((c) => (
                <li
                  key={c.id}
                  className={
                    c.id === chatId ? 'history-item is-open' : 'history-item'
                  }
                >
                  {renaming === c.id ? (
                    <form
                      className="history-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        renameChat(demo, c.id, draft);
                        setRenaming(null);
                      }}
                    >
                      <input
                        className="input"
                        aria-label="Chat name"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => setRenaming(null)}
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="history-open"
                      onClick={() => {
                        openChat(c.id, c.turns.map(toTurn));
                        onClose();
                      }}
                    >
                      <strong>{c.title}</strong>
                      <small>
                        {when(c.updatedAt)} · {c.model} · {c.turns.length}{' '}
                        {c.turns.length === 1 ? 'reply' : 'replies'}
                      </small>
                    </button>
                  )}
                  <div className="history-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Rename ${c.title}`}
                      title="Rename"
                      onClick={() => {
                        setDraft(c.title);
                        setRenaming(c.id);
                      }}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Export ${c.title} as Markdown`}
                      title="Export Markdown"
                      onClick={() =>
                        download(
                          fileNameOf(c, 'md'),
                          toMarkdown(c),
                          'text/markdown',
                        )
                      }
                    >
                      <Download size={15} aria-hidden="true" />
                      <span className="icon-tag">md</span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Export ${c.title} as JSON`}
                      title="Export JSON"
                      onClick={() =>
                        download(
                          fileNameOf(c, 'json'),
                          toJson(c),
                          'application/json',
                        )
                      }
                    >
                      <Download size={15} aria-hidden="true" />
                      <span className="icon-tag">json</span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-danger"
                      aria-label={`Delete ${c.title}`}
                      title="Delete"
                      onClick={() => {
                        deleteChat(demo, c.id);
                        if (c.id === chatId) openChat(null);
                      }}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {keep && chats.length > 0 && (
            <div className="drawer-foot">
              {confirmAll ? (
                <>
                  <span>Delete all {chats.length} saved chats?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-small"
                    onClick={() => {
                      deleteAllChats(demo);
                      setConfirmAll(false);
                      openChat(null);
                    }}
                  >
                    Delete all
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => setConfirmAll(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => setConfirmAll(true)}
                >
                  <Trash2 size={15} aria-hidden="true" /> Delete all saved chats
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </Layer>
  );
}

/** "Wipe this device": one button in the top bar, one confirmation, then everything Anonymo keeps here is gone. */
export function WipeDevice() {
  const { openChat } = useAnonymo();
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  const wipe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) wipe.current?.focus();
  }, [asking]);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-small wipe-btn"
        title="Wipe everything Anonymo keeps in this browser"
        onClick={() => setAsking(true)}
      >
        <Flame size={16} aria-hidden="true" />
        <span className="btn-label">Wipe</span>
      </button>
      {asking && (
        <Layer>
          <div
            className="drawer-back wipe-back"
            onClick={() => setAsking(false)}
          >
            <div
              className="wipe-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="wipe-title"
              aria-describedby="wipe-text"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}
            >
              {done ? (
                <>
                  <h2 id="wipe-title">Wiped.</h2>
                  <p id="wipe-text">
                    Nothing from Anonymo is left in this browser.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => window.location.assign('/')}
                  >
                    Done
                  </button>
                </>
              ) : (
                <>
                  <h2 id="wipe-title">Wipe this device?</h2>
                  <p id="wipe-text">
                    This removes everything Anonymo keeps in this browser: your
                    API key, saved chats, characters, receipt list and settings.
                    It can’t be undone.{' '}
                    <strong>
                      If your key has credit, copy it somewhere safe first
                    </strong>
                    : Anonymo can’t show it again.
                  </p>
                  <div className="age-gate-actions">
                    <button
                      ref={wipe}
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        wipeDevice();
                        for (const s of [
                          keyStore,
                          keepStore,
                          chatsStore(false),
                          chatsStore(true),
                          charactersStore,
                          receiptsStore,
                          modelStore,
                          adultStore,
                        ])
                          s.changed();
                        openChat(null);
                        setDone(true);
                      }}
                    >
                      <Flame size={16} aria-hidden="true" /> Wipe everything
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setAsking(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </Layer>
      )}
    </>
  );
}
