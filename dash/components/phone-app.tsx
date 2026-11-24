'use client';

import { Download, PlusSquare, Share, Smartphone, X } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { API_BASE } from '@/lib/anonymo/config';
import { APP_DISMISSAL, APP_SCOPE, APP_WORKER, canRunAppWorker, isIosSafari } from '@/lib/anonymo/phone-app';
import './phone-app.css';

type InstallEvent = Event & {
  prompt: () => Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const InstallContext = createContext<{
  ios: boolean;
  install: (() => void) | null;
  dismiss: () => void;
} | null>(null);

const PHONE = '(max-width: 720px)';
const STANDALONE = '(display-mode: standalone)';

function subscribeToDisplay(change: () => void) {
  const phone = matchMedia(PHONE);
  const standalone = matchMedia(STANDALONE);
  phone.addEventListener('change', change);
  standalone.addEventListener('change', change);
  return () => {
    phone.removeEventListener('change', change);
    standalone.removeEventListener('change', change);
  };
}

function displayMode() {
  if (!matchMedia(PHONE).matches || matchMedia(STANDALONE).matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone) return null;
  return isIosSafari(navigator.userAgent, navigator.maxTouchPoints) ? 'ios' : 'prompt';
}

function subscribeToDismissal(change: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_DISMISSAL || event.key === null) change();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

function readDismissal() {
  try { return localStorage.getItem(APP_DISMISSAL) === '1'; } catch { return false; }
}

export function PhoneApp({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(subscribeToDisplay, displayMode, () => null);
  const dismissedOnDevice = useSyncExternalStore(subscribeToDismissal, readDismissal, () => false);
  const [dismissed, setDismissed] = useState(false);
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);

  function dismiss() {
    setDismissed(true);
    setPrompt(null);
    try { localStorage.setItem(APP_DISMISSAL, '1'); } catch { /* storage is blocked */ }
  }

  useEffect(() => {
    const offer = (event: Event) => {
      if (displayMode() !== 'prompt') return;
      event.preventDefault();
      setPrompt(event as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', offer);
    window.addEventListener('appinstalled', dismiss);
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator &&
        canRunAppWorker(API_BASE, window.location.href)) {
      void navigator.serviceWorker.register(APP_WORKER, { scope: APP_SCOPE, updateViaCache: 'none' }).catch(() => {});
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', offer);
      window.removeEventListener('appinstalled', dismiss);
    };
  }, []);

  async function install() {
    if (!prompt) return;
    setPrompt(null);
    try {
      await prompt.prompt();
      await prompt.userChoice;
      dismiss();
    } catch { /* the browser withdrew the offer */ }
  }

  const offer = !dismissed && !dismissedOnDevice && (mode === 'ios' || (mode === 'prompt' && prompt))
    ? { ios: mode === 'ios', install: prompt ? () => void install() : null, dismiss }
    : null;
  return <InstallContext.Provider value={offer}>{children}</InstallContext.Provider>;
}

export function InstallAppCard() {
  const offer = useContext(InstallContext);
  const title = useId();
  if (!offer) return null;
  return (
    <section className="notice install-app" aria-labelledby={title}>
      <header>
        <Smartphone size={19} aria-hidden="true" />
        <h2 id={title}>Install the app</h2>
        <button type="button" className="btn btn-ghost" aria-label="Dismiss app install" onClick={offer.dismiss}>
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <p>Open Anonymo from your Home Screen. Your key stays on this phone.</p>
      {offer.ios ? (
        <>
          <ol>
            <li><Share size={16} aria-hidden="true" /> Tap <strong>Share</strong> in Safari.</li>
            <li><PlusSquare size={16} aria-hidden="true" /> Tap <strong>Add to Home Screen</strong>.</li>
          </ol>
          <p className="muted">If the app asks for a key, paste the one you already use.</p>
        </>
      ) : (
        <button type="button" className="btn btn-primary btn-small" onClick={offer.install ?? undefined}>
          <Download size={16} aria-hidden="true" /> Install Anonymo
        </button>
      )}
    </section>
  );
}
