// Update "auto": the Auto model (`anonymo-auto`, gateway/src/auto/plan.ts). One model id that picks a model for each
// message. The gateway reads the request (code, roleplay, reasoning, image or general), keeps the live models set up for
// that kind of request, ranks them by refusal rate over the last 30 days and then by price, and sends the request to
// the first. The reply names the model that answered, and the `x-anonymo-auto` header names the kind of request.
//
// The demo gateway (mock/gateway.ts) follows the same steps with a smaller classifier and the demo routes' counts.

import type { ChatMessage, ModelInfo } from './types.ts';

export const AUTO_MODEL = 'anonymo-auto';
export const AUTO_HEADER = 'x-anonymo-auto';
export const AUTO_CLASSES = ['code', 'roleplay', 'reasoning', 'vision', 'general'] as const;
export type AutoClass = (typeof AUTO_CLASSES)[number];

export const isAutoModel = (id: string | null | undefined): boolean => id === AUTO_MODEL;

/** The picker entry. Short plain sentences; it says what Auto does and that the answer shows the model used. */
export const AUTO_CHOICE = {
  id: AUTO_MODEL,
  name: 'Auto',
  summary: 'Picks a model for each message. Each answer shows which model replied.',
} as const;

/** How the developer docs and the picker's tooltip explain the choice. */
export const AUTO_EXPLAINER =
  'Auto reads each request to tell code, roleplay, reasoning, image and general requests apart. ' +
  'It keeps the live models set up for that kind of request. ' +
  'It ranks them by refusal rate over the last 30 days, then by price. ' +
  'The others become the fallback list. You pay the normal price of the model that answered.';

const CLASS_WORDS: Record<AutoClass, string> = { code: 'code', roleplay: 'roleplay', reasoning: 'reasoning', vision: 'image', general: 'general' };

/** The class in an `x-anonymo-auto` header, or null for anything else. */
export function autoClassOf(value: string | null | undefined): AutoClass | null {
  const v = value?.trim().toLowerCase();
  return v && (AUTO_CLASSES as readonly string[]).includes(v) ? (v as AutoClass) : null;
}

/** The answer card's tab: the model that answered, marked as an Auto pick. */
export function autoTabLabel(answeredBy: string | null | undefined): string {
  return answeredBy && !isAutoModel(answeredBy) ? `Auto · ${answeredBy}` : 'Auto';
}

/** One line under an Auto answer: which model answered and why. */
export function autoNote(answeredBy: string | null | undefined, cls: AutoClass | null): string {
  if (!answeredBy || isAutoModel(answeredBy)) return 'Auto picks a model when the reply starts.';
  return cls ? `Auto sent this ${CLASS_WORDS[cls]} request to ${answeredBy}.` : `Auto sent this request to ${answeredBy}.`;
}

// ---- demo ----------------------------------------------------------------------------------------------------------

const textOf = (content: ChatMessage['content'] | unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n')
      : '';
const hasImage = (content: unknown) =>
  Array.isArray(content) && content.some((p) => p && typeof p === 'object' && ['image_url', 'input_image', 'image'].includes(String((p as { type?: unknown }).type)));

const CODE_STRONG = /```|\bdef\s+\w+\s*\(|\bfunction\s*\w*\s*\([^)]*\)\s*\{|\bconsole\.log\(|\bTraceback \(most recent call last\)|#include\s*</;
const CODE_WEAK = [/\bcode\b/i, /\bpython\b/i, /\bjavascript\b/i, /\btypescript\b/i, /\bscript\b/i, /\bdebug/i, /\bfunction\b/i, /\bbug\b/i, /\bregex\b/i, /\bsql\b/i, /\bapi\b/i, /\bcompil/i];
const RP_SYSTEM = /\{\{\s*(?:char|user)\s*\}\}|\bin character\b|\brole-?play|\bnext reply in an? (?:fictional )?(?:chat|story)|\b(?:personality|scenario|persona)\s*:/i;
const RP_USER = /(?:^|\s)\*[^*\n]{3,80}\*(?=\s|$|[.,!?])|\blet'?s (?:role-?play|rp)\b/i;
const REASONING = /\bstep[- ]by[- ]step\b|\b(?:prove|proof|derive|equation|integral|derivative|probability|logic puzzle|riddle)\b|\d+(?:\.\d+)?\s*[*×÷^]\s*\d|\bwhat is\s+\d+(?:\.\d+)?\s*[-+*/x×÷^]\s*\d/i;

/** The demo's classifier: the gateway's order (images, code, roleplay, reasoning, general) with fewer signals. */
export function classifyDemo(messages: readonly ChatMessage[], tools = false): AutoClass {
  if (messages.some((m) => hasImage(m.content))) return 'vision';
  if (tools) return 'code';
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
  const last = textOf([...messages].reverse().find((m) => m.role === 'user')?.content);
  if (RP_SYSTEM.test(system)) return 'roleplay';
  if (CODE_STRONG.test(last) || CODE_WEAK.filter((re) => re.test(last)).length >= 2) return 'code';
  if (RP_USER.test(last)) return 'roleplay';
  if (REASONING.test(last)) return 'reasoning';
  return 'general';
}

/** Demo candidates per class: direct demo model ids (mock/fixtures.ts), in the operator's order. */
export const DEMO_AUTO_CANDIDATES: Readonly<Record<AutoClass, readonly string[]>> = {
  code: ['kimi-k2.7-code', 'deepseek-v4.1-flash-abliterated', 'gemma-4-26b-uncensored'],
  roleplay: ['dolphin-venice-24b', 'qwen3.5-27b-abliterated', 'gemma-4-26b-uncensored'],
  reasoning: ['deepseek-v4.1-flash-abliterated', 'glm-5.2-abliterated', 'qwen3.5-27b-abliterated'],
  vision: ['gemma-4-26b-uncensored'],
  general: ['dolphin-venice-24b', 'deepseek-v4.1-flash-abliterated', 'gemma-4-26b-uncensored', 'glm-5.2-abliterated'],
};

type Rankable = Pick<ModelInfo, 'id' | 'refusal_rate_30d' | 'attested' | 'architecture'> & { price?: number };

/**
 * The gateway's ranking on demo data: refusal rate in whole percentage points (unknown last), then price, then the
 * listed order. Sealed keeps only attested models; an image request only models that read images. Deterministic.
 */
export function rankAuto(cls: AutoClass, models: readonly Rankable[], o: { sealed?: boolean; candidates?: Readonly<Record<AutoClass, readonly string[]>> } = {}): string[] {
  const list = (o.candidates ?? DEMO_AUTO_CANDIDATES)[cls];
  const rows = list
    .map((id, index) => ({ m: models.find((x) => x.id === id), index }))
    .filter((x): x is { m: Rankable; index: number } => !!x.m)
    .filter(({ m }) => (!o.sealed || m.attested === true) && (cls !== 'vision' || (m.architecture?.input_modalities ?? []).includes('image')));
  const bucket = (r: number | null | undefined) => (typeof r === 'number' ? Math.round(r * 100) : Number.POSITIVE_INFINITY);
  rows.sort((a, b) => bucket(a.m.refusal_rate_30d) - bucket(b.m.refusal_rate_30d) || (a.m.price ?? 0) - (b.m.price ?? 0) || a.index - b.index);
  return rows.map(({ m }) => m.id);
}

/** The demo's `anonymo-auto` entry in `GET /v1/models`. */
export const DEMO_AUTO_MODEL_INFO = {
  id: AUTO_MODEL,
  name: 'Anonymo Auto',
  description: AUTO_EXPLAINER,
  context_length: 65536,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  family: null,
  quant: null,
  weights_hash: null,
  attested: true,
  refusal_rate_30d: null,
} satisfies ModelInfo;
