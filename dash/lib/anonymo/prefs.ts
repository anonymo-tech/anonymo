import { deviceStore, readJson, writeJson } from './device-store.ts';
import { ANONYMO_MODEL_IDS, type AnonymoModelId } from './types.ts';

// Small per-device choices. No identity, no history: the last model picked, the receipt ids seen, the 18+ answer.

const MODEL = 'anonymo.model.v1';
const RECEIPTS = 'anonymo.receipts.v1';
const ADULT = 'anonymo.adult.v1';

export const modelStore = deviceStore<AnonymoModelId>(() => {
  const saved = readJson<string>(MODEL, 'anonymo-1');
  return (ANONYMO_MODEL_IDS as readonly string[]).includes(saved) ? (saved as AnonymoModelId) : 'anonymo-1';
}, 'anonymo-1');
// Chat accepts direct catalog IDs. Workspaces designed around the four Anonymo aliases keep their existing store.
export const chatModelStore = deviceStore<string>(() => {
  const saved = readJson<unknown>(MODEL, 'anonymo-1');
  return typeof saved === 'string' && /^[\w~][\w~./:-]{0,199}$/.test(saved) ? saved : 'anonymo-1';
}, 'anonymo-1');
export function setChatModel(id: string) {
  writeJson(MODEL, id);
  modelStore.changed();
  chatModelStore.changed();
}
const MODEL_WELCOME = 'anonymo.chat-model-welcome.v1';
let dismissedWithoutStorage = false;
export const modelWelcomeDone = deviceStore(() =>
  dismissedWithoutStorage || readJson(MODEL_WELCOME, false) || readJson(MODEL, null) !== null, true);
export function dismissModelWelcome() {
  dismissedWithoutStorage = !writeJson(MODEL_WELCOME, true);
  modelWelcomeDone.changed();
}
export function setStoredModel(id: AnonymoModelId) {
  setChatModel(id);
}

export type SeenReceipt = { id: string; model: string; at: string };
export const receiptsStore = deviceStore<SeenReceipt[]>(() => {
  const parsed = readJson<unknown>(RECEIPTS, []);
  return Array.isArray(parsed) ? (parsed as SeenReceipt[]).filter((r) => typeof r?.id === 'string').slice(0, 200) : [];
}, []);
export function rememberReceipt(receipt: SeenReceipt) {
  writeJson(RECEIPTS, [receipt, ...receiptsStore.get().filter((r) => r.id !== receipt.id)].slice(0, 200));
  receiptsStore.changed();
}
export function forgetReceipts() {
  writeJson(RECEIPTS, []);
  receiptsStore.changed();
}

let adultThisPage = false; // when storage is blocked the answer lasts for this page
export const adultStore = deviceStore<boolean>(() => adultThisPage || readJson<boolean>(ADULT, false) === true, false);
export function confirmAdult() {
  adultThisPage = true;
  writeJson(ADULT, true);
  adultStore.changed();
}
