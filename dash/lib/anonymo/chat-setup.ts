import { ASK_TOPICS, type AskTopic } from './askmo.ts';
import { isChatMode, type ChatMode } from './chat-modes.ts';
import { parseUsdAtto, type Atto } from './pricetag.ts';

export type ChatSetupStep = 'key' | 'funds';

export function chatSetupStep(hasKey: boolean, available: number | undefined, price?: Atto): ChatSetupStep | null {
  if (!hasKey) return 'key';
  if (available === undefined || !Number.isFinite(available)) return null;
  if (available <= 0) return 'funds';
  if (price === undefined) return null;
  const credit = parseUsdAtto(available < 0.000001 ? available.toFixed(18) : String(available));
  return credit !== null && credit < price ? 'funds' : null;
}

const SLOT = 'anonymo.chat-setup-draft';
type Slot = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Scope = { destination: string; demo: boolean };

export const readSetupDraft = (storage: Slot | null, scope: Scope) => readSetupMessage(storage, scope)?.text ?? null;

export function readSetupMessage(storage: Slot | null, scope: Scope): { text: string; mode: ChatMode | null; topic?: AskTopic } | null {
  try {
    const raw = storage?.getItem(SLOT);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    return draft?.destination === scope.destination && draft.demo === scope.demo && typeof draft.text === 'string'
      ? { text: draft.text, mode: isChatMode(draft.mode) ? draft.mode : null, ...(Object.hasOwn(ASK_TOPICS, draft.topic) ? { topic: draft.topic } : {}) } : null;
  } catch {
    return null;
  }
}

export function writeSetupDraft(storage: Slot | null, scope: Scope, text: string, mode?: ChatMode | null, topic?: AskTopic | null): boolean {
  if (!text.trim() && !mode) {
    clearSetupDraft(storage, scope);
    return true;
  }
  try {
    if (!storage) return false;
    storage.setItem(SLOT, JSON.stringify({ destination: scope.destination, demo: scope.demo, text, ...(mode ? { mode } : {}), ...(topic ? { topic } : {}) }));
    return true;
  } catch {
    return false;
  }
}

export function clearSetupDraft(storage: Slot | null, scope: Scope) {
  try {
    if (readSetupDraft(storage, scope) !== null) storage?.removeItem(SLOT);
  } catch {
    // Storage can be unavailable even while the composer still works.
  }
}
