'use client';

import './image-studio.css';
import { ImageModelDialog, ImageModelMark, imagePrice } from './image-model-dialog';
import { adultStore } from '@/lib/anonymo/prefs';
import { loadKey } from '@/lib/anonymo/key-store';
import { dashboardSignup } from '@/lib/anonymo/dashboard-signup';
import { setupHref } from '@/lib/anonymo/setup-return';

// Update "images": the image studio. Prompt, model, size and count; images come back as base64 PNGs with provenance
// (a hidden watermark and a signed C2PA label) and stay in this tab until downloaded or saved. Safe for work: the gateway refuses nude or
// sexual prompts before anything is made and checks every image before it is returned (gateway src/anonymo/media).

import Link from 'next/link';
import { CopyButton } from '../copy-button';
import { Photo } from '../photo';
import { ArrowLeftRight, ArrowUpRight, ChevronDown, Download, ImageIcon, Maximize2, Proportions, WandSparkles, X, Loader2, SlidersHorizontal, Stamp, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { usdToMusd } from '@/lib/anonymo/money';
import { IMAGE_PROMPT_LIMIT, imageCounts, imageError, imageModels } from '@/lib/anonymo/chat-modes';
import { takeStudioDraft } from './image-studio-draft';
import type { MediaImageModel } from '@/lib/anonymo/types';
import { updateOn } from '@/lib/anonymo/updates';
import { ImageCompare } from './image-compare';
import { SaveLibraryImage } from './save-library-image';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { IMAGE_PRESETS, studioPrompt, type ImagePreset } from '@/lib/anonymo/studio-presets';
import { StudioCharacter } from './studio-character';

export { imageError } from '@/lib/anonymo/chat-modes';

type Shot = { id: string; src: string; prompt: string; model: string; size: string; costUsd: string; requestId: string; at: number; preset?: ImagePreset; characterId?: string };
type Job = { id: string; n: number; ratio: string; started: number };

const IDEAS = [
  {
    title: 'Unredacted',
    art: 'unredacted',
    prompt: 'A punk zine portrait with one eye staring through a torn black redaction strip. Raspberry ink, grainy halftone and rough paper edges.',
  },
  {
    title: 'Pirate radio',
    art: 'pirate-radio',
    prompt: 'Inside a pirate radio booth at midnight. A silver microphone under a red on-air lamp, amber mixer lights and deep shadows on grainy analog film.',
  },
  {
    title: 'Banned pages',
    art: 'banned-pages',
    prompt: 'A banned book breaks open and black ink birds fly through a split redaction bar. Screen print in cobalt and vermilion on warm ivory paper.',
  },
];

// The catalog provides pixel dimensions, including nonstandard model-specific ratios.
function aspectLabel(size: string) {
  const [w, h] = size.split('x').map(Number);
  let a = w, b = h;
  while (b) [a, b] = [b, a % b];
  return `${w / a}:${h / a}`;
}

const ratioOf = (size: string) => {
  const [w, h] = size.split('x').map(Number);
  return `${w} / ${h}`;
};
const makeJob = (n: number, size: string): Job => ({ id: crypto.randomUUID(), n, ratio: ratioOf(size), started: Date.now() });

export function ImageStudio() {
  const { ready, key, setKey, client, refreshBalance, demo } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const [picker, showPicker] = useState(false);
  const [picking, setPicking] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const pickingNow = useRef(false);
  const making = useRef(false);
  const initialized = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [retry, refresh] = useState(0);
  const [pickError, setPickError] = useState<string | null>(null);
  const [offer, setOffer] = useState<{client: typeof client; available: boolean; eligible_models: string[]} | null>(null);
  const [offerError, setOfferError] = useState(false);
  const currentOffer = offer?.client === client ? offer : null;
  const modelSlot = demo ? 'anonymo.image-model.demo.v1' : 'anonymo.image-model.v1';
  const compareOn = updateOn('compare', demo);
  const studioOn = updateOn('studio', demo);
  const characters = useDeviceStore(charactersStore);
  const [preset, setPreset] = useState<ImagePreset | ''>('');
  const [characterId, setCharacterId] = useState('');
  const character = characters.find((entry) => entry.id === characterId);
  const [compareMode, setCompareMode] = useState(false);
  const studioModeButton = useRef<HTMLButtonElement>(null);
  const comparing = compareOn && compareMode;
  const [models, setModels] = useState<MediaImageModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState('');
  const [chosenSize, setSize] = useState('1024x1024');
  const [chosenCount, setN] = useState(1);
  const [prompt, setPrompt] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [shots, setShots] = useState<Shot[]>([]);
  const [preview, setPreview] = useState<Shot | null>(null);
  const viewer = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!preview) return;
    const node = viewer.current;
    node?.showModal();
    return () => node?.close();
  }, [preview]);
  const [error, setError] = useState<{ text: string; funds: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const urls = useRef<string[]>([]);

  useEffect(() => {
    if (!ready) return;
    let stale = false;
    setModelsError(null);
    client.mediaModels().then(
      (list) => {
        if (stale) return;
        const images = imageModels(list);
        const draft = key && updateOn('modes', demo) ? takeStudioDraft(demo) : null;
        if (draft) {
          setPrompt(draft.prompt);
          setSize(draft.settings.size);
          setN(draft.settings.n);
        }
        setModels(images);
        let saved = '';
        try { saved = localStorage.getItem(modelSlot) ?? ''; } catch { /* Device storage is optional. */ }
        const preferred = draft?.settings.model ?? saved;
        const valid = images.some(entry => entry.id === preferred);
        if (draft || !initialized.current) {
          setModelId(valid ? preferred : '');
          showPicker(!(valid && key));
          initialized.current = true;
        }
      },
      () => !stale && setModelsError('Images are not switched on for this gateway yet.'),
    );
    return () => {
      stale = true;
    };
  }, [ready, client, demo, key, retry, modelSlot]);
  useEffect(() => {
    if (!ready || !adult) return;
    const abort = new AbortController();
    setOffer(null);
    setOfferError(false);
    client.imageWelcome(abort.signal).then(info => {
      if (!abort.signal.aborted) setOffer({client, ...info});
    }).catch(() => { if (!abort.signal.aborted) setOfferError(true); });
    return () => abort.abort();
  }, [ready, adult, client, retry]);

  async function pickModel(id: string) {
    if (pickingNow.current) return;
    pickingNow.current = true;
    setPickError(null);
    setPicking(true);
    try {
      if (!loadKey(demo)) {
        const fresh = await client.createKey({dashboard_signup: await dashboardSignup(demo)});
        if (!loadKey(demo)) {
          setKey(fresh.key, false);
          setCreatedKey(fresh.key);
        }
      }
      setModelId(id);
      try { localStorage.setItem(modelSlot, id); } catch { /* Kept for this visit. */ }
      showPicker(false);
      requestAnimationFrame(() => editor.current?.focus({preventScroll: true}));
    } catch (e) {
      setPickError(describeError(e));
    } finally {
      pickingNow.current = false;
      setPicking(false);
    }
  }
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => {
    if (!jobs.length) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [jobs.length]);

  const model = models?.find((m) => m.id === modelId) ?? null;
  const size = model && !model.sizes.includes(chosenSize) ? model.sizes[0] : chosenSize;
  const stickerPack = studioOn && preset === 'stickers';
  const counts = stickerPack ? [1] : studioOn || updateOn('modes', demo) ? imageCounts(model) : [1, 2, 3, 4];
  const n = counts.includes(chosenCount) ? chosenCount : (counts.at(-1) ?? 1);
  const cost = model ? usdToMusd(model.pricing.usd_per_image) * n : 0;
  const text = studioOn ? studioPrompt(prompt, preset, character?.card.data) : prompt.trim();
  const tooLong = studioOn && text.length > IMAGE_PROMPT_LIMIT;

  const sponsored = !!model && n === 1 && !!currentOffer?.available && currentOffer.eligible_models.includes(model.id);
  async function generate() {
    if (!text || tooLong || making.current) return;
    if (!model || !key) { showPicker(true); return; }
    if (!currentOffer) return;
    making.current = true;
    setError(null);
    const job = makeJob(n, size);
    setJobs((j) => [job, ...j]);
    try {
      const res = await (sponsored ? client.sponsoredImage : client.generateImages)({ model: model.id, prompt: text, n, size });
      const made: Shot[] = res.data.flatMap((d, i) => {
        if (!d.b64_json) return [];
        const bytes = Uint8Array.from(atob(d.b64_json), (c) => c.charCodeAt(0));
        const src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        urls.current.push(src);
        return [{ id: `${res.anonymo.request_id}-${i}`, src, prompt: prompt.trim(), model: model.name, size, costUsd: res.anonymo.cost_usd, requestId: res.anonymo.request_id, at: Date.now(), preset: preset || undefined, characterId: character?.id }];
      });
      if (!made.length) throw new Error('No image came back. Please try again.');
      setShots((s) => [...made, ...s]);
    } catch (e) {
      setError({ text: imageError(e), funds: isOutOfCredit(e) });
    } finally {
      setJobs((j) => j.filter((x) => x.id !== job.id));
      making.current = false;
      if (sponsored) { setOffer(null); refresh(i => i + 1); }
      refreshBalance();
    }
  }

  const freeModels = currentOffer ? (currentOffer.available ? currentOffer.eligible_models : []) : null;
  return (<div className="image-workspace">
    <header className="image-heading"><div><h1>Image studio</h1>
      {compareOn && key && <button type="button" className="image-compare-link" ref={studioModeButton}
        onClick={() => setCompareMode(!comparing)}><ArrowLeftRight size={14} />{comparing ? 'Back to studio' : 'Compare models'}</button>}
    </div><p>From uncensored chat to image generation, you choose the model.</p></header>
    {picker && ready && adult && <ImageModelDialog models={models ?? []} selected={modelId} free={freeModels}
      loading={!models && !modelsError} error={pickError ?? modelsError} busy={picking}
      onRetry={() => { setPickError(null); refresh(i => i + 1); }} onPick={id => void pickModel(id)} onClose={() => showPicker(false)} />}
    {modelsError && !picker && <p role="alert">{modelsError} <button onClick={() => refresh(i => i + 1)}>Retry</button></p>}
    {compareOn && key && (
      <>
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
        <label className="field image-prompt-field">
          <span className="image-field-label">Describe your image</span>
          <textarea
            className="textarea studio-prompt"
            ref={editor} rows={3}
            maxLength={IMAGE_PROMPT_LIMIT}
            value={prompt}
            placeholder="What do you want to make?"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void generate();
              }
            }}
          />
        </label>
        {tooLong && <p className="muted">Shorten your description to leave room for the preset and character details.</p>}
        <div className="image-controls">
          <button type="button" className="image-model-trigger" onClick={() => showPicker(true)}>
            {model ? <ImageModelMark id={model.id} /> : <ImageIcon size={15} />}
            <span>{model?.name ?? 'Choose a model'}</span><ChevronDown size={14} />
          </button>
          {model && <label className="aspect-select"><Proportions size={15} aria-hidden="true" />
            <select aria-label="Aspect ratio" value={size} onChange={e => setSize(e.target.value)}>
              {model.sizes.map(s => <option key={s} value={s}>{aspectLabel(s)}</option>)}
            </select></label>}
        </div>
        {offerError && <p role="alert">Couldn’t check the image offer. <button type="button" onClick={() => refresh(i => i + 1)}>Retry</button></p>}
        <details className="studio-options field-help">
          <summary><SlidersHorizontal size={14} /> Image options <span>{n === 1 ? '' : n + ' images'}</span><ChevronDown size={14} /></summary>
          <div className="studio-options-fields">
        {studioOn && (
          <>
            <fieldset className="field">
              <legend>Preset</legend>
              <div className="studio-sizes">
                <button type="button" className={preset === '' ? 'size-chip is-on' : 'size-chip'} aria-pressed={preset === ''} onClick={() => setPreset('')}>Custom</button>
                {(Object.keys(IMAGE_PRESETS) as ImagePreset[]).map((id) => (
                  <button key={id} type="button" className={preset === id ? 'size-chip is-on' : 'size-chip'} aria-pressed={preset === id} onClick={() => setPreset(id)}>
                    {IMAGE_PRESETS[id].label}
                  </button>
                ))}
                <Link href="/dashboard/video" className="size-chip">Short clip</Link>
              </div>
              {stickerPack && <small className="muted">Four expressions on one sticker sheet.</small>}
            </fieldset>
            <StudioCharacter characters={characters} selected={character?.id ?? ''} onChange={setCharacterId} />
          </>
        )}

        {!stickerPack && <fieldset className="field">
          <legend>How many</legend>
          <div className="studio-count">
            {counts.map((c) => (
              <button key={c} type="button" className={c === n ? 'size-chip is-on' : 'size-chip'} aria-pressed={c === n} onClick={() => setN(c)}>
                {c}
              </button>
            ))}
          </div>
        </fieldset>}

          </div>
        </details>

        <button type="submit" className="btn btn-primary studio-go"
          disabled={!text || tooLong || picking || jobs.length > 0 || (!!key && !!model && !currentOffer)}>
          <WandSparkles size={16} aria-hidden="true" />
          {jobs.length ? 'Generating…' : sponsored ? (stickerPack ? 'Generate free sticker pack' : 'Generate free image')
            : stickerPack ? 'Make sticker pack' : n > 1 ? `Make ${n} images` : 'Generate image'}
          {model && currentOffer && !sponsored && <span className="studio-cost">{imagePrice(cost)}</span>}
        </button>
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
        {!jobs.length && !shots.length && <section className="image-ideas" aria-label="Prompt ideas">
          <h2>Prompt ideas</h2><div>{IDEAS.map(idea => <button key={idea.art} type="button"
            onClick={() => { setPrompt(idea.prompt); editor.current?.focus(); }}>
            <img className="idea-art" src={`/image-studio/${idea.art}.webp`} alt="" />
            <span>{idea.title} <ArrowUpRight size={15} /></span>
          </button>)}</div>
        </section>}
        {(jobs.length > 0 || shots.length > 0) && <h2 className="image-results-title">Your images</h2>}
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
              <button type="button" className="shot-open" aria-label="View full image" onClick={() => setPreview(s)}>
                <Photo src={s.src} alt={s.prompt || (s.preset ? IMAGE_PRESETS[s.preset].label : 'Generated image')} style={{ aspectRatio: ratioOf(s.size) }} />
                <span aria-hidden="true"><Maximize2 size={16} /></span>
              </button>
              <figcaption>
                <p title={s.prompt}>{s.prompt || (s.preset && IMAGE_PRESETS[s.preset].label)}</p>
                <div className="shot-meta">
                  <span className="chip chip-signal">
                    <Stamp size={12} aria-hidden="true" /> C2PA + watermark
                  </span>
                  <span className="chip">{s.model}</span>
                  <span className="chip">{imagePrice(usdToMusd(s.costUsd))}</span>
                </div>
                <div className="shot-actions">
                  <a className="btn btn-small" href={s.src} download={`anonymo-${s.requestId}.png`}>
                    <Download size={15} aria-hidden="true" /> Download PNG
                  </a>
                  {key && key === createdKey && s === shots[0] && <CopyButton text={key} label="Copy your key" className="btn btn-small" />}
                  {updateOn('vault', demo) && <SaveLibraryImage demo={demo} src={s.src} title={s.model} />}
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => {
                    setPrompt(s.prompt);
                    setPreset(s.preset ?? '');
                    setCharacterId(s.characterId ?? '');
                  }}>
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
    {preview && <dialog ref={viewer} className="image-viewer" aria-label="Full image" onCancel={() => setPreview(null)}>
      <header><strong>{preview.model}</strong><button type="button" autoFocus aria-label="Close full image" onClick={() => setPreview(null)}><X size={19} /></button></header>
      <Photo src={preview.src} alt={preview.prompt || 'Generated image'} />
      <footer><span>{preview.size.replace('x', ' × ')}</span>
        <a className="btn btn-small" href={preview.src} download={`anonymo-${preview.requestId}.png`}><Download size={14} /> Download PNG</a>
      </footer>
    </dialog>}
    <p className="image-policy">Image generation is safe for work. Download images to keep them.</p>
  </div>
  );
}
