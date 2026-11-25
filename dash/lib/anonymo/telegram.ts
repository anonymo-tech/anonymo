export const TELEGRAM_NOTICE = 'Telegram keeps messages sent here. The full app is where nobody keeps the chat.';
export const TELEGRAM_SESSION = /^anm_tg_[a-f0-9]{64}$/;

export function telegramInitFromFragment(hash: string) {
  const fields = new URLSearchParams(hash.slice(1));
  const values = fields.getAll('tgWebAppData');
  return values.length === 1 && values[0].length > 0 && values[0].length <= 16_384 ? values[0] : null;
}

export function handoffFromFragment(hash: string) {
  return /^#handoff=([a-f0-9]{64})$/.exec(hash)?.[1] ?? null;
}

export function takeTelegramFragment(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'state' | 'replaceState'>) {
  const { hash, pathname, search } = location;
  try {
    if (hash) history.replaceState(history.state, '', pathname + search);
  } catch {
    return '';
  }
  return hash;
}

type BridgeWindow = Window & {
  TelegramWebviewProxy?: { postEvent: (type: string, data: string) => void };
  external: External & { notify?: (event: string) => void };
};

/** Use the host's bridge without loading third-party script on the API key's origin. */
export function telegramEvent(host: BridgeWindow, eventType: string, eventData?: object) {
  try {
    if (host.TelegramWebviewProxy?.postEvent) {
      host.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData ?? null));
      return true;
    }
    const message = JSON.stringify({ eventType, eventData });
    if (host.external?.notify) {
      host.external.notify(message);
      return true;
    }
    if (host.parent !== host) {
      host.parent.postMessage(message, 'https://web.telegram.org');
      return true;
    }
  } catch { /* Let an ordinary anchor handle this client. */ }
  return false;
}

export function telegramWorkspaceUrl(value: string, origin: string) {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.search) return null;
    if (url.pathname === '/dashboard/chat' && !url.hash) return url.href;
    return url.pathname === '/telegram/handoff' && handoffFromFragment(url.hash) ? url.href : null;
  } catch {
    return null;
  }
}
