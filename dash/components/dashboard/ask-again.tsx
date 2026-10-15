'use client';

import { useState } from 'react';
import { EverydayDialog } from './everyday-dialog';
import { readPaperPrompt, type PaperSource } from '../../lib/paper-trail';
import type { Turn } from './canvas-state';

export type ReuseQuestion = (turn: Turn, question: string, source?: PaperSource) => string | null;

export function AskAgain({ turn, source, onReuse }: { turn: Turn; source?: PaperSource; onReuse: ReuseQuestion }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  return <>
    <button className="cw-ask-again" type="button" onClick={() => {
      setQuestion(readPaperPrompt(turn.prompt)?.question ?? turn.prompt);
      setError('');
      setOpen(true);
    }}>Use this question</button>
    {open && <EverydayDialog title="Ask Again" onClose={() => setOpen(false)}>
      <label className="eu-field">Edit your question<textarea rows={6} value={question} onChange={event => setQuestion(event.target.value)} /></label>
      {(source || turn.images?.length) && <p className="eu-note">{source ? `Document: ${source.name}. ` : ''}{turn.images?.length ? `${turn.images.length} picture${turn.images.length === 1 ? '' : 's'} included. ` : ''}The original attachments will be kept.</p>}
      <p className="eu-note">This adds the question to your draft. Review your models and cost before sending.</p>
      {error && <p role="alert" className="eu-error">{error}</p>}
      <button className="eu-primary" type="button" disabled={!question.trim()} onClick={() => {
        const failure = onReuse(turn, question, source);
        if (failure) setError(failure);
        else setOpen(false);
      }}>Add to draft</button>
    </EverydayDialog>}
  </>;
}
