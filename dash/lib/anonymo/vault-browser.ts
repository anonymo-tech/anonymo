import { createVault, historySlot, type VaultNotice } from './vault.ts';
import { vaultDisk } from './vault-db.ts';

const hiddenSetting = 'anonymo.vault.lock-hidden.v1';
const idleMs = 15 * 60_000;
const hiddenMs = 5 * 60_000;

let channel: BroadcastChannel | undefined;
let started = false;
let reschedule = () => {};

export const vault = createVault({
  disk: vaultDisk,
  legacy: () => localStorage,
  exclusive: async (operation) => navigator.locks?.request('anonymo.vault.storage.v1', operation) ?? operation(),
  announce: (notice) => channel?.postMessage(notice),
});

export function lockWhenHidden() {
  try {
    return localStorage.getItem(hiddenSetting) !== 'off';
  } catch {
    return true;
  }
}

export function setLockWhenHidden(on: boolean) {
  localStorage.setItem(hiddenSetting, on ? 'on' : 'off');
  reschedule();
}

export function startVault() {
  if (started || typeof window === 'undefined') return;
  started = true;
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('anonymo.vault.v1');
    channel.onmessage = ({ data }: MessageEvent<VaultNotice>) => { void vault.received(data).catch(() => {}); };
  }
  reschedule = watchAutoLock(vault, window, document, lockWhenHidden);
  window.addEventListener('storage', (event) => {
    if (event.key === hiddenSetting) reschedule();
    if (event.key === null || event.key === historySlot(false) || event.key === historySlot(true))
      void vault.refresh().catch(() => {});
  });
  void vault.refresh().catch(() => {});
}

export function watchAutoLock(
  session: Pick<typeof vault, 'state' | 'subscribe' | 'lock'>,
  events: EventTarget,
  documentState: EventTarget & { readonly hidden: boolean },
  hiddenEnabled: () => boolean,
) {
  // The last time this tab was interacted with is kept only in memory.
  let lastActivity = Date.now();
  let hiddenAt = documentState.hidden ? lastActivity : null;
  let timeout: ReturnType<typeof setTimeout>;
  let wasUnlocked = false;

  function check() {
    clearTimeout(timeout);
    if (session.state().mode !== 'unlocked') return;
    const idleDeadline = lastActivity + idleMs;
    const hiddenDeadline = hiddenAt !== null && hiddenEnabled() ? hiddenAt + hiddenMs : Infinity;
    const remaining = Math.min(idleDeadline, hiddenDeadline) - Date.now();
    if (remaining <= 0) session.lock();
    else timeout = setTimeout(check, remaining);
  }

  session.subscribe(() => {
    const unlocked = session.state().mode === 'unlocked';
    if (unlocked && !wasUnlocked) {
      lastActivity = Date.now();
      if (documentState.hidden) hiddenAt = lastActivity;
    }
    wasUnlocked = unlocked;
    check();
  });
  for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel']) {
    events.addEventListener(event, () => {
      if (session.state().mode !== 'unlocked' || documentState.hidden) return;
      // A delayed timer must not let the first interaction after the deadline extend the session.
      if (Date.now() - lastActivity >= idleMs) session.lock();
      else lastActivity = Date.now();
    }, { passive: true, capture: true });
  }
  documentState.addEventListener('visibilitychange', () => {
    check();
    hiddenAt = documentState.hidden ? Date.now() : null;
    check();
  });
  events.addEventListener('pagehide', () => {
    if (session.state().mode === 'unlocked') session.lock();
  });
  return check;
}

export function enableDeviceVault(passphrase: string) {
  if (!navigator.locks || !crypto.subtle || !channel) throw new Error('Vault setup needs a browser with secure device storage.');
  return vault.enable(passphrase);
}

export function lockDeviceVault() {
  vault.lock();
  channel?.postMessage('locked');
}
