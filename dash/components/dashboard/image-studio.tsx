'use client';

import { setupHref } from '@/lib/anonymo/setup-return';

// Update "images": the image studio. Prompt, model, size and count; images come back as base64 PNGs with provenance
// (a hidden watermark and a signed C2PA label) and stay in this tab until downloaded or saved. Safe for work: the gateway refuses nude or
// sexual prompts before anything is made and checks every image before it is returned (gateway src/anonymo/media).

import Link from 'next/link';
import { Photo } from '../photo';
import { Download, ImageIcon, Loader2, ShieldCheck, Sparkles, Stamp, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { AnonymoApiError, describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';
import type { MediaImageModel } from '@/lib/anonymo/types';
import { updateOn } from '@/lib/anonymo/updates';
import { ImageCompare } from './image-compare';
import { SaveLibraryImage } from './save-library-image';

type Shot = { id: string; src: string; prompt: string; model: string; size: string; costUsd: string; requestId: string; at: number };
type Job = { id: string; n: number; ratio: string; started: number };

const IDEAS = [
  'A neon-lit ramen stall in the rain at 2 a.m., film photo, shallow depth of field',
  'An isometric cutaway of a tiny cozy apartment inside a hollowed-out tree',
  'Vintage travel poster for a city on Saturn’s rings, bold flat colours',
  'A detective’s desk in 1947: case files, cigarette smoke, a single desk lamp',
];

const ratioOf = (size: string) => {
  const [w, h] = size.split('x').map(Number);
  return `${w} / ${h}`;
};
const shapeOf = (size: string) => {
  const [w, h] = size.split('x').map(Number);
  const r = w / h;
  return r === 1 ? 'Square' : r >= 1.5 ? 'Wide' : r > 1 ? 'Landscape' : r <= 2 / 3 ? 'Tall' : 'Portrait';
};

/** Image errors say what happened without the chat's floor wording when the gateway's own message is clearer. */
export function imageError(error: unknown): string {
  if (error instanceof AnonymoApiError && (error.code === 'explicit_media_unavailable' || error.code === 'media_blocked' || error.code === 'media_gate_unavailable' || error.code?.startsWith('upstream_')))
    return error.message;
  if (error instanceof AnonymoApiError && error.status === 404 && error.code !== 'model_not_found') return 'Images are not switched on for this gateway yet.';
  return describeError(error);
}

export function ImageStudio() {
  const { ready, key, client, refreshBalance, demo } = useAnonymo();
  const compareOn = updateOn('compare', demo);
  const [compareMode, setCompareMode] = useState(false);
  const studioModeButton = useRef<HTMLButtonElement>(null);
  const comparing = compareOn && compareMode;
  const [models, setModels] = useState<MediaImageModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState('');
  const [chosenSize, setSize] = useState('1024x1024');
  const [n, setN] = useState(1);
  const [prompt, setPrompt] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [shots, setShots] = useState<Shot[]>([]);
  const [error, setError] = useState<{ text: string; funds: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const urls = useRef<string[]>([]);

  useEffect(() => {
    if (!ready) return;
    let stale = false;
    client.mediaModels().then(
      (list) => {
        if (stale) return;
        const images = list.data.filter((m): m is MediaImageModel => m.kind === 'image' && !!m.id && !!m.pricing && !m.edit);
        setModels(images);
        setModelId((id) => id || images[0]?.id || '');
      },
      () => !stale && setModelsError('Images are not switched on for this gateway yet.'),
    );
    return () => {
      stale = true;
    };
  }, [ready, client]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => {
    if (!jobs.length) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [jobs.length]);

  const model = models?.find((m) => m.id === modelId) ?? null;
  const size = model && !model.sizes.includes(chosenSize) ? model.sizes[0] : chosenSize;
  const cost = useMemo(() => (model ? usdToMusd(model.pricing.usd_per_image) * n : 0), [model, n]);

  async function generate() {
    const text = prompt.trim();
    if (!text || !model || !key) return;
    setError(null);
    const job: Job = { id: crypto.randomUUID(), n, ratio: ratioOf(size), started: Date.now() };
    setJobs((j) => [job, ...j]);
    try {
      const res = await client.generateImages({ model: model.id, prompt: text, n, size });
      const made: Shot[] = res.data.flatMap((d, i) => {
        if (!d.b64_json) return [];
        const bytes = Uint8Array.from(atob(d.b64_json), (c) => c.charCodeAt(0));
        const src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        urls.current.push(src);
        return [{ id: `${res.anonymo.request_id}-${i}`, src, prompt: text, model: model.name, size, costUsd: res.anonymo.cost_usd, requestId: res.anonymo.request_id, at: Date.now() }];
      });
      setShots((s) => [...made, ...s]);
    } catch (e) {
      setError({ text: imageError(e), funds: isOutOfCredit(e) });
    } finally {
      setJobs((j) => j.filter((x) => x.id !== job.id));
      refreshBalance();
    }
  }

  if (ready && !key)
    return (
      <div className="notice row">
        <span style={{ flex: 1 }}>Connect an API key to generate your first image.</span>
        <Link className="btn btn-primary btn-small" href={setupHref('key', '/dashboard/images')}>
          Create a key
        </Link>
      </div>
    );

  return (<>
    {compareOn && (
      <>
        <div className="compare-mode" role="group" aria-label="Image studio mode">
          <button ref={studioModeButton} type="button" className="size-chip" aria-pressed={!comparing} onClick={() => setCompareMode(false)}>Studio</button>
          <button type="button" className="size-chip" aria-pressed={comparing} onClick={() => setCompareMode(true)}>Compare</button>
        </div>
        <div hidden={!comparing}>
          <ImageCompare
            models={models} modelsError={modelsError} prompt={prompt} setPrompt={setPrompt}
            preferredModel={modelId} preferredSize={size}
            onUseModel={(id, resultSize) => {
              setModelId(id);
              setSize(resultSize);
              setCompareMode(false);
              studioModeButton.current?.focus();
            }}
          />
        </div>
      </>
    )}
    <div className="studio" hidden={comparing}>
      <form
        className="studio-panel"
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <label className="field">
          <span>Describe the image</span>
          <textarea
            className="textarea studio-prompt"
            rows={5}
            maxLength={4000}
            value={prompt}
            placeholder="A lighthouse on black rocks at dusk, oil painting"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void generate();
              }
            }}
          />
        </label>
        {!prompt && (
          <div className="studio-ideas">
            {IDEAS.map((idea) => (
              <button key={idea} type="button" className="chip" onClick={() => setPrompt(idea)}>
                <Sparkles size={12} aria-hidden="true" /> {idea.split(',')[0]}
              </button>
            ))}
          </div>
        )}

        <fieldset className="field">
          <legend>Model</legend>
          {modelsError ? (
            <p className="muted">{modelsError}</p>
          ) : !models ? (
            <p className="muted">Loading models…</p>
          ) : (
            <div className="studio-models">
              {models.map((m) => (
                <label key={m.id} className={m.id === modelId ? 'studio-model is-on' : 'studio-model'}>
                  <input type="radio" name="model" value={m.id} checked={m.id === modelId} onChange={() => setModelId(m.id)} />
                  <strong>{m.name}</strong>
                  <small>{formatUsd(usdToMusd(m.pricing.usd_per_image))} an image</small>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <details className="studio-options field-help">
          <summary>Image options <span>{model ? shapeOf(size) + ' · ' : ''}{n === 1 ? '1 image' : n + ' images'}</span></summary>
          <div className="studio-options-fields">
        {model && (
          <fieldset className="field">
            <legend>Shape</legend>
            <div className="studio-sizes">
              {model.sizes.map((s) => (
                <button key={s} type="button" className={s === size ? 'size-chip is-on' : 'size-chip'} aria-pressed={s === size} onClick={() => setSize(s)}>
                  <span className="size-box" style={{ aspectRatio: ratioOf(s) }} aria-hidden="true" />
                  <span>
                    {shapeOf(s)} <small>{s.replace('x', '×')}</small>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="field">
          <legend>How many</legend>
          <div className="studio-count">
            {[1, 2, 3, 4].map((c) => (
              <button key={c} type="button" className={c === n ? 'size-chip is-on' : 'size-chip'} aria-pressed={c === n} onClick={() => setN(c)}>
                {c}
              </button>
            ))}
          </div>
        </fieldset>

          </div>
        </details>

        <button type="submit" className="btn btn-primary studio-go" disabled={!model || !prompt.trim() || !key}>
          <ImageIcon size={18} aria-hidden="true" /> Make {n === 1 ? 'image' : `${n} images`}
          {model && <span className="studio-cost">{formatUsd(cost)}</span>}
        </button>
        <p className="studio-note">
          <ShieldCheck size={14} aria-hidden="true" /> Safe for work only. Every image is checked. Refused or failed images cost nothing.
        </p>
      </form>

      <section className="studio-board" aria-live="polite" aria-label="Your images">
        {error && (
          <div className={error.funds ? 'notice notice-amber row' : 'notice notice-rose'} role="alert">
            <span style={{ flex: 1 }}>{error.text}</span>
            {error.funds && (
              <Link className="btn btn-small" href={setupHref('funds', '/dashboard/images')}>
                Add funds
              </Link>
            )}
          </div>
        )}
        {!jobs.length && !shots.length && !error && (
          <div className="studio-empty">
            <ImageIcon size={34} strokeWidth={1.25} aria-hidden="true" />
            <strong>Your images appear here.</strong>
            <p className="muted">They stay in this tab only. Download the ones you want to keep: each PNG carries a hidden watermark and a signed label saying it was made with AI.</p>
          </div>
        )}
        <div className="studio-grid">
          {jobs.flatMap((job) =>
            Array.from({ length: job.n }, (_, i) => (
              <div key={`${job.id}-${i}`} className="shot shot-pending" style={{ aspectRatio: job.ratio }}>
                <Loader2 size={22} className="spin" aria-hidden="true" />
                <span>
                  Painting… {Math.max(0, Math.round((now - job.started) / 1000))} s
                  <small>usually 10–40 s</small>
                </span>
              </div>
            )),
          )}
          {shots.map((s) => (
            <figure key={s.id} className="shot">
              <Photo src={s.src} alt={s.prompt} style={{ aspectRatio: ratioOf(s.size) }} />
              <figcaption>
                <p title={s.prompt}>{s.prompt}</p>
                <div className="shot-meta">
                  <span className="chip chip-signal">
                    <Stamp size={12} aria-hidden="true" /> C2PA + watermark
                  </span>
                  <span className="chip">{s.model}</span>
                  <span className="chip">{formatUsd(usdToMusd(s.costUsd))}</span>
                </div>
                <div className="shot-actions">
                  <a className="btn btn-small" href={s.src} download={`anonymo-${s.requestId}.png`}>
                    <Download size={15} aria-hidden="true" /> Download PNG
                  </a>
                  {updateOn('vault', demo) && <SaveLibraryImage demo={demo} src={s.src} title={s.model} />}
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => setPrompt(s.prompt)}>
                    Reuse prompt
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-danger"
                    aria-label="Remove from this tab"
                    title="Remove from this tab"
                    onClick={() => {
                      URL.revokeObjectURL(s.src);
                      setShots((list) => list.filter((x) => x.id !== s.id));
                    }}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  </>
  );
}
