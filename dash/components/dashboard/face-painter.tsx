'use client';

// Update "faces": giving a character a face. One sentence (the "look") is all the image model sees; the person can have
// the chat model write it from the card, or type it, and edit it before anything is painted. One image then holds six
// faces of the same person, which this browser cuts apart and keeps (lib/anonymo/faces-store.ts). Every button that
// costs money says what it costs, and nothing is painted without a click.

import Link from 'next/link';
import { Download, Loader2, Paintbrush, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PlushMaker } from './plush-maker';
import { Photo } from '@/components/photo';
import { useAnonymo } from '../anonymo-provider';
import { FaceAvatar, hasFace, useFaces, type Faces } from './face';
import { imageError } from './image-studio';
import { describeError, isOutOfCredit, type AnonymoClient } from '@/lib/anonymo/client';
import type { StoredCharacter } from '@/lib/anonymo/characters-store';
import {
  EXPRESSIONS,
  EXPRESSION_LABEL,
  FACE_STYLES,
  HELPER_MAX_TOKENS,
  HELPER_MODEL,
  LOOK_MAX,
  SHEET_RATIO,
  isExpression,
  lookRequest,
  pickSize,
  sheetPrompt,
  tidySentence,
  type Expression,
  type FaceStyle,
} from '@/lib/anonymo/faces';
import { b64ToBlob, sliceSheet } from '@/lib/anonymo/faces-image';
import { removePainted, saveLook, savePainted, setLabels, setUse } from '@/lib/anonymo/faces-store';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';
import type { ChatMessage, MediaImageModel } from '@/lib/anonymo/types';

export type Trouble = { text: string; funds: boolean };
export const chatTrouble = (e: unknown): Trouble => ({ text: describeError(e), funds: isOutOfCredit(e) });
export const paintTrouble = (e: unknown): Trouble => ({ text: imageError(e), funds: isOutOfCredit(e) });

/** The image models this gateway offers (the same list the image studio shows), best fit for `ratio` first. */
export function useImageModels(ratio: number) {
  const { ready, client } = useAnonymo();
  const [state, setState] = useState<{ models: MediaImageModel[] | null; error: string | null }>({ models: null, error: null });
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    client.mediaModels().then(
      (list) => {
        if (stale) return;
        const fit = (m: MediaImageModel) => {
          const [w, h] = pickSize(m.sizes, ratio).split('x').map(Number);
          return Math.abs(Math.log(w / h / ratio));
        };
        const images = list.data.filter((m): m is MediaImageModel => m.kind === 'image' && !!m.id && !!m.pricing && !m.edit && Array.isArray(m.sizes));
        setState({ models: [...images].sort((a, b) => fit(a) - fit(b)), error: null });
      },
      () => !stale && setState({ models: null, error: 'Images are not switched on for this gateway yet.' }),
    );
    return () => {
      stale = true;
    };
  }, [ready, client, ratio]);
  return state;
}

/** One small chat request that writes a sentence (the look, or a scene). An ordinary paid call with its own receipt. */
export async function askForSentence(
  client: AnonymoClient,
  messages: ChatMessage[],
  max: number,
  remember: (receipt: { id: string; model: string; at: string }) => void,
): Promise<string> {
  const result = await client.chat({ model: HELPER_MODEL, messages, max_tokens: HELPER_MAX_TOKENS, temperature: 0.4 });
  if (result.receiptId) remember({ id: result.receiptId, model: HELPER_MODEL, at: new Date().toISOString() });
  const text = tidySentence(result.content, max);
  if (!text) throw new Error('No description came back. Try again, or write it yourself.');
  return text;
}

export function StyleChips({ value, onChange, disabled }: { value: FaceStyle; onChange: (style: FaceStyle) => void; disabled?: boolean }) {
  return (
    <fieldset className="field faces-field">
      <legend>Style</legend>
      <div className="studio-count">
        {FACE_STYLES.map((s) => (
          <button key={s.id} type="button" className={s.id === value ? 'size-chip is-on' : 'size-chip'} aria-pressed={s.id === value} disabled={disabled} onClick={() => onChange(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function ModelChoice({ models, error, value, onChange, disabled }: { models: MediaImageModel[] | null; error: string | null; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return (
    <fieldset className="field faces-field">
      <legend>Painted by</legend>
      {error ? (
        <p className="muted">{error}</p>
      ) : !models ? (
        <p className="muted">Loading models…</p>
      ) : (
        <div className="studio-models">
          {models.map((m) => (
            <label key={m.id} className={m.id === value ? 'studio-model is-on' : 'studio-model'}>
              <input type="radio" name="face-model" value={m.id} checked={m.id === value} disabled={disabled} onChange={() => onChange(m.id)} />
              <strong>{m.name}</strong>
              <small>{formatUsd(usdToMusd(m.pricing.usd_per_image))} an image</small>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function TroubleNote({ trouble }: { trouble: Trouble | null }) {
  if (!trouble) return null;
  return (
    <div className={trouble.funds ? 'notice notice-amber row' : 'notice notice-rose'} role="alert">
      <span style={{ flex: 1 }}>{trouble.text}</span>
      {trouble.funds && (
        <Link className="btn btn-small" href="/dashboard/funds">
          Add funds
        </Link>
      )}
    </div>
  );
}

/** The small round picture in the character list: the face if there is one, else the first letter of the name. */
export function FaceThumb({ id, name }: { id: string; name: string }) {
  const { demo } = useAnonymo();
  const faces = useFaces(demo, id);
  return (
    <span className="face-thumb" aria-hidden="true">
      {hasFace(faces) ? <FaceAvatar faces={faces} /> : name.trim().slice(0, 1).toUpperCase() || '?'}
    </span>
  );
}

/** The Face panel for one character. */
export function FacePainter({ character, onClose }: { character: StoredCharacter; onClose: () => void }) {
  const { demo, key, client, rememberReceipt, refreshBalance } = useAnonymo();
  const name = character.card.data.name;
  const faces = useFaces(demo, character.id);
  const [editor, setEditor] = useState<'plush' | 'paint'>('plush');
  const { models, error: modelsError } = useImageModels(SHEET_RATIO);
  // What the person typed since the panel opened; until then the kept look and style show.
  const [typed, setTyped] = useState<string | null>(null);
  const [picked, setPicked] = useState<FaceStyle | null>(null);
  const [modelChoice, setModelChoice] = useState('');
  const [busy, setBusy] = useState<'look' | 'paint' | null>(null);
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  // The face the person clicked to look at; until then the preview is what shows in chat.
  const [shown, setShown] = useState<number | null>(null);
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(0);

  const look = typed ?? faces?.meta?.look ?? '';
  const style: FaceStyle = picked ?? faces?.meta?.style ?? 'plush';
  const model = models?.find((m) => m.id === modelChoice) ?? models?.[0] ?? null;
  const labels = faces?.meta?.labels ?? null;
  const painted = !!faces && faces.tiles.length > 0 && !!labels;
  const sentence = tidySentence(look, LOOK_MAX);

  useEffect(() => {
    if (busy !== 'paint') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [busy]);

  async function describe() {
    if (!key || busy) return;
    setBusy('look');
    setTrouble(null);
    try {
      const text = await askForSentence(client, lookRequest(character.card), LOOK_MAX, rememberReceipt);
      setTyped(text);
      await saveLook(demo, character.id, text, style);
    } catch (e) {
      setTrouble(chatTrouble(e));
    } finally {
      setBusy(null);
      refreshBalance();
    }
  }

  async function paint() {
    if (!key || busy || !model || !sentence) return;
    setBusy('paint');
    setStarted(Date.now());
    setNow(Date.now());
    setTrouble(null);
    try {
      const res = await client.generateImages({ model: model.id, prompt: sheetPrompt(sentence, style), n: 1, size: pickSize(model.sizes, SHEET_RATIO) });
      const b64 = res.data[0]?.b64_json;
      if (!b64) throw new Error('No image came back. Try again.');
      const sheet = b64ToBlob(b64);
      await savePainted(demo, character.id, { look: sentence, style, sheet, tiles: await sliceSheet(sheet) });
      setTyped(null);
      setShown(null);
    } catch (e) {
      setTrouble(paintTrouble(e));
    } finally {
      setBusy(null);
      refreshBalance();
    }
  }

  const relabel = (i: number, mood: string) => {
    if (!labels || !isExpression(mood)) return;
    void setLabels(demo, character.id, labels.map((l, at): Expression => (at === i ? mood : l))).catch(() => setTrouble({ text: 'This browser would not store the change.', funds: false }));
  };
  const keepLook = () => {
    if (typed !== null && typed !== (faces?.meta?.look ?? '')) void saveLook(demo, character.id, typed, style).catch(() => undefined);
  };

  const art = faces?.art ?? null;
  const artInUse = !!art && (!painted || faces.meta?.use === 'card');
  const at = Math.min(shown ?? 0, 5);
  const preview = painted && !(shown === null && artInUse) ? faces.tiles[at] : art;

  return (
    <section className="faces-panel" aria-label={`Customize ${name}`}>
      <header className="editor-tools">
        <fieldset className="segmented" aria-label="Face editor">
          <button type="button" disabled={!!busy} aria-pressed={editor === 'plush'} onClick={() => setEditor('plush')}>Plush maker</button>
          <button type="button" disabled={!!busy} aria-pressed={editor === 'paint'} onClick={() => setEditor('paint')}>Image painter</button>
        </fieldset>
        <button type="button" className="icon-btn" aria-label="Back to collection" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div hidden={editor !== 'plush'}>{faces && <PlushMaker demo={demo} id={character.id} name={name} saved={faces.meta?.plush} />}</div>
      {editor === 'paint' && <div className="panel faces-grid image-editor">
        <div className="faces-show">
          <div className={busy === 'paint' ? 'faces-preview is-busy' : 'faces-preview'}>
            {busy === 'paint' ? (
              <span className="faces-wait">
                <Loader2 size={22} className="spin" aria-hidden="true" />
                Painting six faces… {Math.max(0, Math.round((now - started) / 1000))} s<small>usually 10–40 s</small>
              </span>
            ) : preview ? (
              <Photo key={preview} src={preview} alt={preview === art ? `${name}, from the card` : `${name}, ${EXPRESSION_LABEL[labels?.[at] ?? 'calm'].toLowerCase()}`} loading="eager" />
            ) : (
              <span className="faces-wait">
                <Paintbrush size={26} strokeWidth={1.25} aria-hidden="true" />
                No face yet.
              </span>
            )}
          </div>

          {painted && labels && (
            <>
              <ul className="face-tiles">
                {faces.tiles.map((src, i) => (
                  <li key={src}>
                    <button type="button" className="face-tile" aria-pressed={preview === src} aria-label={`Show face ${i + 1}, ${EXPRESSION_LABEL[labels[i]].toLowerCase()}`} onClick={() => setShown(i)}>
                      <Photo src={src} alt="" />
                    </button>
                    <select className="select" aria-label={`Mood of face ${i + 1}`} value={labels[i]} onChange={(e) => relabel(i, e.target.value)}>
                      {EXPRESSIONS.map((e) => (
                        <option key={e} value={e}>
                          {EXPRESSION_LABEL[e]}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
              <p className="faint faces-hint">A face showing the wrong mood? Change its label. A mood with no face shows the calm one.</p>
            </>
          )}

          {painted && (
            <div className="row">
              {faces.sheet && (
                <a className="btn btn-small" href={faces.sheet} download={`anonymo-faces-${character.id}.png`} title="The sheet as it was painted. It keeps its AI-made label and watermark; the cut faces do not.">
                  <Download size={15} aria-hidden="true" /> Download the sheet
                </a>
              )}
              <button type="button" className="btn btn-small btn-ghost btn-danger" disabled={busy !== null} onClick={() => void removePainted(demo, character.id)}>
                <Trash2 size={15} aria-hidden="true" /> Remove painted faces
              </button>
            </div>
          )}
        </div>

        <form
          className="faces-form"
          onSubmit={(e) => {
            e.preventDefault();
            void paint();
          }}
        >
          <label className="field faces-field">
            <span>Their look</span>
            <textarea
              className="textarea"
              rows={4}
              maxLength={LOOK_MAX}
              value={look}
              placeholder="An adult felt captain in a teal coat with brass buttons"
              disabled={busy !== null}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={keepLook}
            />
          </label>
          <div className="row">
            <button type="button" className="btn btn-small" disabled={!key || busy !== null} onClick={() => void describe()} title="A small chat request to anonymo-1, usually well under a cent. It gets a receipt like any other.">
              {busy === 'look' ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />} Describe from the card
            </button>
            <span className="faint faces-count">
              {look.length} / {LOOK_MAX}
            </span>
          </div>
          <p className="faint faces-hint">This sentence is all the image model sees. Read it, change what you like, then paint.</p>

          <StyleChips value={style} onChange={setPicked} disabled={busy !== null} />
          <ModelChoice models={models} error={modelsError} value={model?.id ?? ''} onChange={setModelChoice} disabled={busy !== null} />

          <button type="submit" className="btn btn-primary studio-go" disabled={!key || busy !== null || !model || !sentence}>
            <Paintbrush size={18} aria-hidden="true" /> {painted ? 'Paint six new faces' : 'Paint six faces'}
            {model && <span className="studio-cost">{formatUsd(usdToMusd(model.pricing.usd_per_image))}</span>}
          </button>
          {!key && (
            <p className="faint faces-hint">
              You need a key to paint. <Link href="/dashboard/key">Create a key</Link>
            </p>
          )}
          <TroubleNote trouble={trouble} />
          <p className="studio-note">
            <ShieldCheck size={14} aria-hidden="true" /> One image makes all six faces, so they are the same person in every mood. Safe for work only: an adult, clothed, from the shoulders up. If the image check
            turns a look down, nothing is charged. Faces stay in this browser; Wipe removes them.
          </p>
          {demo && <p className="faint faces-hint">Demo painting uses the sample captain sheet. The live image model uses your chosen look and style.</p>}
        </form>
      </div>}
      {faces && <WhichFace faces={faces} onUse={use => {
        setShown(null);
        void setUse(demo, character.id, use).catch(() => setTrouble({ text: 'This browser could not save the choice.', funds: false }));
      }} />}
      {editor === 'plush' && <TroubleNote trouble={trouble} />}
    </section>
  );
}

function WhichFace({ faces, onUse }: { faces: Faces; onUse: (use: 'card' | 'painted' | 'plush') => void }) {
  const options = [
    { id: 'plush', label: 'My plush', available: faces.plushTiles.length },
    { id: 'painted', label: 'Painted faces', available: faces.tiles.length },
    { id: 'card', label: 'Card art', available: faces.art },
  ] as const;
  const available = options.filter(option => option.available);
  if (available.length < 2) return null;
  return <fieldset className="segmented faces-which">
    <legend>Use in chat</legend>
    {available.map(option => <button type="button" key={option.id} aria-pressed={faces.meta?.use === option.id} onClick={() => onUse(option.id)}>{option.label}</button>)}
  </fieldset>;
}
