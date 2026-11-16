'use client';

// Shared workspace state: demo or live mode, the API key held on this device, a typed client bound to both, the
// conversation (memory only, never stored) and the receipt ids this device has seen (ids only, no text).

import { useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAnonymoClient, type AnonymoClient } from '@/lib/anonymo/client';
import { API_BASE, DEMO_BY_DEFAULT, isDemoMode } from '@/lib/anonymo/config';
import { deviceStore, useDeviceStore, useHydrated } from '@/lib/anonymo/device-store';
import { forgetKey, keyStore, saveKey } from '@/lib/anonymo/key-store';
import { createMockGateway, type MockGateway } from '@/lib/anonymo/mock/gateway';
import { forgetReceipts, receiptsStore, rememberReceipt, type SeenReceipt } from '@/lib/anonymo/prefs';
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
  receipts: SeenReceipt[];
  rememberReceipt: (receipt: SeenReceipt) => void;
  forgetReceipts: () => void;
  balanceVersion: number;
  refreshBalance: () => void;
  /** Model IDs `GET /v1/models` lists right now, or null until known (then every ID is offered). */
  liveModels: ReadonlySet<string> | null;
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
  const [turns, setTurnsState] = useState<Turn[]>([]);
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

  // Which model IDs have routes right now. A model with none (anonymo-rp before self-hosted routes exist, anonymo-sealed
  // before an attested route) is left out of /v1/models, so the UI marks it "not live yet" instead of failing on send.
  const [liveModels, setLiveModels] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    // A keyless client: the model list is public and the same for every key, so it is fetched once per mode.
    createAnonymoClient({ baseUrl: demo ? DEMO_BASE : API_BASE, fetch: mock?.fetch }).models().then(
      (list) => !stale && setLiveModels(new Set(list.data.map((m) => m.id))),
      () => undefined, // unknown: keep offering every model and let the gateway answer
    );
    return () => {
      stale = true;
    };
  }, [ready, demo, mock]);

  const setKey = useCallback(
    (value: string, remember: boolean) => {
      saveKey(demo, value, remember);
      setBalanceVersion((v) => v + 1);
    },
    [demo],
  );
  const clearKey = useCallback(() => {
    forgetKey(demo);
    setTurnsState([]);
  }, [demo]);
  const setTurns = useCallback((update: (turns: Turn[]) => Turn[]) => setTurnsState(update), []);
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
      receipts,
      rememberReceipt,
      forgetReceipts,
      balanceVersion,
      refreshBalance,
      liveModels,
    }),
    [ready, demo, key, client, mock, setKey, clearKey, turns, setTurns, receipts, balanceVersion, refreshBalance, liveModels],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Whether a model ID can be picked: listed by the gateway, or the list is not known yet. */
export const isLiveModel = (live: ReadonlySet<string> | null, id: string) => !live || live.has(id);

export function useAnonymo(): AnonymoState {
  const value = useContext(Context);
  if (!value) throw new Error('useAnonymo must be used inside AnonymoProvider');
  return value;
}
