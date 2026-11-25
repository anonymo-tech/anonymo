'use client';

import { Fingerprint } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AnonymoApiError, type AnonymoClient } from '@/lib/anonymo/client';
import { localKeySafe, removeKeySafe, restoreFromKeySafe, saveToPasskey, unlockWithPasskey } from '@/lib/anonymo/key-safe';
import { loadKey } from '@/lib/anonymo/key-store';

type Props = {
  client: AnonymoClient;
  demo: boolean;
  apiKey: string | null;
  onSaved?: () => void;
  onUnlocked?: (key: string) => void;
  canRemove?: boolean;
};

export function KeySafeControls({ client, demo, apiKey, onSaved, onUnlocked, canRemove }: Props) {
  const pending = useRef<AbortController | null>(null);
  const [backup, setBackup] = useState(() => localKeySafe(demo));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => () => pending.current?.abort(), []);

  async function run(task: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setNotice('');
    setError('');
    setBusy(true);
    try {
      await task(controller.signal);
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof DOMException && e.name === 'NotAllowedError')
        setError('Passkey verification did not finish. Try again or use a copied key.');
      else if (e instanceof DOMException && e.name === 'NotSupportedError')
        setError('This browser or passkey provider does not support passkey encryption (PRF). Use a copied key instead.');
      else if (e instanceof AnonymoApiError && e.status === 429)
        setError('Too many key safe requests. Wait a moment and try again.');
      else setError(e instanceof TypeError ? 'The key safe could not be reached.' : e instanceof Error ? e.message : 'The key safe could not finish.');
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <>
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={() => void run(async (signal) => {
          if (apiKey) {
            const ids = await saveToPasskey(client, demo, apiKey, signal);
            if (signal.aborted) return;
            setBackup(ids);
            setNotice(demo ? 'Saved to passkey in this browser.' : 'Saved to passkey.');
            onSaved?.();
          } else {
            const opened = await unlockWithPasskey(client, signal);
            if (!signal.aborted && !loadKey(demo) && onUnlocked) await restoreFromKeySafe(demo, opened, onUnlocked);
          }
        })}>
          <Fingerprint size={16} aria-hidden="true" />
          {apiKey ? 'Save to passkey' : 'Unlock with passkey'}
        </button>
        {canRemove && backup && !confirmRemove && (
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove passkey backup</button>
        )}
      </div>
      {canRemove && backup && confirmRemove && (
        <div className="row">
          <p className="faint">Remove the backup last saved or unlocked here? Your key on this device keeps working.</p>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void run(async (signal) => {
            await removeKeySafe(client, demo, backup, signal);
            if (signal.aborted) return;
            setBackup(null);
            setConfirmRemove(false);
            setNotice('Passkey backup removed.');
          })}>Remove backup</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button>
        </div>
      )}
      {busy && <p className="faint" role="status">Waiting for key safe…</p>}
      {notice && <p className="faint" role="status">{notice}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </>
  );
}
