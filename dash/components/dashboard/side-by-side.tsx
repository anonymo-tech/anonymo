'use client';

// Update "sidebyside": Side by Side. One question, three models answering at the same time in three columns, each with
// its cost, its tokens and its own signed receipt; then one button that merges them into a single answer, and a strip
// of receipt paper that lists who answered, who said no and the total. A column whose receipt lists a refused route is
// stamped REFUNDED and names the model that stepped in.
//
// Every request is an ordinary gateway call started by a click on a button that shows its price. The question and the
// answers live in this tab only (side-by-side-session.ts). The safety notices are the chat thread's: the AI notice
// under the question box, the 3-hourly reminder, the crisis lines, and the content guard before anything is sent.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Columns3, Combine, MessageSquare, ReceiptText, RotateCcw, Search, Square } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { MascotSprite } from '../mascot-sprite';
import { AnswerText } from './answer-card';
import { sideBySide, useSideBySide } from './side-by-side-session';
import { useContentGuard } from './use-content-guard';
import { formatUsd } from '@/lib/anonymo/money';
import { AI_NOTICE, AI_REMINDER, CRISIS_LINES } from '@/lib/anonymo/safety';
import {
  MERGE_MODEL,
  SLOTS,
  askEstimate,
  canMerge,
  chatTurn,
  costOf,
  isBusy,
  listPrice,
  mergeEstimate,
  mergeRequest,
  mergeable,
  receiptStrip,
  reconcileSlots,
  refusalLabel,
  rerouteOf,
  roundReceipts,
  roundUpEstimate,
  searchModels,
  setSlot,
  totalCost,
  type Answer,
  type Reroute,
  type StripRow,
} from '@/lib/anonymo/sidebyside';
import type { ModelInfo } from '@/lib/anonymo/types';
import './sidebyside.css';

const STARTERS = [
  'What actually happens in the body during a long fast, hour by hour? Be frank.',
  'Make the strongest case against the thing I believe most firmly, then tell me how sure you are.',
  'Three ways to structure a dark heist novel, and which one holds tension best.',
];
/** Demo mode only: the mock gateway refuses and reroutes a prompt that has this word in it. */
const DEMO_STARTER = 'Demo: reroute a refusal, so one column gets its stamp.';

const upTo = (musd: number | null) => (musd === null ? null : `up to ${formatUsd(roundUpEstimate(musd))}`);
const familyOf = (models: readonly ModelInfo[], id: string) => models.find((m) => m.id === id)?.family ?? null;
const familyLabel = (family: string | null) => (family ? `${family} family` : 'family not listed');

export function SideBySide() {
  const { ready, demo, key, client, turns, openChat, refreshBalance } = useAnonymo();
  const { draft, slots: chosen, round } = useSideBySide();
  const router = useRouter();
  const scan = useContentGuard();
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [guardNote, setGuardNote] = useState<{ redacted: string; message: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const pendingScan = useRef(0);
  const question = useRef<HTMLTextAreaElement>(null);
  const answers = useRef<HTMLDivElement>(null);
  // A new question brings its answers into view. Coming back to the page with answers already there does not move it.
  const lastRun = useRef(round.run);
  useEffect(() => {
    if (round.run === lastRun.current) return;
    lastRun.current = round.run;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    answers.current?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  }, [round.run]);

  // The model list is public and the same for every key.
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    client.models().then(
      (list) => {
        if (stale) return;
        setModels(list.data);
        setListFailed(false);
      },
      () => !stale && setListFailed(true),
    );
    return () => {
      stale = true;
    };
  }, [ready, client, attempt]);

  const slots = useMemo(() => (models ? reconcileSlots(chosen, models) : []), [chosen, models]);
  const enough = slots.length === SLOTS.length;
  const busy = isBusy(round);
  const askPrice = useMemo(() => upTo(askEstimate(draft, slots.map((id) => listPrice(models?.find((m) => m.id === id))))), [draft, slots, models]);
  // A chat that is still streaming cannot be swapped out, so "Continue in chat" waits for it.
  const chatBusy = turns.some((t) => t.status === 'streaming');

  function send(text: string) {
    setGuardNote(null);
    if (!key || !enough) return;
    sideBySide.ask(client, text, slots, refreshBalance);
  }

  async function submit() {
    const text = draft.trim();
    if (!text || !key || !enough || busy || checking) return;
    const request = ++pendingScan.current;
    setChecking(true);
    const result = await scan(text);
    if (request !== pendingScan.current) return;
    setChecking(false);
    const blocking = result.findings.filter((f) => f.severity === 'block');
    if (blocking.length) {
      setGuardNote({ redacted: result.redacted, message: blocking[0].message });
      return;
    }
    send(text);
  }

  const edit = (text: string) => {
    pendingScan.current++;
    setChecking(false);
    setGuardNote(null);
    sideBySide.setDraft(text);
  };

  const continueInChat = (answer: Answer) => {
    openChat(null, [chatTurn(crypto.randomUUID(), round.question, answer)]);
    router.push('/dashboard/chat');
  };

  if (!ready) return null;

  return (
    <div className="sbs">
      <form
        className="sbs-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {listFailed && !models ? (
          <div className="notice notice-rose notice-action" role="alert">
            <p>The model list could not be loaded, so there is nothing to put in the columns yet.</p>
            <button type="button" className="btn btn-small" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : !models ? (
          <p className="muted">Loading the models…</p>
        ) : !enough ? (
          <div className="notice notice-amber notice-action" role="note">
            <p>
              Side by side needs three models that can each answer on their own. {slots.length === 0 ? 'None is' : slots.length === 1 ? 'Only one is' : 'Only two are'} listed right now, so there is
              nothing to compare yet.
            </p>
            <Link className="btn btn-small" href="/dashboard/chat">
              Open chat
            </Link>
          </div>
        ) : (
          <fieldset className="sbs-slots">
            <legend className="sr-only">The three models</legend>
            {slots.map((id, i) => (
              <SlotPicker key={SLOTS[i]} label={SLOTS[i]} value={id} slots={slots} models={models} onPick={(next) => sideBySide.setSlots(setSlot(slots, i, next))} />
            ))}
          </fieldset>
        )}
        {models && enough && (
          <p className="sbs-hint faint">It starts with anonymo-1 and the two other model families that said no least in the last 30 days. Change any of them.</p>
        )}

        {guardNote && (
          <div className="notice notice-amber row" role="alert">
            <span style={{ flex: 1, minWidth: 200 }}>{guardNote.message}</span>
            <button type="button" className="btn btn-small" disabled={busy || !enough || !key} onClick={() => send(guardNote.redacted)}>
              Ask with it redacted{askPrice ? ` · ${askPrice}` : ' · 3 charges'}
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => {
                setGuardNote(null);
                question.current?.focus();
              }}
            >
              Edit
            </button>
          </div>
        )}

        <label className="sr-only" htmlFor="sbs-question">
          Your question
        </label>
        <textarea
          id="sbs-question"
          ref={question}
          className="textarea sbs-question"
          rows={3}
          value={draft}
          placeholder={!key ? 'Create a key to ask' : round.columns.length ? 'Ask another question. It replaces the answers below.' : 'Ask one question. Three models answer it at the same time.'}
          disabled={!key}
          onChange={(e) => edit(e.target.value)}
        />

        {!key ? (
          <div className="chat-entry">
            <span>Connect a key to ask three models at once.</span>
            <Link className="btn btn-primary btn-small" href="/dashboard/key">
              Create a key
            </Link>
          </div>
        ) : (
          <div className="sbs-send">
            <p className="sbs-charges">
              <strong>Three answers mean three charges</strong>, one for each model, each on its own signed receipt. A model that says no costs nothing.
            </p>
            <button type="submit" className="btn btn-primary sbs-go" disabled={!draft.trim() || !enough || busy || checking}>
              <Columns3 size={17} aria-hidden="true" />
              {busy ? 'Answers are arriving…' : checking ? 'Checking…' : 'Ask all three'}
              {!busy && !checking && <span className="sbs-cost">{askPrice ?? '3 charges'}</span>}
            </button>
          </div>
        )}

        {key && enough && !round.columns.length && (
          <div className="sbs-starters">
            {[...STARTERS, ...(demo ? [DEMO_STARTER] : [])].map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => {
                  edit(text);
                  question.current?.focus();
                }}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        <p className="ai-notice">{AI_NOTICE}</p>
        <p className="sbs-private faint">Questions and answers stay in this tab and are never stored.</p>
      </form>

      {round.columns.length === 0 ? (
        models && enough && <Preview slots={slots} models={models} />
      ) : (
        <div className="sbs-answers" ref={answers}>
          <Answers
            models={models ?? []}
            chatBusy={chatBusy}
            canPay={!!key}
            onContinue={continueInChat}
            onAskAgain={() => {
              edit(round.question);
              question.current?.focus();
            }}
            onMerge={() => sideBySide.merge(client, refreshBalance)}
          />
        </div>
      )}
    </div>
  );
}

/** Before the first question: the three columns as they will be laid out. */
function Preview({ slots, models }: { slots: string[]; models: ModelInfo[] }) {
  return (
    <ol className="sbs-preview" aria-label="The three columns">
      {slots.map((id, i) => (
        <li key={SLOTS[i]}>
          <span className="sbs-letter" aria-hidden="true">
            {SLOTS[i]}
          </span>
          <strong>{id}</strong>
          <span className="faint">{familyLabel(familyOf(models, id))}</span>
        </li>
      ))}
    </ol>
  );
}

function Answers({
  models,
  chatBusy,
  canPay,
  onContinue,
  onAskAgain,
  onMerge,
}: {
  models: ModelInfo[];
  chatBusy: boolean;
  canPay: boolean;
  onContinue: (answer: Answer) => void;
  onAskAgain: () => void;
  onMerge: () => void;
}) {
  const { round } = useSideBySide();
  const scroller = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  const base = useId();
  const columns = round.columns;
  const count = (status: Answer['status']) => columns.filter((c) => c.status === status).length;
  const arriving = count('streaming');
  const finished = count('done');
  const stopped = count('stopped');
  const failed = count('error');
  const answersTotal = totalCost(columns.map((c) => c.receipt));
  // "All three answered", "2 of 3 answered · 1 stopped", "3 could not answer".
  const outcome = arriving
    ? `${columns.length - arriving} of ${columns.length} answers have arrived`
    : [finished ? `${finished === columns.length ? 'All three' : `${finished} of ${columns.length}`} answered` : '', stopped ? `${stopped} stopped` : '', failed ? `${failed} could not answer` : '']
        .filter(Boolean)
        .join(' · ');
  const merge = round.merge;
  const usable = mergeable(round);
  const mergePrice = useMemo(() => {
    if (!canMerge(round)) return null;
    return upTo(mergeEstimate(mergeRequest(round.question, mergeable(round)), listPrice(models.find((m) => m.id === MERGE_MODEL))));
  }, [round, models]);

  // Phones show one column at a time: the letters above jump between them and mark the one in view.
  const jump = useCallback((index: number) => {
    const box = scroller.current;
    const column = box?.children[index] as HTMLElement | undefined;
    if (!box || !column) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({ left: column.offsetLeft - box.offsetLeft, behavior: still ? 'auto' : 'smooth' });
  }, []);
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const offsets = [...box.children].map((c) => Math.abs((c as HTMLElement).offsetLeft - box.offsetLeft - box.scrollLeft));
        setShown(Math.max(0, offsets.indexOf(Math.min(...offsets))));
      });
    };
    const resized = new ResizeObserver(measure);
    resized.observe(box);
    box.addEventListener('scroll', measure, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      box.removeEventListener('scroll', measure);
    };
  }, []);

  return (
    <section className="sbs-round" aria-label="Answers">
      {round.aiReminder && (
        <p className="ai-reminder" role="note">
          {AI_REMINDER}
        </p>
      )}
      <p className="prompt">{round.question}</p>
      {round.crisis && <CrisisNotice />}
      <output className="sr-only">{arriving ? `${outcome}.` : `${outcome}. Total so far ${formatUsd(answersTotal)}.`}</output>

      <div className="sbs-bar">
        <p className="sbs-status faint" aria-hidden="true">
          {outcome}
        </p>
        <nav className="sbs-tabs" aria-label="Jump to a column">
          {columns.map((c, i) => (
            <button key={SLOTS[i]} type="button" aria-controls={`${base}-col-${i}`} aria-current={shown === i ? 'true' : undefined} data-status={c.status} data-refunded={rerouteOf(c.receipt) ? 'true' : undefined} onClick={() => jump(i)}>
              <span className="sbs-letter" aria-hidden="true">
                {SLOTS[i]}
              </span>
              <span className="sr-only">Column {SLOTS[i]}: </span>
              <span className="sbs-tab-name">{c.model}</span>
            </button>
          ))}
        </nav>
        {arriving > 0 && (
          <button type="button" className="btn btn-small" onClick={sideBySide.stopAll}>
            <Square size={12} fill="currentColor" aria-hidden="true" /> Stop all
          </button>
        )}
      </div>

      <div className="sbs-columns" ref={scroller}>
        {columns.map((answer, i) => (
          <Column
            key={SLOTS[i]}
            id={`${base}-col-${i}`}
            label={SLOTS[i]}
            answer={answer}
            family={familyOf(models, answer.model)}
            chatBusy={chatBusy}
            onStop={() => sideBySide.stop(i)}
            onContinue={() => onContinue(answer)}
          />
        ))}
      </div>

      {arriving === 0 && (
        <div className="sbs-total">
          <p>
            {finished === columns.length ? 'Three answers' : `${finished} of ${columns.length} finished`} · total <strong className="mono">{formatUsd(answersTotal)}</strong>
            {stopped > 0 && (
              <span className="faint">
                {' '}
                · {stopped === 1 ? 'the stopped answer is charged for the text that arrived, and its receipt is' : 'stopped answers are charged for the text that arrived, and their receipts are'} on the Receipts page
              </span>
            )}
          </p>
          {(failed > 0 || stopped > 0) && (
            <button type="button" className="btn btn-small" onClick={onAskAgain}>
              <RotateCcw size={14} aria-hidden="true" /> Put the question back
            </button>
          )}
        </div>
      )}

      {arriving === 0 && !merge && usable.length >= 2 && (
        <div className="sbs-offer">
          <div>
            <h2>One answer from {usable.length === columns.length ? 'all three' : 'the two that answered'}</h2>
            <p className="muted">
              One more request: {MERGE_MODEL} reads answers {usable.map((a) => a.label).join(', ').replace(/, ([^,]*)$/, ' and $1')}, keeps what they agree on and lists where they differed. It is charged like any
              other answer.
            </p>
          </div>
          <button type="button" className="btn btn-primary sbs-go" disabled={!canMerge(round) || !canPay} onClick={onMerge}>
            <Combine size={17} aria-hidden="true" />
            Merge into one
            <span className="sbs-cost">{mergePrice ?? '1 charge'}</span>
          </button>
        </div>
      )}

      {merge && (
        <div className="sbs-merge" data-printed={merge.status === 'done' || merge.status === 'stopped' ? 'true' : undefined}>
          <article className="sbs-merged" aria-label="Merged answer" data-status={merge.status}>
            <header className="sbs-col-head">
              <span className="sbs-letter sbs-letter-merge" aria-hidden="true">
                <Combine size={14} />
              </span>
              <div className="sbs-col-name">
                <strong>Merged answer</strong>
                <span className="faint">
                  {merge.model} read {usable.length === columns.length ? 'all three' : `answers ${usable.map((a) => a.label).join(' and ')}`}
                </span>
              </div>
              {merge.status === 'streaming' && (
                <button type="button" className="btn btn-small" onClick={() => sideBySide.stop('merge')}>
                  <Square size={12} fill="currentColor" aria-hidden="true" /> Stop
                </button>
              )}
            </header>
            <AnswerBody answer={merge} />
            <AnswerFoot answer={merge} chatBusy={chatBusy} onContinue={() => onContinue(merge)} />
            {(merge.status === 'error' || merge.status === 'stopped') && (
              <div className="row">
                <button type="button" className="btn btn-small" disabled={!canMerge(round) || !canPay} onClick={onMerge}>
                  <Combine size={14} aria-hidden="true" /> Merge again{mergePrice ? ` · ${mergePrice}` : ' · 1 charge'}
                </button>
              </div>
            )}
          </article>
          {(merge.status === 'done' || merge.status === 'stopped') && <Printer rows={receiptStrip(round)} total={formatUsd(totalCost(roundReceipts(round)))} run={round.run} />}
        </div>
      )}
    </section>
  );
}

function Column({ id, label, answer, family, chatBusy, onStop, onContinue }: { id: string; label: string; answer: Answer; family: string | null; chatBusy: boolean; onStop: () => void; onContinue: () => void }) {
  const reroute = rerouteOf(answer.receipt);
  return (
    <article id={id} className="sbs-col" data-status={answer.status} data-refunded={reroute ? 'true' : undefined} aria-label={`Answer ${label}, from ${answer.model}`}>
      <header className="sbs-col-head">
        <span className="sbs-letter" aria-hidden="true">
          {label}
        </span>
        <div className="sbs-col-name">
          <strong>{answer.model}</strong>
          <span className="faint">{familyLabel(family)}</span>
        </div>
        {answer.status === 'streaming' && (
          <button type="button" className="btn btn-small" aria-label={`Stop answer ${label}`} onClick={onStop}>
            <Square size={12} fill="currentColor" aria-hidden="true" /> Stop
          </button>
        )}
      </header>
      {reroute && <RefundSlip reroute={reroute} model={answer.model} />}
      <AnswerBody answer={answer} />
      <AnswerFoot answer={answer} chatBusy={chatBusy} onContinue={onContinue} />
    </article>
  );
}

function AnswerBody({ answer }: { answer: Answer }) {
  if (answer.status === 'error')
    return (
      <div className="notice notice-rose notice-action" role="alert">
        <p>{answer.error}</p>
        {answer.needsFunds && (
          <Link className="btn btn-small btn-primary" href="/dashboard/funds">
            Add funds
          </Link>
        )}
      </div>
    );
  const streaming = answer.status === 'streaming';
  return (
    <>
      {answer.content || streaming ? <AnswerText text={answer.content} streaming={streaming} /> : <p className="muted">{answer.status === 'stopped' ? 'Stopped before any text arrived.' : 'No text came back.'}</p>}
      {answer.status === 'stopped' && <p className="faint sbs-note">Stopped. You are charged only for the text that arrived.</p>}
      {answer.cutOff && <p className="faint sbs-note">This reached the length limit here. Continue in chat to ask for the rest.</p>}
    </>
  );
}

/** What it cost, its tokens, its signed receipt, and the way on into a chat. */
function AnswerFoot({ answer, chatBusy, onContinue }: { answer: Answer; chatBusy: boolean; onContinue: () => void }) {
  if (answer.status === 'streaming' || answer.status === 'error') return null;
  const cost = costOf(answer.receipt);
  return (
    <footer className="sbs-foot">
      <div className="answer-foot">
        {cost !== null && <span className="sbs-price mono">{formatUsd(cost)}</span>}
        {answer.receipt && (
          <span className="faint">
            {answer.receipt.tokens.in.toLocaleString()} in · {answer.receipt.tokens.out.toLocaleString()} out
          </span>
        )}
        {answer.receiptId && (
          <Link href={`/dashboard/receipts/${encodeURIComponent(answer.receiptId)}`}>
            <ReceiptText size={15} aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: 5 }} />
            Signed receipt
          </Link>
        )}
      </div>
      {answer.content.trim() && (
        <div className="row">
          <button type="button" className="btn btn-small" disabled={chatBusy} title={chatBusy ? 'A chat is still answering. Let it finish or stop it first.' : undefined} onClick={onContinue}>
            <MessageSquare size={14} aria-hidden="true" /> Continue in chat
          </button>
          {answer.status === 'done' && <CopyButton text={answer.content} className="btn-ghost" />}
        </div>
      )}
    </footer>
  );
}

/** A slip of receipt paper on a column the refusal catch touched: who said no (stamped), and who stepped in. */
function RefundSlip({ reroute, model }: { reroute: Reroute; model: string }) {
  const refused = reroute.saidNo.length ? reroute.saidNo.map((r) => r.model) : [model];
  const names = refused.join(' and ');
  const said = reroute.steppedIn
    ? `${names} said no, so ${reroute.steppedIn.model} from the ${reroute.steppedIn.family} family stepped in. The refused attempt was refunded.`
    : `${names} said no, and no other family could take it. This answer cost nothing.`;
  return (
    <div className="sbs-slip" role="note">
      <div className="sbs-slip-shadow" aria-hidden="true">
        <div className="sbs-paper sbs-slip-paper">
          {refused.map((name, i) => (
            <PaperRow key={`${name}-${i}`} row={{ kind: 'pair', label: name, value: 'said no', stamp: 'REFUNDED' }} />
          ))}
          {reroute.steppedIn && <PaperRow row={{ kind: 'pair', label: reroute.steppedIn.model, value: 'answered' }} />}
          <PaperRow row={{ kind: 'pair', label: 'You paid for', value: reroute.steppedIn ? 'the answer' : 'nothing', tone: 'amber' }} />
        </div>
      </div>
      <p>{said}</p>
    </div>
  );
}

/** The receipt printer: the animated plush stands over a slot, and the strip for this round feeds out of it. */
function Printer({ rows, total, run }: { rows: StripRow[]; total: string; run: number }) {
  return (
    <aside className="sbs-printer" aria-label={`Receipt for this round. Total ${total}.`}>
      <div className="sbs-printer-body" aria-hidden="true">
        <div className="sbs-printer-mascot">
          <MascotSprite mood="joy" />
        </div>
        <div className="sbs-printer-slot" />
        <div className="sbs-paper-window">
          <div className="sbs-paper sbs-strip" key={run}>
            {rows.map((row, i) => (
              <PaperRow key={i} row={row} />
            ))}
          </div>
        </div>
      </div>
      {/* The printed strip is a picture of a receipt; this is the same receipt as a list. */}
      <ul className="sr-only">
        {rows.map((row, i) =>
          row.kind === 'pair' ? <li key={i}>{`${row.label}: ${row.value}${row.stamp ? ` (${row.stamp.toLowerCase()})` : ''}`}</li> : row.kind === 'head' ? <li key={i}>{row.label === '+' ? row.text : `Column ${row.label}: ${row.text}`}</li> : null,
        )}
      </ul>
    </aside>
  );
}

function PaperRow({ row }: { row: StripRow }) {
  if (row.kind === 'logo')
    return (
      <div className="sbs-rx sbs-rx-logo">
        <svg viewBox="0 0 48 24" width="56" height="28">
          <path d="M4 12C4 5.5 11 3.5 24 6.5 37 3.5 44 5.5 44 12s-7 8.5-20 5.5C11 20.5 4 18.5 4 12Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="1.6 1.4" />
          <path d="M10.5 11.5q4.5 3.6 9 0M28.5 11.5q4.5 3.6 9 0" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
    );
  if (row.kind === 'rule') return <div className="sbs-rx sbs-rx-rule" />;
  if (row.kind === 'center') return <div className={`sbs-rx sbs-rx-center${row.big ? ' sbs-rx-big' : ''}`}>{row.text}</div>;
  if (row.kind === 'head')
    return (
      <div className="sbs-rx sbs-rx-head">
        <b>{row.label}</b>
        <span>{row.text}</span>
      </div>
    );
  return (
    <div className={`sbs-rx sbs-rx-pair${row.tone === 'amber' ? ' sbs-rx-amber' : ''}`}>
      <span>{row.label}</span>
      <i />
      <span>{row.value}</span>
      {row.stamp && <b className="sbs-stamp">{row.stamp}</b>}
    </div>
  );
}

/** One of the three slots: a button that opens a searchable list of models with each one's family and refusal rate. */
function SlotPicker({ label, value, slots, models, onPick }: { label: string; value: string; slots: string[]; models: ModelInfo[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const panelId = useId();
  const current = models.find((m) => m.id === value);
  const found = useMemo(() => searchModels(models, query), [models, query]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) button.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    // On a phone the list can open below the fold: bring it into view, clear of the bottom bar.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.current?.parentElement?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, close]);

  const pick = (id: string) => {
    onPick(id);
    close(true);
  };
  /** Arrow keys walk from the search box down the list and back; Escape closes it. */
  const walk = (event: KeyboardEvent<HTMLElement>, from: number) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const options = [...(list.current?.querySelectorAll('button') ?? [])];
    const next = from + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) search.current?.focus();
    else options[Math.min(next, options.length - 1)]?.focus();
  };

  return (
    <div
      className="sbs-slot"
      ref={root}
      onBlur={(event) => {
        // Tabbing out of the list closes it; a click on its own padding does not.
        if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(false);
      }}
    >
      <button ref={button} type="button" className="sbs-slot-btn" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => (open ? close(false) : setOpen(true))}>
        <span className="sbs-letter" aria-hidden="true">
          {label}
        </span>
        <span className="sbs-slot-text">
          <span className="sr-only">Column {label} asks </span>
          <strong>{value}</strong>
          <small>
            {familyLabel(current?.family ?? null)} · {refusalLabel(current?.refusal_rate_30d)}
          </small>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="sbs-menu" id={panelId}>
          <label className="sbs-search">
            <Search size={15} aria-hidden="true" />
            <span className="sr-only">Search the models for column {label}. Enter picks the first match.</span>
            <input
              ref={search}
              className="input"
              autoComplete="off"
              spellCheck={false}
              placeholder="Search by model or family"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Never the form around the slots: Enter here chooses a model, it does not send the question.
                  e.preventDefault();
                  if (found[0]) pick(found[0].id);
                } else walk(e, -1);
              }}
            />
          </label>
          <ul ref={list} aria-label={`Models for column ${label}`}>
            {found.map((m, i) => {
              const elsewhere = slots.indexOf(m.id);
              const price = listPrice(m);
              return (
                <li key={m.id}>
                  <button type="button" aria-current={m.id === value ? 'true' : undefined} onClick={() => pick(m.id)} onKeyDown={(e) => walk(e, i)}>
                    <span className="sbs-opt-name">
                      <span>{m.id}</span>
                      {m.id === value ? (
                        <>
                          <Check size={14} aria-hidden="true" />
                          <span className="sr-only">in this column now</span>
                        </>
                      ) : (
                        elsewhere !== -1 && <span className="chip">in column {SLOTS[elsewhere]} · trades places</span>
                      )}
                    </span>
                    <span className="sbs-opt-meta">
                      {familyLabel(m.family)} · {refusalLabel(m.refusal_rate_30d)}
                    </span>
                    {price && (
                      <span className="sbs-opt-meta">
                        {formatUsd(price.in)} in · {formatUsd(price.out)} out, for a million tokens
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
            {!found.length && <li className="sbs-opt-none">No model matches that.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The chat thread's crisis notice, shown with any question that mentions suicide or self-harm. It never blocks. */
function CrisisNotice() {
  return (
    <aside className="notice crisis-notice" aria-label="Crisis support">
      <strong>If you’re thinking about suicide or hurting yourself, you can talk to a person right now.</strong>
      <p className="muted">Free and confidential. If you’re in immediate danger, call your local emergency number.</p>
      <ul>
        {CRISIS_LINES.map((l) => (
          <li key={l.href}>
            <span className="crisis-where">{l.where} ·</span> {l.what}:{' '}
            <a href={l.href} {...(l.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
              {l.action}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
