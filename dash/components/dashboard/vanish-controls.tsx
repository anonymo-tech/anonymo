'use client';

import { Timer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { setChatExpiry } from '@/lib/anonymo/vanish-history';
import type { SavedChat } from '@/lib/anonymo/history';
import { MINUTE_MS, expiryChoice, neutralUrl, savedExpiry, timeLeft, type ExpiryChoice } from '@/lib/anonymo/vanish';
import { setVanishPrefs, vanishStore } from '@/lib/anonymo/vanish-prefs';

function ExpiryOptions({ label, value, onChange }: { label: string; value: ExpiryChoice; onChange: (choice: ExpiryChoice) => void }) {
  return (
    <select className="select vanish-select" aria-label={label} value={value} onChange={(e) => onChange(expiryChoice(e.target.value))}>
      <option value="never">Never delete</option>
      <option value="hour">After 1 hour</option>
      <option value="day">After 1 day</option>
      <option value="week">After 1 week</option>
    </select>
  );
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, MINUTE_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return (
    <span className="chip chip-amber vanish-badge" title="Time until this chat is deleted">
      <Timer size={13} aria-hidden="true" /> {timeLeft(expiresAt, now)}
    </span>
  );
}

export function VanishBadge({ expiresAt }: { expiresAt?: number }) {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? <Countdown expiresAt={expiresAt} /> : null;
}

export function ChatExpiry({ chat, demo, onExpired }: { chat: SavedChat; demo: boolean; onExpired: () => void }) {
  return (
    <div className="vanish-chat-expiry">
      <ExpiryOptions label="Delete this chat after its last message" value={savedExpiry(chat)} onChange={(value) => {
        if (setChatExpiry(demo, chat.id, value)) onExpired();
      }} />
      <VanishBadge expiresAt={chat.expiresAt} />
    </div>
  );
}

function NeutralPageField({ page }: { page: string }) {
  const [value, setValue] = useState(page);
  const [error, setError] = useState('');
  return (
    <form className="field" onSubmit={(e) => {
      e.preventDefault();
      const url = neutralUrl(value);
      if (!url) {
        setError('Enter a valid HTTPS URL.');
        return;
      }
      if (!setVanishPrefs({ neutralPage: url })) {
        setError('Could not save this setting.');
        return;
      }
      setError('');
      setValue(url);
    }}>
      <label htmlFor="vanish-neutral-page">Neutral page</label>
      <div className="vanish-url">
        <input id="vanish-neutral-page" className="input" type="text" inputMode="url" value={value} spellCheck={false}
          aria-invalid={!!error} aria-describedby={error ? 'vanish-url-error' : undefined}
          onChange={(e) => { setValue(e.target.value); setError(''); }} />
        <button type="submit" className="btn btn-small" disabled={value === page}>Save</button>
      </div>
      {error && <small id="vanish-url-error" role="alert">{error}</small>}
    </form>
  );
}

export function VanishSettings() {
  const { defaultExpiry, panicOn, neutralPage, wipeOnPanic } = useDeviceStore(vanishStore);
  return (
    <details className="field-help vanish-settings">
      <summary>History settings</summary>
      <div className="vanish-fields">
        <label className="field">
          <span>Delete new chats after their last message</span>
          <ExpiryOptions label="Delete new chats after their last message" value={defaultExpiry}
            onChange={(value) => setVanishPrefs({ defaultExpiry: value })} />
        </label>
        <label className="switch-row">
          <input type="checkbox" role="switch" checked={panicOn} aria-labelledby="vanish-panic-label" aria-describedby="vanish-panic-hint"
            onChange={(e) => setVanishPrefs({ panicOn: e.target.checked })} />
          <span>
            <strong id="vanish-panic-label">Panic key</strong>
            <small id="vanish-panic-hint">Press Escape 3 times quickly to leave the workspace.</small>
          </span>
        </label>
        <NeutralPageField key={neutralPage} page={neutralPage} />
        <label className="switch-row">
          <input type="checkbox" role="switch" checked={wipeOnPanic} aria-labelledby="vanish-wipe-label" aria-describedby="vanish-wipe-hint"
            onChange={(e) => setVanishPrefs({ wipeOnPanic: e.target.checked })} />
          <span>
            <strong id="vanish-wipe-label">Also wipe this device</strong>
            <small id="vanish-wipe-hint">Using the panic key erases your saved chats, keys and settings on this device.</small>
          </span>
        </label>
      </div>
    </details>
  );
}
