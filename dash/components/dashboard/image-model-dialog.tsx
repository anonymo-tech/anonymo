'use client';

import { ArrowUpRight, Check, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { MediaImageModel } from '@/lib/anonymo/types';
import { musdToUsdString, usdToMusd } from '@/lib/anonymo/money';

const logos: Record<string, string> = {
  google: 'gemini', openai: 'openai', bfl: 'flux', ideogram: 'ideogram', recraft: 'recraft', krea: 'krea', xai: 'grok',
};

export function ImageModelMark({ id }: { id: string }) {
  const brand = id.split('/')[0];
  const logo = logos[brand];
  return <span className="image-brand" aria-hidden="true">{logo
    ? <img alt="" src={'/model-logos/' + logo + '.svg'} width="22" height="22" />
    : brand.slice(0, 2).toUpperCase()}</span>;
}

export function imagePrice(microUsd: number) {
  const amount = musdToUsdString(microUsd);
  const [whole, fraction = ''] = amount.split('.');
  return '$' + whole + '.' + fraction.padEnd(2, '0');
}

const tasks: Record<string, string> = {
  'google/nano-banana': 'Everyday scenes and playful illustrations',
  'openai/gpt-image-2': 'Detailed prompts and complex compositions',
  'bfl/flux.2-max': 'Realistic lighting and fine detail',
  'bfl/flux.2-flash': 'Quick sketches and visual experiments',
  'ideogram/v4.5': 'Posters, lettering and graphic layouts',
  'recraft/v4.1': 'Brand graphics and stylized illustrations',
  'krea/krea-2-medium': 'Art direction and expressive textures',
  'xai/grok-imagine-2': 'Cinematic scenes and imaginative concepts',
};

export function ImageModelDialog({ models, selected, free, loading, error, busy, onRetry, onPick, onClose }: {
  models: MediaImageModel[]; selected: string; free: string[] | null; loading: boolean; error: string | null;
  busy: boolean; onRetry: () => void; onPick: (id: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    node?.querySelector('h2')?.focus();
    return () => node?.close();
  }, []);
  // Use explicit catalog naming only. A provider or an open license says nothing about filtering.
  const marked = (m: MediaImageModel) => /(?:^|[\s/_-])uncensored(?:$|[\s/_-])/i.test(m.id + ' ' + m.name);
  const sorted = [...models].sort((a, b) => Number(marked(b)) - Number(marked(a)));
  return createPortal(<dialog ref={dialog} className="image-model-dialog" aria-labelledby="image-model-title"
    onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <header><button type="button" aria-label="Close image model chooser" disabled={busy} onClick={onClose}><X size={19} /></button>
      <h2 id="image-model-title" tabIndex={-1}>Choose your image model</h2>
      <p>{free?.length ? 'Your first image is on us. Pick a model to start.' : 'Pick a model for the image you have in mind.'}</p>
    </header>
    {error && <p role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></p>}
    {loading ? <p role="status">Loading image models…</p> : <ul aria-label="Image models">{sorted.map(model => {
      return <li key={model.id}><button type="button" disabled={busy} onClick={() => onPick(model.id)}>
        <ImageModelMark id={model.id} />
        <span><strong>{model.name}</strong><small>{tasks[model.id] ?? model.family}</small></span>
        {free && !free.includes(model.id) && <small>{imagePrice(usdToMusd(model.pricing.usd_per_image))}</small>}
        {selected === model.id ? <Check size={16} /> : <ArrowUpRight size={16} />}
      </button></li>;
    })}</ul>}
    {!loading && !error && !models.length && <p role="status">No image models are available right now.</p>}
    {busy && <p role="status">Preparing your studio…</p>}
  </dialog>,document.body);
}
