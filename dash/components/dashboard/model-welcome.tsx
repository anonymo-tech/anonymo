'use client';

import { ArrowUpRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { describeError } from '@/lib/anonymo/client';
import { chatModelName } from '@/lib/anonymo/chat-models';
import type { ModelInfo } from '@/lib/anonymo/types';
import { MaskGlyph } from '../brand';
import { directLogo, ModelLogo } from './model-picker';

function taskSuggestion(model: ModelInfo) {
  const name = chatModelName(model);
  if (/role[ -]?play/i.test(name)) return 'Build a character, play out dialogue, or write a scene together.';
  if (/deepseek/i.test(name)) return 'Walk through a coding problem or break down a tricky question.';
  if (/glm/i.test(name)) return 'Turn a rough idea into a plan or work through code step by step.';
  if (/gemma/i.test(name)) return 'Summarize a passage, explain a concept, or polish a draft.';
  if (/venice|dolphin/i.test(name)) return 'Brainstorm story ideas, explore a topic, or try a different writing voice.';
  if (/qwen/i.test(name)) return 'Draft text, translate a passage, or talk through a coding question.';
  return model.description?.trim() || 'Ask a question, brainstorm ideas, or get help with a first draft.';
}

type Props = {
  models: readonly ModelInfo[];
  loading: boolean;
  error: boolean;
  retry: () => void;

  onPick: (id: string) => Promise<void>;
  onDismiss: () => void;
};

export function ModelWelcome({ models, loading, error, retry, onPick, onDismiss }: Props) {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState('');
  async function start(id: string) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setSetupError('');
    try {
      await onPick(id);
      onDismiss();
    } catch (error) {
      setSetupError(describeError(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    node?.querySelector('h2')?.focus();
    return () => node?.close();
  }, []);
  const options = models.filter(model => model.availability !== 'temporarily_unavailable');
  // Show one example of each use case before closely related variants, retaining catalog order within each pass.
  const tasks = new Set<string>();
  const alternatives: ModelInfo[] = [];
  const firstChoices = options.filter(model => {
    const task = taskSuggestion(model);
    if (tasks.has(task)) { alternatives.push(model); return false; }
    tasks.add(task);
    return true;
  });
  return createPortal(
    <dialog ref={dialog} className="chat-model-dialog model-welcome" aria-labelledby="model-welcome-heading"
      onCancel={event => { if (busy) event.preventDefault(); else onDismiss(); }}>
      <header className="welcome-cover">
        <div className="welcome-brand" aria-hidden="true"><MaskGlyph size={33} /> anonymo</div>
        <h2 id="model-welcome-heading" tabIndex={-1}>Choose your <em>chat model</em></h2>
        <p>You can switch models later in Chat.</p>
      </header>
      <div className="welcome-catalog">
      <div className="welcome-list-heading">
        <h3>Uncensored models</h3>
        {options.length > 0 && <span aria-label={options.length + ' models available'}>{options.length}</span>}
        <button type="button" aria-label="Close model chooser" disabled={busy} onClick={onDismiss}><X size={18} /></button>
      </div>
      <div className="model-results">
        {error ? <p role="status">The model list couldn’t load. <button className="btn btn-small" onClick={retry}>Retry</button></p>
          : loading ? <p role="status">Loading models…</p>
          : !options.length ? <p role="status">No uncensored models are available right now.</p>
          : <ul aria-label="Uncensored chat models">{[...firstChoices, ...alternatives].map(model =>
            <li key={model.id}><button type="button" className="model-option" disabled={busy} onClick={() => void start(model.id)}>
              <ModelLogo src={directLogo(model)} />
              <span className="model-name">{chatModelName(model)}<small>{taskSuggestion(model)}</small></span>
              <ArrowUpRight className="welcome-arrow" size={17} aria-hidden="true" />
            </button></li>
          )}</ul>}
      </div>
      <footer>
        {setupError && <p role="alert">{setupError}</p>}
        {busy && <p role="status">Setting up your chat…</p>}
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void start('anonymo-1')}>
        Use the default model
      </button></footer>
      </div>
    </dialog>, document.body);
}
