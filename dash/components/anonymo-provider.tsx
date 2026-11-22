'use client';

// Shared workspace state: demo or live mode, the API key held on this device, a typed client bound to both, the
// conversation (memory only, unless the person turns on keeping chats in this browser: lib/anonymo/history.ts) and
// the receipt ids this device has seen (ids only, no text).

import { useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAnonymoClient, type AnonymoClient } from '@/lib/anonymo/client';
import { API_BASE, DEMO_BY_DEFAULT, isDemoMode } from '@/lib/anonymo/config';
import { deviceStore, useDeviceStore, useHydrated } from '@/lib/anonymo/device-store';
import { forgetKey, keyStore, saveKey } from '@/lib/anonymo/key-store';
import { createMockGateway, type MockGateway } from '@/lib/anonymo/mock/gateway';
import { forgetReceipts, receiptsStore, rememberReceipt, type SeenReceipt } from '@/lib/anonymo/prefs';
import { keepStore } from '@/lib/anonymo/history';
import { freshTabChats, switchTabChat, type TabChat } from '@/lib/anonymo/tab-chats';
import { updateOn } from '@/lib/anonymo/updates';
import type { ModelInfo } from '@/lib/anonymo/types';
import type { Turn } from './dashboard/chat-types';

const DEMO_BASE = 'https://demo.anonymo.invalid';
const demoStore = deviceStore<boolean>(isDemoMode, DEMO_BY_DEFAULT);

export type { SeenReceipt };

type AnonymoState = {
  ready: boolean;
  demo: boolean;
  key: string | null;
  client: AnonymoClient;
  mock: MockGateway | null;
  setKey: (key: string, remember: boolean) => void;
  clearKey: () => void;
  turns: Turn[];
  setTurns: (update: (turns: Turn[]) => Turn[]) => void;
  /** Which saved chat the current conversation is (a fresh id per new chat). */
  chatId: string;
  recentChats: TabChat[];
  resetChats: () => void;
  /** Start a new conversation, or open a saved one with its turns. */
  openChat: (id: string | null, turns?: Turn[]) => void;
  receipts: SeenReceipt[];
  rememberReceipt: (receipt: SeenReceipt) => void;
  forgetReceipts: () => void;
  balanceVersion: number;
  refreshBalance: () => void;
  /** Model IDs `GET /v1/models` lists right now, or null until known (then every ID is offered). */
  liveModels: ReadonlySet<string> | null;
  catalog: readonly ModelInfo[] | null;
  catalogError: boolean;
  refreshCatalog: () => void;
};

const Context = createContext<AnonymoState | null>(null);

let mockSingleton: MockGateway | null = null;
function demoGateway() {
  if (!mockSingleton) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    mockSingleton = createMockGateway({ storage });
  }
  return mockSingleton;
}

export function AnonymoProvider({ children }: { children: ReactNode }) {
  const ready = useHydrated();
  const demo = useDeviceStore(demoStore);
  const key = useDeviceStore(keyStore);
  const receipts = useDeviceStore(receiptsStore);
  const [chats, setChats] = useState(() => freshTabChats(newId()));
  const { id: chatId, turns } = chats.active;
  const keeping = useDeviceStore(keepStore) && updateOn('history', demo);
  const [scope, setScope] = useState({ key, demo, keeping });
  if (key !== scope.key || demo !== scope.demo || keeping !== scope.keeping) {
    setScope({ key, demo, keeping });
    setChats(key !== scope.key || demo !== scope.demo ? freshTabChats(newId()) : { ...chats, recent: [] });
  }
  const [balanceVersion, setBalanceVersion] = useState(0);
  const search = useSearchParams();
  // `?demo=1` / `?demo=0` can arrive on a client-side navigation: re-read the mode and its key.
  useEffect(() => {
    demoStore.changed();
    keyStore.changed();
  }, [search]);

  const mock = ready && demo ? demoGateway() : null;
  const client = useMemo(
    () => createAnonymoClient({ baseUrl: demo ? DEMO_BASE : API_BASE, key, fetch: mock?.fetch }),
    [demo, key, mock],
  );

  const [catalog, setCatalog] = useState<ModelInfo[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const refreshCatalog = useCallback(() => setCatalogVersion(v => v + 1), []);
  const liveModels = useMemo(() => catalog && new Set(catalog.filter(m => m.availability !== 'temporarily_unavailable').map(m => m.id)), [catalog]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const publicClient = createAnonymoClient({ baseUrl: demo ? DEMO_BASE : API_BASE, fetch: mock?.fetch });
    let fetching = false;
    let checked = 0;
    async function load() {
      if (fetching || document.visibilityState === 'hidden' || Date.now() - checked < 60_000) return;
      fetching = true;
      try {
        const response = await publicClient.models(controller.signal);
        if (!controller.signal.aborted) {
          setCatalog(response.data);
          setCatalogError(false);
        }
      } catch {
        if (!controller.signal.aborted) { setCatalog(null); setCatalogError(true); }
      } finally {
        checked = Date.now();
        fetching = false;
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 65_000);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', load);
    };
  }, [ready, demo, mock, catalogVersion]);

  const setKey = useCallback(
    (value: string, remember: boolean) => {
      saveKey(demo, value, remember);
      setBalanceVersion((v) => v + 1);
    },
    [demo],
  );
  const clearKey = useCallback(() => {
    forgetKey(demo);
    setChats(freshTabChats(newId()));
  }, [demo]);
  const resetChats = useCallback(() => setChats(freshTabChats(newId())), []);
  const setTurns = useCallback((update: (turns: Turn[]) => Turn[]) => {
    setChats((state) => ({ ...state, active: { ...state.active, turns: update(state.active.turns) } }));
  }, []);
  const openChat = useCallback((id: string | null, saved?: Turn[]) => {
    const next = id ?? newId();
    setChats((state) => switchTabChat(state, next, saved, !keeping));
  }, [keeping]);
  const refreshBalance = useCallback(() => setBalanceVersion((v) => v + 1), []);

  const value = useMemo<AnonymoState>(
    () => ({
      ready,
      demo,
      key: ready ? key : null,
      client,
      mock,
      setKey,
      clearKey,
      turns,
      setTurns,
      chatId,
      recentChats: chats.recent,
      resetChats,
      openChat,
      receipts,
      rememberReceipt,
      forgetReceipts,
      balanceVersion,
      refreshBalance,
      liveModels, catalog, catalogError, refreshCatalog,
    }),
    [ready, demo, key, client, mock, setKey, clearKey, turns, setTurns, chatId, chats.recent, resetChats, openChat, receipts, balanceVersion, refreshBalance, liveModels, catalog, catalogError, refreshCatalog],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

/** Whether a model ID can be picked: listed by the gateway, or the list is not known yet. */
export const isLiveModel = (live: ReadonlySet<string> | null, id: string) => !live || live.has(id);

export function useAnonymo(): AnonymoState {
  const value = useContext(Context);
  if (!value) throw new Error('useAnonymo must be used inside AnonymoProvider');
  return value;
}
