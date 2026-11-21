// Tickets (update "tickets"): a funded key handed to another adult as a link, a QR code or a printed ticket.
//
// A ticket is an ordinary key. It is made with POST /keys and funded from the giver's own wallet through the deposit
// router, like any deposit, so the product rules hold unchanged: credit never moves between keys, and what is left can
// only go back to the wallet that paid (POST /withdraw with the ticket's key).
//
// The ticket's key lives in two places and nowhere else: this device (the list below, under the prefix that "Wipe this
// device" clears) and the ticket itself. In the link it rides in the fragment, which a browser keeps to itself: it is
// not part of any request. Nothing here logs a key.

import { DEVICE_PREFIX, deviceStore, readJson, writeJson } from './device-store.ts';
import { isApiKey } from './key-store.ts';
import { formatUsd, MUSD_PER_USD, parseUsd } from './money.ts';
import type { MicroUsd, PayoutChain } from './types.ts';

// ---- the link ---------------------------------------------------------------------------------------------------

export const TICKET_PATH = '/ticket';
const KEY_PARAM = 'k';

/** `<origin>/ticket#k=<key>`. The key is in the fragment and never in the path or the query. */
export function ticketLink(origin: string, key: string): string {
  if (!isApiKey(key) || key !== key.trim()) throw new Error('A ticket needs an Anonymo key.');
  return `${origin.replace(/\/+$/, '')}${TICKET_PATH}#${KEY_PARAM}=${key}`;
}

/** The key in a fragment (`#k=…`, with or without the `#`), or null. */
export function keyFromFragment(fragment: string): string | null {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq) !== KEY_PARAM) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return null;
    }
    return isApiKey(value) && value === value.trim() ? value : null;
  }
  return null;
}

/** The key in a whole ticket link, or null. Only the fragment is read: a key in the path or the query is not a ticket. */
export function keyFromLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.pathname.replace(/\/+$/, '') !== TICKET_PATH) return null;
  return keyFromFragment(url.hash);
}

// ---- amount and expiry ------------------------------------------------------------------------------------------

/** The amounts offered as one tap. Any amount between the two limits can be typed. */
export const TICKET_AMOUNTS: readonly MicroUsd[] = [1, 5, 10, 25].map((usd) => usd * MUSD_PER_USD);
/** The gateway's smallest withdrawal is $1 by default, so a smaller ticket could never be taken back. */
export const TICKET_MIN: MicroUsd = 1 * MUSD_PER_USD;
/** A ticket is spendable by whoever holds it, so it is kept small. */
export const TICKET_MAX: MicroUsd = 100 * MUSD_PER_USD;
const CENT = MUSD_PER_USD / 100;

export type AmountCheck = { ok: true; musd: MicroUsd } | { ok: false; reason: string };

/** A typed ticket amount: plain dollars and whole cents, between the smallest and the largest ticket. */
export function checkTicketAmount(input: string): AmountCheck {
  const musd = parseUsd(input);
  if (musd === null) return { ok: false, reason: 'Enter an amount in dollars, like 5 or 7.50.' };
  if (musd % CENT !== 0) return { ok: false, reason: 'Use whole cents, like 7.50.' };
  if (musd < TICKET_MIN) return { ok: false, reason: `The smallest ticket is ${formatUsd(TICKET_MIN)}.` };
  if (musd > TICKET_MAX) return { ok: false, reason: `The largest ticket is ${formatUsd(TICKET_MAX)}.` };
  return { ok: true, musd };
}

/** Days offered for the expiry; `null` is "no expiry". */
export const TICKET_EXPIRY_DAYS: readonly (number | null)[] = [7, 30, 90, null];
export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_EXPIRY_DAYS = 365;
const DAY_MS = 86_400_000;

export const validExpiryDays = (days: unknown): days is number | null =>
  days === null || (typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= MAX_EXPIRY_DAYS);

/** When a ticket made at `now` stops working, as the ISO time POST /keys takes for `caps.expires_at`; null = never. */
export function expiryFor(days: number | null, now: number): string | null {
  if (!validExpiryDays(days)) throw new RangeError(`Expiry is 1 to ${MAX_EXPIRY_DAYS} whole days, or none.`);
  return days === null ? null : new Date(now + days * DAY_MS).toISOString();
}

/** Whole days until the expiry, rounded up; 0 once it has passed; null when there is none. */
export function daysLeft(expiresAt: string | null, now: number): number | null {
  if (expiresAt === null) return null;
  const ms = Date.parse(expiresAt) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / DAY_MS) : 0;
}

/** "30 days left", to the nearest day, so a ticket made a moment ago with 30 days reads 30 and not 29 or 31. */
export function timeLeft(expiresAt: string, now: number): string {
  const days = Math.round((Date.parse(expiresAt) - now) / DAY_MS);
  return days >= 2 ? `${days} days left` : days === 1 ? '1 day left' : 'less than a day left';
}

// ---- a ticket this device gave ----------------------------------------------------------------------------------

export type TicketSource = { chain: PayoutChain; address: string };
/** `none`: nothing paid yet. `pending`: paid, waiting for the gateway. `held`: received but not spendable. */
export type TicketCredit = 'none' | 'pending' | 'credited' | 'held';
/** What the gateway last said about the key itself. */
export type TicketKeyState = 'ok' | 'expired' | 'unknown';

export type GivenTicket = {
  id: string;
  /** The ticket's key. This list and the ticket itself are the only copies. */
  key: string;
  amountMusd: MicroUsd;
  createdAt: string;
  expiresAt: string | null;
  credit: TicketCredit;
  /** The payment transaction, kept so the wait for credit can pick up after a reload. */
  txHash: string | null;
  /** The wallet that paid: the only place unspent credit can go back to. */
  paidFrom: TicketSource | null;
  /** What the gateway last said is left, and when it said so. Null until it has answered. */
  leftMusd: MicroUsd | null;
  checkedAt: string | null;
  takenBackMusd: MicroUsd;
  keyState: TicketKeyState;
};

export function newTicket(o: { id: string; key: string; amountMusd: MicroUsd; createdAt: string; expiresAt: string | null }): GivenTicket {
  return { ...o, credit: 'none', txHash: null, paidFrom: null, leftMusd: null, checkedAt: null, takenBackMusd: 0, keyState: 'ok' };
}

/** What can happen to a ticket after it is made. Each is something the wallet or the gateway reported. */
export type TicketEvent =
  | { type: 'payment_sent'; txHash: string; from: TicketSource | null }
  | { type: 'credited'; amountMusd: MicroUsd; from: TicketSource }
  | { type: 'held' }
  | { type: 'balance'; leftMusd: MicroUsd; at: string; from?: TicketSource | null }
  | { type: 'taken_back'; amountMusd: MicroUsd; at: string }
  | { type: 'key_expired' }
  | { type: 'key_unknown' };

/** The ticket after an event. Pure: the same ticket and event always give the same result, and applying one twice is safe. */
export function reduceTicket(t: GivenTicket, e: TicketEvent): GivenTicket {
  switch (e.type) {
    case 'payment_sent':
      return { ...t, txHash: e.txHash, paidFrom: t.paidFrom ?? e.from, credit: t.credit === 'none' ? 'pending' : t.credit };
    case 'credited':
      // The gateway's own figure wins over what was asked for. A repeat does not reset what is left.
      return { ...t, credit: 'credited', amountMusd: e.amountMusd, paidFrom: e.from, leftMusd: t.credit === 'credited' ? t.leftMusd : (t.leftMusd ?? e.amountMusd), keyState: 'ok' };
    case 'held':
      return t.credit === 'credited' ? t : { ...t, credit: 'held' };
    case 'balance':
      return {
        ...t,
        leftMusd: e.leftMusd,
        checkedAt: e.at,
        keyState: 'ok', // the gateway answered, so the key works
        // Only fills a gap: the wallet recorded with the payment is never replaced by a guess from the balance.
        paidFrom: t.paidFrom ?? e.from ?? null,
        // A balance above zero proves the payment arrived, even if this device never saw the deposit row.
        credit: e.leftMusd > 0 && t.credit !== 'held' ? 'credited' : t.credit,
      };
    case 'taken_back':
      return { ...t, takenBackMusd: t.takenBackMusd + e.amountMusd, leftMusd: Math.max(0, (t.leftMusd ?? e.amountMusd) - e.amountMusd), checkedAt: e.at };
    case 'key_expired':
      return { ...t, keyState: 'expired' };
    case 'key_unknown':
      return { ...t, keyState: 'unknown' };
  }
}

export type TicketStatus = 'unpaid' | 'pending' | 'held' | 'ready' | 'in_use' | 'used_up' | 'taken_back' | 'expired' | 'unknown';

export const hasExpired = (t: Pick<GivenTicket, 'expiresAt' | 'keyState'>, now: number) =>
  t.keyState === 'expired' || (t.expiresAt !== null && Date.parse(t.expiresAt) <= now);

/** Where a ticket stands, in the order a giver cares about: is it gone, is it empty, has it expired, is it in use. */
export function ticketStatus(t: GivenTicket, now: number): TicketStatus {
  if (t.keyState === 'unknown') return 'unknown';
  if (t.credit === 'credited' && t.leftMusd === 0) return t.takenBackMusd > 0 ? 'taken_back' : 'used_up';
  if (hasExpired(t, now)) return 'expired';
  if (t.credit === 'none') return 'unpaid';
  if (t.credit === 'pending') return 'pending';
  if (t.credit === 'held') return 'held';
  return t.leftMusd === null || t.leftMusd >= t.amountMusd ? 'ready' : 'in_use';
}

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  unpaid: 'Not paid',
  pending: 'Waiting for credit',
  held: 'Held for review',
  ready: 'Not used yet',
  in_use: 'In use',
  used_up: 'Used up',
  taken_back: 'Taken back',
  expired: 'Expired',
  unknown: 'Not found',
};

/** Nothing more can change for these, so they are not asked about again on every visit. */
export const isSettled = (status: TicketStatus) => status === 'taken_back' || status === 'used_up' || status === 'unknown';

/**
 * Whether "Take back what's left" can be offered: the credit arrived, some is left, and the gateway has not refused
 * the key. It refuses an expired key on every route, POST /withdraw included (gateway/src/api/auth.ts), so once it
 * has said so there is nothing to offer.
 */
export const canTakeBack = (t: GivenTicket) => t.credit === 'credited' && t.keyState === 'ok' && (t.leftMusd ?? 0) > 0;

/** A ticket that still holds credit and expires within `withinDays`: the giver should take it back before then. */
export function expiresSoon(t: GivenTicket, now: number, withinDays = 3): boolean {
  const days = daysLeft(t.expiresAt, now);
  return canTakeBack(t) && days !== null && days > 0 && days <= withinDays;
}

// ---- kept on this device ----------------------------------------------------------------------------------------

/** Live and demo tickets are kept apart, both under the prefix that "Wipe this device" removes. */
export const ticketsSlot = (demo: boolean) => `${DEVICE_PREFIX}${demo ? 'demo.' : ''}tickets.v1`;
export const MAX_TICKETS = 200;

const SOURCE_OK = (s: unknown) => s === null || (typeof s === 'object' && typeof (s as TicketSource).chain === 'string' && typeof (s as TicketSource).address === 'string');

export function isGivenTicket(value: unknown): value is GivenTicket {
  const t = value as GivenTicket | null;
  return (
    !!t &&
    typeof t === 'object' &&
    typeof t.id === 'string' &&
    typeof t.key === 'string' &&
    isApiKey(t.key) &&
    Number.isSafeInteger(t.amountMusd) &&
    t.amountMusd > 0 &&
    typeof t.createdAt === 'string' &&
    (t.expiresAt === null || typeof t.expiresAt === 'string') &&
    ['none', 'pending', 'credited', 'held'].includes(t.credit) &&
    (t.txHash === null || typeof t.txHash === 'string') &&
    SOURCE_OK(t.paidFrom) &&
    (t.leftMusd === null || Number.isSafeInteger(t.leftMusd)) &&
    (t.checkedAt === null || typeof t.checkedAt === 'string') &&
    Number.isSafeInteger(t.takenBackMusd) &&
    ['ok', 'expired', 'unknown'].includes(t.keyState)
  );
}

export function loadTickets(demo: boolean): GivenTicket[] {
  const parsed = readJson<unknown>(ticketsSlot(demo), []);
  return Array.isArray(parsed) ? parsed.filter(isGivenTicket).slice(0, MAX_TICKETS) : [];
}

const stores = { live: deviceStore<GivenTicket[]>(() => loadTickets(false), []), demo: deviceStore<GivenTicket[]>(() => loadTickets(true), []) };
export const ticketsStore = (demo: boolean) => (demo ? stores.demo : stores.live);

/** Rewrites the list. False when the browser would not keep it, in which case nothing changed. */
function change(demo: boolean, update: (list: GivenTicket[]) => GivenTicket[]): boolean {
  const ok = writeJson(ticketsSlot(demo), update(loadTickets(demo)).slice(0, MAX_TICKETS));
  ticketsStore(demo).changed();
  return ok;
}

/**
 * Keeps a new ticket on this device, newest first. Returns false when the browser will not store it or the list is
 * full: the caller must then stop before any payment, because a key that is not kept here could never be taken back.
 */
export function keepTicket(demo: boolean, ticket: GivenTicket): boolean {
  if (loadTickets(demo).filter((t) => t.id !== ticket.id).length >= MAX_TICKETS) return false;
  if (!change(demo, (list) => [ticket, ...list.filter((t) => t.id !== ticket.id)])) return false;
  return loadTickets(demo).some((t) => t.id === ticket.id && t.key === ticket.key);
}

export const applyToTicket = (demo: boolean, id: string, event: TicketEvent) =>
  change(demo, (list) => list.map((t) => (t.id === id ? reduceTicket(t, event) : t)));

/** Removes a ticket from this device. Its key is then gone from here for good. */
export const forgetTicket = (demo: boolean, id: string) => change(demo, (list) => list.filter((t) => t.id !== id));
