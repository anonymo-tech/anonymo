'use client';

import { Star, Check } from 'lucide-react';
import { useState } from 'react';
import { featureOn } from './feature-switches';
import { useDeviceSetting, isStringList } from './use-device-setting';
import '@/app/dashboard/everyday-updates.css';
import { chineseModelByKey } from '../../lib/chinese-models';
import { ProviderIcon } from './answer-card';

type PickerModel = { id: string; name: string; family: string; specialty: string };

export function ModelPickerOptions({ models, selected, available, query, studio, onToggle, accountScope }: {
  accountScope: string;
  models: readonly PickerModel[];
  selected: readonly string[];
  available: readonly string[] | null;
  query: string;
  studio: boolean;
  onToggle: (id: string) => void;
}) {
  const favourites = useDeviceSetting(`conclave-front-row-v1:${accountScope}`, [] as string[], isStringList, featureOn('frontRow') && !studio);
  const [starredOnly, setStarredOnly] = useState(false);
  const search = query.trim().toLowerCase();
  const filtered = models.filter(model => {
    if (!studio && featureOn('frontRow') && starredOnly && !favourites.value.includes(model.id)) return false;
    const chinese = chineseModelByKey.get(model.id);
    return `${model.name} ${model.family} ${chinese?.name ?? ''} ${chinese?.modelId ?? ''} ${chinese?.provider ?? ''} ${chinese ? 'Chinese China 中国 中文' : ''}`.toLowerCase().includes(search);
  });
  filtered.sort((a,b) => Number(favourites.value.includes(b.id)) - Number(favourites.value.includes(a.id)));
  const global = filtered.filter(model => studio || !chineseModelByKey.has(model.id));
  const chinese = studio ? [] : filtered.filter(model => chineseModelByKey.has(model.id));
  const featured = chinese.filter(model => chineseModelByKey.get(model.id)?.featured || selected.includes(model.id));
  const more = chinese.filter(model => !featured.includes(model));
  function option(model: PickerModel) {
    const detail = chineseModelByKey.get(model.id);
    const chosen = selected.includes(model.id);
    const connected = available === null || available.includes(model.id);
    const button = <button className="cw-model-option" data-icon-trigger key={model.id}
      disabled={!chosen && !connected} aria-pressed={chosen}
      onClick={() => onToggle(model.id)}>
      <ProviderIcon id={model.id} />
      <span><strong>{detail?.name ?? model.name}</strong><small>{!connected ? 'Temporarily unavailable' : detail?.publisher ?? (studio && available ? 'Video generation' : model.specialty)}</small></span>
      <span className={`cw-choice${chosen ? ' checked' : ''}`}>{chosen && <Check size={13} />}</span>
    </button>;
    return !studio && featureOn('frontRow') ? <div className="eu-model-row" key={model.id}>{button}<button className="eu-star" disabled={!favourites.loaded} aria-label={`${favourites.value.includes(model.id) ? 'Remove' : 'Keep'} ${model.name} ${favourites.value.includes(model.id) ? 'from' : 'in'} Front Row`} aria-pressed={favourites.value.includes(model.id)} onClick={() => favourites.save(favourites.value.includes(model.id) ? favourites.value.filter(id => id !== model.id) : [...favourites.value, model.id])}><Star size={17} fill={favourites.value.includes(model.id) ? 'currentColor' : 'none'} /></button></div> : button;
  }
  return <div className="cw-model-options">
    {!studio && featureOn('frontRow') && <><div className="eu-controls"><button aria-pressed={starredOnly} onClick={() => setStarredOnly(!starredOnly)}>Front Row</button><span className="eu-note">Your picks, saved on this device.</span></div>{favourites.error && <p role="status" className="eu-error">{favourites.error}</p>}</>}
    {global.map(option)}
    {chinese.length > 0 && <section className="cw-chinese-models" aria-labelledby="cw-chinese-models-title">
      <h3 id="cw-chinese-models-title">Chinese models <span>{chinese.length}</span></h3>
      {(search ? chinese : featured).map(option)}
      {!search && more.length > 0 && <details className="cw-model-variants">
        <summary>More Chinese models <span>{more.length}</span></summary>
        {more.map(option)}
      </details>}
    </section>}
    {!filtered.length && <p className="cw-model-empty">No models match “{query.trim()}”.</p>}
  </div>;
}
