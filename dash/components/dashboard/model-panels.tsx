'use client';
import { useState } from 'react';
import { useDeviceSetting } from './use-device-setting';
import {
  isModelPanels,
  panelAvailable,
  type ModelPanel,
} from '../../lib/model-panels';
export function ModelPanels({
  scope,
  selected,
  available,
  onApply,
}: {
  scope: string;
  selected: readonly string[];
  available: readonly string[];
  onApply: (ids: string[]) => void;
}) {
  const saved = useDeviceSetting(
    `conclave-panels-v1:${scope}`,
    [] as ModelPanel[],
    isModelPanels,
  );
  const [name, setName] = useState('');
  return (
    <details>
      <summary>Your Panel</summary>
      <p className="eu-note">
        Keep a group of up to four models on this device.
      </p>
      <form
        className="eu-controls"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            !name.trim() ||
            !selected.length ||
            selected.length > 4 ||
            saved.value.length >= 20
          )
            return;
          saved.save([
            ...saved.value,
            {
              id: crypto.randomUUID(),
              name: name.trim(),
              models: [...selected],
            },
          ]);
          setName('');
        }}
      >
        <input
          aria-label="Panel name"
          placeholder="Name this group"
          value={name}
          maxLength={48}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          disabled={
            !saved.loaded ||
            !name.trim() ||
            !selected.length ||
            saved.value.length >= 20
          }
        >
          Save panel
        </button>
      </form>
      {saved.value.map((p) => (
        <div className="eu-controls" key={p.id}>
          <button
            disabled={!panelAvailable(p, available)}
            title={
              panelAvailable(p, available)
                ? p.models.join(', ')
                : 'One or more models are unavailable'
            }
            onClick={() => onApply([...p.models])}
          >
            {p.name} · {p.models.length}
          </button>
          <button
            aria-label={`Delete panel ${p.name}`}
            onClick={() => saved.save(saved.value.filter((v) => v.id !== p.id))}
          >
            Remove
          </button>
        </div>
      ))}
      {saved.value.length >= 20 && (
        <p className="eu-note">
          Remove a saved panel to make room for another.
        </p>
      )}
      {saved.error && (
        <output className="eu-error">
          {saved.error}
        </output>
      )}
    </details>
  );
}
