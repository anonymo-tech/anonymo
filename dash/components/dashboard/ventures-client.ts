'use client';

// Update "ventures": the client the Ventures pages call. With a key on this device it is the workspace's own client.
// In demo mode with no key, the pages make a sample key on the in-browser demo gateway and fund it, so a whole run
// can be watched with no key and no gateway; that key stays in this tab and is never saved as the workspace key.

import { useCallback, useEffect, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { createAnonymoClient, type AnonymoClient } from '@/lib/anonymo/client';
import type { MockGateway } from '@/lib/anonymo/mock/gateway';

const DEMO_BASE = 'https://demo.anonymo.invalid';
const SAMPLE_KEY = 'anonymo.ventures.demo-key';
let sample: { mock: MockGateway; key: Promise<string> } | null = null;

function sampleKey(mock: MockGateway): Promise<string> {
  if (sample?.mock === mock) return sample.key;
  const key = (async () => {
    try {
      const kept = sessionStorage.getItem(SAMPLE_KEY);
      if (kept) {
        await createAnonymoClient({ baseUrl: DEMO_BASE, fetch: mock.fetch, key: kept }).balance();
        return kept;
      }
    } catch {
      // no session storage, or the demo gateway forgot the key: make a new one
    }
    const { key: fresh } = await createAnonymoClient({ baseUrl: DEMO_BASE, fetch: mock.fetch }).createKey();
    await mock.simulateDeposit(fresh, 'rhc', 'USDG', 600_000_000);
    try {
      sessionStorage.setItem(SAMPLE_KEY, fresh);
    } catch {
      // kept in memory only
    }
    return fresh;
  })();
  sample = { mock, key };
  return key;
}

export type VenturesClient = {
  client: AnonymoClient | null;
  /** True when the pages run on a sample key of the demo gateway. */
  sample: boolean;
  demo: boolean;
  ready: boolean;
  /** Demo mode only: tops the key up on the demo gateway. */
  addDemoCredit: ((usd: number) => Promise<void>) | null;
};

export function useVenturesClient(): VenturesClient {
  const { ready, demo, key, client, mock, refreshBalance } = useAnonymo();
  const [own, setOwn] = useState<{ mock: MockGateway; key: string; client: AnonymoClient } | null>(null);
  const wantSample = ready && demo && !key && !!mock;
  useEffect(() => {
    if (!wantSample || !mock) return;
    let live = true;
    sampleKey(mock).then(
      (k) => live && setOwn({ mock, key: k, client: createAnonymoClient({ baseUrl: DEMO_BASE, fetch: mock.fetch, key: k }) }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wantSample, mock]);
  const mine = own?.mock === mock ? own : null;
  const usedKey = key ?? (wantSample ? (mine?.key ?? null) : null);
  const addDemoCredit = useCallback(
    async (usd: number) => {
      if (!mock || !usedKey) return;
      await mock.simulateDeposit(usedKey, 'rhc', 'USDG', Math.round(usd * 1_000_000));
      refreshBalance();
    },
    [mock, usedKey, refreshBalance],
  );
  const credit = demo && mock && usedKey ? addDemoCredit : null;
  if (!ready) return { client: null, sample: false, demo, ready: false, addDemoCredit: null };
  if (key) return { client, sample: false, demo, ready: true, addDemoCredit: credit };
  if (wantSample) return { client: mine?.client ?? null, sample: true, demo, ready: !!mine, addDemoCredit: credit };
  return { client: null, sample: false, demo, ready: true, addDemoCredit: null };
}
