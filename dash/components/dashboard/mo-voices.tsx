'use client';

import './mo-voice.css';
import Link from 'next/link';
import { AudioLines, Play, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { describeError } from '@/lib/anonymo/client';
import type { DesignedVoice } from '@/lib/anonymo/mo-voice';
import { setupHref } from '@/lib/anonymo/setup-return';

const LINE = 'The last light is still on. We can sit here a little longer.';
type Preview = { id: string; url?: string; cost?: string | null };

export function MoVoices() {
  const { key, demo, client, refreshBalance } = useAnonymo();
  const [description, setDescription] = useState('');
  const [name, setName] = useState('');
  const [list, setList] = useState<DesignedVoice[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState('');
  const task = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setPreview(null);
    setList([]);
    setBusy(false);
    if (key) {
      const load = demo
        ? import('@/lib/anonymo/mock/mo-voice').then((module) => module.demoVoiceList(client, ctl.signal))
        : client.moVoiceList(ctl.signal);
      void load.then((voices) => { if (!ctl.signal.aborted) setList(voices.designed); },
        (error) => { if (!ctl.signal.aborted) setNotice(describeError(error)); });
    }
    return () => { ctl.abort(); task.current?.abort(); task.current = null; if (demo) window.speechSynthesis?.cancel(); };
  }, [client, demo, key]);

  useEffect(() => {
    const url = preview?.url;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [preview]);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (task.current) return;
    const ctl = new AbortController();
    task.current = ctl;
    setBusy(true);
    setNotice('');
    setSaved('');
    try {
      await work(ctl.signal);
    } catch (error) {
      if (!ctl.signal.aborted) setNotice(describeError(error));
    } finally {
      if (task.current === ctl) { task.current = null; setBusy(false); }
    }
  }

  function makePreview() {
    setPreview(null);
    void run(async (signal) => {
      if (demo) {
        const { demoSpeech } = await import('@/lib/anonymo/mock/mo-voice');
        if (signal.aborted) return;
        window.speechSynthesis?.cancel();
        if (!demoSpeech(LINE, description)) setNotice('A local voice is unavailable on this device.');
        setPreview({ id: crypto.randomUUID() });
        return;
      }
      const result = await client.moVoicePreview(description.trim(), signal);
      if (signal.aborted) return;
      const bytes = Uint8Array.from(atob(result.audio), (char) => char.charCodeAt(0));
      setPreview({ id: result.preview_id, url: URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })), cost: result.cost });
      refreshBalance();
    });
  }

  const save = () => {
    if (!preview) return;
    void run(async (signal) => {
      const voice = demo
        ? (await import('@/lib/anonymo/mock/mo-voice')).saveDemoVoice(client, preview.id, name.trim())
        : await client.moVoiceSave(preview.id, name.trim(), signal);
      if (signal.aborted) return;
      setList((current) => [voice, ...current.filter((item) => item.id !== voice.id)]);
      setSaved(`Saved ${voice.name} to this key.`);
      setName('');
      setPreview(null);
    });
  };

  return (
    <div className="panel-stack mv-workspace">
      <header className="ws-head"><h1>Voices</h1><p>Describe a voice. Hear it.</p></header>
      {!key ? <div className="notice row"><span>Connect an API key to design and save a voice.</span>
        <Link href={setupHref('key', '/dashboard/voices')} className="btn btn-primary">Set up a key</Link></div> : (
        <div className="mv-voices">
          <section className="panel mv-design">
            <header><AudioLines size={24} aria-hidden="true" /><h2>Design a voice</h2></header>
            <form className="panel-stack" onSubmit={(e) => { e.preventDefault(); makePreview(); }}>
              <label className="field"><span>Voice description</span>
                <textarea className="textarea" rows={3} maxLength={300} placeholder="warm, low, slightly husky" required
                  value={description} disabled={busy} onChange={(e) => { setDescription(e.target.value); setPreview(null); }} />
              </label>
              <p className="muted">Describe pitch, pace and tone. Try “clear, bright, measured” or “deep, calm, slightly gravelly.”</p>
              <button className="btn btn-primary" disabled={busy || !description.trim()}><Play size={16} aria-hidden="true" /> {busy && !preview ? 'Preparing…' : 'Preview'}</button>
            </form>
            {preview && <div className="mv-preview">
              {preview.url && <audio src={preview.url} controls autoPlay aria-label="Voice preview" />}
              {preview.cost && <p className="muted">Preview charge ${preview.cost}</p>}
              <form className="panel-stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
                <label className="field"><span>Voice name</span>
                  <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <button className="btn btn-primary" disabled={busy || !name.trim()}><Plus size={16} aria-hidden="true" /> {busy ? 'Saving…' : 'Save voice'}</button>
              </form>
            </div>}
            {notice && <p className="notice" role="alert">{notice}</p>}
            {saved && <p role="status">{saved}</p>}
          </section>
          <section className="panel mv-saved">
            <header><h2>Saved voices</h2></header>
            {list.length ? <ul>{list.map((item) => <li key={item.id}>{item.name}</li>)}</ul> : <p className="muted">Voices you save to this key appear here.</p>}
            <Link href="/dashboard/mo-voice" className="btn btn-small">Open Mo Voice</Link>
          </section>
        </div>
      )}
    </div>
  );
}
