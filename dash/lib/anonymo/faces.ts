// Update "faces": a face for each character that changes with the mood of the reply, and the Stage (a chat shown as a
// scene with a painted backdrop). This file is the logic with no browser APIs in it, so the dash checks can run it:
// which mood a reply is in, what is asked of the chat model and of the image model, and how one sheet becomes six faces.
//
// One image holds all six faces (a 3 by 2 "expression sheet"), so they are the same person in every mood without a
// reference-image model. The browser cuts it into tiles (faces-image.ts) and keeps them on this device (faces-store.ts).
//
// The image model only ever sees one short sentence: the "look" for faces, the "scene" for a backdrop. The person can
// read and edit that sentence before anything is painted, and nothing from a chat reaches the image model any other way.
// Images are safe for work only (gateway src/anonymo/media): the prompts say so in words the gateway's own word rules
// accept, because those rules refuse a prompt that so much as names what it must not show.

import { applyMacros, type CharacterCard } from './card.ts';
import type { ChatMessage } from './types.ts';

// ---- the six faces ---------------------------------------------------------------------------------------------------

/** The moods a face can show, in the order they sit on the sheet: top row left to right, then the bottom row. */
export const EXPRESSIONS = ['calm', 'happy', 'sad', 'angry', 'surprised', 'tender'] as const;
export type Expression = (typeof EXPRESSIONS)[number];
export const isExpression = (v: unknown): v is Expression => typeof v === 'string' && (EXPRESSIONS as readonly string[]).includes(v);
export const EXPRESSION_LABEL: Record<Expression, string> = { calm: 'Calm', happy: 'Happy', sad: 'Sad', angry: 'Angry', surprised: 'Surprised', tender: 'Tender' };

export const SHEET_COLS = 3;
export const SHEET_ROWS = 2;
/** The sheet is three panels wide and two tall, so a 3:2 image gives square faces. */
export const SHEET_RATIO = SHEET_COLS / SHEET_ROWS;
/** A backdrop wants the widest shape a model offers. */
export const SCENE_RATIO = 16 / 9;

// ---- mood ------------------------------------------------------------------------------------------------------------

/** How far back a reply is read for its mood, in characters, and how much one word counts at each distance. */
export const MOOD_WINDOW = 900;
/** A mood needs more than this to replace calm: one telling word in the last three quarters of the window is enough. */
export const MOOD_THRESHOLD = 0.25;

const MOOD_WORDS: Record<Exclude<Expression, 'calm'>, RegExp> = {
  happy:
    /\b(?:smil(?:e|es|ed|ing)|grin(?:s|ned|ning)?|laugh(?:s|ed|ing|ter)?|chuckl(?:e|es|ed|ing)|giggl(?:e|es|ed|ing)|beam(?:s|ed|ing)?|cheer(?:s|ed|ful|fully)?|delight(?:s|ed)?|glad|happy|happily|joy(?:ful|fully)?|ha(?:ha)+|he(?:he)+|lol|wink(?:s|ed|ing)?)\b|[😀😁😂😃😄😅😆😊🙂😉🤣😸]/gu,
  sad: /\b(?:sigh(?:s|ed|ing)?|tear(?:s|ful|fully)?|cr(?:y|ies|ied|ying)|sob(?:s|bed|bing)?|weep(?:s|ing)?|wept|frown(?:s|ed|ing)?|sorrow(?:ful)?|grie(?:f|ve|ves|ved|ving)|lonely|sorry|heartbroken|mourn(?:s|ed|ing)?|sad(?:ly|ness)?|miss(?:ed|ing)? (?:you|her|him|them))\b|[😢😭😞😔🥺💔]/gu,
  angry:
    /\b(?:glar(?:e|es|ed|ing)|scowl(?:s|ed|ing)?|snarl(?:s|ed|ing)?|growl(?:s|ed|ing)?|snap(?:s|ped|ping)?|furious(?:ly)?|angr(?:y|ily)|rage|enraged|seeth(?:e|es|ed|ing)|clench(?:es|ed|ing)?|grit(?:s|ted|ting)?|shout(?:s|ed|ing)?|yell(?:s|ed|ing)?|how dare|slam(?:s|med|ming)?|fum(?:e|es|ed|ing))\b|[😠😡🤬]/gu,
  surprised:
    /\b(?:gasp(?:s|ed|ing)?|blink(?:s|ed|ing)?|startl(?:e|es|ed|ing)|stunned|shock(?:ed)?|wide-eyed|eyes (?:widen|go wide|went wide)|jaw drops?|astonish(?:ed|ment)|speechless|disbelief|no way)\b|\?!|!\?|[😲😮😯😳🤯]/gu,
  tender:
    /\b(?:blush(?:es|ed|ing)?|softly|soften(?:s|ed|ing)?|gentl[ey]|warm(?:ly|th)?|tender(?:ly)?|caress(?:es|ed|ing)?|embrac(?:e|es|ed|ing)|hug(?:s|ged|ging)?|kiss(?:es|ed|ing)?|shy(?:ly)?|fond(?:ly)?|affection(?:ate|ately)?|darling|sweetheart|my love)\b|[❤💕💖💗💞🥰😘😍]/gu,
};
const MOODS = Object.keys(MOOD_WORDS) as Exclude<Expression, 'calm'>[];

/**
 * The mood of a reply, read on this device from its words and emoji (no model is asked). Each telling word counts for
 * more the nearer it is to the end, so the face follows the reply as it streams and settles on how it ends. Nothing
 * telling within reach means calm. It does not understand "not smiling"; the labels on the faces can be changed instead.
 */
export function moodOf(text: string): Expression {
  const tail = text.slice(-MOOD_WINDOW).toLowerCase();
  if (!tail.trim()) return 'calm';
  let best: Expression = 'calm';
  let bestScore = MOOD_THRESHOLD;
  let bestAt = -1;
  for (const mood of MOODS) {
    let score = 0;
    let last = -1;
    for (const hit of tail.matchAll(MOOD_WORDS[mood])) {
      score += 1 - (tail.length - hit.index) / (MOOD_WINDOW + 1);
      last = hit.index;
    }
    if (score > bestScore || (score === bestScore && last > bestAt && last >= 0 && best !== 'calm')) {
      best = mood;
      bestScore = score;
      bestAt = last;
    }
  }
  return best;
}

// ---- what is asked of the chat model ---------------------------------------------------------------------------------

/** The model that writes the look and the scene: the default one, which is always live. */
export const HELPER_MODEL = 'anonymo-1';
export const HELPER_MAX_TOKENS = 160;
export const LOOK_MAX = 400;
export const SCENE_MAX = 300;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The request ends with this, so the answer is one sentence a painter could work from. */
export const LOOK_INSTRUCTION = [
  'Describe how this character looks, for a portrait painter, in one sentence of at most 60 words.',
  'Say only what can be seen: that they are an adult and roughly how old, hair, eyes, skin, build, what they wear, and one detail that makes them easy to recognise.',
  'They are an adult and fully dressed. Leave out anything sexual. Do not use their name, and do not name any real person, brand or artwork.',
  'Write the sentence only, with nothing before or after it.',
].join(' ');

/** Asks for a character's look from their card. The card text is cut short: a look needs the description, not the lore. */
export function lookRequest(card: CharacterCard): ChatMessage[] {
  const d = card.data;
  const names = { char: d.nickname || d.name, user: 'the other person' };
  const part = (label: string, text: string, max: number) => (text.trim() ? `${label}: ${clip(applyMacros(text, names).trim(), max)}` : '');
  const about = [`Name: ${names.char}`, part('Description', d.description, 3000), part('Personality', d.personality, 600), part('Scenario', d.scenario, 600)].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: 'You write short, plain visual descriptions of fictional adult characters for an illustrator.' },
    { role: 'user', content: `${about}\n\n${LOOK_INSTRUCTION}` },
  ];
}

export const SCENE_INSTRUCTION = [
  'Describe the place where this scene is happening right now, for a backdrop painter, in one sentence of at most 40 words.',
  'Say only what the place looks like: where it is, the time of day, the light and the weather.',
  'No people, no characters, no actions and no dialogue. Leave out anything sexual or gory.',
  'If the place is not clear, describe a quiet room that fits the mood.',
  'Write the sentence only, with nothing before or after it.',
].join(' ');

/**
 * Asks where a chat is taking place, from its last few messages (and the card's scenario and greeting when the chat
 * has not started). The messages are cut short, so this stays a small request.
 */
export function sceneRequest(thread: ChatMessage[], card?: CharacterCard | null): ChatMessage[] {
  const said = thread.filter((m) => m.role !== 'system' && m.content.trim()).slice(-6);
  const lines = said.map((m) => `${m.role === 'user' ? 'Person' : 'Character'}: ${clip(m.content.trim(), 700)}`);
  if (card) {
    const d = card.data;
    const names = { char: d.nickname || d.name, user: 'the other person' };
    if (d.scenario.trim()) lines.unshift(`Scenario: ${clip(applyMacros(d.scenario, names).trim(), 600)}`);
    if (!said.length && d.first_mes.trim()) lines.push(`Character: ${clip(applyMacros(d.first_mes, names).trim(), 700)}`);
  }
  return [
    { role: 'system', content: 'You write short, plain descriptions of places for a backdrop painter.' },
    { role: 'user', content: `${lines.join('\n\n') || 'The chat has not started yet.'}\n\n${SCENE_INSTRUCTION}` },
  ];
}

/** One clean sentence out of a model's answer: no quotes, labels, asterisks or line breaks, and not too long. */
export function tidySentence(text: string, max: number): string {
  let s = text.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:look|appearance|scene|setting|description)\s*:\s*/i, '');
  s = s.replace(/^["'“”‘’*_`\s]+|["'“”‘’*_`\s]+$/g, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).replace(/[\s,;:]+$/, '')}…`;
}

// ---- what is asked of the image model --------------------------------------------------------------------------------

export const FACE_STYLES = [
  { id: 'plush', label: 'Anonymo plush', prompt: 'hand-sewn Anonymo mascot, round felt head, plum sleep mask with gold embroidered eyes, stitched mouth, character-specific clothes and accessories, textile studio photography' },
  { id: 'painted', label: 'Painted', prompt: 'painterly digital illustration, soft brushwork, warm rim light' },
  { id: 'anime', label: 'Anime', prompt: 'clean anime illustration, crisp line art, soft cel shading' },
  { id: 'photo', label: 'Photo', prompt: 'realistic studio portrait photograph, soft key light, shallow depth of field' },
] as const;
export type FaceStyle = (typeof FACE_STYLES)[number]['id'];
export const isFaceStyle = (v: unknown): v is FaceStyle => FACE_STYLES.some((s) => s.id === v);
const styleWords = (style: FaceStyle) => (FACE_STYLES.find((s) => s.id === style) ?? FACE_STYLES[0]).prompt;

/** Every face prompt starts with this; the demo gateway knows a sheet by it. */
export const SHEET_MARK = 'Character expression sheet';
/** Said in every face prompt. Worded so the gateway's word rules pass it: they refuse a prompt that names what to leave out. */
export const SAFE_PERSON = 'The person is an adult and fully clothed. Safe for work.';
/** Said in every backdrop prompt. */
export const SAFE_PLACE = 'An empty place with no people in it. Safe for work.';

const HOW_THEY_LOOK: Record<Expression, string> = {
  calm: 'calm, with a neutral face',
  happy: 'happy, smiling warmly',
  sad: 'sad, with lowered eyes',
  angry: 'angry, with brows drawn down',
  surprised: 'surprised, with wide eyes',
  tender: 'tender, with a soft, fond smile',
};

/** The prompt for the six faces of one person, from their look. */
export function sheetPrompt(look: string, style: FaceStyle): string {
  const row = (from: number) => EXPRESSIONS.slice(from, from + SHEET_COLS).map((e) => HOW_THEY_LOOK[e]).join('; ');
  return [
    `${SHEET_MARK}: one image divided into six equal panels, three across and two down, with no gaps, borders, text or labels.`,
    'Every panel shows the same person, with the same face, hair and outfit, from the shoulders up, centred and facing the viewer, on the same plain dark plum background.',
    `Only the expression changes. Top row, left to right: ${row(0)}. Bottom row, left to right: ${row(SHEET_COLS)}.`,
    `The person: ${tidySentence(look, LOOK_MAX)}`,
    `Style: ${styleWords(style)}.`,
    SAFE_PERSON,
  ].join(' ');
}

/** The prompt for a backdrop, from the scene sentence. */
export function scenePrompt(scene: string, style: FaceStyle): string {
  return [
    `Wide establishing shot of a place, as the backdrop of a scene: ${tidySentence(scene, SCENE_MAX)}`,
    `Style: ${style === 'plush' ? 'handcrafted miniature felt set, soft lamplight, tactile stitched scenery' : style === 'photo' ? 'cinematic photograph, soft atmospheric light' : `${styleWords(style)}, atmospheric, a little out of focus`}.`,
    'The lower third is darker and calmer, so words can sit over it. No text.',
    SAFE_PLACE,
  ].join(' ');
}

// ---- sizes and tiles -------------------------------------------------------------------------------------------------

const parseSize = (size: string) => {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  return m ? { size, w: Number(m[1]), h: Number(m[2]) } : null;
};

/** The size a model offers whose shape is nearest to `ratio` (width over height); between equals, the larger one. */
export function pickSize(sizes: readonly string[], ratio: number): string {
  let best: { size: string; off: number; area: number } | null = null;
  for (const s of sizes) {
    const p = parseSize(s);
    if (!p) continue;
    const off = Math.abs(Math.log(p.w / p.h / ratio));
    const area = p.w * p.h;
    if (!best || off < best.off - 1e-9 || (Math.abs(off - best.off) <= 1e-9 && area > best.area)) best = { size: p.size, off, area };
  }
  return best?.size ?? sizes[0] ?? '1024x1024';
}

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Where the six faces are on a sheet of this size: equal panels, row by row. `inset` trims that share of a panel's
 * shorter side from every edge, which drops the thin line a model sometimes draws between panels.
 */
export function tileRects(width: number, height: number, cols = SHEET_COLS, rows = SHEET_ROWS, inset = 0.03): Rect[] {
  const out: Rect[] = [];
  const edge = (i: number, n: number, total: number) => Math.round((i * total) / n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = edge(c, cols, width), x1 = edge(c + 1, cols, width);
      const y0 = edge(r, rows, height), y1 = edge(r + 1, rows, height);
      const trim = Math.max(0, Math.min(Math.floor(Math.min(x1 - x0, y1 - y0) * inset), Math.floor((Math.min(x1 - x0, y1 - y0) - 1) / 2)));
      out.push({ x: x0 + trim, y: y0 + trim, w: Math.max(1, x1 - x0 - 2 * trim), h: Math.max(1, y1 - y0 - 2 * trim) });
    }
  }
  return out;
}

/** The labels a freshly cut sheet starts with: the order the prompt asked for. */
export const defaultLabels = (): Expression[] => [...EXPRESSIONS];

/** Which tile shows a mood: the one labelled with it, else the calm one, else the first. -1 when there are none. */
export function tileFor(labels: readonly Expression[], mood: Expression): number {
  if (!labels.length) return -1;
  const at = labels.indexOf(mood);
  if (at >= 0) return at;
  const calm = labels.indexOf('calm');
  return calm >= 0 ? calm : 0;
}
