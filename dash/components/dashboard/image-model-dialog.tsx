'use client';

import { StudioModelDialog, type StudioDialogActions } from './studio-model-dialog';
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

export function ImageModelDialog({ models, free, ...actions }: StudioDialogActions & {
  models: MediaImageModel[]; free: string[] | null;
}) {
  // Use explicit catalog naming only. A provider or an open license says nothing about filtering.
  const marked = (m: MediaImageModel) => /(?:^|[\s/_-])uncensored(?:$|[\s/_-])/i.test(m.id + ' ' + m.name);
  const sorted = [...models].sort((a, b) => Number(marked(b)) - Number(marked(a)));
  return <StudioModelDialog {...actions} kind="image"
    subtitle={free?.length ? 'Your first image is on us. Pick a model to start.' : 'Pick a model for the image you have in mind.'}
    choices={sorted.map(model => ({
      id: model.id, name: model.name, description: tasks[model.id] ?? model.family,
      mark: <ImageModelMark id={model.id} />,
      price: free && !free.includes(model.id) ? imagePrice(usdToMusd(model.pricing.usd_per_image)) : undefined,
    }))} />;
}
