'use client';

import { useState, type ReactNode } from 'react';
import { CopyButton } from '../copy-button';

export function NewKeyReveal({ secret, action, remember, onRememberChange, onContinue, onAddFunds, safe }: {
  secret: string;
  action: string;
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
  onContinue: (remember: boolean) => void;
  onAddFunds?: (remember: boolean) => void;
  /** Update "keysafe": the passkey controls, which tick "stored" once the key is saved to a passkey. */
  safe?: (markSaved: () => void) => ReactNode;
}) {
  const [saved, setSaved] = useState(false);

  return (
    <section className="key-reveal" aria-labelledby="key-title">
      <h2 id="key-title">Your key. This is the only time it is shown.</h2>
      <p className="muted">
        {safe
          ? 'Save your key to your passkey or copy it somewhere private. Anyone holding this key can spend its credit.'
          : 'Anonymo keeps only a hash of it and cannot show it again or recover it. Anyone holding this key can spend its credit, so store it like a password.'}
      </p>
      <code>{secret}</code>
      <div className="row">
        <CopyButton text={secret} label="Copy key" />
        <label className="checkbox">
          <input type="checkbox" checked={remember} onChange={(e) => onRememberChange(e.target.checked)} />
          Remember on this device
        </label>
      </div>
      {safe?.(() => setSaved(true))}
      <label className="checkbox">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I have stored this key somewhere safe
      </label>
      <div className="row">
        {onAddFunds && <button type="button" className="btn btn-primary" disabled={!saved} onClick={() => onAddFunds(remember)}>Add funds</button>}
        <button type="button" className={onAddFunds ? 'btn' : 'btn btn-primary'} disabled={!saved} onClick={() => onContinue(remember)}>
          {action}
        </button>
      </div>
    </section>
  );
}
