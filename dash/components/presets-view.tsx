'use client';

import { useState } from 'react';
import { useAnonymo } from './anonymo-provider';
import { CopyButton } from './copy-button';
import { API_BASE, publicApiBase } from '@/lib/anonymo/config';
import { maskKey } from '@/lib/anonymo/key-store';
import { KEY_PLACEHOLDER, PRESETS, presetText } from '@/lib/anonymo/presets';
import { ANONYMO_MODEL_IDS } from '@/lib/anonymo/types';

/** One-paste setups for JanitorAI, SillyTavern, Chub, Agnai, Open WebUI, LibreChat and TypingMind. */
export function PresetsView() {
  const { ready, demo, key } = useAnonymo();
  const [active, setActive] = useState(PRESETS[0].id);
  const [model, setModel] = useState<string | null>(null);
  const [withKey, setWithKey] = useState(false);
  const preset = PRESETS.find((p) => p.id === active) ?? PRESETS[0];
  const chosenModel = model ?? preset.defaultModel;
  const base = ready ? publicApiBase(demo) : API_BASE || 'https://api.anonymo.example';
  const realKey = withKey && key ? key : KEY_PLACEHOLDER;
  const ctx = { base, key: realKey, model: chosenModel };
  const shown = { ...ctx, key: withKey && key ? maskKey(key) : KEY_PLACEHOLDER };
  const snippet = preset.snippet?.(ctx);
  const shownSnippet = preset.snippet?.(shown);

  return (
    <div className="panel-stack">
      <fieldset className="segmented">
        <legend className="sr-only">Frontend</legend>
        {PRESETS.map((p) => (
          <button key={p.id} type="button" aria-pressed={p.id === preset.id} onClick={() => { setActive(p.id); setModel(null); }}>
            {p.name}
          </button>
        ))}
      </fieldset>
      <section className="panel" aria-labelledby="preset-title">
        <header>
          <h2 id="preset-title">{preset.name}</h2>
          <span className="faint">{preset.where}</span>
        </header>
        <div className="row">
          <label className="field" style={{ minWidth: 220 }}>
            Model
            <select className="select" value={chosenModel} onChange={(e) => setModel(e.target.value)}>
              {ANONYMO_MODEL_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          {key && (
            <label className="checkbox" style={{ alignSelf: 'flex-end', minHeight: 40 }}>
              <input type="checkbox" checked={withKey} onChange={(e) => setWithKey(e.target.checked)} />
              Fill in my key when copying
            </label>
          )}
        </div>
        <div className="preset-fields">
          {preset.fields(ctx).map((field, i) => {
            const display = preset.fields(shown)[i];
            return (
              <div className="preset-field" key={field.label}>
                <span>{field.label}</span>
                <code>{display.value}</code>
                <CopyButton text={field.value} />
              </div>
            );
          })}
        </div>
        {snippet && shownSnippet && (
          <>
            <pre className="snippet">
              <code>{shownSnippet.text}</code>
            </pre>
          </>
        )}
        <div className="row">
          <CopyButton text={presetText(preset, ctx)} label="Copy whole setup" className="btn-primary" />
          {snippet && <CopyButton text={snippet.text} label={`Copy ${snippet.language}`} />}
        </div>
        {preset.note && <p className="faint">{preset.note}</p>}
        <p className="faint">
          A frontend sees what you send through it. Your key works anywhere it is pasted, so use frontends you trust and set a
          spend cap on the key if you share a machine.
        </p>
        {demo && <p className="notice notice-amber">Demo mode: the base URL is a placeholder until the gateway is live.</p>}
      </section>
    </div>
  );
}
