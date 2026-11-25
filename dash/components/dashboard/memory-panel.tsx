'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { StoredCharacter } from '@/lib/anonymo/characters-store';
import {
  cleanFact, FACT_LENGTH, memoryFingerprint, memorySize, selectMemories, suggestionsFor,
  type CharacterMemory,
} from '@/lib/anonymo/memory';
import { editMemory, memorySession } from '@/lib/anonymo/memory-store';
import { useCharacterMemory } from './memory-state';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { chatsStore } from '@/lib/anonymo/history';
import { updateOn } from '@/lib/anonymo/updates';

export function MemoryPanel({ demo, characters, initialId }: {
  demo: boolean;
  characters: StoredCharacter[];
  initialId: string | null;
}) {
  const [selected, setSelected] = useState(initialId);
  const character = characters.find((item) => item.id === selected) ?? characters[0] ?? null;
  const { mode, memory } = useCharacterMemory(demo, character);
  if (!character) return <p className="collection-empty">Create or import a character to keep memories.</p>;

  return (
    <section className="panel memory-panel" aria-label="Character memory">
      <div className="row memory-character">
        <label className="field">
          <span>Character</span>
          <select className="select" value={character.id} onChange={(event) => setSelected(event.target.value)}>
            {characters.map((item) => <option key={item.id} value={item.id}>{item.card.data.name}</option>)}
          </select>
        </label>
        <Link className="btn btn-small" href={`/dashboard/chat?character=${encodeURIComponent(character.id)}`}>Chat</Link>
      </div>
      {memory ? <MemoryEditor key={character.id} demo={demo} memory={memory} /> : (
        <p className="muted" role="status">
          {mode === 'locked' ? 'Unlock the vault to view memories.' : mode === 'unavailable' ? 'Device storage is unavailable.' : 'Loading memories…'}
        </p>
      )}
    </section>
  );
}

function MemoryEditor({ demo, memory }: { demo: boolean; memory: CharacterMemory }) {
  // A fact's source chat by its title when the chat is saved on this device; unsaved chats leave no trace to name.
  const savedChats = useDeviceStore(chatsStore(demo));
  const vaultMemory = updateOn('vaultsync', demo);
  const chatTitle = (id: string) => savedChats.find((chat) => chat.id === id)?.title ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const active = memory.enabled ? selectMemories(memory.facts) : [];
  const bytes = memorySize(active);
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;

  async function apply(change: (current: CharacterMemory) => CharacterMemory, done?: () => void, prepare?: () => Promise<void>) {
    const session = memorySession();
    setBusy(true);
    setError('');
    try {
      await prepare?.();
      if (session !== memorySession()) return;
      await editMemory(demo, memory.characterId, (current) => {
        if (memory.generation && memory.generation !== current.generation) throw new MemoryEditError('Memory changed. Try again.');
        return change(current);
      });
      done?.();
    } catch (reason) {
      setError(reason instanceof MemoryEditError ? reason.message : 'Could not save this change on this device.');
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const text = cleanFact(draft);
    if (!text || busy) return;
    let fingerprint: string;
    void apply((current) => {
      const previous = current.facts.find(({ id }) => id === editing);
      if (editing && !previous) throw new MemoryEditError('This fact was removed.');
      if (previous?.text === text) return current;
      if (!suggestionsFor({ ...current, facts: current.facts.filter(({ id }) => id !== editing) }, [
        { text, fingerprint, replace: null, previous: null },
      ]).length) throw new MemoryEditError('This fact is already saved or was dismissed.');
      const fact = { id: editing ?? crypto.randomUUID(), text, chatId: previous?.chatId ?? null, at: new Date().toISOString() };
      return { ...current, facts: [fact, ...current.facts.filter(({ id }) => id !== editing)] };
    }, clearDraft, async () => { fingerprint = await memoryFingerprint(text); });
  }

  function clearDraft() {
    setEditing(null);
    setDraft('');
  }

  return (
    <>
      <header>
        <h2>Memory</h2>
        <p className="memory-stats" title="Facts available for a reply. The chat can choose a different mix based on the conversation.">
          {!vaultMemory && `${active.length} in use · ${size} in prompt · `}{memory.facts.length} saved
        </p>
      </header>
      {vaultMemory
        ? <p className="muted">Chat recalls relevant memories. Manage sync, pins and exports in <Link href="/dashboard/memory">Memory</Link>.</p>
        : <p className="muted">Facts are saved on this device. Memory adds relevant facts to this character’s chat requests.</p>}
      <fieldset className="memory-settings" disabled={busy}>
        <legend className="sr-only">Memory settings</legend>
        <label>
          <input type="checkbox" role="switch" checked={memory.enabled} onChange={(event) => {
            const enabled = event.target.checked;
            void apply((current) => ({ ...current, enabled, generation: '' }));
          }} />
          Memory on
        </label>
        <label>
          <input type="checkbox" checked={memory.extract} disabled={!memory.enabled} onChange={(event) => {
            const extract = event.target.checked;
            void apply((current) => ({ ...current, extract, generation: '' }));
          }} />
          Suggest facts after replies
        </label>
        <label>
          <input type="checkbox" checked={memory.autoSave} disabled={!memory.enabled || !memory.extract} onChange={(event) => {
            const autoSave = event.target.checked;
            void apply((current) => ({ ...current, autoSave }));
          }} />
          Save automatically
        </label>
      </fieldset>
      <p className="faint">Suggestions use a separate paid chat request{vaultMemory ? "." : " on the same model."}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {memory.facts.length ? (
        <ul className="memory-facts">
          {memory.facts.map((fact) => (
            <li key={fact.id}>
              <div>
                <p>{fact.text}</p>
                <small className="faint">
                  {fact.chatId ? (chatTitle(fact.chatId) ? `From “${chatTitle(fact.chatId)}”` : 'From a chat') : 'Added by you'}
                  {' · '}<time dateTime={fact.at}>{new Date(fact.at).toLocaleDateString()}</time>
                </small>
              </div>
              <div className="row">
                <button type="button" className="btn btn-small" disabled={busy} aria-label={`Edit ${fact.text}`} onClick={() => {
                  setEditing(fact.id);
                  setDraft(fact.text);
                  input.current?.focus();
                }}>Edit</button>
                <button type="button" className="btn btn-small btn-ghost btn-danger" disabled={busy} aria-label={`Delete ${fact.text}`}
                  onClick={() => void apply((current) => ({ ...current, facts: current.facts.filter(({ id }) => id !== fact.id) }),
                    () => { if (editing === fact.id) clearDraft(); })}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="faint">No facts saved yet.</p>}
      <form className="memory-fact-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <label className="field" htmlFor="memory-fact-text">
          <span>{editing ? 'Edit fact' : 'Add a fact'}</span>
          <input id="memory-fact-text" ref={input} className="input" maxLength={FACT_LENGTH} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <div className="row">
          <button type="submit" className="btn btn-small btn-primary" disabled={busy || !cleanFact(draft)}>{editing ? 'Save edit' : 'Add fact'}</button>
          {editing && <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={clearDraft}>Cancel edit</button>}
        </div>
      </form>
      <div className="row memory-forget">
        {confirm && <span className="muted">Delete every saved fact for this character?</span>}
        <button type="button" className="btn btn-small btn-ghost btn-danger" disabled={busy}
          onClick={() => confirm
            ? void apply((current) => ({ ...current, facts: [], generation: '' }), () => { setConfirm(false); clearDraft(); })
            : setConfirm(true)}>{confirm ? 'Delete all facts' : 'Forget everything'}</button>
        {confirm && <button type="button" className="btn btn-small" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>}
      </div>
    </>
  );
}

class MemoryEditError extends Error {}
