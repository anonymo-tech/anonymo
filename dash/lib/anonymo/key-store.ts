// The API key lives only in this browser. The gateway stores sha256(key) and cannot show it again, so the dashboard
// asks before remembering it and offers to forget it at any time. It is sent nowhere except as the Authorization
// header of gateway calls.

import { isDemoMode } from './config.ts';
import { deviceStore } from './device-store.ts';
import { clearAllAttempts } from './topup-attempt.ts';
import { TELEGRAM_SESSION } from './telegram.ts';
import { updateOn } from './updates.ts';

const KEY_RE = /^anm_(live|test)_[A-Za-z0-9_-]{16,128}$/;

export const isApiKey = (value: string) => KEY_RE.test(value.trim());

const slot = (demo: boolean) => (demo ? 'anonymo.demo.key' : 'anonymo.key');
// Used when browser storage is blocked: the key then lasts for this page only.
const memory: Record<string, string | null> = {};
const TELEGRAM_SLOT = 'anonymo.telegram-session';
let session: { key: string; expiry: number } | null = null;

function telegramSession() {
  let saved = session;
  try {
    if (!saved) saved = JSON.parse(sessionStorage.getItem(TELEGRAM_SLOT) ?? 'null');
  } catch { /* Storage may be unavailable. */ }
  return saved && TELEGRAM_SESSION.test(saved.key) && saved.expiry > Date.now() ? saved.key : null;
}

export function saveTelegramSession(key: string, expiresAt: string) {
  const expiry = Date.parse(expiresAt);
  if (!TELEGRAM_SESSION.test(key) || !(expiry > Date.now())) throw new Error('This Telegram session has expired.');
  session = { key, expiry };
  try { sessionStorage.setItem(TELEGRAM_SLOT, JSON.stringify(session)); } catch { /* Kept for this page. */ }
  keyStore.changed();
}

function forgetTelegramSession() {
  session = null;
  try { sessionStorage.removeItem(TELEGRAM_SLOT); } catch { /* Storage may be unavailable. */ }
}


export function loadKey(demo: boolean): string | null {
  if (!demo && updateOn('telegram', false)) {
    const temporary = telegramSession();
    if (temporary) return temporary;
  }
  let value: string | null = null;
  try {
    value = localStorage.getItem(slot(demo)) ?? sessionStorage.getItem(slot(demo));
  } catch {
    value = null;
  }
  value ??= memory[slot(demo)] ?? null;
  return value && isApiKey(value) ? value : null;
}

/** `remember` keeps the key across browser restarts; otherwise it lasts for this tab only. */
export function saveKey(demo: boolean, key: string, remember: boolean) {
  if (!isApiKey(key)) throw new Error('That does not look like an Anonymo key (anm_live_…).');
  if (!demo && updateOn('telegram', false)) forgetTelegramSession();
  forgetKey(demo);
  memory[slot(demo)] = key.trim();
  try {
    (remember ? localStorage : sessionStorage).setItem(slot(demo), key.trim());
  } catch {
    // storage blocked: kept in memory only
  }
  keyStore.changed();
}

export function forgetKey(demo: boolean) {
  if (!demo && updateOn('telegram', false) && telegramSession()) {
    forgetTelegramSession();
    keyStore.changed();
    return;
  }
  memory[slot(demo)] = null;
  try {
    localStorage.removeItem(slot(demo));
    sessionStorage.removeItem(slot(demo));
    clearAllAttempts(localStorage); // an open top-up belongs to the key that started it
  } catch {
    // nothing was stored
  }
  keyStore.changed();
}

/** The key held for the current mode (demo or live). */
export const keyStore = deviceStore<string | null>(() => loadKey(isDemoMode()), null);

export const maskKey = (key: string) => `${key.slice(0, 13)}…${key.slice(-4)}`;
