'use client';

import { Columns2, Download, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  type CompareFailure,
  compareSizes,
  comparisonTotal,
  formatComparePrice,
  MAX_COMPARE_MODELS,
  MIN_COMPARE_MODELS,
  planComparison,
  runComparison,
  toggleCompareModel,
} from '@/lib/anonymo/compare';
import { usdToMusd } from '@/lib/anonymo/money';
import type { MediaImageModel } from '@/lib/anonymo/types';
import { useAnonymo } from '../anonymo-provider';
import { Photo } from '../photo';

const EXAMPLE = 'A lighthouse on black rocks at dusk, textured screen print';
const FAILURE_LABELS = { blocked: 'Blocked', failed: 'Failed', unconfirmed: 'Result unconfirmed' };

type Outcome =
  | { status: 'pending' }
  | { status: 'ready'; imageUrl: string; receiptUrl: string | null; requestId: string; price: number }
  | CompareFailure;
type Tile = ReturnType<typeof planComparison>[number] & { outcome: Outcome };

type Props = {
  models: MediaImageModel[] | null;
  modelsError: string | null;
  prompt: string;
  setPrompt: (prompt: string) => void;
  preferredModel: string;
  preferredSize: string;
  onUseModel: (id: string, size: string) => void;
};

export function ImageCompare({ models, modelsError, prompt, setPrompt, preferredModel, preferredSize, onUseModel }: Props) {
  const { client, key, refreshBalance } = useAnonymo();
  const [selection, setSelection] = useState<readonly string[] | null>(null);
  const [chosenSize, setChosenSize] = useState('');
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [submittedPrompt, setSubmittedPrompt] = useState('');
  const run = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => () => {
    run.current?.abort();
    urls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const available = models?.filter((model) => model.sizes.length) ?? [];
  const defaults = available.find((model) => model.id === preferredModel);
  const ids = (selection ?? [
    ...(defaults ? [defaults] : []),
    ...available.filter((model) => model !== defaults),
  ].slice(0, MIN_COMPARE_MODELS).map((model) => model.id)).filter((id) => available.some((model) => model.id === id));
  const selected = available.filter((model) => ids.includes(model.id));
  const sizes = compareSizes(selected);
  const requestedSize = chosenSize || preferredSize;
  const size = sizes.includes(requestedSize) ? requestedSize : (sizes[0] ?? '');
  const plan = planComparison(selected, size);
  const total = comparisonTotal(plan);
  const busy = tiles.some(({ outcome }) => outcome.status === 'pending');
  const canSubmit = !!key && !!prompt.trim() && selected.length >= MIN_COMPARE_MODELS && Number.isSafeInteger(total) && !busy;

  async function compare() {
    if (!canSubmit || run.current) return;
    const controller = new AbortController();
    run.current = controller;
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
    setSubmittedPrompt(prompt.trim());
    setTiles(plan.map((image) => ({ ...image, outcome: { status: 'pending' } })));

    function objectUrl(blob: Blob) {
      const url = URL.createObjectURL(blob);
      urls.current.push(url);
      return url;
    }

    try {
      await runComparison(plan, prompt, (request) => client.generateImages(request, controller.signal), (id, result) => {
        if (controller.signal.aborted) return;
        const outcome: Outcome = result.status === 'ready' ? {
          status: 'ready',
          imageUrl: objectUrl(new Blob([result.png], { type: 'image/png' })),
          receiptUrl: result.receipt ? objectUrl(new Blob([JSON.stringify(result.receipt, null, 2)], { type: 'application/json' })) : null,
          requestId: result.requestId,
          price: result.price,
        } : result;
        setTiles((previous) => previous.map((tile) => tile.model.id === id ? { ...tile, outcome } : tile));
      });
    } finally {
      run.current = null;
      if (!controller.signal.aborted) refreshBalance();
    }
  }

  return (
    <div className="image-compare">
      <form className="compare-form studio-panel" onSubmit={(event) => {
        event.preventDefault();
        void compare();
      }}>
        <div className="compare-prompt">
          <label className="field">
            <span>Describe the image</span>
            <textarea className="textarea studio-prompt" rows={4} maxLength={4000} value={prompt}
              placeholder={EXAMPLE} onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void compare();
                }
              }} />
          </label>
          {!prompt && <div className="studio-ideas">
            <button type="button" className="chip" onClick={() => setPrompt(EXAMPLE)}>Try the lighthouse prompt</button>
          </div>}
          {sizes.length > 0 && <label className="field compare-size">
            <span>Image size</span>
            <select className="select" value={size} onChange={(event) => setChosenSize(event.target.value)}>
              {sizes.map((option) => <option key={option} value={option}>{option.replace('x', ' × ')}</option>)}
            </select>
          </label>}
        </div>

        <fieldset className="field">
          <legend>Models · {selected.length}/{MAX_COMPARE_MODELS} selected</legend>
          {modelsError ? <p className="muted">{modelsError}</p>
            : !models ? <p className="muted">Loading models…</p>
            : available.length < MIN_COMPARE_MODELS ? <p className="muted">Compare needs at least two image models.</p>
            : <>
              <p className="muted">Pick 2 to 4 models. Each makes one image.</p>
              <div className="compare-models">
                {available.map((model) => {
                  const checked = ids.includes(model.id);
                  const planned = plan.find((image) => image.model.id === model.id);
                  return <label key={model.id} className={checked ? 'studio-model is-on' : 'studio-model'}>
                    <input type="checkbox" checked={checked} disabled={!checked && ids.length >= MAX_COMPARE_MODELS}
                      onChange={() => setSelection(toggleCompareModel(ids, model.id))} />
                    <strong>{model.name}</strong>
                    <small>
                      {formatComparePrice(usdToMusd(model.pricing.usd_per_image))}
                      {planned && planned.size !== size && ` · Uses ${planned.size.replace('x', ' × ')}`}
                    </small>
                  </label>;
                })}
              </div>
            </>}
        </fieldset>

        <div className="compare-submit">
          <p className="studio-note"><ShieldCheck size={14} aria-hidden="true" /> Safe for work only. Every image is checked.</p>
          <div className="compare-total">
            <span aria-live="polite" aria-atomic="true">Total <strong>{formatComparePrice(total)}</strong></span>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              <Columns2 size={17} aria-hidden="true" /> {busy ? 'Comparing…' : 'Compare models'}
            </button>
          </div>
        </div>
      </form>

      <section className="studio-board" aria-label="Comparison results">
        {tiles.length === 0 ? (
          <div className="studio-empty">
            <Columns2 size={34} strokeWidth={1.25} aria-hidden="true" />
            <strong>Your comparison appears here.</strong>
          </div>
        ) : (
          <div className={tiles.length > 2 ? 'compare-grid compare-grid-many' : 'compare-grid'}>
            {tiles.map((tile) => <CompareTile key={tile.model.id} tile={tile} prompt={submittedPrompt}
              onUseModel={() => onUseModel(tile.model.id, tile.size)} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function CompareTile({ tile, prompt, onUseModel }: { tile: Tile; prompt: string; onUseModel: () => void }) {
  const { model, outcome, price, size } = tile;
  const pending = outcome.status === 'pending';
  const ready = outcome.status === 'ready';
  const cost = ready ? formatComparePrice(outcome.price) : pending ? formatComparePrice(price) : outcome.status === 'unconfirmed' ? '—' : '$0.00';

  return (
    <article className="shot compare-tile" aria-label={model.name}>
      <header className="compare-tile-head">
        <h3>{model.name}</h3>
        <span>{size.replace('x', ' × ')} · {cost}</span>
      </header>
      <div className="compare-preview">
        {ready && <Photo src={outcome.imageUrl} alt={`${model.name} result for ${prompt}`} />}
        <div className={ready ? 'sr-only' : 'compare-state'} role="status">
          <span className="sr-only">{model.name}. </span>
          {ready ? 'Image ready.' : pending ? <>
            <Loader2 className="spin" size={22} aria-hidden="true" />
            <span>Generating…</span>
          </> : <>
            <strong>{FAILURE_LABELS[outcome.status]}</strong>
            <span>{outcome.message}</span>
            {outcome.status !== 'unconfirmed' && <span>You were not charged.</span>}
          </>}
        </div>
      </div>
      <footer className="shot-actions compare-tile-actions">
        {ready && <>
          <a className="btn btn-small" href={outcome.imageUrl} download={`anonymo-${outcome.requestId}.png`}>
            <Download size={15} aria-hidden="true" /> Download
          </a>
          {outcome.receiptUrl && <a className="btn btn-ghost btn-small" href={outcome.receiptUrl} target="_blank" rel="noopener noreferrer">Receipt</a>}
        </>}
        {!pending && <button type="button" className="btn btn-ghost btn-small" onClick={onUseModel}>Use this model</button>}
      </footer>
    </article>
  );
}
