'use client';

import { useEffect, useRef, useState } from 'react';
import { AnonymoApiError, type AnonymoClient } from '@/lib/anonymo/client';
import { freeDevice, type FreeChallenge } from '@/lib/anonymo/free-chat';
import freeWorkerUrl from '@/lib/anonymo/free-pow.worker.ts?worker&url';

function deviceToken(demo: boolean) {
  try {
    return freeDevice(localStorage, demo);
  } catch {
    throw new Error('Free chat needs this browser to keep a device token. Allow site storage and try again.');
  }
}

function solve(challenge: FreeChallenge & { challenge: string }, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(freeWorkerUrl, { type: 'module' });
    function finish() {
      worker.terminate();
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
    function abort() {
      finish();
      reject(signal.reason);
    }
    function expired() {
      finish();
      reject(new Error('The free chat check expired. Try sending again.'));
    }
    const timer = setTimeout(expired, Math.max(0, challenge.expires - Date.now()));
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<number | null>) => {
      if (data === null) return expired();
      finish();
      resolve(data);
    };
    worker.onerror = () => {
      finish();
      reject(new Error('The free chat check could not run in this browser.'));
    };
    worker.postMessage(challenge);
  });
}

export function useFreeChat(client: AnonymoClient, on: boolean, demo: boolean) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [solving, setSolving] = useState(false);
  const cached = useRef<{ token: string; value: FreeChallenge } | null>(null);

  const [resetsAt, setResetsAt] = useState<number | null>(null);
  const [day, setDay] = useState(0);

  useEffect(() => {
    if (!on) return;
    const abort = new AbortController();
    async function refresh() {
      try {
        const token = deviceToken(demo);
        const value = await client.freeChallenge(token, abort.signal);
        if (abort.signal.aborted) return;
        cached.current = { token, value };
        setRemaining(value.remaining);
        setResetsAt(value.resets_at);
      } catch { /* Sending retries with a fresh challenge and can show the reason. */ }
    }
    void refresh();
    return () => {
      abort.abort();
      cached.current = null;
      setRemaining(null);
      setResetsAt(null);
    };
  }, [client, demo, on, day]);

  useEffect(() => {
    if (!on || resetsAt === null) return;
    const timer = setTimeout(() => setDay(day => day + 1), Math.max(1000, resetsAt - Date.now() + 100));
    return () => clearTimeout(timer);
  }, [on, resetsAt]);

  async function authorize(signal: AbortSignal) {
    const token = deviceToken(demo);
    const entry = cached.current;
    cached.current = null;
    setSolving(true);
    try {
      const value = entry?.token === token && entry.value.expires > Date.now() + 3000
        ? entry.value : await client.freeChallenge(token, signal);
      setRemaining(value.remaining);
      setResetsAt(value.resets_at);
      if (value.remaining === 0)
        throw new AnonymoApiError(429, 'free_daily_limit', 'You’ve used your free messages today.');
      if (!value.challenge || !value.model) throw new Error('Free chat is temporarily unavailable.');
      const nonce = await solve({ ...value, challenge: value.challenge }, signal);
      return { model: value.model, token, proof: `${value.challenge}:${nonce}:0` };
    } finally {
      setSolving(false);
    }
  }

  return { remaining, setRemaining, solving, authorize };
}
