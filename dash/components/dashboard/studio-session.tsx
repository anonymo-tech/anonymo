'use client';

import { useT, translate } from '@/lib/i18n';

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
      return translate('Choose a JPEG, PNG, WebP or GIF smaller than 20 MB.');
    if (scanPrompt(file.name))
      return translate(
        'Rename this file to remove secret-like text before attaching it.',
      );
    const previous = urls.current.get(projectId);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(file);
    urls.current.set(projectId, url);
    update({ reference: { name: file.name, url } });
    return translate(
      'Reference attached to this Studio draft. It stays in this tab and is not uploaded.',
    );
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
  const t = useT();
  return (
    <div className="cs-draft-options">
      <label>
        {t('Frame')}
        <select
          aria-label={t('Studio aspect ratio')}
          value={draft.ratio}
          onChange={(event) => onChange({ ratio: event.target.value })}
        >
          <option>16:9</option>
          <option>9:16</option>
          <option>1:1</option>
        </select>
      </label>
      <label>
        {t('Length')}
        <select
          aria-label={t('Studio duration')}
          value={draft.duration}
          onChange={(event) => onChange({ duration: event.target.value })}
        >
          {connected ? (
            <>
              <option value="5">{t('Prefer 5 seconds')}</option>
              <option value="6">{t('Closest format per model')}</option>
              <option value="8">{t('Prefer 8 seconds')}</option>
              <option value="10">{t('Prefer 10 seconds')}</option>
            </>
          ) : (
            <>
              <option value="6">{t('6 seconds')}</option>
              <option value="10">{t('10 seconds')}</option>
              <option value="15">{t('15 seconds')}</option>
            </>
          )}
        </select>
      </label>
      <p>
        {connected
          ? t('Exact supported formats appear in the review before approval.')
          : t('For your draft. Sample playback stays 16:9 · 6s.')}
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
  const t = useT();
  const exportDraft = () => {
    const text = t(
      '# Studio draft\n\nProject: {project}\nModels: {models}\nFrame: {ratio}\nDuration: {duration} seconds\nReference: {reference}\n\n## Direction\n\n{prompt}\n\nLocal draft only. No model was called. Reference image is not included.\n',
      {
        project: projectName,
        models: modelNames.join(', '),
        ratio: draft.ratio,
        duration: draft.duration,
        reference: draft.reference?.name ?? t('None'),
        prompt: draft.prompt.trim(),
      },
    );
    if (scanPrompt(text)) {
      onToast(t('Remove secret-like text before downloading this draft.'));
      return;
    }
    downloadFile('conclave-studio-draft.md', text, 'text/markdown');
    onToast(t('Studio draft downloaded. No request was sent to a model.'));
  };
  return (
    <div className="cs-draft-review cw-simple-form">
      <p>
        {t(
          'Video models are not connected yet. Keep this direction as a draft; the sample clips stay unchanged.',
        )}
      </p>
      <dl>
        <div>
          <dt>{t('Project')}</dt>
          <dd>{projectName}</dd>
        </div>
        <div>
          <dt>{t('Models')}</dt>
          <dd>{modelNames.join(', ')}</dd>
        </div>
        <div>
          <dt>{t('Format')}</dt>
          <dd>
            {t('{ratio} · {duration} seconds', {
              ratio: draft.ratio,
              duration: draft.duration,
            })}
          </dd>
        </div>
      </dl>
      <blockquote>{draft.prompt}</blockquote>
      {draft.reference && (
        <figure>
          <Image
            src={draft.reference.url}
            alt={t('Your local reference')}
            width={360}
            height={180}
            unoptimized
          />
          <figcaption>
            {t('{name} · Local only', { name: draft.reference.name })}
          </figcaption>
        </figure>
      )}
      <small>
        {t(
          'This Studio draft stays in this tab. Download it before refreshing.',
        )}
      </small>
      <button className="cw-primary" onClick={exportDraft}>
        {t('Download draft')}
      </button>
      <button onClick={onClose}>{t('Keep editing')}</button>
    </div>
  );
}
