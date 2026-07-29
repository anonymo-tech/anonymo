'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { downloadFile, scanPrompt } from './data';

type StudioDraft = {
  prompt: string;
  modelIds: string[];
  ratio: string;
  duration: string;
  strict: boolean;
  reference: { name: string; url: string } | null;
};

const emptyDraft = (): StudioDraft => ({
  prompt: '',
  modelIds: ['runway', 'veo'],
  ratio: '16:9',
  duration: '6',
  strict: false,
  reference: null,
});

/** Studio drafts and references belong to this tab, separately from saved chats. */
export function useStudioSession(projectId: string) {
  const [drafts, setDrafts] = useState<Record<string, StudioDraft>>({});
  const urls = useRef(new Map<string, string>());
  const draft = drafts[projectId] ?? emptyDraft();
  const update = (change: Partial<StudioDraft>) => {
    setDrafts((current) => ({
      ...current,
      [projectId]: { ...(current[projectId] ?? emptyDraft()), ...change },
    }));
    return true;
  };
  useEffect(() => {
    const references = urls.current;
    return () => {
      references.forEach((url) => URL.revokeObjectURL(url));
      references.clear();
    };
  }, []);

  const clearReference = () => {
    const previous = urls.current.get(projectId);
    if (previous) URL.revokeObjectURL(previous);
    urls.current.delete(projectId);
    update({ reference: null });
  };
  const attach = (file?: File) => {
    if (!file) return '';
    if (
      !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(
        file.type,
      ) ||
      file.size > 20 * 1024 * 1024
    )
      return 'Choose a JPEG, PNG, WebP or GIF smaller than 20 MB.';
    if (scanPrompt(file.name))
      return 'Rename this file to remove secret-like text before attaching it.';
    const previous = urls.current.get(projectId);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(file);
    urls.current.set(projectId, url);
    update({ reference: { name: file.name, url } });
    return 'Reference attached to this Studio draft. It stays in this tab and is not uploaded.';
  };
  const reset = () => {
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current.clear();
    setDrafts({});
  };
  const removeProject = (id: string) => {
    const previous = urls.current.get(id);
    if (previous) URL.revokeObjectURL(previous);
    urls.current.delete(id);
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };
  return { draft, update, attach, clearReference, reset, removeProject };
}

export function StudioDraftOptions({
  draft,
  onChange,
  connected = false,
}: {
  draft: StudioDraft;
  onChange: (change: Partial<StudioDraft>) => void;
  connected?: boolean;
}) {
  return (
    <div className="cs-draft-options">
      <label>
        Frame
        <select
          aria-label="Studio aspect ratio"
          value={draft.ratio}
          onChange={(event) => onChange({ ratio: event.target.value })}
        >
          <option>16:9</option>
          <option>9:16</option>
          <option>1:1</option>
        </select>
      </label>
      <label>
        Length
        <select
          aria-label="Studio duration"
          value={draft.duration}
          onChange={(event) => onChange({ duration: event.target.value })}
        >
          {connected ? (
            <>
              <option value="5">Prefer 5 seconds</option>
              <option value="6">Closest format per model</option>
              <option value="8">Prefer 8 seconds</option>
              <option value="10">Prefer 10 seconds</option>
            </>
          ) : (
            <>
              <option value="6">6 seconds</option>
              <option value="10">10 seconds</option>
              <option value="15">15 seconds</option>
            </>
          )}
        </select>
      </label>
      <p>
        {connected
          ? 'Exact supported formats appear in the review before approval.'
          : 'For your draft. Sample playback stays 16:9 · 6s.'}
      </p>
    </div>
  );
}

export function StudioDraftReview({
  draft,
  projectName,
  modelNames,
  onClose,
  onToast,
}: {
  draft: StudioDraft;
  projectName: string;
  modelNames: string[];
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const exportDraft = () => {
    const text = `# Studio draft\n\nProject: ${projectName}\nModels: ${modelNames.join(', ')}\nFrame: ${draft.ratio}\nDuration: ${draft.duration} seconds\nReference: ${draft.reference?.name ?? 'None'}\n\n## Direction\n\n${draft.prompt.trim()}\n\nLocal draft only. No model was called. Reference image is not included.\n`;
    if (scanPrompt(text)) {
      onToast('Remove secret-like text before downloading this draft.');
      return;
    }
    downloadFile('conclave-studio-draft.md', text, 'text/markdown');
    onToast('Studio draft downloaded. No request was sent to a model.');
  };
  return (
    <div className="cs-draft-review cw-simple-form">
      <p>
        Video models are not connected yet. Keep this direction as a draft; the
        sample clips stay unchanged.
      </p>
      <dl>
        <div>
          <dt>Project</dt>
          <dd>{projectName}</dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd>{modelNames.join(', ')}</dd>
        </div>
        <div>
          <dt>Format</dt>
          <dd>
            {draft.ratio} · {draft.duration} seconds
          </dd>
        </div>
      </dl>
      <blockquote>{draft.prompt}</blockquote>
      {draft.reference && (
        <figure>
          <Image
            src={draft.reference.url}
            alt="Your local reference"
            width={360}
            height={180}
            unoptimized
          />
          <figcaption>{draft.reference.name} · Local only</figcaption>
        </figure>
      )}
      <small>
        This Studio draft stays in this tab. Download it before refreshing.
      </small>
      <button className="cw-primary" onClick={exportDraft}>
        Download draft
      </button>
      <button onClick={onClose}>Keep editing</button>
    </div>
  );
}
