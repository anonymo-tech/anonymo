'use client';

import { useState, type FormEvent } from 'react';
import { Download, Pin, Plus, RefreshCw, Smartphone, Upload } from 'lucide-react';
import { useAnonymo } from '../anonymo-provider';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { readMemorySecret } from '@/lib/anonymo/memory-secret';
import {
  exportRecovery, importRecovery, KINDS, MAX_RECOVERY_BYTES, type MemoryItem, type MemoryKind,
} from '@/lib/anonymo/vault-memory/crypto';
import { ASSISTANT, scopeOf } from '@/lib/anonymo/vault-memory/items';
import {
  bringVaultMemory, enableVaultSync, loadVaultMemory, reconcileBeforeWipe, syncVaultMemory, updateMemoryItem, wipeVaultMemory,
} from '@/lib/anonymo/vault-memory/store';
import { editMemory, getMemory } from '@/lib/anonymo/memory-store';
import { VaultButton } from './vault-controls';
import { PairDevices } from './vault-memory-pair';
import { useMemoryCapacity, useVaultMemory, vaultMemoryTransport } from './vault-memory-state';
import type { MemorySnapshot } from '@/lib/anonymo/vault-memory/store';

function download(name: string, data: string, type: string) {
  const href = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

const labels: Record<MemoryKind, string> = { fact: 'Fact', pref: 'Preference', event: 'Event', summary: 'Summary' };

export function VaultMemoryPage() {
  const { demo } = useAnonymo();
  const { snapshot, mode, error } = useVaultMemory(demo);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');
  if (!snapshot) {
    return <section className="panel memory-panel">
      <p role="status">{error || (mode === 'locked' ? 'Unlock the vault to view your memories.' :
        mode === 'unavailable' ? 'Device storage is unavailable.' : 'Opening your memories…')}</p>
      {mode === 'locked' && <VaultButton />}
    </section>;
  }
  return <MemoryBoard key={String(demo)} snapshot={snapshot} status={status} setStatus={setStatus} error={actionError} setError={setActionError} />;
}

function MemoryBoard({ snapshot, status, setStatus, error, setError }: {
  snapshot: MemorySnapshot;
  status: string;
  setStatus: (status: string) => void;
  error: string;
  setError: (error: string) => void;
}) {
  const { key, demo } = useAnonymo();
  const characters = useDeviceStore(charactersStore);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<'pair' | 'import' | 'export' | 'wipe' | null>(null);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [adding, setAdding] = useState(false);
  const assistant = getMemory(demo, ASSISTANT);
  const items = [...snapshot.items].sort((a, b) => b.weight - a.weight || b.createdAt.localeCompare(a.createdAt));
  const names = new Map(characters.flatMap((character) => [[character.id, character.card.data.name], [scopeOf(character.hash), character.card.data.name]]));
  const name = (id: string | null) => id ? names.get(id) ?? 'Character' : 'Assistant';

  async function run(operation: () => Promise<string | void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try { setStatus((await operation()) ?? ''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'This change could not be saved.'); }
    finally { setBusy(false); }
  }

  const capacityKey = useMemoryCapacity(demo);
  const capacity = capacityKey === undefined ? undefined : { key: capacityKey };

  async function sync() {
    if (demo || !await syncVaultMemory(vaultMemoryTransport, undefined, capacity)) return false;
    return true;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    await run(async () => {
      if (editing) {
        await updateMemoryItem(demo, editing.id, (current) => {
          if (current.text !== editing.text || current.kind !== editing.kind) throw new Error('This memory changed. Open it again to edit.');
          return { ...current, kind, text: draft.trim() };
        });
      } else {
        await editMemory(demo, ASSISTANT, (current) => ({ ...current, facts: [...current.facts, {
          id: crypto.randomUUID(), kind, text: draft.trim(), at: new Date().toISOString(), chatId: null,
        }] }));
      }
      setEditing(null);
      setAdding(false);
      setDraft('');
      return 'Memory saved.';
    });
  }

  async function recovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const passphrase = String(form.get('passphrase') ?? '');
    await run(async () => {
      if (action === 'export') {
        const secret = await readMemorySecret(demo);
        if (!secret) throw new Error('The memory secret is unavailable.');
        const latest = await loadVaultMemory(demo);
        if (!latest || latest.stored.id !== snapshot.stored.id) throw new Error('The active memory vault changed. Try again.');
        const data = await exportRecovery(secret, latest.stored.rows, passphrase);
        download('memory.anovault', data, 'application/octet-stream');
      } else {
        const file = form.get('recovery');
        if (!(file instanceof File) || !file.size || file.size > MAX_RECOVERY_BYTES) throw new Error('Choose a recovery file smaller than 64 MB.');
        const recovered = await importRecovery(await file.text(), passphrase);
        await bringVaultMemory(demo, recovered.secret, recovered.rows, form.has('allowSwitch'));
        setAction(null);
        await sync();
      }
      setAction(null);
      return action === 'export' ? 'Recovery file downloaded.' : 'Recovery file opened.';
    });
  }

  return (
    <div className="vault-memory-layout">
      <section className="panel memory-panel" aria-label="Saved memories">
        <header>
          <h2>Saved memories</h2>
          <span className="memory-stats">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
        </header>
        {items.length ? <ul className="memory-facts">
          {items.map((item) => <li key={item.id}>
            <div>
              <small>{name(item.characterId)} · {labels[item.kind]}{item.weight >= 2 ? ' · Pinned' : ''}</small>
              <p>{item.text}</p>
            </div>
            <div className="row">
              <button type="button" className="btn btn-small" disabled={busy} aria-pressed={item.weight >= 2}
                onClick={() => void run(async () => { await updateMemoryItem(demo, item.id, (current) => ({ ...current, weight: current.weight >= 2 ? 1 : 2 })); })}>
                <Pin size={14} /> {item.weight >= 2 ? 'Unpin' : 'Pin'}
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => {
                setEditing(item); setAdding(false); setDraft(item.text); setKind(item.kind);
              }}>Edit</button>
              <button type="button" className="btn btn-small btn-ghost btn-danger" disabled={busy} onClick={() => void run(async () => {
                await updateMemoryItem(demo, item.id, () => null);
                if (editing?.id === item.id) setEditing(null);
                return 'Memory deleted.';
              })}>Delete</button>
            </div>
          </li>)}
        </ul> : <p className="muted">Save a suggestion after a chat or add a memory here.</p>}
        {editing || adding ? (
          <form className="vault-fields" onSubmit={save}>
            <label className="field">
              <span>{editing ? 'Edit memory' : 'Add assistant memory'}</span>
              <textarea className="textarea" rows={3} value={draft} maxLength={1600} onChange={(event) => setDraft(event.target.value)} />
            </label>
            <label className="field">
              <span>Kind</span>
              <select className="select" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
                {KINDS.map((value) => <option key={value} value={value}>{labels[value]}</option>)}
              </select>
            </label>
            <div className="row">
              <button className="btn btn-small btn-primary" disabled={busy || !draft.trim()}>Save memory</button>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => { setEditing(null); setAdding(false); }}>Cancel</button>
            </div>
          </form>
        ) : <button type="button" className="btn btn-small" onClick={() => { setAdding(true); setDraft(''); setKind('fact'); }}><Plus size={14} /> Add memory</button>}
        <fieldset className="memory-settings" disabled={busy}>
          <legend className="sr-only">Assistant memory settings</legend>
          <label><input type="checkbox" checked={assistant.enabled} onChange={(event) => {
            const enabled = event.target.checked;
            void run(async () => { await editMemory(demo, ASSISTANT, (current) => ({ ...current, enabled, generation: '' })); });
          }} /> Use memory in assistant chats</label>
          <label><input type="checkbox" checked={assistant.autoSave} onChange={(event) => {
            const autoSave = event.target.checked;
            void run(async () => { await editMemory(demo, ASSISTANT, (current) => ({ ...current, autoSave, generation: '' })); });
          }} /> Automatically save assistant suggestions</label>
        </fieldset>
      </section>
      <div className="panel-stack">
        <section className="panel">
          <h2>Sync across devices</h2>
          <p className="muted">Memory is encrypted on this device. Sync sends encrypted items to Anonymo.</p>
          <div className="row">
            {!demo && key && <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void run(async () => {
              if (!await sync()) {
                await enableVaultSync(false, vaultMemoryTransport, key);
                await sync();
              }
              return 'Memory sync is on.';
            })}>{snapshot.stored.sync ? 'Check or enable sync' : 'Enable sync'}</button>}
            {!demo && snapshot.stored.sync && <button type="button" className="btn btn-small" disabled={busy}
              onClick={() => void run(async () => await sync() ? 'Memory is up to date.' : 'Enable sync with a funded key to share this vault.')}>
              <RefreshCw size={14} /> Sync now
            </button>}
            <button type="button" className="btn btn-small" disabled={busy} aria-expanded={action === 'pair'}
              onClick={() => setAction(action === 'pair' ? null : 'pair')}><Smartphone size={15} /> Add this device</button>
          </div>
          {!demo && !snapshot.stored.sync && !key && <p className="muted">A funded key enables sync. You can also join a memory vault from another device.</p>}
          {demo && <p className="muted">Live sync uses a funded Anonymo key.</p>}
          {action === 'pair' && <PairDevices demo={demo} hasMemories={items.length > 0} joined={() => {
            setAction(null);
            void run(async () => {
              if (await sync()) return 'Device added. Memory is up to date.';
              return demo ? 'Device connected.' : 'Device added. Enable sync on the device with your memories.';
            });
          }} />}
        </section>
        <section className="panel">
          <h2>Export and recovery</h2>
          <div className="row">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(async () => {
              const latest = await loadVaultMemory(demo);
              if (!latest) throw new Error('Unlock the memory vault and try again.');
              download('memory.json', JSON.stringify(latest.items, null, 2), 'application/json');
              return 'Plaintext JSON downloaded.';
            })}><Download size={14} /> Export plaintext JSON</button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAction('export')}><Download size={14} /> Export .anovault</button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAction('import')}><Upload size={14} /> Import .anovault</button>
          </div>
          {(action === 'export' || action === 'import') && (
            <form className="vault-fields" key={action} onSubmit={recovery}>
              {action === 'import' && <label className="field"><span>Recovery file</span><input type="file" name="recovery" accept=".anovault" required /></label>}
              <label className="field">
                <span>{action === 'export' ? 'Choose a recovery passphrase' : 'Recovery passphrase'}</span>
                <input className="input" type="password" name="passphrase" required minLength={action === 'export' ? 12 : undefined}
                  autoComplete={action === 'export' ? 'new-password' : 'current-password'} />
              </label>
              {action === 'import' && items.length > 0 && <label className="vault-check">
                <input type="checkbox" name="allowSwitch" />
                Switch vaults if this file opens a different one
              </label>}
              <div className="row">
                <button className="btn btn-small btn-primary" disabled={busy}>{action === 'export' ? 'Download encrypted file' : 'Open recovery file'}</button>
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
              </div>
            </form>
          )}
        </section>
        <section className="panel">
          <h2>Wipe memories</h2>
          {action === 'wipe' && <p className="muted">Delete every memory in this vault. Synced devices apply those deletions when they reconnect.</p>}
          <div className="row">
            <button className="btn btn-small btn-danger" type="button" disabled={busy} onClick={() => {
              if (action !== 'wipe') { setAction('wipe'); return; }
              void run(async () => {
                const synced = !demo && snapshot.stored.sync && await reconcileBeforeWipe(vaultMemoryTransport, capacity);
                await wipeVaultMemory(demo);
                setEditing(null);
                setDraft('');
                setAdding(false);
                setAction(null);
                if (synced) await sync();
                return 'Memories wiped.';
              });
            }}>{action === 'wipe' ? 'Confirm wipe' : 'Wipe all memories'}</button>
            {action === 'wipe' && <button className="btn btn-small" type="button" disabled={busy} onClick={() => setAction(null)}>Cancel</button>}
          </div>
        </section>
        {status && <output className="muted" role="status">{status}</output>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    </div>
  );
}
