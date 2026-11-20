'use client';

import { LockKeyhole, LockKeyholeOpen, Settings2, X } from 'lucide-react';
import {
  useEffect, useId, useRef, useState, useSyncExternalStore,
  type FormEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnonymo } from '../anonymo-provider';
import { enableDeviceVault, lockDeviceVault, lockWhenHidden, setLockWhenHidden, startVault, vault } from '@/lib/anonymo/vault-browser';
import { VaultLocked, historySlot } from '@/lib/anonymo/vault';
import { WrongPassphrase } from '@/lib/anonymo/vault-crypto';

const serverState = { mode: 'loading', revision: 0 } as const;
export function useVault() {
  useEffect(startVault, []);
  return useSyncExternalStore(vault.subscribe, vault.state, () => serverState);
}

export function VaultModal({ title, close, children, busy = false }: {
  title: string;
  close: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    node?.querySelector<HTMLInputElement>('[data-vault-focus]')?.focus();
    return () => node?.close();
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className="vault-modal"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation(); }}
    >
      <div className="vault-modal-body">
        <header className="vault-modal-head">
          <h2 id={id}>{title}</h2>
          <button className="icon-btn" type="button" aria-label="Close" onClick={close} disabled={busy}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}

type Action = 'change' | 'disable';

function Passphrase({ name, label, fresh = false, focus = false }: { name: string; label: string; fresh?: boolean; focus?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" name={name} type="password" autoComplete={fresh ? 'new-password' : 'current-password'} autoFocus={focus} data-vault-focus={focus || undefined} required />
    </label>
  );
}

function VaultDialog({ close }: { close: () => void }) {
  const { mode } = useVault();
  const [action, setAction] = useState<Action | null>(null);
  const [hidden, setHidden] = useState(lockWhenHidden);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kind = mode === 'locked' ? 'unlock' : mode === 'off' ? 'enable' : mode === 'unlocked' ? (action ?? 'settings') : mode;
  const label = {
    enable: 'Set up vault', unlock: 'Unlock vault', settings: 'Vault settings',
    change: 'Change passphrase', disable: 'Turn off vault', loading: 'Vault', unavailable: 'Vault',
  }[kind];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const passphrase = String(fields.get('passphrase') ?? '');
    const replacement = String(fields.get('replacement') ?? '');
    if ((kind === 'enable' || kind === 'change') && replacement !== fields.get('confirmation')) {
      setError('The passphrases don’t match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (kind === 'enable') await enableDeviceVault(replacement);
      if (kind === 'unlock') await vault.unlock(passphrase);
      if (kind === 'change') await vault.changePassphrase(passphrase, replacement);
      if (kind === 'disable') await vault.disable(passphrase);
      close();
    } catch (err) {
      if (err instanceof WrongPassphrase || err instanceof VaultLocked) setError(err.message);
      else setError('Couldn’t update the vault. Check that secure browser storage is available.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <VaultModal title={label} close={close} busy={busy}>
      {kind === 'unavailable' ? <p role="alert">The vault can’t access device storage.</p> : kind === 'loading' ? <p role="status">Reading device storage…</p> : kind === 'settings' ? (
        <div className="vault-fields">
          <p>Saved chats and library images are encrypted. The vault locks after 15 minutes of inactivity.</p>
          <label className="vault-check">
            <input type="checkbox" checked={hidden} onChange={(event) => {
              try {
                setLockWhenHidden(event.target.checked);
                setHidden(event.target.checked);
                setError('');
              } catch {
                setError('Couldn’t save this setting.');
              }
            }} />
            Lock after 5 minutes when this tab is hidden
          </label>
          <div className="vault-actions">
            <button type="button" className="btn btn-small" onClick={() => { lockDeviceVault(); close(); }}>Lock vault</button>
            <button type="button" className="btn btn-small" onClick={() => { setError(''); setAction('change'); }}>Change passphrase</button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => { setError(''); setAction('disable'); }}>Turn off vault</button>
          </div>
        </div>
      ) : (
        <form className="vault-fields" onSubmit={submit} key={kind}>
          {kind === 'enable' && <p>Encrypt saved chats and library images. If you forget your passphrase, the only way out is Wipe this device. It deletes your saved data.</p>}
          {kind === 'unlock' && <p>Enter your passphrase to open saved chats and images.</p>}
          {kind === 'disable' && <p>Saved chats and library images will stay on this device without encryption.</p>}
          <fieldset disabled={busy} className="vault-fields">
            {kind !== 'enable' && <Passphrase name="passphrase" label={kind === 'change' ? 'Current passphrase' : 'Passphrase'} focus />}
            {(kind === 'enable' || kind === 'change') && (
              <>
                <Passphrase name="replacement" label={kind === 'change' ? 'New passphrase' : 'Passphrase'} fresh focus={kind === 'enable'} />
                <Passphrase name="confirmation" label="Confirm passphrase" fresh />
              </>
            )}
            <div className="vault-actions">
              <button className="btn btn-primary btn-small" type="submit">{busy ? 'Working…' : label}</button>
              {action && mode === 'unlocked' && <button className="btn btn-ghost btn-small" type="button" onClick={() => { setError(''); setAction(null); }}>Back</button>}
            </div>
          </fieldset>
        </form>
      )}
      {error && <p className="notice notice-rose" role="alert">{error}</p>}
    </VaultModal>
  );
}

export function VaultButton({ top = false, settings = false }: { top?: boolean; settings?: boolean }) {
  const { mode } = useVault();
  const [open, setOpen] = useState(false);
  const directLock = mode === 'unlocked' && !settings;
  const label = mode === 'locked' ? 'Unlock vault' : mode === 'unlocked' ? (settings ? 'Vault settings' : 'Lock vault') : 'Set up vault';
  const Icon = mode === 'locked' ? LockKeyhole : settings && mode === 'unlocked' ? Settings2 : LockKeyholeOpen;

  return (
    <>
      <button
        className={top ? 'icon-btn vault-top-button' : 'btn btn-ghost btn-small'}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup={directLock ? undefined : 'dialog'}
        disabled={mode === 'loading'}
        onClick={() => directLock ? lockDeviceVault() : setOpen(true)}
      >
        <Icon size={16} aria-hidden="true" />
        {!top && label}
      </button>
      {open && <VaultDialog close={() => setOpen(false)} />}
    </>
  );
}

export function VaultTopBar() {
  const { chatId, demo, openChat } = useAnonymo();
  useEffect(() => vault.onLock((chats) => {
    // Closing a saved conversation also removes the copy already open in the live thread.
    if (chats.get(historySlot(demo))?.some((chat) => (chat as { id?: string } | null)?.id === chatId)) openChat(null);
  }), [chatId, demo, openChat]);
  return <VaultButton top />;
}
