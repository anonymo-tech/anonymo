'use client';

// Gateway calls for one ticket (update "tickets"). A ticket is a key of its own, so every call about it goes out with
// that key and no other: the workspace's own key is never used for a ticket, and a ticket's key is never used for
// anything but its own balance, deposits and withdrawal.

import { useCallback } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { AnonymoApiError, createAnonymoClient, type AnonymoClient } from '@/lib/anonymo/client';
import { API_BASE } from '@/lib/anonymo/config';
import { usdToMusd } from '@/lib/anonymo/money';
import { applyToTicket, type GivenTicket, type TicketSource } from '@/lib/anonymo/tickets';
import type { DepositRow, PayoutChain } from '@/lib/anonymo/types';

/** The demo gateway answers on any origin; this one is a name that can never resolve. */
const DEMO_BASE = 'https://demo.anonymo.invalid';

/** Makes a client bound to a ticket's key (or to no key, to create one), in the tab's current mode. */
export function useTicketClient(): (key: string | null) => AnonymoClient {
  const { demo, mock } = useAnonymo();
  return useCallback((key: string | null) => createAnonymoClient({ baseUrl: demo ? DEMO_BASE : API_BASE, key, fetch: mock?.fetch }), [demo, mock]);
}

/** Why the gateway refused a key, when it did: its date has passed, or it does not know the key. */
export function keyRefusal(error: unknown): 'key_expired' | 'key_unknown' | null {
  if (!(error instanceof AnonymoApiError) || error.status !== 401) return null;
  return error.code === 'key_expired' ? 'key_expired' : 'key_unknown';
}

export const sourceOf = (row: Pick<DepositRow, 'chain' | 'from'>): TicketSource => ({ chain: row.chain as PayoutChain, address: row.from });

/** The deposit that paid for a ticket: the one for its transaction when that is known, else its first stablecoin deposit. */
export function depositFor(rows: DepositRow[], txHash: string | null): DepositRow | undefined {
  const paid = rows.filter((r) => r.chain !== 'coin');
  // On EVM chains the row's `ref` is `<chain>:<txhash>:<logIndex>` (the same match as rowForTx in lib/anonymo/wallet,
  // written out here so the public ticket page does not load the wallet code).
  const hash = txHash?.toLowerCase();
  return (hash ? paid.find((r) => r.ref.toLowerCase().includes(hash)) : undefined) ?? paid[paid.length - 1];
}

/**
 * Asks the gateway where a ticket stands and records the answer on this device: what is left, whether the payment
 * has been credited or held, or that the key is refused. A network failure throws and changes nothing.
 */
export async function checkTicket(client: AnonymoClient, demo: boolean, ticket: GivenTicket, signal?: AbortSignal): Promise<void> {
  try {
    const balance = await client.balance(signal);
    const left = usdToMusd(balance.available_usd);
    const first = balance.withdraw_to[0];
    applyToTicket(demo, ticket.id, {
      type: 'balance',
      leftMusd: Number.isSafeInteger(left) && left > 0 ? left : 0,
      at: new Date().toISOString(),
      from: first ? { chain: first.chain, address: first.address } : null,
    });
    if (ticket.credit === 'credited' || left > 0) return;
    // Nothing spendable yet: the deposit row says whether it is still on its way, credited and already spent, or held.
    const row = depositFor((await client.deposits(signal)).data, ticket.txHash);
    if (row?.status === 'credited') applyToTicket(demo, ticket.id, { type: 'credited', amountMusd: usdToMusd(row.amount_usd), from: sourceOf(row) });
    else if (row?.status === 'held') applyToTicket(demo, ticket.id, { type: 'held' });
  } catch (error) {
    const refusal = keyRefusal(error);
    if (!refusal) throw error;
    applyToTicket(demo, ticket.id, { type: refusal });
  }
}
