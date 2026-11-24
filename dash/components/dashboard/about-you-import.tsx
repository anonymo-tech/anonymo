'use client';

import { PackageOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  ABOUT_YOU_FACT_COUNT, ABOUT_YOU_MAX, aboutYouFits, aboutYouLength, mapChatGptSetup, mergeAboutYouImport, type AboutYouImport,
} from '@/lib/anonymo/about-you';
import { aboutYouReadable, saveAboutYou, savedAboutYou } from '@/lib/anonymo/about-you-store';
import { readChatGptSetup } from '@/lib/anonymo/movein/chatgpt-setup';
import { vault } from '@/lib/anonymo/vault-browser';
import { VaultButton, useVault } from './vault-controls';
import './about-you.css';

const labels = { aboutMe: 'About me', answerStyle: 'How I like answers', fact: 'Saved memory' };

type CloseImport = (saved?: boolean) => void;

export function AboutYouImportPreview({ items, demo, onClose }: { items: AboutYouImport[]; demo: boolean; onClose: CloseImport }) {
  const { mode } = useVault();
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const base = savedAboutYou(demo);
  const selected = items.filter((_, index) => picked.has(index));
  const preview = mergeAboutYouImport(base, selected, () => '');
  const fits = aboutYouFits(preview);

  async function save() {
    if (saving || !selected.length || !fits || !aboutYouReadable(vault.state().mode)) return;
    setSaving(true);
    setError('');
    try {
      await saveAboutYou(demo, vault.session(), base, mergeAboutYouImport(base, selected, () => crypto.randomUUID()));
      onClose(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save About you.');
    } finally {
      setSaving(false);
    }
  }

  if (!aboutYouReadable(mode)) return (
    <div className="row">
      <span>Unlock your vault to review this import.</span>
      {mode === 'locked' && <VaultButton />}
    </div>
  );

  return (
    <div className="about-you-preview">
      <p>Choose what to keep. Selected text fields replace the matching fields. Saved memories are added as facts.</p>
      <ul aria-label="ChatGPT settings and saved memories">
        {items.map(({ field, text, shortened }, index) => (
          <li key={index}>
            <label aria-label={`${labels[field]}${shortened ? ' (shortened)' : ''}: ${text}`}>
              <input
                type="checkbox"
                checked={picked.has(index)}
                disabled={saving}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setPicked((list) => {
                    const next = new Set(list);
                    if (checked) next.add(index);
                    else next.delete(index);
                    return next;
                  });
                }}
              />
              <span>
                <strong>{labels[field]}{shortened && ' (shortened)'}</strong>
                <span className="about-you-text">{text}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="faint">{aboutYouLength(preview).toLocaleString()} / {ABOUT_YOU_MAX.toLocaleString()} characters · {preview.facts.length} / {ABOUT_YOU_FACT_COUNT} facts</p>
      {!fits && <p className="notice notice-amber">Choose fewer items to fit your profile.</p>}
      <div className="row">
        <button className="btn btn-primary" type="button" disabled={saving || !picked.size || !fits} onClick={() => void save()}>Save to About you</button>
        <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => onClose()}>Cancel</button>
      </div>
      {error && <p className="notice notice-rose" role="alert">{error}</p>}
    </div>
  );
}

export function BringFromChatGpt({ demo, onClose }: { demo: boolean; onClose: CloseImport }) {
  const picker = useRef<HTMLInputElement>(null);
  const reader = useRef<AbortController | null>(null);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const [items, setItems] = useState<AboutYouImport[]>([]);
  const [error, setError] = useState('');

  useEffect(() => () => reader.current?.abort(), []);

  async function read(file: File | undefined) {
    if (!file || reader.current) return;
    const abort = new AbortController();
    const session = vault.session();
    reader.current = abort;
    setReading(true);
    setError('');
    try {
      const setup = await readChatGptSetup({ name: file.name, blob: file }, abort.signal);
      if (abort.signal.aborted || session !== vault.session()) return;
      const found = mapChatGptSetup(setup);
      if (found.length) setItems(found);
      else setError('We couldn’t find any ChatGPT settings or saved memories in this file.');
    } catch {
      if (!abort.signal.aborted) setError('We couldn’t read that export. Try the original ZIP or its conversations.json file.');
    } finally {
      reader.current = null;
      if (!abort.signal.aborted) setReading(false);
    }
  }

  if (items.length) return <AboutYouImportPreview items={items} demo={demo} onClose={onClose} />;
  return (
    <div className="about-you-preview">
      <ol className="muted">
        <li>In ChatGPT on the web, open your profile menu and choose <strong>Settings</strong>.</li>
        <li>Open <strong>Data controls</strong>. Under <strong>Export data</strong>, choose <strong>Export</strong>, then <strong>Confirm export</strong>.</li>
        <li>When it’s ready, choose <strong>Download data export</strong>.</li>
      </ol>
      <input ref={picker} type="file" hidden accept=".zip,.json" onChange={(event) => {
        void read(event.currentTarget.files?.[0]);
        event.currentTarget.value = '';
      }} />
      <button
        type="button"
        className="dropzone"
        data-over={over}
        disabled={reading}
        onClick={() => picker.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void read(event.dataTransfer.files[0]);
        }}
      >
        <PackageOpen size={22} aria-hidden="true" />
        <span>Drop your ZIP or conversations.json here, or choose a file</span>
        <span className="faint">Your export is read in this browser.</span>
      </button>
      {reading && <output>Reading your export…</output>}
      {error && <p className="notice notice-rose" role="alert">{error}</p>}
      <div className="row"><button className="btn btn-ghost" type="button" onClick={() => onClose()}>Cancel</button></div>
    </div>
  );
}
