'use client';

import { Box, Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { chatModelName, publishedPpqChat, searchChatModels, uncensoredChatModel } from '@/lib/anonymo/chat-models';
import type { AnonymoModelId, ModelInfo } from '@/lib/anonymo/types';
import { AUTO_CHOICE, AUTO_EXPLAINER, isAutoModel } from '@/lib/anonymo/auto';
import './model-picker.css';

export const MODEL_CHOICES: { id: AnonymoModelId; name: string; summary: string }[] = [
  { id: 'anonymo-1', name: 'Anonymo 1', summary: 'Automatic routing for everyday chat.' },
  { id: 'anonymo-rp', name: 'Anonymo RP', summary: 'Long-context roleplay with character cards and lorebooks.' },
  { id: 'anonymo-council', name: 'Anonymo Council', summary: 'Three model families compare answers. Priced at 4–5×.' },
  { id: 'anonymo-sealed', name: 'Anonymo Sealed', summary: 'Requires a hardware-attested route.' },
];

const familyLogos: [RegExp, string][] = [
  [/\bdeepseek/i, 'deepseek.svg'], [/\bgemma/i, 'gemma.svg'], [/\bglm(?:[-\s\d]|$)|^~?z-ai\//i, 'glm.svg'],
  [/\bqwen/i, 'qwen.svg'], [/\bclaude|^~?anthropic\//i, 'claude.svg'], [/\bgemini/i, 'gemini.svg'],
  [/^~?openai\//i, 'openai.svg'], [/\bmistral|\bmixtral/i, 'mistral.svg'], [/\bllama|^~?meta-llama\//i, 'meta.svg'],
];

export function directLogo(model: ModelInfo) {
  const name = chatModelName(model);
  if (/^venice(?:\s|:)/i.test(name)) return '/model-logos/venice.svg';
  const family = familyLogos.find(([pattern]) => pattern.test(`${model.id} ${name}`));
  return family ? `/model-logos/${family[1]}` : null;
}

export function modelIdentity(id: string, models: readonly ModelInfo[]) {
  const direct = models.find(model => model.id === id);
  if (direct) return { name: chatModelName(direct), logo: directLogo(direct) };
  const preset = MODEL_CHOICES.find(model => model.id === id) ?? (isAutoModel(id) ? AUTO_CHOICE : undefined);
  return { name: preset?.name ?? id, logo: preset ? '/favicon.svg' : null };
}

export function ModelLogo({ src }: { src: string | null }) {
  return <span className="model-logo" aria-hidden="true">{src ? <img src={src} width="24" height="24" alt="" /> : <Box size={20} />}</span>;
}

type Props = {
  value: string;
  onChange: (id: string) => void;
  live: ReadonlySet<string> | null;
  models: readonly ModelInfo[];
  catalogError: boolean;
  onRefresh: () => void;
  /** Update "auto": offer Auto (anonymo-auto) at the top of the list. */
  auto?: boolean;
};

export function ModelPicker({ value, onChange, live, models, catalogError, onRefresh, auto = false }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [uncensoredOnly, setUncensoredOnly] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const panel = dialog.current;
    panel?.showModal();
    panel?.focus();
    return () => { panel?.close(); trigger.current?.focus(); };
  }, [open]);

  const { name: selectedName, logo: selectedLogo } = modelIdentity(value, models);
  const featured = models.filter(m => uncensoredChatModel(m) && m.availability !== 'temporarily_unavailable');
  const visible = searchChatModels(uncensoredOnly ? featured : models, search);
  const aliases = uncensoredOnly ? [] : MODEL_CHOICES.filter(m => `${m.id} ${m.name} ${m.summary}`.toLowerCase().includes(search.trim().toLowerCase()));
  // Update "auto": Auto sits above every other choice while the search matches it.
  const showAuto = auto && !uncensoredOnly && `${AUTO_CHOICE.id} ${AUTO_CHOICE.name} ${AUTO_CHOICE.summary}`.toLowerCase().includes(search.trim().toLowerCase());
  const select = (id: string) => { onChange(id); setOpen(false); };
  const option = (id: string, name: string, logo: string | null, disabled: boolean, context: string) => <li key={id}>
    <button type="button" className="model-option" title={`${id} · ${context}`} aria-description={`${id}. ${context}`} aria-pressed={id === value} disabled={disabled} onClick={() => select(id)}>
      <ModelLogo src={logo} />
      <span className="model-name">{name}</span>
      {id === value && <Check className="model-check" size={16} aria-hidden="true" />}
    </button>
  </li>;
  return <div className="picker model-picker">
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} title={value} aria-label={`Choose model: ${selectedName}`}
      onClick={() => { setOpen(true); setSearch(''); setUncensoredOnly(false); }}>
      <ModelLogo src={selectedLogo} /><span>{selectedName}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && createPortal(<dialog className="chat-model-dialog" aria-label="Choose a model" tabIndex={-1} ref={dialog}
      onCancel={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) setOpen(false); }}>
      <div className="chat-model-panel">
        <header><h2>Choose a model</h2><button type="button" aria-label="Close model picker" onClick={() => setOpen(false)}><X size={20} /></button></header>
        <label className="model-search"><Search size={17} aria-hidden="true" /><input type="search" placeholder="Search models" aria-label="Search models" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="model-filters" aria-label="Model filters" role="group">
          <button type="button" aria-pressed={!uncensoredOnly} onClick={() => setUncensoredOnly(false)}>All text models</button>
          <button type="button" aria-pressed={uncensoredOnly} onClick={() => setUncensoredOnly(true)}>Uncensored</button>
        </div>
        <div className="model-results">
          {showAuto && <ul aria-label="Auto" className="model-auto">
            {option(AUTO_CHOICE.id, AUTO_CHOICE.name, '/favicon.svg', live !== null && !live.has(AUTO_CHOICE.id), AUTO_EXPLAINER)}
            <li className="model-auto-note faint">{AUTO_CHOICE.summary}</li>
          </ul>}
          {aliases.length > 0 && <ul aria-label="Anonymo models">{aliases.map(m => option(m.id, m.name, '/favicon.svg', live !== null && !live.has(m.id), m.summary))}</ul>}
          {visible.length > 0 && <ul aria-label="Direct models">{visible.map(m => {
            const logo = directLogo(m);
            const context = publishedPpqChat(m) || m.ppq_uncensored === true ? 'Regular Chat via PPQ. Provider data policy applies.' : 'Regular Chat. Provider data policy applies.';
            return option(m.id, chatModelName(m), logo, m.availability === 'temporarily_unavailable', context);
          })}</ul>}
          {catalogError && <p role="status">The live model list is unavailable. <button type="button" onClick={onRefresh}>Retry</button></p>}
          {!catalogError && live === null && <p role="status">Loading live models…</p>}
          {live && !showAuto && !aliases.length && !visible.length && <p role="status">{uncensoredOnly && !featured.length ? 'No verified uncensored direct models are available right now.' : 'No matching text models.'}</p>}
        </div>
      </div>
    </dialog>, document.body)}
  </div>;
}
