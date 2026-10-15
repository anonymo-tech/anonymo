'use client';

import { useEffect, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { addCouncil, councilLimits, councilName, readCouncils, selectCouncil, writeCouncils, type SavedCouncil } from '../../lib/saved-councils';

// Retain changes when the picker closes, including when browser storage refuses writes.
let memory: { councils: SavedCouncil[]; stored: boolean } | null = null;
const listeners = new Set<() => void>();
const storage = () => window.localStorage;
function update(councils: SavedCouncil[]) {
  memory = { councils, stored: writeCouncils(storage, councils) };
  listeners.forEach(listener => listener());
}

export function SavedCouncilsPicker({ selected, models, available, onChoose, onDelete }: {
  selected: readonly string[];
  models: readonly { id: string; name: string }[];
  available: readonly string[] | null;
  onChoose: (ids: string[]) => void;
  onDelete: (undo: () => boolean) => void;
}) {
  const t = useT();
  const [snapshot, setSnapshot] = useState(memory);
  const [editor, setEditor] = useState<{ id: string | null; name: string } | null>(null);
  const [note, setNote] = useState<string[]>([]);
  const [noneAvailable, setNoneAvailable] = useState(false);
  useEffect(() => {
    memory ??= readCouncils(storage);
    const refresh = () => setSnapshot(memory);
    listeners.add(refresh);
    refresh();
    return () => { listeners.delete(refresh); };
  }, []);
  const councils = snapshot?.councils ?? [];
  const canSave = selected.length >= 2 && selected.length <= councilLimits.models && councils.length < councilLimits.councils;

  function save() {
    if (!editor || !councilName(editor.name) || !memory) return;
    if (editor.id) {
      update(memory.councils.map(item => item.id === editor.id ? { ...item, name: councilName(editor.name) } : item));
    } else if (canSave) {
      update(addCouncil(memory.councils, { id: crypto.randomUUID(), name: editor.name, modelIds: [...selected], createdAt: Date.now() }));
    } else return;
    setEditor(null);
  }

  return <section className="cw-councils" aria-label={t('Councils')}>
    <h3>{t('Councils')}</h3>
    <button type="button" disabled={!snapshot || !canSave} onClick={() => {
      let number = 1;
      while (councils.some(item => item.name === t('Council {number}', { number }))) number++;
      setEditor({ id: null, name: t('Council {number}', { number }) });
    }}>{t('Save this council')}</button>
    {councils.length === councilLimits.councils && <p>{t('You can save up to 6 councils. Delete one to make room.')}</p>}
    {councils.map(council => <div className="cw-council-row" key={council.id}>
      <button type="button" className="cw-council-pick" onClick={() => {
        const result = selectCouncil(council, models.map(model => model.id), available);
        setNote(result.skipped);
        setNoneAvailable(!result.modelIds.length);
        // Keep the existing selection when nothing is available: the composer requires a model.
        if (result.modelIds.length) onChoose(result.modelIds);
      }}>{council.name}</button>
      <details className="cw-council-menu">
        <summary aria-label={t('Council actions for {name}', { name: council.name })}><Ellipsis size={14} aria-hidden="true" /></summary>
        <div>
          <button type="button" onClick={event => {
            event.currentTarget.closest('details')?.removeAttribute('open');
            setEditor({ id: council.id, name: council.name });
          }}>{t('Rename council')}</button>
          <button type="button" onClick={() => {
            const index = councils.findIndex(item => item.id === council.id);
            update(councils.filter(item => item.id !== council.id));
            if (editor?.id === council.id) setEditor(null);
            onDelete(() => {
              const current = memory?.councils ?? [];
              if (current.length >= councilLimits.councils || current.some(item => item.id === council.id)) return false;
              const restored = [...current];
              restored.splice(index, 0, council);
              update(restored);
              return true;
            });
          }}>{t('Delete council')}</button>
        </div>
      </details>
    </div>)}
    {editor && <form className="cw-council-editor" onSubmit={event => { event.preventDefault(); save(); }}>
      <label className="cw-search">
        <input aria-label={t('Council name')} maxLength={councilLimits.name} value={editor.name}
          onChange={event => setEditor({ ...editor, name: event.target.value })} />
      </label>
      <button type="submit" disabled={!councilName(editor.name) || (!editor.id && !canSave)}>{t('Save council')}</button>
      <button type="button" onClick={() => setEditor(null)}>{t('Cancel council edit')}</button>
    </form>}
    <output>
      {note.map(id => <span key={id}>{t("{model} isn't available right now, so it was left out.", { model: models.find(model => model.id === id)?.name ?? t('A saved model') })}</span>)}
      {noneAvailable && <span>{t('No saved models are available. Your selection has not changed.')}</span>}
      {snapshot && !snapshot.stored && <span>{t('Browser storage is unavailable. Councils are kept in memory for this page.')}</span>}
    </output>
  </section>;
}
