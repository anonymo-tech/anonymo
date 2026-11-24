'use client';

import { Pin, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import {
  ABOUT_YOU_FACT_COUNT, ABOUT_YOU_FACT_MAX, ABOUT_YOU_FIELD_MAX, ABOUT_YOU_MAX,
  aboutYouFits, aboutYouLength, cleanAboutYou, type AboutYou as Profile,
} from '@/lib/anonymo/about-you';
import { aboutYouReadable, saveAboutYou, savedAboutYou } from '@/lib/anonymo/about-you-store';
import { vault } from '@/lib/anonymo/vault-browser';
import { BringFromChatGpt } from './about-you-import';
import { VaultButton, useVault } from './vault-controls';

export function AboutYou() {
  const { demo } = useAnonymo();
  const { mode } = useVault();

  if (mode === 'loading') return <output>Loading About you…</output>;
  if (mode === 'unavailable') return <p className="notice notice-rose">This browser couldn’t open your device storage.</p>;
  if (!aboutYouReadable(mode)) return (
    <section className="panel">
      <p>Unlock your vault to read and use About you.</p>
      <div className="row"><VaultButton /></div>
    </section>
  );
  return <ProfileEditor key={`${demo}:${vault.session()}`} demo={demo} />;
}

function ProfileEditor({ demo }: { demo: boolean }) {
  const saved = savedAboutYou(demo);
  const [edit, setEdit] = useState<{ base: Profile; draft: Profile } | null>(null);
  const [bringing, setBringing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [focusFact, setFocusFact] = useState<string | null>(null);
  const newFact = useRef<HTMLInputElement>(null);
  const draft = edit?.draft ?? saved;
  const clean = cleanAboutYou(draft);
  const length = aboutYouLength(clean);
  const fits = aboutYouFits(clean);
  const facts = [...draft.facts].sort((a, b) => Number(b.pinned) - Number(a.pinned));

  useEffect(() => {
    if (focusFact) newFact.current?.focus();
  }, [focusFact]);

  function change(update: (profile: Profile) => Profile) {
    setStatus('');
    setError('');
    setEdit((current) => ({ base: current?.base ?? saved, draft: update(current?.draft ?? saved) }));
  }

  async function save() {
    if (!edit || busy || !fits || !aboutYouReadable(vault.state().mode)) return;
    setBusy(true);
    setError('');
    try {
      await saveAboutYou(demo, vault.session(), edit.base, clean);
      setEdit(null);
      setStatus('Saved on this device.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save About you.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-stack">
      <form className="panel about-you" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <header>
          <h2>Your profile</h2>
          <span className="mono faint">{length.toLocaleString()} / {ABOUT_YOU_MAX.toLocaleString()} characters</span>
        </header>
        <fieldset disabled={busy || bringing}>
          <label className="row">
            <input type="checkbox" checked={draft.enabled && !!length} disabled={!length} onChange={(event) => {
              const enabled = event.target.checked;
              change((profile) => ({ ...profile, enabled }));
            }} />
            <strong>Use About you in chats</strong>
          </label>
          <p className="faint">When on, your profile is sent with each chat so replies can use it.</p>
          <label className="field">
            <span>About me <span className="faint">· up to {ABOUT_YOU_FIELD_MAX} characters</span></span>
            <textarea className="textarea" rows={3} maxLength={ABOUT_YOU_FIELD_MAX} value={draft.aboutMe} onChange={(event) => {
              const aboutMe = event.target.value;
              change((profile) => ({ ...profile, aboutMe }));
            }} />
          </label>
          <label className="field">
            <span>How I like answers <span className="faint">· up to {ABOUT_YOU_FIELD_MAX} characters</span></span>
            <textarea className="textarea" rows={3} maxLength={ABOUT_YOU_FIELD_MAX} value={draft.answerStyle} onChange={(event) => {
              const answerStyle = event.target.value;
              change((profile) => ({ ...profile, answerStyle }));
            }} />
          </label>
          <div>
            <h3>Facts</h3>
            <p className="faint">Pin the facts that matter most. Up to {ABOUT_YOU_FACT_COUNT} facts, {ABOUT_YOU_FACT_MAX} characters each.</p>
          </div>
          {facts.length > 0 && <ul className="about-you-facts">
            {facts.map((fact, index) => (
              <li key={fact.id}>
                <input
                  className="input"
                  ref={focusFact === fact.id ? newFact : undefined}
                  aria-label={`Fact ${index + 1}`}
                  value={fact.text}
                  maxLength={ABOUT_YOU_FACT_MAX}
                  onChange={(event) => {
                    const text = event.target.value;
                    change((profile) => ({ ...profile, facts: profile.facts.map((f) => f.id === fact.id ? { ...f, text } : f) }));
                  }}
                />
                <button className="btn btn-small" type="button" aria-label={`Pin fact ${index + 1}`} aria-pressed={fact.pinned} onClick={() =>
                  change((profile) => ({ ...profile, facts: profile.facts.map((f) => f.id === fact.id ? { ...f, pinned: !f.pinned } : f) }))
                }><Pin size={14} aria-hidden="true" /> {fact.pinned ? 'Pinned' : 'Pin'}</button>
                <button className="btn btn-small btn-ghost btn-danger" type="button" aria-label={`Delete fact ${index + 1}`} onClick={() =>
                  change((profile) => ({ ...profile, facts: profile.facts.filter((f) => f.id !== fact.id) }))
                }>Delete</button>
              </li>
            ))}
          </ul>}
          <div className="row">
            <button className="btn btn-small" type="button" disabled={facts.length >= ABOUT_YOU_FACT_COUNT} onClick={() => {
              const id = crypto.randomUUID();
              change((profile) => ({ ...profile, facts: [...profile.facts, { id, text: '', pinned: false }] }));
              setFocusFact(id);
            }}><Plus size={15} aria-hidden="true" /> Add a fact</button>
          </div>
          {!fits && <p className="notice notice-amber">Trim your profile before saving.</p>}
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={!edit || !fits}>Save changes</button>
            {edit && <button className="btn btn-ghost" type="button" onClick={() => { setEdit(null); setError(''); }}>Discard changes</button>}
            {status && <output className="muted">{status}</output>}
          </div>
        </fieldset>
        {error && <p className="notice notice-rose" role="alert">{error}</p>}
      </form>
      <section className="panel" aria-label="Import from ChatGPT">
        {bringing ? <>
          <header><h2>Bring it from ChatGPT</h2></header>
          <BringFromChatGpt demo={demo} onClose={(saved) => {
            setBringing(false);
            if (saved) setStatus('Saved on this device.');
          }} />
        </> : (
          <div className="row">
            <button className="btn" type="button" disabled={!!edit || busy} onClick={() => setBringing(true)}>Bring it from ChatGPT</button>
            {edit && <span className="faint">Save or discard your edits before importing.</span>}
          </div>
        )}
      </section>
    </div>
  );
}
