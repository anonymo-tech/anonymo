// Update "sidebyside": the Side by Side round of this tab. The draft question, the three chosen models and the answers
// live in memory only: never in storage, and sent nowhere but the gateway calls themselves. They sit in a module store
// rather than in component state so that opening a receipt or the Funds page and coming back does not lose three paid
// answers, and so a stream keeps arriving while another page is open. Everything is dropped when the key changes,
// which is also what "Wipe this device" does to the key.

import { useSyncExternalStore } from 'react';
import { describeError, isOutOfCredit, type AnonymoClient } from '@/lib/anonymo/client';
import { keyStore } from '@/lib/anonymo/key-store';
import { rememberReceipt } from '@/lib/anonymo/prefs';
import { mentionsSelfHarm, reminderDue } from '@/lib/anonymo/safety';
import {
  ANSWER_MAX_TOKENS,
  EMPTY_ROUND,
  MERGE_MAX_TOKENS,
  MERGE_MODEL,
  SLOTS,
  canMerge,
  isBusy,
  mergeRequest,
  mergeable,
  roundReducer,
  type Round,
  type RoundAction,
  type SlotId,
} from '@/lib/anonymo/sidebyside';
import type { ChatMessage } from '@/lib/anonymo/types';

export type Session = {
  /** What is typed in the question box. */
  draft: string;
  /** The models the person chose for the columns, or null while the defaults stand. */
  slots: string[] | null;
  round: Round;
};

const EMPTY: Session = { draft: '', slots: null, round: EMPTY_ROUND };
let state = EMPTY;
const listeners = new Set<() => void>();
const controllers = new Map<SlotId, AbortController>();
// Text that arrived since the last paint, so three streams repaint the page once a frame and not once a word.
const arriving = new Map<SlotId, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let arrivingRun = 0;
// The AI notice under the question box is always on screen; this marks when a round last repeated it.
let noticedAt = Date.now();
let scopeKey: string | null | undefined;

function set(next: Session) {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!arriving.size) return;
  let round = state.round;
  for (const [slot, text] of arriving) round = roundReducer(round, { type: 'delta', run: arrivingRun, slot, text });
  arriving.clear();
  if (round !== state.round) set({ ...state, round });
}

function dispatch(action: RoundAction) {
  flush(); // text first, so an answer is whole before it settles
  const round = roundReducer(state.round, action);
  if (round !== state.round) set({ ...state, round });
}

function arrive(run: number, slot: SlotId, text: string) {
  if (run !== state.round.run) return;
  arrivingRun = run;
  arriving.set(slot, (arriving.get(slot) ?? '') + text);
  flushTimer ??= setTimeout(flush, 24);
}

function abortAll() {
  for (const controller of controllers.values()) controller.abort();
}

/** Stops whatever is arriving and forgets the question, the chosen models and the answers. */
function drop() {
  abortAll();
  arriving.clear();
  set({ ...EMPTY, round: roundReducer(state.round, { type: 'clear' }) });
}

function watchKey() {
  if (scopeKey !== undefined || typeof window === 'undefined') return;
  scopeKey = keyStore.get();
  keyStore.subscribe(() => {
    const key = keyStore.get();
    if (key === scopeKey) return;
    scopeKey = key;
    drop();
  });
}

function subscribe(listener: () => void) {
  watchKey();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One request, streamed into its column (or into the merge), then settled with its receipt. */
async function stream(client: AnonymoClient, run: number, slot: SlotId, model: string, messages: ChatMessage[], maxTokens: number, settled: () => void) {
  const abort = new AbortController();
  controllers.set(slot, abort);
  try {
    const result = await client.chat(
      { model, messages, max_tokens: maxTokens },
      { signal: abort.signal, headers: { refusalCatch: 'on' }, onDelta: (text) => arrive(run, slot, text) },
    );
    dispatch({ type: 'done', run, slot, content: result.content, receiptId: result.receiptId, receipt: result.receipt, cutOff: result.finishReason === 'length' });
    if (result.receiptId) {
      rememberReceipt({ id: result.receiptId, model, at: new Date().toISOString() });
      if (!result.receipt)
        client.receipt(result.receiptId).then(
          (view) => dispatch({ type: 'receipt', run, slot, receipt: view.receipt }),
          () => undefined,
        );
    }
  } catch (error) {
    if (abort.signal.aborted) dispatch({ type: 'stopped', run, slot });
    else dispatch({ type: 'error', run, slot, message: describeError(error), needsFunds: isOutOfCredit(error) });
  } finally {
    if (controllers.get(slot) === abort) controllers.delete(slot);
    settled();
  }
}

export const sideBySide = {
  setDraft(draft: string) {
    set({ ...state, draft });
  },
  setSlots(slots: string[]) {
    set({ ...state, slots });
  },
  /**
   * Sends the question to every model at once: one request each, on its own stop switch. `settled` runs after each
   * request ends (the balance has changed). Returns false when nothing was sent.
   */
  ask(client: AnonymoClient, question: string, models: readonly string[], settled: () => void): boolean {
    const text = question.trim();
    if (!text || models.length !== SLOTS.length || isBusy(state.round)) return false;
    const run = state.round.run + 1;
    const aiReminder = reminderDue(noticedAt);
    if (aiReminder) noticedAt = Date.now();
    dispatch({ type: 'ask', run, question: text, models, aiReminder, crisis: mentionsSelfHarm(text) });
    if (state.round.run !== run) return false;
    set({ ...state, draft: '' });
    models.forEach((model, slot) => void stream(client, run, slot, model, [{ role: 'user', content: text }], ANSWER_MAX_TOKENS, settled));
    return true;
  },
  /** One more request: the answers so far, merged by anonymo-1. */
  merge(client: AnonymoClient, settled: () => void): boolean {
    const round = state.round;
    if (!canMerge(round)) return false;
    const messages = mergeRequest(round.question, mergeable(round));
    dispatch({ type: 'merge', run: round.run, model: MERGE_MODEL });
    if (state.round.merge?.status !== 'streaming') return false;
    void stream(client, round.run, 'merge', MERGE_MODEL, messages, MERGE_MAX_TOKENS, settled);
    return true;
  },
  stop(slot: SlotId) {
    controllers.get(slot)?.abort();
  },
  stopAll: abortAll,
};

export const useSideBySide = () =>
  useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
