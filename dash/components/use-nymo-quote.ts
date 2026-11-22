'use client';

import { useEffect, useState } from 'react';
import { AnonymoApiError, type AnonymoClient } from '@/lib/anonymo/client';
import { readNymoQuote } from '@/lib/anonymo/nymo-quote';
import type { NymoQuote, PublicCoinInstructions } from '@/lib/anonymo/types';

type Result = { quote: NymoQuote; message?: never } | { quote?: never; message: string };

export function nymoQuoteError(error: unknown): string {
  if (error instanceof AnonymoApiError && error.status === 422) return 'This amount exceeds the current NYMO payment limit. Choose a smaller amount.';
  return 'A NYMO quote is unavailable right now. Try again or choose USDG.';
}

export function useNymoQuote(client: AnonymoClient, coin: PublicCoinInstructions, musd: number | null) {
  const input = `${musd}:${coin.chain_id}:${coin.coin_pay}:${coin.token.address}:${coin.confirmations}`;
  const [result, setResult] = useState<{ input: string; result: Result } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!musd) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      readNymoQuote(client, coin, musd, controller.signal).then(quote => {
        if (!controller.signal.aborted) setResult({ input, result: { quote } });
      }, error => {
        if (!controller.signal.aborted) setResult({ input, result: { message: nymoQuoteError(error) } });
      });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [client, coin, musd, input, attempt]);
  const current = result?.input === input ? result.result : null;
  return {
    quote: musd ? current?.quote : undefined,
    message: !musd ? 'Enter a positive USD amount.' : current?.message ?? 'Checking current NYMO quote…',
    failed: !!musd && !!current?.message,
    replace: (value: Result) => setResult({ input, result: value }),
    retry: () => { setResult(null); setAttempt(value => value + 1); },
  };
}
