'use client';

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { deviceStore, useDeviceStore } from '@/lib/anonymo/device-store';
import { chatsStore, keepStore, wipeDevice, type SavedChat } from '@/lib/anonymo/history';
import { updateOn } from '@/lib/anonymo/updates';
import { MINUTE_MS, panicSequence } from '@/lib/anonymo/vanish';
import { seedDemoHistory, sweepChatStores } from '@/lib/anonymo/vanish-history';
import { loadVanishPrefs } from '@/lib/anonymo/vanish-prefs';
import { useAnonymo } from '../anonymo-provider';

const dormantChats = deviceStore<SavedChat[]>(() => [], []);

function useHistoryExpiry(enabled: boolean) {
  const { demo, chatId, openChat } = useAnonymo();
  const keep = useDeviceStore(keepStore);
  const chats = useDeviceStore(enabled ? chatsStore(demo) : dormantChats);
  const saved = chats.find((chat) => chat.id === chatId);
  const previousTimed = useRef<{ demo: boolean; id: string } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    sweepChatStores();
    const timer = window.setInterval(sweepChatStores, MINUTE_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') sweepChatStores();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  useEffect(() => {
    if (enabled && demo && keep) seedDemoHistory();
  }, [enabled, demo, keep]);

  useEffect(() => {
    const previous = previousTimed.current;
    previousTimed.current = enabled && saved?.expiresAt !== undefined ? { demo, id: chatId } : null;
    if (enabled && !saved && previous?.demo === demo && previous.id === chatId) openChat(null);
  }, [enabled, demo, saved, chatId, openChat]);
}

function clearComposer() {
  const composer = document.querySelector<HTMLTextAreaElement>('textarea#composer');
  if (!composer?.value) return;
  // Use the native setter and input event so the existing controlled composer also clears its draft state.
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setValue?.call(composer, '');
  composer.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Runs once per workspace shell. A latched panic unmounts the workspace and its portals. */
export function useVanishWorkspace(): boolean {
  const { ready, demo, openChat } = useAnonymo();
  const [hidden, setHidden] = useState(false);
  const enabled = ready && updateOn('vanish', demo);
  useHistoryExpiry(enabled && !hidden);

  useEffect(() => {
    if (!enabled || hidden) return;
    const sequence = panicSequence();
    let composing = false;
    const startComposition = () => { composing = true; sequence.reset(); };
    const reset = () => { composing = false; sequence.reset(); };
    const onKey = (e: KeyboardEvent) => {
      const isComposing = composing || e.isComposing || e.keyCode === 229;
      if (!sequence.press({ key: e.key, isComposing, repeat: e.repeat }, e.timeStamp)) return;
      const prefs = loadVanishPrefs();
      if (!prefs.panicOn) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      document.documentElement.setAttribute('data-anonymo-panic', '');
      try {
        flushSync(() => {
          document.querySelector<HTMLButtonElement>('.ws-composer .send-stop')?.click();
          clearComposer();
          openChat(null);
          setHidden(true);
        });
      } finally {
        try {
          if (prefs.wipeOnPanic) wipeDevice();
        } finally {
          window.location.replace(prefs.neutralPage);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('compositionstart', startComposition, true);
    window.addEventListener('compositionend', reset, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('compositionstart', startComposition, true);
      window.removeEventListener('compositionend', reset, true);
      window.removeEventListener('blur', reset);
    };
  }, [enabled, hidden, openChat]);

  return hidden;
}
