'use client';

import { characterDestination } from '@/lib/anonymo/setup-return';

// Update "faces": the Stage. The same chat, shown as a scene: a painted backdrop, the character's face in the mood of
// the reply, and the reply in a box under it. It is another way to look at the thread, not another chat: the answer
// card is the thread's own (cost, receipt, council view and errors included), and the notices the thread shows with a
// turn (the AI reminder, crisis lines) are shown here too.
//
// "Paint the scene" has two steps, so nothing from the chat reaches the image model unseen: the chat model writes one
// sentence about the place, the person reads or changes it, and only that sentence is painted.

import Link from 'next/link';
import { ChevronLeft, ChevronRight, Clapperboard, Download, Loader2, Mountain, Paintbrush, ScrollText, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Photo } from '@/components/photo';
import { useAnonymo } from '../anonymo-provider';
import { AnswerCard } from './answer-card';
import type { Turn } from './chat-types';
import { FacePortrait, hasFace, useScene, type Faces, type SceneView } from './face';
import { ModelChoice, StyleChips, TroubleNote, askForSentence, chatTrouble, paintTrouble, useImageModels, type Trouble } from './face-painter';
import type { StoredCharacter } from '@/lib/anonymo/characters-store';
import { greetingsOf } from '@/lib/anonymo/card';
import { SCENE_MAX, SCENE_RATIO, moodOf, pickSize, scenePrompt, sceneRequest, tidySentence, type FaceStyle } from '@/lib/anonymo/faces';
import { b64ToBlob } from '@/lib/anonymo/faces-image';
import { removeScene, saveScene } from '@/lib/anonymo/faces-store';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';
import type { ChatMessage } from '@/lib/anonymo/types';

/** The Stage switch, for the row of options under the message box (next to the character it belongs to). */
export function StageTools({ on, onToggle, character, faces }: { on: boolean; onToggle: () => void; character: StoredCharacter; faces: Faces | null }) {
  return (
    <>
      <button type="button" className="tool" aria-pressed={on} title="Show this chat as a scene: a backdrop, a face and the reply" onClick={onToggle}>
        <Clapperboard size={14} aria-hidden="true" /> Stage
      </button>
      {faces && !hasFace(faces) && (
        <Link className="tool" href={`/dashboard/characters?face=${encodeURIComponent(character.id)}`}>
          <Paintbrush size={14} aria-hidden="true" /> Give {character.card.data.name} a face
        </Link>
      )}
    </>
  );
}

const threadOf = (turns: Turn[]): ChatMessage[] =>
  turns.flatMap((t): ChatMessage[] => (t.recap || t.status === 'error' ? [] : [{ role: 'user', content: t.prompt }, ...(t.content ? [{ role: 'assistant' as const, content: t.content }] : [])]));

export function Stage({
  character,
  faces,
  turns,
  streaming,
  notices,
  renderAnswer,
  onLog,
}: {
  character: StoredCharacter;
  faces: Faces | null;
  turns: Turn[];
  streaming: boolean;
  /** What the thread shows with a turn besides the answer: the AI reminder and the crisis lines. */
  notices: (turn: Turn) => ReactNode;
  renderAnswer?: (turn: Turn) => ReactNode;
  onLog: () => void;
}) {
  const { demo, chatId } = useAnonymo();
  const name = character.card.data.name;
  const scene = useScene(demo, chatId);
  const [painting, setPainting] = useState(false);
  // Stepping back pins a turn; a new turn lets go of the pin, so the Stage follows the chat again.
  const [pin, setPin] = useState<{ index: number; count: number } | null>(null);
  const index = pin && pin.count === turns.length ? Math.min(pin.index, turns.length - 1) : turns.length - 1;
  const turn = index >= 0 ? turns[index] : null;
  const mood = useMemo(() => (turn && turn.status !== 'error' ? moodOf(turn.content) : 'calm'), [turn]);
  const greeting = greetingsOf(character.card)[0] ?? null;
  const box = useRef<HTMLDivElement>(null);

  // A long reply scrolls inside the box; keep its newest line in view while it is being written.
  const writing = turn?.status === 'streaming' ? turn.content.length : 0;
  useEffect(() => {
    if (writing && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [writing]);

  const step = (by: number) => setPin({ index: Math.max(0, Math.min(turns.length - 1, index + by)), count: turns.length });

  return (
    <section className="stage chat-col" aria-label={`${name}, on stage`}>
      <div className="stage-back" aria-hidden="true">
        {scene && <Photo key={scene.url} src={scene.url} alt="" loading="eager" />}
      </div>

      <header className="stage-top">
        <strong className="stage-name">{name}</strong>
        <span className="stage-tools">
          <button type="button" className="btn btn-small" aria-expanded={painting} onClick={() => setPainting((p) => !p)}>
            <Mountain size={16} aria-hidden="true" /> {scene ? 'Change the scene' : 'Paint the scene'}
          </button>
          <button type="button" className="btn btn-small" onClick={onLog} title="Back to the whole thread">
            <ScrollText size={16} aria-hidden="true" /> Log
          </button>
        </span>
      </header>

      {painting && <ScenePainter key={chatId} character={character} thread={threadOf(turns)} scene={scene} busyChat={streaming} onDone={() => setPainting(false)} />}

      <div className="stage-floor">
        <div className="stage-figure">
          {hasFace(faces) ? (
            <FacePortrait faces={faces} mood={mood} name={name} className="stage-face" />
          ) : (
            <span className="stage-face stage-noface">
              <Photo src="/mascot/avatar.jpg" alt="" width={256} height={256} />
              <Link className="btn btn-small" href={`/dashboard/characters?face=${encodeURIComponent(character.id)}`}>
                <Paintbrush size={15} aria-hidden="true" /> Give {name} a face
              </Link>
            </span>
          )}
        </div>

        <div className="stage-box" ref={box} aria-live="polite" aria-busy={streaming}>
          {turn ? (
            <>
              {notices(turn)}
              <p className="stage-you">
                <span>You</span> {turn.prompt}
              </p>
              {renderAnswer ? renderAnswer(turn) : <AnswerCard turn={turn} characterId={character.id} />}
            </>
          ) : greeting ? (
            <div className="answer">
              <div className="answer-head">{name}</div>
              <p className="answer-body">{greeting}</p>
            </div>
          ) : (
            <p className="muted">Write to {name} to begin.</p>
          )}
          {turns.length > 1 && (
            <nav className="stage-steps" aria-label="Replies">
              <button type="button" className="icon-btn" aria-label="Earlier reply" disabled={index <= 0} onClick={() => step(-1)}>
                <ChevronLeft size={18} aria-hidden="true" />
              </button>
              <span>
                {index + 1} of {turns.length}
              </span>
              <button type="button" className="icon-btn" aria-label="Later reply" disabled={index >= turns.length - 1} onClick={() => step(1)}>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </nav>
          )}
        </div>
      </div>
    </section>
  );
}

function ScenePainter({ character, thread, scene, busyChat, onDone }: { character: StoredCharacter; thread: ChatMessage[]; scene: SceneView | null; busyChat: boolean; onDone: () => void }) {
  const { demo, key, client, chatId, rememberReceipt, refreshBalance } = useAnonymo();
  const { models, error: modelsError } = useImageModels(SCENE_RATIO);
  const [typed, setTyped] = useState<string | null>(null);
  const [picked, setPicked] = useState<FaceStyle | null>(null);
  const [modelChoice, setModelChoice] = useState('');
  const [busy, setBusy] = useState<'scene' | 'paint' | null>(null);
  const [trouble, setTrouble] = useState<Trouble | null>(null);

  const text = typed ?? scene?.meta.scene ?? '';
  const style: FaceStyle = picked ?? scene?.meta.style ?? 'painted';
  const model = models?.find((m) => m.id === modelChoice) ?? models?.[0] ?? null;
  const sentence = tidySentence(text, SCENE_MAX);

  async function describe() {
    if (!key || busy) return;
    setBusy('scene');
    setTrouble(null);
    try {
      setTyped(await askForSentence(client, sceneRequest(thread, character.card), SCENE_MAX, rememberReceipt));
    } catch (e) {
      setTrouble(chatTrouble(e));
    } finally {
      setBusy(null);
      refreshBalance();
    }
  }

  async function paint() {
    if (!key || busy || !model || !sentence) return;
    setBusy('paint');
    setTrouble(null);
    try {
      const res = await client.generateImages({ model: model.id, prompt: scenePrompt(sentence, style), n: 1, size: pickSize(model.sizes, SCENE_RATIO) });
      const b64 = res.data[0]?.b64_json;
      if (!b64) throw new Error('No image came back. Try again.');
      await saveScene(demo, chatId, sentence, style, b64ToBlob(b64));
      onDone();
    } catch (e) {
      setTrouble(paintTrouble(e));
    } finally {
      setBusy(null);
      refreshBalance();
    }
  }

  return (
    <form
      className="stage-paint"
      onSubmit={(e) => {
        e.preventDefault();
        void paint();
      }}
    >
      <label className="field faces-field">
        <span>The scene</span>
        <textarea className="textarea" rows={3} maxLength={SCENE_MAX} value={text} placeholder="A lamplit cabin on a small ship at night, rain on the window" disabled={busy !== null} onChange={(e) => setTyped(e.target.value)} />
      </label>
      <div className="row">
        <button
          type="button"
          className="btn btn-small"
          disabled={!key || busy !== null || busyChat}
          onClick={() => void describe()}
          title="A small chat request to anonymo-1 that reads the last few messages, usually well under a cent. It gets a receipt like any other."
        >
          {busy === 'scene' ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />} Describe from the chat
        </button>
        <span className="faint faces-hint">This sentence is all the image model sees.</span>
      </div>
      <div className="stage-paint-choices">
        <StyleChips value={style} onChange={setPicked} disabled={busy !== null} />
        <ModelChoice models={models} error={modelsError} value={model?.id ?? ''} onChange={setModelChoice} disabled={busy !== null} />
      </div>
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!key || busy !== null || !model || !sentence}>
          {busy === 'paint' ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Mountain size={16} aria-hidden="true" />} {busy === 'paint' ? 'Painting…' : 'Paint the scene'}
          {model && <span className="studio-cost">{formatUsd(usdToMusd(model.pricing.usd_per_image))}</span>}
        </button>
        {scene && (
          <>
            <a className="btn btn-small" href={scene.url} download={`anonymo-scene-${chatId.slice(0, 8)}.png`}>
              <Download size={15} aria-hidden="true" /> Download
            </a>
            <button type="button" className="btn btn-small btn-ghost btn-danger" disabled={busy !== null} onClick={() => void removeScene(demo, chatId)}>
              <Trash2 size={15} aria-hidden="true" /> Remove the backdrop
            </button>
          </>
        )}
        <button type="button" className="btn btn-small btn-ghost" onClick={onDone}>
          Close
        </button>
      </div>
      <TroubleNote trouble={trouble} destination={characterDestination('chat', character.id)} />
      <p className="studio-note">
        <ShieldCheck size={14} aria-hidden="true" /> Safe for work only: an empty place, no people. If the image check turns a scene down, nothing is charged. The backdrop stays in this browser.
      </p>
    </form>
  );
}
