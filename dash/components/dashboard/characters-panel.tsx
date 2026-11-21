'use client';

// Character-card import (V1/V2/V3 JSON, or PNG with a `chara`/`ccv3` chunk). Cards are parsed and kept on this device;
// "Save sealed to gateway" encrypts the card here with a viewing key derived from the API key and sends only the
// ciphertext and hash (the gateway's private-card path), so no card text reaches the server in the clear.

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowUpRight,
  BookOpen,
  Library,
  Paintbrush,
  Plus,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { FacePainter, FaceThumb } from './face-painter';
import { MemoryPanel } from './memory-panel';
import { PlushMaker } from './plush-maker';
import type { Plush } from '@/lib/anonymo/plush';
import {
  CardError,
  cardHash,
  deriveViewingKey,
  greetingsOf,
  normalizeCard,
  sealCard,
  type CharacterCard,
} from '@/lib/anonymo/card';
import {
  charactersStore,
  loadCharacters,
  readCardFile,
  saveCharacters,
  type StoredCharacter,
} from '@/lib/anonymo/characters-store';
import { describeError } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { shrink } from '@/lib/anonymo/faces-image';
import { removeFaces, saveArt, savePlush } from '@/lib/anonymo/faces-store';
import { plushCard, SAMPLE_CARD } from '@/lib/anonymo/sample-character';
import { updateOn } from '@/lib/anonymo/updates';

export function CharactersPanel() {
  const { ready, demo, key, client } = useAnonymo();
  const list = useDeviceStore(charactersStore);
  // Update "faces": the art inside a PNG card is kept as the character's face, and any character can be given painted
  // ones. `?face=<id>` (the chat's "Give them a face" link) opens that character's Face panel.
  const facesOn = ready && updateOn('faces', demo);
  const memoryOn = ready && updateOn('memory', demo);
  const [memoryFor, setMemoryFor] = useState<string | null>(null);
  const [art, setArt] = useState<Blob | null>(null);
  const [faceFor, setFaceFor] = useState<string | null>(
    useSearchParams().get('face'),
  );
  const faceCharacter = facesOn
    ? (list.find((c) => c.id === faceFor) ?? null)
    : null;
  const [view, setView] = useState<'studio' | 'collection' | 'import' | 'memory'>(
    'studio',
  );
  const active = view === 'memory' && !memoryOn ? 'collection' : view === 'studio' && !facesOn ? 'import' : view;
  const go = (next: typeof view) => {
    setView(next);
    setError('');
    setNote('');
  };
  const [preview, setPreview] = useState<CharacterCard | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [personality, setPersonality] = useState('');
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  async function read(input: File) {
    setError('');
    setNote('');
    try {
      setPreview(await readCardFile(input));
      setArt(
        input.type === 'image/png' || /\.png$/i.test(input.name) ? input : null,
      );
    } catch (e) {
      setPreview(null);
      setError(
        e instanceof CardError
          ? e.message
          : 'That file could not be read as a character card.',
      );
    }
  }

  async function keep(card: CharacterCard, picture: Blob | null = art) {
    const hash = await cardHash(card);
    const next = [
      {
        id: hash.slice(0, 16),
        hash,
        card,
        importedAt: new Date().toISOString(),
      },
      ...list.filter((c) => c.hash !== hash),
    ];
    if (!saveCharacters(next)) {
      setError('This browser could not store the character.');
      return null;
    }
    // The card's own picture becomes the character's face, made small and kept on this device (never uploaded).
    if (facesOn && picture)
      void shrink(picture)
        .then((small) => saveArt(hash.slice(0, 16), small))
        .catch(() => undefined);
    setPreview(null);
    setArt(null);
    setNote(`${card.data.name} is ready. Press Chat to talk to them.`);
    return hash.slice(0, 16);
  }

  async function createPlush(design: Plush, tiles: Blob[]) {
    const card = normalizeCard(plushCard(name, personality));
    const hash = await cardHash(card);
    const id = hash.slice(0, 16);
    if (loadCharacters().some((c) => c.hash === hash))
      throw new Error(
        'This character already exists. Open it in your collection or choose a different name.',
      );
    await savePlush(demo, id, design, tiles);
    if (
      !saveCharacters([
        { id, hash, card, importedAt: new Date().toISOString() },
        ...loadCharacters(),
      ])
    ) {
      await removeFaces(id);
      throw new Error('This browser could not store the character.');
    }
    setName('');
    setPersonality('');
    setFaceFor(id);
    setNote(`${card.data.name} is saved in your collection.`);
  }

  async function sealToGateway(c: StoredCharacter) {
    if (!key) return;
    setError('');
    setNote('');
    try {
      const viewingKey = await deriveViewingKey(key);
      const sealed = await sealCard(viewingKey, c.card);
      const result = await client.importCharacter({
        visibility: 'private',
        sealed_card: sealed.sealed_card,
        card_hash: sealed.card_hash,
      });
      setNote(
        `Saved sealed to the gateway as ${result.data.id}. Only this key can open it.`,
      );
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <div className="character-studio">
      <header className="character-heading">
        <h1>
          {active === 'studio'
            ? 'Character studio'
            : active === 'collection'
              ? 'Your collection'
              : active === 'memory' ? 'Character memory' : 'Import a character'}
        </h1>
        <nav aria-label="Character workspace">
          {facesOn && (
            <button
              type="button"
              aria-current={active === 'studio' ? 'page' : undefined}
              onClick={() => go('studio')}
            >
              <Paintbrush size={16} /> Studio
            </button>
          )}
          <button
            type="button"
            aria-current={active === 'collection' ? 'page' : undefined}
            onClick={() => go('collection')}
          >
            <Library size={16} /> Collection <small>{list.length}</small>
          </button>
          <button
            type="button"
            aria-current={active === 'import' ? 'page' : undefined}
            onClick={() => go('import')}
          >
            <Upload size={16} /> Import
          </button>
          {memoryOn && <button type="button" className="memory-tab" aria-current={active === 'memory' ? 'page' : undefined}
            onClick={() => { setMemoryFor(null); go('memory'); }}>Memory</button>}
        </nav>
      </header>
      {note && <output className="notice notice-signal">{note}</output>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {facesOn && (
        <div hidden={active !== 'studio'}>
          {faceCharacter ? (
            <FacePainter
              key={faceCharacter.id}
              character={faceCharacter}
              onClose={() => go('collection')}
            />
          ) : (
            <PlushMaker
              demo={demo}
              name={name}
              onCreate={createPlush}
              identity={
                <>
                  <label className="studio-name">
                    <span>Character name</span>
                    <input
                      name="characterName"
                      required
                      maxLength={64}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Choose a name"
                    />
                  </label>
                  <details className="studio-personality">
                    <summary>
                      Personality <small>Optional</small>
                    </summary>
                    <textarea
                      aria-label="Personality"
                      maxLength={600}
                      value={personality}
                      onChange={(e) => setPersonality(e.target.value)}
                      placeholder="What are they like?"
                      rows={2}
                    />
                  </details>
                </>
              }
            />
          )}
        </div>
      )}
      {active === 'import' && (
        <section className="panel character-import">
          <header>
            <h2>Character card</h2>
            <span className="faint">Tavern V1–V3 · JSON or PNG</span>
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
            <span className="faint">
              Read on this device. Nothing is uploaded unless you choose to save
              it sealed.
            </span>
          </button>
          {preview && (
            <div className="card-preview">
              <div className="row">
                <h3 style={{ flex: 1 }}>{preview.data.name}</h3>
                <span className="chip">
                  {preview.spec === 'chara_card_v3' ? 'V3' : 'V2'}
                </span>
                {preview.data.character_book && (
                  <span className="chip">
                    lorebook · {preview.data.character_book.entries.length}
                  </span>
                )}
              </div>
              {preview.data.tags.length > 0 && (
                <p className="faint">
                  {preview.data.tags.slice(0, 12).join(' · ')}
                </p>
              )}
              {preview.data.description && (
                <p className="muted">
                  {preview.data.description.slice(0, 400)}
                  {preview.data.description.length > 400 ? '…' : ''}
                </p>
              )}
              {greetingsOf(preview)[0] && (
                <p className="first">{greetingsOf(preview)[0].slice(0, 800)}</p>
              )}
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() =>
                    void keep(preview).then((id) => {
                      if (id) setView('collection');
                    })
                  }
                >
                  Keep on this device
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setPreview(null)}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
          {facesOn && !preview && (
            <div className="sample-offer">
              <p>Try Mara, the captain of the Lantern.</p>
              <button
                type="button"
                className="btn btn-small"
                onClick={() =>
                  void keep(normalizeCard(SAMPLE_CARD), null).then((id) => {
                    if (id) {
                      setFaceFor(id);
                      go('studio');
                    }
                  })
                }
              >
                <BookOpen size={15} /> Add a sample character
              </button>
            </div>
          )}
        </section>
      )}
      {active === 'collection' && (
        <section className="character-collection">
          {facesOn && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setFaceFor(null);
                go('studio');
              }}
            >
              <Plus size={16} /> New character
            </button>
          )}
          {!ready ? null : list.length === 0 ? (
            <p className="collection-empty">
              Characters you save or import will appear here.
            </p>
          ) : (
            <ul className="character-cards">
              {list.map((c) => (
                <li key={c.id}>
                  <span>
                    {facesOn && <FaceThumb id={c.id} name={c.card.data.name} />}
                    <strong>{c.card.data.name}</strong>
                  </span>
                  <span className="row">
                    <Link
                      className="btn btn-small btn-primary"
                      href={`/dashboard/chat?character=${encodeURIComponent(c.id)}`}
                    >
                      Chat <ArrowUpRight size={14} />
                    </Link>
                    {facesOn && (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => {
                          setFaceFor(c.id);
                          go('studio');
                        }}
                      >
                        <Paintbrush size={15} aria-hidden="true" /> Customize
                      </button>
                    )}
                    {memoryOn && <button type="button" className="btn btn-small" onClick={() => {
                      setMemoryFor(c.id);
                      go('memory');
                    }}>Memory</button>}
                    <details className="character-options">
                      <summary>Manage</summary>
                      <div>
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={!key}
                          onClick={() => void sealToGateway(c)}
                        >
                          Save sealed to gateway
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-ghost btn-danger"
                          onClick={() => {
                            const next = list.filter((x) => x.id !== c.id);
                            if (!saveCharacters(next)) {
                              setError(
                                'This browser could not remove the character.',
                              );
                              return;
                            }
                            void removeFaces(c.id);
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </details>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {active === 'memory' && (
        demo && list.length === 0 ? (
          <div className="panel memory-panel">
            <p className="muted">Try memory with the captain of the Lantern.</p>
            <button type="button" className="btn btn-small" onClick={() => void keep(normalizeCard(SAMPLE_CARD), null).then(setMemoryFor)}>
              <BookOpen size={15} aria-hidden="true" /> Add a sample character
            </button>
          </div>
        ) : <MemoryPanel demo={demo} characters={list} initialId={memoryFor} />
      )}
    </div>
  );
}
