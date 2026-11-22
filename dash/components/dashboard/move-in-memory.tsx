'use client';

import { characterDestination, setupHref } from '@/lib/anonymo/setup-return';

// Update "movein": the memory board, "What <name> remembers". A summary and short facts as stitched felt patches the
// person can edit, pin, delete and add to, kept on this device and sent with each message to that character.
// "Build memory" writes them from the imported chats with ordinary chat calls: the price is shown on the button
// before anything is spent, the running total while it runs, and every call's receipt is remembered.

import Link from 'next/link';
import { Pencil, Pin, PinOff, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { isLiveModel, useAnonymo } from '../anonymo-provider';
import { AnonymoApiError, describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { formatUsd, usdToMusd } from '@/lib/anonymo/money';
import { historyOf, type ArchiveCharacter } from '@/lib/anonymo/movein/archive';
import {
  addPatch,
  applyBuild,
  editPatch,
  emptyBoard,
  estimateMusd,
  factsRequest,
  isProtected,
  listedPrice,
  parseFacts,
  PATCH_MAX_CHARS,
  pinPatch,
  planBuild,
  planFrom,
  removePatch,
  SENT_FACTS,
  summaryOf,
  summaryStep,
  type Board,
  type BuildPlan,
  type Patch,
  type TextPrice,
} from '@/lib/anonymo/movein/memory';
import { archiveDisk, saveBoard } from '@/lib/anonymo/movein/store';
import { modelStore } from '@/lib/anonymo/prefs';
import { CRISIS_LINES, mentionsSelfHarm } from '@/lib/anonymo/safety';
import type { ChatResult } from '@/lib/anonymo/types';

/** The models a build can run on: one model, not the council, and only where the gateway lists a price. */
const BUILD_MODELS = ['anonymo-1', 'anonymo-rp', 'anonymo-sealed'];
const SCOPES = [300, 1000];
const WRITERS: Record<Patch['by'], string> = { model: 'Written by AI', you: 'Yours', export: 'From your export' };
const FELT = ['#f6d9a8', '#f7c4d4', '#c9e6cf', '#c7dcf4', '#ddd0f4', '#f8cdb4'];
const EMPTY = emptyBoard();
/** The time, for stamping patches. Only ever called from a click, never while rendering. */
const stamp = () => Date.now();
const when = (ms: number) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

type Run = { done: number; of: number; spent: number };
type Trouble = { text: string; funds: boolean; skip: number | null };

/** The text box a patch is written in, focused when it opens. */
function PatchForm({ label, labelHidden, rows, initial, submit, onSave, onCancel }: { label: string; labelHidden?: boolean; rows: number; initial: string; submit: string; onSave: (text: string) => void; onCancel: () => void }) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  useEffect(() => box.current?.focus(), []);
  return (
    <form
      className="mi-patch-edit"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text);
      }}
    >
      <label className={labelHidden ? 'sr-only' : undefined} htmlFor={id}>
        {label}
      </label>
      <textarea id={id} ref={box} className="textarea" rows={rows} maxLength={PATCH_MAX_CHARS} value={text} onChange={(event) => setText(event.target.value)} />
      <div className="row">
        <button type="submit" className="btn btn-small btn-primary" disabled={!text.trim() && !initial}>
          {submit}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MemoryBoard({ character, board: saved, onClose }: { character: ArchiveCharacter; board: Board | undefined; onClose: () => void }) {
  const { demo, key, client, rememberReceipt, refreshBalance, liveModels } = useAnonymo();
  const board = saved ?? EMPTY;
  const name = character.name;
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  // The board as last saved from here. A build saves several times in a row, faster than the page re-renders.
  const latest = useRef(board);
  useEffect(() => {
    latest.current = board;
  }, [board]);

  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const [note, setNote] = useState('');
  const building = run !== null;

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => controller.current?.abort();
  }, []);

  const save = async (next: Board) => {
    latest.current = next;
    const empty = !next.patches.length && !next.built && !next.unfinished;
    if (!(await saveBoard(demo, character.id, empty ? null : next))) setTrouble({ text: 'This browser would not store the change. Its storage is full or blocked.', funds: false, skip: null });
  };

  // ---- what a build would send, and what it would cost -------------------------------------------------------------
  const stored = useDeviceStore(modelStore);
  const [prices, setPrices] = useState<Record<string, TextPrice> | null>(null);
  useEffect(() => {
    let stale = false;
    client.models().then(
      (list) => {
        if (stale) return;
        const found: Record<string, TextPrice> = {};
        for (const model of list.data) {
          const price = listedPrice(model);
          if (price) found[model.id] = price;
        }
        setPrices(found);
      },
      () => !stale && setPrices({}),
    );
    return () => {
      stale = true;
    };
  }, [client]);
  const choices = BUILD_MODELS.filter((id) => isLiveModel(liveModels, id) && prices?.[id]);
  const [picked, setPicked] = useState<string | null>(null);
  const model = picked && choices.includes(picked) ? picked : choices.includes(stored) ? stored : (choices[0] ?? null);
  const price = model ? (prices?.[model] ?? null) : null;

  const total = character.messages;
  const [scope, setScope] = useState<number | null>(total > 2000 ? 1000 : null);
  const kept = summaryOf(board);
  const keepSummary = !!kept && isProtected(kept);
  // The plan is worked out from the chats themselves, so it is read again whenever what it depends on changes.
  const planKey = `${character.id}:${total}:${scope ?? 'all'}:${keepSummary}`;
  const [planned, setPlanned] = useState<{ key: string; plan: BuildPlan } | null>(null);
  const plan = planned?.key === planKey ? planned.plan : null;
  useEffect(() => {
    if (!total) return;
    let stale = false;
    historyOf(archiveDisk(), demo, character, scope ?? undefined).then(
      (messages) => !stale && setPlanned({ key: planKey, plan: planBuild(messages, name, { summary: !keepSummary }) }),
      () => !stale && setTrouble({ text: 'The chats could not be read from this device.', funds: false, skip: null }),
    );
    return () => {
      stale = true;
    };
  }, [demo, character, name, scope, total, keepSummary, planKey]);

  const resumeAt = plan && board.unfinished?.plan === plan.id && board.unfinished.done < plan.requests ? board.unfinished.done : 0;
  const left = plan ? planFrom(plan, resumeAt) : null;
  const estimate = left && price ? estimateMusd(left, price) : null;

  // ---- the build ----------------------------------------------------------------------------------------------------
  async function build(from: number) {
    if (!plan || !model || !price || !key || building || estimate === null) return;
    const abort = new AbortController();
    controller.current = abort;
    setTrouble(null);
    setNote('');
    let spent = from > 0 ? (latest.current.unfinished?.costMusd ?? 0) : 0;
    let done = from;
    let at = from;
    setRun({ done, of: plan.requests, spent });
    const newId = () => crypto.randomUUID();
    /** One paid call is over: remember its receipt, add what it cost, refresh the balance. */
    const settle = async (result: ChatResult) => {
      let cost = usdToMusd(result.receipt?.cost);
      if (result.receiptId) {
        rememberReceipt({ id: result.receiptId, model, at: new Date().toISOString() });
        if (Number.isNaN(cost)) cost = usdToMusd((await client.receipt(result.receiptId).catch(() => null))?.receipt.cost);
      }
      if (!Number.isNaN(cost)) spent += cost;
      done++;
      refreshBalance();
      setRun({ done, of: plan.requests, spent });
    };
    try {
      // The running summary: each piece of history is folded into the summary so far.
      let summary = from > 0 ? (summaryOf(latest.current)?.text ?? '') : '';
      while (at < plan.chunks.length) {
        const result = await client.chat(summaryStep(model, summary, plan.chunks[at]), { signal: abort.signal });
        await settle(result);
        summary = result.content.trim() || summary;
        await save({ ...applyBuild(latest.current, { summary }, newId, stamp()), unfinished: { done, of: plan.requests, plan: plan.id, costMusd: spent } });
        at++;
      }
      // One small request for the facts, from the summary and the newest turns.
      const result = await client.chat(factsRequest(model, name, summaryOf(latest.current)?.text ?? '', plan.recent), { signal: abort.signal });
      await settle(result);
      const { unfinished: _done, ...finished } = applyBuild(latest.current, { facts: parseFacts(result.content) }, newId, stamp());
      await save({ ...finished, built: { at: stamp(), model, messages: plan.messages, requests: plan.requests, costMusd: spent } });
      setNote(`Built from ${count(plan.messages, 'message')} for ${formatUsd(spent)}.`);
    } catch (error) {
      if (abort.signal.aborted) setNote(done > from ? `Stopped after ${count(done, 'request')}. What was built so far is kept, and you can carry on from there.` : 'Stopped before anything was spent.');
      else {
        // A piece of history the floor check refuses can be left out, so one piece does not end the whole build.
        const blocked = error instanceof AnonymoApiError && (error.status === 451 || error.code === 'floor_blocked') && at < plan.chunks.length;
        setTrouble({ text: describeError(error), funds: isOutOfCredit(error), skip: blocked ? at + 1 : null });
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      setRun(null);
      refreshBalance();
    }
  }

  /** Marks the piece the floor check refused as left out. Nothing is sent: the build button carries on from there. */
  async function leaveOut(next: number) {
    if (!plan) return;
    setTrouble(null);
    await save({ ...latest.current, unfinished: { done: next, of: plan.requests, plan: plan.id, costMusd: latest.current.unfinished?.costMusd ?? 0 } });
  }

  const close = () => {
    if (!building) dialog.current?.close();
  };
  const facts = board.patches.filter((p) => p.kind === 'fact');
  const ordered = [...board.patches.filter((p) => p.kind === 'summary'), ...facts.filter((p) => p.pinned), ...facts.filter((p) => !p.pinned)];
  const crisis = board.patches.some((p) => mentionsSelfHarm(p.text));
  const label = keepSummary ? 'Rebuild the facts' : resumeAt ? 'Carry on building' : board.built ? 'Rebuild memory' : 'Build memory';
  const scopes = SCOPES.filter((n) => n < total);

  return (
    <dialog
      ref={dialog}
      className="mi-board"
      aria-labelledby={title}
      onClose={onClose}
      onCancel={(event) => {
        if (building) event.preventDefault();
      }}
    >
      <div className="mi-board-inner">
        <header className="mi-board-head">
          <div>
            <h2 id={title}>What {name} remembers</h2>
            <p className="muted">Sent with each message you write to {name}, so replies stay true to what came before. Kept in this browser only. Every patch is yours to change.</p>
          </div>
          <button type="button" className="btn btn-ghost" aria-label="Close" disabled={building} onClick={close}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        {ordered.length === 0 ? (
          <p className="mi-board-empty">Nothing here yet. Build memory from the chats that moved in, or sew on a patch of your own.</p>
        ) : (
          <ul className="mi-patches">
            {ordered.map((patch, i) => (
              <li key={patch.id} className="mi-patch" data-kind={patch.kind} data-pinned={patch.pinned} style={{ '--mi-felt': patch.kind === 'summary' ? '#f3e6dc' : FELT[i % FELT.length], '--mi-tilt': ((i * 37) % 5) - 2 } as CSSProperties}>
                {editing === patch.id ? (
                  <PatchForm
                    label={patch.kind === 'summary' ? 'Summary' : 'Fact'}
                    labelHidden
                    rows={patch.kind === 'summary' ? 7 : 3}
                    initial={patch.text}
                    submit="Save"
                    onSave={(text) => {
                      void save(editPatch(board, patch.id, text, stamp()));
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <>
                    {patch.pinned && <span className="mi-pin" aria-hidden="true" />}
                    <span className="mi-patch-kind">{patch.kind === 'summary' ? 'Summary' : 'Fact'}</span>
                    <p>{patch.text}</p>
                    <div className="mi-patch-foot">
                      <span>{WRITERS[patch.by]}</span>
                      <span className="mi-patch-tools">
                        <button type="button" aria-pressed={patch.pinned} title={patch.pinned ? 'Unpin' : 'Pin, so a rebuild leaves it alone'} disabled={building} onClick={() => void save(pinPatch(board, patch.id, !patch.pinned))}>
                          {patch.pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
                          <span className="sr-only">Pin this patch</span>
                        </button>
                        <button type="button" title="Edit" disabled={building} onClick={() => setEditing(patch.id)}>
                          <Pencil size={15} aria-hidden="true" />
                          <span className="sr-only">Edit this patch</span>
                        </button>
                        <button type="button" title="Delete" disabled={building} onClick={() => void save(removePatch(board, patch.id))}>
                          <Trash2 size={15} aria-hidden="true" />
                          <span className="sr-only">Delete this patch</span>
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {adding ? (
          <div className="mi-add">
            <PatchForm
              label={`A fact ${name} should remember`}
              rows={2}
              initial=""
              submit="Sew it on"
              onSave={(text) => {
                if (text.trim()) void save(addPatch(board, text, crypto.randomUUID(), stamp()));
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          </div>
        ) : (
          <div className="row">
            <button type="button" className="btn btn-small" disabled={building} onClick={() => setAdding(true)}>
              <Plus size={15} aria-hidden="true" /> Add a patch
            </button>
            {facts.length > SENT_FACTS && <span className="faint">The first {SENT_FACTS} facts are sent, pinned ones first.</span>}
          </div>
        )}

        {crisis && (
          <aside className="notice crisis-notice" aria-label="Crisis support">
            <strong>If you’re thinking about suicide or hurting yourself, you can talk to a person right now.</strong>
            <p className="muted">Free and confidential. If you’re in immediate danger, call your local emergency number.</p>
            <ul>
              {CRISIS_LINES.map((line) => (
                <li key={line.href}>
                  <span className="crisis-where">{line.where} ·</span> {line.what}:{' '}
                  <a href={line.href} {...(line.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
                    {line.action}
                  </a>
                </li>
              ))}
            </ul>
          </aside>
        )}

        <section className="mi-build" aria-label="Build memory">
          <h3>Build it from the chats</h3>
          {total === 0 ? (
            <p className="muted">No chats moved in with {name}, so there is nothing to build from. Patches you add yourself work the same.</p>
          ) : (
            <>
              <p className="muted">A model reads the chats in pieces and keeps a running summary, then lists short facts. These are ordinary chat calls: each one is priced, checked and given a signed receipt, like any message you send.</p>
              <div className="mi-build-fields">
                <label className="field">
                  Read
                  <select className="select" value={scope ?? 'all'} disabled={building} onChange={(event) => setScope(event.target.value === 'all' ? null : Number(event.target.value))}>
                    <option value="all">All {count(total, 'message')}</option>
                    {scopes.map((n) => (
                      <option key={n} value={n}>
                        The newest {n.toLocaleString('en-US')} messages
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Model
                  <select className="select" value={model ?? ''} disabled={building || choices.length === 0} onChange={(event) => setPicked(event.target.value)}>
                    {choices.length === 0 && <option value="">{prices ? 'None with a listed price' : 'Loading…'}</option>}
                    {choices.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {keepSummary && (
                <p className="faint">
                  The summary is {kept?.pinned ? 'pinned' : kept?.by === 'export' ? 'from your export' : 'your own'}, so a build leaves it alone and writes only the facts. Delete that patch to have the summary built again.
                </p>
              )}
              {resumeAt > 0 && !building && plan && (
                <p className="faint">
                  The last build stopped after {resumeAt} of {plan.requests} requests. Carrying on does not pay for those again.
                </p>
              )}
              {prices && choices.length === 0 && <p className="notice notice-amber">The gateway lists no price right now for a model that can do this, so the cost cannot be shown and nothing can be built yet.</p>}

              {run ? (
                <output className="mi-run" aria-live="polite">
                  <progress max={run.of} value={run.done} aria-label="Build progress" />
                  <span className="mono">
                    Request {Math.min(run.done + 1, run.of)} of {run.of} · <b className="mi-cost">{formatUsd(run.spent)}</b> so far
                  </span>
                  <button type="button" className="btn btn-small" onClick={() => controller.current?.abort()}>
                    <Square size={13} fill="currentColor" aria-hidden="true" /> Stop
                  </button>
                </output>
              ) : !key ? (
                <div className="row">
                  <Link className="btn btn-primary btn-small" href={setupHref('key', characterDestination('move-in', character.id))}>
                    Create a key to build memory
                  </Link>
                  {estimate !== null && left && (
                    <span className="faint">
                      It would cost about <b className="mi-cost">{formatUsd(estimate)}</b> for {count(left.requests, 'request')}.
                    </span>
                  )}
                </div>
              ) : (
                <div className="row">
                  <button type="button" className="btn btn-primary mi-go" disabled={estimate === null || !left || left.requests === 0} onClick={() => void build(resumeAt)}>
                    {label}
                    <span className="mi-cost">{estimate === null ? (plan && prices ? '—' : 'Counting…') : `about ${formatUsd(estimate)}`}</span>
                  </button>
                  {left && estimate !== null && (
                    <span className="faint">
                      {count(left.requests, 'request')} with {model}, about {left.tokensIn.toLocaleString('en-US')} tokens in. This is the most it can cost: you pay what each request really uses.
                    </span>
                  )}
                </div>
              )}
            </>
          )}
          {note && <output className="notice notice-signal">{note}</output>}
          {trouble && (
            <div className="notice notice-rose notice-action" role="alert">
              <p>{trouble.text}</p>
              {trouble.funds && (
                <Link className="btn btn-small btn-primary" href={setupHref('funds', characterDestination('move-in', character.id))}>
                  Add funds
                </Link>
              )}
              {trouble.skip !== null && (
                <button type="button" className="btn btn-small" onClick={() => void leaveOut(trouble.skip!)}>
                  Leave that part out
                </button>
              )}
            </div>
          )}
          {board.built && !building && (
            <p className="faint">
              Last built {when(board.built.at)} from {count(board.built.messages, 'message')} with {board.built.model}, for <span className="mi-cost">{formatUsd(board.built.costMusd)}</span>. <Link href="/dashboard/receipts">Its receipts</Link> are with your others.
            </p>
          )}
        </section>
        <p className="ai-notice">Review the AI-generated notes and correct any mistakes.</p>
      </div>
    </dialog>
  );
}
