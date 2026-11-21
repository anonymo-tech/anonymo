'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isLiveModel, useAnonymo } from '../anonymo-provider';
import { describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { storyDemoClient } from '@/lib/anonymo/mock/story';
import { modelStore, setStoredModel } from '@/lib/anonymo/prefs';
import {
  STORY_ACTIONS, acceptStoryProposal, formatContinuation, storyEstimate, storyMessages, storyOutputTokens,
  storyTarget, undoStoryProposal, wordCount, type Story, type StoryAction, type StoryChapter, type StoryModel,
  type StorySelection, type StoryTarget,
} from '@/lib/anonymo/story';
import { editChapter, editStory } from '@/lib/anonymo/story-store';
import { ANONYMO_MODEL_IDS, type AnonymoModelId } from '@/lib/anonymo/types';
import { vault } from '@/lib/anonymo/vault-browser';

const actions = Object.keys(STORY_ACTIONS) as StoryAction[];

type Proposal = {
  id: string;
  action: StoryAction;
  target: StoryTarget;
  sourceText: string;
  text: string;
  status: 'writing' | 'ready' | 'stopped';
};

export function StoryChapterEditor({
  story, chapter, words, saveField, models,
}: {
  story: Story;
  chapter: StoryChapter;
  words: number;
  saveField: (field: 'title' | 'text', value: string) => void;
  models: StoryModel[];
}) {
  const { client, demo, key, liveModels, mock, refreshBalance, rememberReceipt } = useAnonymo();
  const model = useDeviceStore(modelStore);
  const [selection, setSelection] = useState<(StorySelection & { caret: number }) | null>(null);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<{ text: string; needsFunds?: boolean } | null>(null);
  const [applying, setApplying] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const proposalTitle = useRef<HTMLHeadingElement>(null);
  const proposalId = proposal?.id;

  useEffect(() => {
    const stop = () => controller.current?.abort();
    const unsubscribe = vault.onLock(stop);
    return () => { unsubscribe(); stop(); };
  }, [client]);
  useEffect(() => {
    if (proposalId) proposalTitle.current?.focus();
  }, [proposalId]);

  const cursor = selection?.caret ?? chapter.text.length;
  const hasSelection = !!selection && selection.end > selection.start && !!chapter.text.slice(selection.start, selection.end).trim();
  const canWrite = (demo && !!mock) || !!key;
  const estimates = useMemo(() => {
    const price = models.find(({ id }) => id === model)?.pricing;
    return actions.map((action) => {
      const range = action !== 'continue' && selection ? selection : { start: cursor, end: cursor };
      const target = storyTarget(chapter, action, range);
      const messages = storyMessages(story, chapter, action, target, instruction);
      const max_tokens = storyOutputTokens(action);
      const isCouncil = model === 'anonymo-council' && !demo;
      const lower = storyEstimate(messages, max_tokens, price, isCouncil ? 4 : 1);
      const upper = isCouncil ? storyEstimate(messages, max_tokens, price, 5) : lower;
      return { action, target, messages, max_tokens, estimate: lower === upper ? lower : `${lower}–${upper}` };
    });
  }, [chapter, cursor, demo, instruction, model, models, selection, story]);

  async function generate({ action, target, messages, max_tokens }: (typeof estimates)[number]) {
    if (!canWrite || controller.current || proposal || applying) return;
    setError(null);
    const id = crypto.randomUUID();
    const abort = new AbortController();
    controller.current = abort;
    setProposal({ id, action, target, sourceText: chapter.text, text: '', status: 'writing' });
    try {
      const gateway = demo && mock && !key ? await storyDemoClient(mock) : client;
      abort.signal.throwIfAborted();
      const result = await gateway.chat(
        { model, messages, max_tokens },
        {
          signal: abort.signal,
          headers: { refusalCatch: 'on' },
          onDelta: (delta) => {
            if (!abort.signal.aborted) setProposal((current) => current?.id === id ? { ...current, text: current.text + delta } : current);
          },
        },
      );
      abort.signal.throwIfAborted();
      if (result.receiptId) rememberReceipt({ id: result.receiptId, model, at: new Date().toISOString() });
      if (!result.content.trim()) {
        setProposal(null);
        setError({ text: 'The model returned no text. Try again.' });
      } else {
        setProposal((current) => current?.id === id ? { ...current, text: result.content, status: 'ready' } : current);
      }
    } catch (cause) {
      if (abort.signal.aborted) {
        setProposal((current) => current?.id === id ? { ...current, status: 'stopped' } : current);
      } else {
        setProposal(null);
        setError({ text: describeError(cause), needsFunds: isOutOfCredit(cause) });
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      refreshBalance();
    }
  }

  const stale = !!proposal && (chapter.text !== proposal.sourceText || chapter[proposal.target.field] !== proposal.target.original);
  const latestUndo = chapter.undo.at(-1);

  async function accept() {
    if (!proposal || stale || applying || proposal.status === 'writing' || !proposal.text.trim()) return;
    const approved = proposal;
    const text = approved.action === 'continue' ? formatContinuation(approved.target, approved.text) : approved.text;
    setError(null);
    setApplying(true);
    try {
      await editStory(demo, story.id, (stored) => editChapter(stored, chapter.id, (current) => {
        if (current.text !== approved.sourceText || current[approved.target.field] !== approved.target.original) {
          throw new Error('The chapter changed. Discard this proposal and try again.');
        }
        return acceptStoryProposal(current, approved.target, text, approved.id);
      }));
      setProposal(null);
      setSelection(null);
      editor.current?.focus();
    } catch (cause) {
      setError({ text: cause instanceof Error && cause.message.startsWith('The chapter changed.')
        ? cause.message : 'Couldn’t save the proposal. Try again.' });
    } finally {
      setApplying(false);
    }
  }

  async function undo() {
    if (!latestUndo || applying) return;
    const restore = chapter[latestUndo.field] !== latestUndo.after;
    if (restore && !window.confirm('Undo restores the text from before this proposal. Replace edits made since then?')) return;
    setError(null);
    setApplying(true);
    try {
      await editStory(demo, story.id, (stored) => editChapter(stored, chapter.id, (current) => {
        if (current[latestUndo.field] !== chapter[latestUndo.field] || current.undo.at(-1)?.id !== latestUndo.id) {
          throw new Error('The chapter changed.');
        }
        return undoStoryProposal(current, latestUndo.id, restore);
      }));
      setSelection(null);
    } catch {
      setError({ text: 'Couldn’t undo the proposal. Try again.' });
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <div className="story-manuscript">
        <div className="story-manuscript-head">
          <label className="field">
            Chapter title
            <input className="input" value={chapter.title} maxLength={120} onChange={(event) => saveField('title', event.currentTarget.value)} />
          </label>
          <span className="faint story-count">{words.toLocaleString()} words</span>
        </div>
        <label className="sr-only" htmlFor="story-chapter-text">Chapter text</label>
        <textarea
          ref={editor}
          id="story-chapter-text"
          className="textarea story-prose"
          autoComplete="off"
          spellCheck
          value={chapter.text}
          placeholder="Begin your chapter."
          readOnly={applying}
          onChange={(event) => {
            const input = event.currentTarget;
            saveField('text', input.value);
            setSelection({ start: input.selectionStart, end: input.selectionEnd, caret: input.selectionEnd });
          }}
          onSelect={(event) => {
            const { selectionStart: start, selectionEnd: end, selectionDirection } = event.currentTarget;
            setSelection({ start, end, caret: selectionDirection === 'backward' ? start : end });
          }}
        />
      </div>

      <section className="story-writing" aria-labelledby="story-writing-title">
        <div className="story-line">
          <h2 id="story-writing-title">Writing actions</h2>
          <label className="story-model field">
            Model
            <select className="select" value={model} onChange={(event) => setStoredModel(event.currentTarget.value as AnonymoModelId)}>
              {ANONYMO_MODEL_IDS.map((id) => <option value={id} key={id} disabled={id !== model && !isLiveModel(liveModels, id)}>{id}</option>)}
            </select>
          </label>
        </div>
        <div className="story-line">
          <p className="faint story-count">{hasSelection
            ? `${wordCount(chapter.text.slice(selection!.start, selection!.end))} words selected`
            : 'Select text to rewrite or expand it.'}</p>
          <button className="btn btn-small" type="button" disabled={!latestUndo || applying || proposal?.status === 'writing'} onClick={() => void undo()}>
            Undo proposal
          </button>
        </div>
        {hasSelection && (
          <label className="field">
            Rewrite instruction
            <input className="input" type="text" value={instruction} maxLength={500}
              placeholder="Darker, more dialogue…"
              onChange={(event) => setInstruction(event.currentTarget.value)}
            />
          </label>
        )}
        {!canWrite && <p className="faint"><Link className="link" href="/dashboard/key">Add an API key</Link> to use writing actions.</p>}
        <div className="story-action-grid" aria-label="Writing actions and estimates" role="group">
          {estimates.map((item) => {
            const selectionNeeded = item.action === 'rewrite' || item.action === 'expand';
            const emptyChapter = item.action === 'summarize' && !chapter.text.trim();
            return (
              <button
                className={`btn ${item.action === 'continue' ? 'btn-primary' : ''}`}
                type="button"
                key={item.action}
                disabled={!canWrite || !!proposal || applying || (selectionNeeded && !hasSelection) || emptyChapter}
                onClick={() => void generate(item)}
              >
                {STORY_ACTIONS[item.action]}
                <span>{item.estimate ? `Est. ${item.estimate}` : 'Estimate unavailable'}</span>
              </button>
            );
          })}
        </div>
      </section>

      {proposal && (
        <section className="panel story-proposal" aria-labelledby="story-proposal-title">
          <header>
            <h2 ref={proposalTitle} tabIndex={-1} id="story-proposal-title">{proposal.action === 'summarize' ? 'Recap proposal' : 'Draft proposal'}</h2>
            <span className="faint" role="status">{proposal.status === 'writing' ? 'Writing…' : proposal.status === 'stopped' ? 'Stopped' : 'Ready to review'}</span>
          </header>
          <textarea
            className="textarea story-prose"
            aria-label={proposal.action === 'summarize' ? 'Proposed recap' : 'Proposed prose'}
            rows={9}
            value={proposal.text}
            readOnly={applying || proposal.status === 'writing'}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setProposal((current) => current ? { ...current, text } : current);
            }}
          />
          {stale && <p className="story-error" role="status">The chapter changed. Discard this proposal to generate a new one.</p>}
          <div className="story-buttons">
            {proposal.status === 'writing' ? (
              <button className="btn btn-small" type="button" onClick={() => controller.current?.abort()}>Stop</button>
            ) : (
              <>
                <button className="btn btn-primary btn-small" type="button" disabled={stale || applying || !proposal.text.trim()} onClick={() => void accept()}>
                  {proposal.action === 'summarize' ? 'Save recap' : 'Accept proposal'}
                </button>
                <button className="btn btn-small" type="button" disabled={applying} onClick={() => {
                  setProposal(null);
                  setError(null);
                  editor.current?.focus();
                }}>Discard</button>
              </>
            )}
          </div>
        </section>
      )}
      {error && <p className="notice notice-rose" role="alert">{error.text} {error.needsFunds && <Link className="link" href="/dashboard/funds">Add funds</Link>}</p>}
    </>
  );
}
