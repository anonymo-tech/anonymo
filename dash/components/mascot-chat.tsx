'use client';

import {
  lazy,
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowLeft, ArrowUpRight, Lightbulb, Minus, Plus } from 'lucide-react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useAnonymo } from './anonymo-provider';
import { FeatureGuide, MascotTip, useMascotTips } from './mascot-tips';
import { MascotSprite, useMascotReaction } from './mascot-sprite';
import { WorkspaceShell } from './dashboard/workspace-shell';
import { toTurn } from './dashboard/chat-history';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { chatsStore, keepStore, titleOf } from '@/lib/anonymo/history';
import { adultStore } from '@/lib/anonymo/prefs';
import { updateOn } from '@/lib/anonymo/updates';
import './mascot-chat.css';

const Workspace = lazy(() =>
  import('./dashboard/chat-workspace').then(({ ChatWorkspace }) => ({
    default: ChatWorkspace,
  })),
);
type Mount = (element: HTMLDivElement | null) => void;
const PageSlots = createContext<{
  thread: Mount;
  composer: Mount;
  open: boolean;
  close: () => void;
} | null>(null);

export function FullPageChat() {
  const { key } = useAnonymo();
  const { thread, composer, open, close } = useContext(PageSlots)!;
  return (
    <WorkspaceShell
      section="Chat"
      composer={key ? <div ref={composer} /> : undefined}
    >
      <div className="chat-page-slot" ref={thread} />
      {open && (
        <button type="button" className="btn chat-return" onClick={close}>
          Return chat to this page
        </button>
      )}
    </WorkspaceShell>
  );
}

function SessionPicker() {
  const { demo, chatId, turns, recentChats, openChat } = useAnonymo();
  const keep = useDeviceStore(keepStore);
  const saved = useDeviceStore(chatsStore(demo));
  const available = keep && updateOn('history', demo) ? saved : [];
  const busy = turns.some((turn) => turn.status === 'streaming');
  return (
    <div className="mascot-sessions">
      <select
        aria-label="Chat session"
        value={chatId}
        disabled={busy}
        onChange={(event) => {
          const id = event.target.value;
          openChat(
            id,
            available.find((chat) => chat.id === id)?.turns.map(toTurn),
          );
        }}
      >
        <option value={chatId}>
          {available.find((chat) => chat.id === chatId)?.title ??
            titleOf(turns)}
        </option>
        {recentChats.map((chat) => (
          <option key={chat.id} value={chat.id}>
            {titleOf(chat.turns)}
          </option>
        ))}
        {available
          .filter((chat) => chat.id !== chatId)
          .map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.title}
            </option>
          ))}
      </select>
      <button
        className="icon-btn"
        type="button"
        title="New chat"
        aria-label="Start new chat"
        disabled={busy || !turns.length}
        onClick={() => openChat(null)}
      >
        <Plus size={18} />
      </button>
    </div>
  );
}

export function MascotChat({ children }: { children: ReactNode }) {
  const confirmed = useDeviceStore(adultStore);
  const pathname = usePathname();
  const { demo } = useAnonymo();
  const reminders = useMascotTips(confirmed, demo);
  const [guide, setGuide] = useState(false);
  const { dismiss } = reminders;
  const reaction = useMascotReaction();
  const [carried, setCarried] = useState(false);
  const [open, setOpen] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [pageThread, setPageThread] = useState<HTMLDivElement | null>(null);
  const [pageComposer, setPageComposer] = useState<HTMLDivElement | null>(null);
  const [panelThread, setPanelThread] = useState<HTMLDivElement | null>(null);
  const [panelComposer, setPanelComposer] = useState<HTMLDivElement | null>(
    null,
  );
  const launcher = useRef<HTMLButtonElement>(null);
  const minimize = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDialogElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const visible = confirmed && open;
  const tip = guide && visible ? null : reminders.tip;
  function showGuide() {
    dismiss();
    setGuide(true);
    setEngaged(true);
    setOpen(true);
  }
  const mood = carried
    ? 'carried'
    : (reaction ?? (tip ? 'greet' : visible ? 'listen' : 'roam'));

  const mountThread = useCallback((element: HTMLDivElement | null) => {
    setPageThread(element);
    if (element) setEngaged(true);
  }, []);
  useEffect(() => {
    if (visible) minimize.current?.focus({ preventScroll: true });
  }, [visible]);

  const close = useCallback(() => {
    dismiss();
    setOpen(false);
    setGuide(false);
    requestAnimationFrame(() =>
      launcher.current?.focus({ preventScroll: true }),
    );
  }, [dismiss]);
  // The composer and thread render through portals. Listen on the panel DOM so their events reach it too.
  useEffect(() => {
    const element = panel.current;
    if (!visible || !element) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        element.querySelector('[role="menu"]') ||
        document.querySelector('.drawer-back')
      )
        return;
      event.preventDefault();
      close();
    };
    const followLink = (event: MouseEvent) => {
      if (
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest('a[href^="/"]:not([download])')
      ) {
        // Keep the link mounted until the client router has handled the click.
        requestAnimationFrame(() => {
          setGuide(false);
          setOpen(false);
        });
      }
    };
    element.addEventListener('keydown', escape);
    element.addEventListener('click', followLink);
    return () => {
      element.removeEventListener('keydown', escape);
      element.removeEventListener('click', followLink);
    };
  }, [visible, close]);

  return (
    <PageSlots.Provider
      value={{
        thread: mountThread,
        composer: setPageComposer,
        open: visible,
        close,
      }}
    >
      {children}
      {confirmed && (
        <button
          ref={launcher}
          className="mascot-launcher"
          type="button"
          data-workspace={pathname.startsWith('/dashboard')}
          data-resting={mood === 'roam'}
          data-placed={!!position}
          style={
            position
              ? {
                  left: `clamp(8px, ${position.x}px, calc(100vw - var(--mascot-size) - 8px))`,
                  top: `clamp(8px, ${position.y}px, calc(100dvh - var(--mascot-size) - 8px))`,
                }
              : undefined
          }
          aria-label={open ? 'Minimize Anonymo chat' : 'Open Anonymo chat'}
          aria-haspopup="dialog"
          aria-expanded={visible}
          aria-controls={visible ? 'mascot-chat' : undefined}
          title="Anonymo chat · drag or use the arrow keys to move"
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            suppressClick.current = false;
            const rect = event.currentTarget.getBoundingClientRect();
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: rect.left,
              top: rect.top,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || start.id !== event.pointerId) return;
            const dx = event.clientX - start.x,
              dy = event.clientY - start.y;
            if (!start.moved && Math.hypot(dx, dy) < 7) return;
            if (!start.moved) {
              dismiss();
              setCarried(true);
            }
            start.moved = true;
            setPosition({ x: start.left + dx, y: start.top + dy });
          }}
          onPointerUp={() => {
            suppressClick.current = !!drag.current?.moved;
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            setCarried(false);
            drag.current = null;
          }}
          onKeyDown={(event) => {
            const directions: Record<string, [number, number]> = {
              ArrowLeft: [-32, 0],
              ArrowRight: [32, 0],
              ArrowUp: [0, -32],
              ArrowDown: [0, 32],
            };
            const delta = directions[event.key];
            if (!delta) return;
            dismiss();
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setPosition({ x: rect.left + delta[0], y: rect.top + delta[1] });
          }}
          onClick={(event) => {
            if (suppressClick.current && event.detail) {
              suppressClick.current = false;
              return;
            }
            if (open) close();
            else {
              setGuide(false);
              setEngaged(true);
              setOpen(true);
            }
          }}
        >
          <MascotSprite mood={mood} />
        </button>
      )}
      {confirmed && (
        <output className="sr-only" aria-live="polite">
          {tip ? tip.title + '. ' + tip.text : ''}
        </output>
      )}
      {tip && !visible && (
        <MascotTip
          tip={tip}
          anchor={launcher}
          onDismiss={dismiss}
          onGuide={showGuide}
        />
      )}
      {visible && (
        <dialog
          open
          ref={panel}
          aria-labelledby="mascot-chat-title"
          id="mascot-chat"
          className="mascot-panel"
        >
          <header className="mascot-head">
            <MascotSprite mood={reaction ?? 'listen'} />
            <h2 id="mascot-chat-title">
              {guide ? 'Feature guide' : 'Anonymo chat'}
            </h2>
            <button
              className="icon-btn"
              type="button"
              aria-label={guide ? 'Back to chat' : 'Feature guide'}
              title={guide ? 'Back to chat' : 'Feature guide'}
              aria-pressed={guide}
              onClick={() => {
                dismiss();
                setGuide(!guide);
              }}
            >
              {guide ? <ArrowLeft size={18} /> : <Lightbulb size={18} />}
            </button>
            {pathname !== '/dashboard/chat' && (
              <Link
                href="/dashboard/chat"
                className="icon-btn"
                aria-label="Open full chat"
                title="Open full chat"
              >
                <ArrowUpRight size={18} />
              </Link>
            )}
            <button
              ref={minimize}
              className="icon-btn"
              type="button"
              onClick={close}
              title="Minimize chat"
              aria-label="Minimize chat"
            >
              <Minus size={18} />
            </button>
          </header>
          {guide && (
            <FeatureGuide
              tips={reminders.tips}
              onFollow={dismiss}
              enabled={reminders.enabled}
              onToggle={(enabled) => {
                dismiss();
                reminders.setEnabled(enabled);
              }}
            />
          )}
          <div hidden={guide}>
            <SessionPicker />
            {tip && (
              <MascotTip tip={tip} onDismiss={dismiss} onGuide={showGuide} />
            )}
          </div>
          <div hidden={guide} className="mascot-thread" ref={setPanelThread} />
          <div
            hidden={guide}
            className="mascot-composer"
            ref={setPanelComposer}
          />
        </dialog>
      )}
      {confirmed && (engaged || pageThread) && (
        <Suspense fallback={null}>
          <Workspace
            compact={visible}
            threadHost={visible ? panelThread : pageThread}
            composerHost={visible ? panelComposer : pageComposer}
          />
        </Suspense>
      )}
    </PageSlots.Provider>
  );
}
