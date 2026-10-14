'use client';

import { useT } from '@/lib/i18n';

import { useEffect, useRef, useState } from 'react';
import type { CanvasBrief } from './canvas-state';
import {
  parseBriefAnalysis,
  type BriefAnalysis,
} from '../../lib/brief-document';
import { useContentGuard } from './use-content-guard';

export function LiveBriefEditor({
  brief,
  onSave,
  onClose,
}: {
  brief: CanvasBrief;
  onSave: (brief: CanvasBrief) => Promise<boolean>;
  onClose: () => void;
}) {
  const t = useT();
  const [original] = useState(brief);
  const document = original.live!.document!;
  const [title, setTitle] = useState(original.title);
  const [analysis, setAnalysis] = useState<BriefAnalysis>(
    structuredClone(document.analysis),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const saving = useRef(false),
    alive = useRef(true);
  const scan = useContentGuard();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <form
      className="cp-form-paper"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving.current) return;
        saving.current = true;
        setBusy(true);
        setError('');
        try {
          try {
            parseBriefAnalysis(
              analysis,
              document.evidence.map((e) => e.callId),
            );
          } catch {
            setError('Name each agreement topic, or remove any unused rows.');
            return;
          }
          for (const value of [
            title,
            analysis.decision,
            ...analysis.notes.map((n) => n.text),
            ...analysis.matrix.map((r) => r.topic),
          ]) {
            const result = await scan(value);
            if (!alive.current) return;
            if (result.findings.some((f) => f.severity === 'block')) {
              setError('Remove secret-like text before saving.');
              return;
            }
          }
          const saved = await onSave({
            ...original,
            title: title.trim(),
            live: { ...original.live!, document: { ...document, analysis } },
          });
          if (!alive.current) return;
          if (saved) onClose();
          else
            setError(
              'The save was not confirmed. Refresh the workspace to check its saved revision before trying again. Your draft remains here.',
            );
        } finally {
          saving.current = false;
          if (alive.current) setBusy(false);
        }
      }}
    >
      <p className="cp-fineprint">
        {t(
          'Your assessment. The original responses and their provenance stay unchanged.',
        )}
      </p>
      {brief.live?.revision !== original.live?.revision && (
        <output>
          {t(
            'This Brief has a newer saved revision. Copy any unsaved notes before closing and reopening the editor.',
          )}
        </output>
      )}
      <label>
        {t('Title')}
        <input
          value={title}
          maxLength={160}
          required
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        {t('Your decision')}
        <textarea
          value={analysis.decision}
          maxLength={4000}
          disabled={busy}
          onChange={(e) =>
            setAnalysis((a) => ({ ...a, decision: e.target.value }))
          }
        />
      </label>
      {document.evidence.map((evidence) => (
        <label key={evidence.callId}>
          {t('Your summary · {model}', { model: evidence.modelId })}
          <textarea
            className="cp-short-input"
            maxLength={1600}
            disabled={busy}
            value={
              analysis.notes.find((n) => n.callId === evidence.callId)?.text ??
              ''
            }
            onChange={(event) =>
              setAnalysis((a) => ({
                ...a,
                notes: [
                  ...a.notes.filter((n) => n.callId !== evidence.callId),
                  { callId: evidence.callId, text: event.target.value },
                ],
              }))
            }
          />
        </label>
      ))}
      <details>
        <summary>
          {t('Agreement matrix · {count} topics', {
            count: analysis.matrix.length,
          })}
        </summary>
        <p className="cp-fineprint">
          {t(
            'Record how you read each response. These labels are your assessment.',
          )}
        </p>
        {analysis.matrix.map((row, index) => (
          <fieldset key={index} disabled={busy}>
            <legend>{t('Topic {number}', { number: index + 1 })}</legend>
            <label>
              {t('Topic')}
              <input
                maxLength={240}
                value={row.topic}
                onChange={(e) =>
                  setAnalysis((a) => ({
                    ...a,
                    matrix: a.matrix.map((r, i) =>
                      i === index ? { ...r, topic: e.target.value } : r,
                    ),
                  }))
                }
              />
            </label>
            {document.evidence.map((evidence) => (
              <label key={evidence.callId}>
                {evidence.modelId}
                <select
                  aria-label={t('Assessment for {model}', {
                    model: evidence.modelId,
                  })}
                  value={
                    row.positions.find((p) => p.callId === evidence.callId)!
                      .position
                  }
                  onChange={(e) =>
                    setAnalysis((a) => ({
                      ...a,
                      matrix: a.matrix.map((r, i) =>
                        i === index
                          ? {
                              ...r,
                              positions: r.positions.map((p) =>
                                p.callId === evidence.callId
                                  ? {
                                      ...p,
                                      position: e.target.value as
                                        | 'agrees'
                                        | 'disagrees'
                                        | 'unclear',
                                    }
                                  : p,
                              ),
                            }
                          : r,
                      ),
                    }))
                  }
                >
                  <option value="agrees">{t('Agrees')}</option>
                  <option value="disagrees">{t('Disagrees')}</option>
                  <option value="unclear">
                    {t('Unclear / not addressed')}
                  </option>
                </select>
              </label>
            ))}
            <button
              type="button"
              className="cp-text-button"
              onClick={() =>
                setAnalysis((a) => ({
                  ...a,
                  matrix: a.matrix.filter((_, i) => i !== index),
                }))
              }
            >
              {t('Remove topic {number}', { number: index + 1 })}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="cp-text-button"
          disabled={busy || analysis.matrix.length >= 8}
          onClick={() =>
            setAnalysis((a) => ({
              ...a,
              matrix: [
                ...a.matrix,
                {
                  topic: '',
                  positions: document.evidence.map((e) => ({
                    callId: e.callId,
                    position: 'unclear',
                  })),
                },
              ],
            }))
          }
        >
          {t('Add a topic')}
        </button>
      </details>
      {error && <output role="alert">{t(error)}</output>}
      <button
        type="submit"
        className="cp-button cp-button--ink"
        disabled={busy || !title.trim()}
      >
        {busy ? t('Saving…') : t('Save assessment')}
      </button>
      <button
        type="button"
        className="cp-text-button"
        disabled={busy}
        onClick={onClose}
      >
        {t('Close editor')}
      </button>
    </form>
  );
}
