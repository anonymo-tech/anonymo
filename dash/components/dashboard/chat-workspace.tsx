'use client';

import { Photo } from '@/components/photo';
import Link from 'next/link';
import { ArrowUp, Drama, ShieldCheck, Square } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { AnswerCard } from './answer-card';
import type { Turn } from './chat-types';
import { ModelPicker } from './model-picker';
import { PaperTrail } from './paper-trail';
import { useContentGuard } from './use-content-guard';
import { WorkspaceShell } from './workspace-shell';
import { buildCharacterMessages, greetingsOf } from '@/lib/anonymo/card';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { describeError } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { modelStore, setStoredModel } from '@/lib/anonymo/prefs';
import type { AnonymoModelId, ChatMessage } from '@/lib/anonymo/types';
import { paperPrompt, type PaperSource } from '@/lib/paper-trail';

const STARTERS: { model: AnonymoModelId; text: string }[] = [
  { model: 'anonymo-1', text: 'What actually happens in the body during a long fast, hour by hour? Be frank.' },
  { model: 'anonymo-council', text: 'Three ways to structure a dark heist novel, and which one holds tension best.' },
  { model: 'anonymo-1', text: 'Walk me through how this reentrancy bug in my contract could be exploited.' },
  { model: 'anonymo-sealed', text: 'Help me draft a hard conversation with my doctor. Keep it private.' },
];

export function ChatWorkspace() {
  const { ready, key, client, turns, setTurns, rememberReceipt, refreshBalance } = useAnonymo();
  const model = useDeviceStore(modelStore);
  const params = useSearchParams();
  const [councilMode, setCouncilMode] = useState<'merge' | 'select'>('merge');
  const [refusalCatch, setRefusalCatch] = useState(true);
  const [text, setText] = useState('');
  const [paper, setPaper] = useState<PaperSource | null>(null);
  const characters = useDeviceStore(charactersStore);
  const [characterId, setCharacterId] = useState<string | null>(() => params.get('character'));
  const [guardNote, setGuardNote] = useState<{ redacted: string; message: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const scan = useContentGuard();
  const streaming = turns.some((t) => t.status === 'streaming');
  const character = model === 'anonymo-rp' ? (characters.find((c) => c.id === characterId) ?? null) : null;

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [turns.length]);

  const chooseModel = (id: AnonymoModelId) => setStoredModel(id);

  const update = (id: string, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));

  function history(): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const t of turns) {
      if (t.status !== 'done' && t.status !== 'stopped') continue;
      out.push({ role: 'user', content: t.prompt });
      if (t.content) out.push({ role: 'assistant', content: t.content });
    }
    return out;
  }

  async function send(promptText: string) {
    const prompt = promptText.trim();
    if (!prompt || streaming || !key) return;
    setGuardNote(null);
    const content = paper ? paperPrompt(prompt, paper) : prompt;
    let messages: ChatMessage[] = [...history(), { role: 'user', content }];
    if (character) {
      const built = buildCharacterMessages(character.card, messages);
      messages = built.messages.map((m) => ({ role: m.role as ChatMessage['role'], content: typeof m.content === 'string' ? m.content : '' }));
    }
    const id = crypto.randomUUID();
    const turn: Turn = {
      id,
      model,
      prompt,
      attachment: paper?.name ?? null,
      character: character?.card.data.name ?? null,
      content: '',
      status: 'streaming',
      error: null,
      receiptId: null,
      receipt: null,
      council: null,
      councilMode: model === 'anonymo-council' ? councilMode : null,
    };
    setTurns((list) => [...list, turn]);
    setText('');
    setPaper(null);
    const abort = new AbortController();
    controller.current = abort;
    let receiptId: string | null = null;
    let haveReceipt = false;
    try {
      const result = await client.chat(
        { model, messages },
        {
          signal: abort.signal,
          headers: {
            refusalCatch: refusalCatch ? 'on' : 'off',
            ...(model === 'anonymo-council' ? { councilMode } : {}),
          },
          onDelta: (delta) => update(id, (t) => ({ content: t.content + delta })),
        },
      );
      receiptId = result.receiptId;
      haveReceipt = result.receipt !== null;
      update(id, { status: 'done', content: result.content, council: result.council, receiptId, receipt: result.receipt });
    } catch (error) {
      const stopped = abort.signal.aborted;
      update(id, { status: stopped ? 'stopped' : 'error', error: stopped ? null : describeError(error) });
    } finally {
      controller.current = null;
      refreshBalance();
    }
    if (receiptId) {
      rememberReceipt({ id: receiptId, model, at: new Date().toISOString() });
      if (!haveReceipt)
        client.receipt(receiptId).then(
          (view) => update(id, { receipt: view.receipt }),
          () => undefined,
        );
    }
  }

  async function submit() {
    const prompt = text.trim();
    if (!prompt) return;
    const result = await scan(prompt);
    const blocking = result.findings.filter((f) => f.severity === 'block');
    if (blocking.length) {
      setGuardNote({ redacted: result.redacted, message: blocking[0].message });
      return;
    }
    void send(prompt);
  }

  const composer = (
    <div className="dock-composer">
      <div className="dock-tools">
        <PaperTrail value={paper} onChange={setPaper} />
        {model === 'anonymo-council' && (
          <button
            type="button"
            className="tool"
            aria-pressed={councilMode === 'select'}
            title="merge: an aggregator merges the replies. select: a judge picks the best single reply (cheaper)."
            onClick={() => setCouncilMode((m) => (m === 'merge' ? 'select' : 'merge'))}
          >
            Council: {councilMode}
          </button>
        )}
        {model === 'anonymo-rp' && (
          <label className="tool">
            <Drama size={14} aria-hidden="true" />
            <select
              className="select"
              style={{ minHeight: 0, padding: 0, border: 0, background: 'transparent', width: 'auto' }}
              value={characterId ?? ''}
              onChange={(e) => setCharacterId(e.target.value || null)}
              aria-label="Character"
            >
              <option value="">No character</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.card.data.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="tool"
          aria-pressed={!refusalCatch}
          title="The refusal catch holds back the first tokens to catch a refusal and reroute it. Turning it off streams sooner."
          onClick={() => setRefusalCatch((r) => !r)}
        >
          Refusal catch: {refusalCatch ? 'on' : 'off'}
        </button>
      </div>
      {guardNote && (
        <div className="notice notice-amber row" role="alert">
          <span style={{ flex: 1, minWidth: 200 }}>{guardNote.message}</span>
          <button type="button" className="btn btn-small" onClick={() => void send(guardNote.redacted)}>
            Send with it redacted
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => { setGuardNote(null); input.current?.focus(); }}>
            Edit
          </button>
        </div>
      )}
      <form
        className="dock-input"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="composer">
          Message
        </label>
        <textarea
          id="composer"
          ref={input}
          rows={1}
          value={text}
          placeholder={key ? (character ? `Write to ${character.card.data.name}…` : 'Ask anything…') : 'Create a key to start chatting'}
          disabled={!ready || !key}
          onChange={(e) => {
            setText(e.target.value);
            setGuardNote(null);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <ModelPicker value={model} onChange={chooseModel} />
        {streaming ? (
          <button type="button" className="send send-stop" aria-label="Stop" onClick={() => controller.current?.abort()}>
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="send" aria-label="Send" disabled={!key || !text.trim()}>
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        )}
      </form>
      <div className="dock-meta">
        <span>Enter to send · Shift+Enter for a new line</span>
        <span>Conversations stay in this tab and are never stored.</span>
      </div>
    </div>
  );

  return (
    <WorkspaceShell section="Chat" composer={composer}>
      {turns.length === 0 ? (
        <section className="empty chat-col">
          <div className="empty-hero">
            <Photo src="/mascot/avatar.jpg" alt="" width={256} height={256} />
            <div>
              <h1>Ask anything. Get an answer.</h1>
              <p className="muted">No refusals for legal adult use. Every answer comes with a signed receipt.</p>
            </div>
          </div>
          {ready && !key ? (
            <div className="notice row">
              <span style={{ flex: 1 }}>You need a key to chat. No account, no email.</span>
              <Link className="btn btn-primary btn-small" href="/dashboard/key">
                Create a key
              </Link>
            </div>
          ) : (
            <div className="starters">
              {STARTERS.map((s) => (
                <button
                  key={s.text}
                  type="button"
                  onClick={() => {
                    chooseModel(s.model);
                    setText(s.text);
                    input.current?.focus();
                  }}
                >
                  <strong>
                    {s.model === 'anonymo-sealed' && <ShieldCheck size={12} aria-hidden="true" />} {s.model}
                  </strong>
                  {s.text}
                </button>
              ))}
            </div>
          )}
          {character && greetingsOf(character.card)[0] && (
            <div className="answer">
              <div className="answer-head">{character.card.data.name}</div>
              <p className="answer-body">{greetingsOf(character.card)[0]}</p>
            </div>
          )}
        </section>
      ) : (
        <div className="thread chat-col" aria-live="polite">
          {turns.map((turn) => (
            <article key={turn.id} className="turn">
              <p className="prompt">{turn.prompt}</p>
              {(turn.attachment || turn.character) && (
                <div className="prompt-meta">
                  {turn.attachment && <span className="chip">PDF · {turn.attachment}</span>}
                  {turn.character && <span className="chip">as {turn.character}</span>}
                </div>
              )}
              <div className="ai-row">
                <Photo src="/mascot/avatar.jpg" alt="" width={52} height={52} />
                <AnswerCard turn={turn} />
              </div>
            </article>
          ))}
          <div ref={end} />
        </div>
      )}
    </WorkspaceShell>
  );
}
