'use client';

// Character-card import (V1/V2/V3 JSON, or PNG with a `chara`/`ccv3` chunk). Cards are parsed and kept on this device;
// "Save sealed to gateway" encrypts the card here with a viewing key derived from the API key and sends only the
// ciphertext and hash (the gateway's private-card path), so no card text reaches the server in the clear.

import Link from 'next/link';
import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CardError, cardHash, deriveViewingKey, greetingsOf, sealCard, type CharacterCard } from '@/lib/anonymo/card';
import { charactersStore, readCardFile, saveCharacters, type StoredCharacter } from '@/lib/anonymo/characters-store';
import { describeError } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { setStoredModel } from '@/lib/anonymo/prefs';

export function CharactersPanel() {
  const { ready, key, client } = useAnonymo();
  const list = useDeviceStore(charactersStore);
  const [preview, setPreview] = useState<CharacterCard | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function read(input: File) {
    setError('');
    setNote('');
    try {
      setPreview(await readCardFile(input));
    } catch (e) {
      setPreview(null);
      setError(e instanceof CardError ? e.message : 'That file could not be read as a character card.');
    }
  }

  async function keep(card: CharacterCard) {
    const hash = await cardHash(card);
    const next = [{ id: hash.slice(0, 16), hash, card, importedAt: new Date().toISOString() }, ...list.filter((c) => c.hash !== hash)];
    if (!saveCharacters(next)) setError('This browser would not store the card. It is too large, or storage is blocked.');
    setPreview(null);
    setNote(`${card.data.name} is ready. Pick anonymo-rp in chat to talk to them.`);
  }

  async function sealToGateway(c: StoredCharacter) {
    if (!key) return;
    setError('');
    setNote('');
    try {
      const viewingKey = await deriveViewingKey(key);
      const sealed = await sealCard(viewingKey, c.card);
      const result = await client.importCharacter({ visibility: 'private', sealed_card: sealed.sealed_card, card_hash: sealed.card_hash });
      setNote(`Saved sealed to the gateway as ${result.data.id}. Only this key can open it.`);
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <div className="panel-stack">
      <section className="panel">
        <header>
          <h2>Import a character card</h2>
          <span className="faint">Tavern V1, V2, V3 · JSON or PNG</span>
        </header>
        <input
          ref={file}
          type="file"
          hidden
          accept=".json,.png,application/json,image/png"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void read(f);
          }}
        />
        <button
          type="button"
          className="dropzone"
          data-over={over}
          onClick={() => file.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void read(f);
          }}
        >
          <Upload size={22} aria-hidden="true" />
          <span>Drop a card here, or choose a file</span>
          <span className="faint">Read on this device. Nothing is uploaded unless you choose to save it sealed.</span>
        </button>
        {preview && (
          <div className="card-preview">
            <div className="row">
              <h3 style={{ flex: 1 }}>{preview.data.name}</h3>
              <span className="chip">{preview.spec === 'chara_card_v3' ? 'V3' : 'V2'}</span>
              {preview.data.character_book && <span className="chip">lorebook · {preview.data.character_book.entries.length}</span>}
            </div>
            {preview.data.tags.length > 0 && <p className="faint">{preview.data.tags.slice(0, 12).join(' · ')}</p>}
            {preview.data.description && <p className="muted">{preview.data.description.slice(0, 400)}{preview.data.description.length > 400 ? '…' : ''}</p>}
            {greetingsOf(preview)[0] && <p className="first">{greetingsOf(preview)[0].slice(0, 800)}</p>}
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => void keep(preview)}>
                Keep on this device
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setPreview(null)}>
                Discard
              </button>
            </div>
          </div>
        )}
        {note && <output className="notice notice-signal">{note}</output>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </section>
      <section className="panel">
        <header>
          <h2>Your characters</h2>
        </header>
        {!ready ? null : list.length === 0 ? (
          <p className="lede">No characters yet. Imported cards stay in this browser.</p>
        ) : (
          <ul className="list">
            {list.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.card.data.name}</strong> <span className="faint mono">{c.hash.slice(0, 10)}</span>
                </span>
                <span className="row">
                  <Link className="btn btn-small btn-primary" href={`/dashboard?character=${encodeURIComponent(c.id)}`} onClick={() => setStoredModel('anonymo-rp')}>
                    Chat
                  </Link>
                  <button type="button" className="btn btn-small" disabled={!key} onClick={() => void sealToGateway(c)}>
                    Save sealed to gateway
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-ghost btn-danger"
                    onClick={() => {
                      const next = list.filter((x) => x.id !== c.id);
                      saveCharacters(next);
                    }}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
