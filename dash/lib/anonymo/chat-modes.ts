import { AnonymoApiError, describeError } from './client.ts';
import { estimateMessage, parseUsdAtto, type Atto, type Estimate } from './pricetag.ts';
import { ANSWER_MAX_TOKENS, MERGE_ANSWER_CHARS, MERGE_MAX_TOKENS, MERGE_MODEL, SLOTS, mergeRequest, type Round } from './sidebyside.ts';
import type { MediaImageModel, MediaModelList, ModelInfo, SpeechReceipt } from './types.ts';

const hints = {
  picture: 'draw|drawing|picture|image|photo|paint|painting|sketch',
  three: 'which ai|which model|compare|better at|best at',
  talk: 'out loud|talk|voice|speak',
};
export type ChatMode = keyof typeof hints;
export const CHAT_MODES = ['picture', 'three', 'talk'] as const;
export const isChatMode = (value: unknown): value is ChatMode => CHAT_MODES.some((mode) => mode === value);

const wordChars = '[\\p{L}\\p{M}\\p{N}_]';
const pattern = (mode: ChatMode) => new RegExp(`(?<!${wordChars})(?:${hints[mode]})(?!${wordChars})`, 'giu');

/** Match on the device. When several modes fit, use the first available one in the menu. */
export function modeHint(text: string, available: readonly ChatMode[]) {
  for (const mode of CHAT_MODES) {
    if (!available.includes(mode)) continue;
    const matches = [...text.matchAll(pattern(mode))].map((match) => ({ start: match.index, end: match.index + match[0].length }));
    if (matches.length) return { mode, matches };
  }
  return null;
}

export type PictureSettings = { model: string; size: string; n: number };
export type ThreeSettings = { models: string[]; merged: boolean };
export type TalkSettings = { voice: string; aloud: boolean };
export type ModePrefs = { picture: PictureSettings; three: ThreeSettings; talk: TalkSettings };

export const DEFAULT_MODE_PREFS: ModePrefs = {
  picture: { model: '', size: '1024x1024', n: 1 },
  three: { models: [], merged: true },
  talk: { voice: 'af_alloy', aloud: true },
};

export function readModePrefs(value: unknown): ModePrefs {
  const input = value as Partial<ModePrefs> | null;
  const { picture, three, talk } = DEFAULT_MODE_PREFS;
  const count = input?.picture?.n;
  const models = input?.three?.models;
  return {
    picture: {
      model: typeof input?.picture?.model === 'string' ? input.picture.model : picture.model,
      size: typeof input?.picture?.size === 'string' ? input.picture.size : picture.size,
      n: typeof count === 'number' && [1, 2, 3, 4].includes(count) ? count : picture.n,
    },
    three: {
      models: Array.isArray(models) ? models.filter((id) => typeof id === 'string').slice(0, 3) : three.models,
      merged: typeof input?.three?.merged === 'boolean' ? input.three.merged : three.merged,
    },
    talk: {
      voice: typeof input?.talk?.voice === 'string' ? input.talk.voice : talk.voice,
      aloud: typeof input?.talk?.aloud === 'boolean' ? input.talk.aloud : talk.aloud,
    },
  };
}

export const imageModels = (list: MediaModelList) =>
  list.data.filter((m): m is MediaImageModel => m.kind === 'image' && !!m.id && !!m.pricing && !!m.sizes?.length && !m.edit);

export const imageCounts = (model: MediaImageModel | null) => [1, 2, 3, 4].filter((n) => n <= (model?.max_images ?? 4));

export function reconcilePicture(choice: PictureSettings, models: readonly MediaImageModel[]): PictureSettings {
  const model = models.find((entry) => choice.model === entry.id) ?? models[0];
  if (!model) return choice;
  const counts = imageCounts(model);
  return {
    model: model.id,
    size: model.sizes.includes(choice.size) ? choice.size : model.sizes[0],
    n: counts.includes(choice.n) ? choice.n : (counts.at(-1) ?? 1),
  };
}

export const shapeOf = (size: string) => {
  const [w, h] = size.split('x').map(Number);
  const r = w / h;
  return r === 1 ? 'Square' : r >= 1.5 ? 'Wide' : r > 1 ? 'Landscape' : r <= 2 / 3 ? 'Tall' : 'Portrait';
};

export const IMAGE_PROMPT_LIMIT = 4000;

export const recordingEstimate = (rate: Atto | null, maxSeconds: number) =>
  rate === null ? null : rate * BigInt(Math.ceil(maxSeconds / 60));

export function flatEstimate(price: Atto | null): Estimate {
  return price === null ? { known: false } : { known: true, typical: price, worst: price, tokensIn: 0, typicalOut: 0, worstOut: 0 };
}

export function pictureEstimate(model: MediaImageModel | undefined, n: number) {
  const each = parseUsdAtto(model?.pricing.usd_per_image);
  return flatEstimate(each === null ? null : each * BigInt(n));
}

export function threeEstimate(question: string, settings: ThreeSettings, models: readonly ModelInfo[], demo: boolean, note: string) {
  const find = (id: string) => models.find((m) => m.id === id);
  const withNote = (text: string) => note ? [{ role: 'system' as const, content: note }, { role: 'user' as const, content: text }] : [{ role: 'user' as const, content: text }];
  const estimates = settings.models.map((id) => estimateMessage({ model: find(id), messages: withNote(question), maxTokens: ANSWER_MAX_TOKENS, demo }));
  if (settings.merged) {
    // Use the same merge wrapper and character cap even before the answers arrive.
    const messages = mergeRequest(question, settings.models.map((model, index) => ({
      label: SLOTS[index], model, content: 'x'.repeat(MERGE_ANSWER_CHARS + 1),
    })));
    if (note) messages.unshift({ role: 'system', content: note });
    estimates.push(estimateMessage({ model: find(MERGE_MODEL), messages, maxTokens: MERGE_MAX_TOKENS, demo }));
  }
  if (settings.models.length !== SLOTS.length || estimates.some((entry) => !entry.known)) return flatEstimate(null);
  return flatEstimate(estimates.reduce((total, entry) => total + (entry.known ? entry.worst : 0n), 0n));
}
export type ModeResult =
  | { mode: 'picture'; settings: PictureSettings; name: string; images?: string[]; costUsd?: string; receipt?: SpeechReceipt }
  | { mode: 'three'; settings: ThreeSettings; round: Round; mergeNote?: string }
  | { mode: 'talk'; settings: TalkSettings; speechModel: string; audioCosts: (string | null)[]; audioPending?: boolean; audioReceipts?: SpeechReceipt[] };

/** Image errors say what happened without the chat's floor wording when the gateway's own message is clearer. */
export function imageError(error: unknown): string {
  if (error instanceof AnonymoApiError && (error.code === 'explicit_media_unavailable' || error.code === 'media_blocked' || error.code === 'media_gate_unavailable' || error.code?.startsWith('upstream_')))
    return error.message;
  if (error instanceof AnonymoApiError && error.status === 404 && error.code !== 'model_not_found') return 'Images are not switched on for this gateway yet.';
  return describeError(error);
}
