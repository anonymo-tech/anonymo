// Update "voice" (Night Call): the parts of a voice call that are plain logic, so they can be checked without a
// browser. Cutting a streamed reply into sentences to speak, what a stock voice costs, the sleep timer, which of this
// device's voices are safe to offer, and the caption line. Nothing here touches the network, the microphone or storage.
//
// Two rules the rest of the feature leans on:
//   - Speech in stays on the device. The browser's recogniser is used only when it can be forced to run locally
//     (`processLocally`); otherwise the call uses a text box. `onDeviceSupport` and `listeningAfter` decide that.
//   - Speech out is either a stock voice from the gateway (paid, priced per 1,000 characters) or one of this device's
//     own voices (`localService === true`, free, no text leaves the device). `localVoices` is that filter.

import { recapContext } from './catchup.ts';
import { formatUsd, MUSD_PER_USD, usdToMusd } from './money.ts';
import type { ChatMessage, MicroUsd } from './types.ts';

// ---- Sentences, as the reply streams ---------------------------------------------------------------------------------

/** A piece is spoken once it is this long, so "Oh." is not a request of its own. */
export const MIN_PIECE = 12;
/** With no sentence end in sight, a piece is cut at a clause or a word gap by this length. */
export const MAX_PIECE = 280;

const TERMINATORS = '.!?…';
const CLOSERS = '"\'”’)]»*_';
const CLAUSE_MARKS = ',;:—–';
/** A full stop after one of these does not end the sentence. */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'fig', 'approx', 'inc', 'ltd']);

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** Whether the full stop at `dot` closes an abbreviation, an initial or a list number rather than a sentence. */
function closesAbbreviation(text: string, start: number, dot: number): boolean {
  let from = dot;
  while (from > start && !isSpace(text[from - 1])) from--;
  const word = text.slice(from, dot).replace(/^[("'“‘[]+/, '');
  if (!word) return false;
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  if (/^\p{Lu}$/u.test(word)) return true; // an initial: "J. R."
  // "1." at the start of a line is a list number, not the end of a sentence.
  return /^\d{1,3}$/.test(word) && (from === start || text[from - 1] === '\n');
}

/** Where the next piece ends (exclusive), or -1 when the text so far has to wait for more. */
function nextCut(text: string, start: number, min: number, max: number, flush: boolean): number {
  const limit = Math.min(text.length, start + max);
  let i = start;
  while (i < limit) {
    const ch = text[i];
    if (ch === '\n') {
      let end = i + 1;
      while (end < text.length && isSpace(text[end])) end++;
      if (end - start >= min) return end;
      i = end;
      continue;
    }
    if (TERMINATORS.includes(ch)) {
      let after = i + 1;
      while (after < text.length && TERMINATORS.includes(text[after])) after++;
      const single = ch === '.' && after === i + 1;
      while (after < text.length && CLOSERS.includes(text[after])) after++;
      // A sentence ends only once white space follows it: "3.14" and a full stop still waiting for its next
      // character are left alone.
      if (isSpace(text[after]) && !(single && closesAbbreviation(text, start, i))) {
        let end = after;
        while (end < text.length && isSpace(text[end])) end++;
        if (end - start >= min) return end;
        i = end;
        continue;
      }
      i = after;
      continue;
    }
    i++;
  }
  // No sentence end in the window. Short of `max` the text waits for more, or goes out whole at the end of the reply.
  if (text.length - start <= max) return flush && text.length > start ? text.length : -1;
  for (let j = limit; j > start + Math.floor(max / 2); j--) {
    if (CLAUSE_MARKS.includes(text[j - 1]) && isSpace(text[j])) {
      let end = j;
      while (end < text.length && isSpace(text[end])) end++;
      return end;
    }
  }
  for (let j = limit; j > start + 1; j--) if (isSpace(text[j - 1]) && !isSpace(text[j])) return j;
  // One unbroken run: cut mid-word, but never between the two halves of a surrogate pair.
  const high = text.charCodeAt(limit - 1);
  if (high >= 0xd800 && high <= 0xdbff) return limit - 1 > start ? limit - 1 : limit + 1;
  return limit;
}

export type Split = { pieces: string[]; rest: string };

/**
 * Cuts the text received so far into pieces that are ready to be spoken, and the remainder still being written.
 * It only slices: the pieces followed by `rest` are always exactly the input, so nothing is dropped or said twice.
 * With `flush` (the reply has ended) the remainder goes out as the last piece.
 */
export function splitSentences(text: string, opts: { flush?: boolean; min?: number; max?: number } = {}): Split {
  const max = Math.max(1, Math.floor(opts.max ?? MAX_PIECE));
  const min = Math.max(0, Math.min(Math.floor(opts.min ?? MIN_PIECE), max));
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = nextCut(text, start, min, max, opts.flush === true);
    if (end === -1) break;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return { pieces, rest: text.slice(start) };
}

/** Feeds a stream: `push` each piece of text as it arrives and speak what comes back; `end` gives the tail. */
export function sentenceFeed(opts: { min?: number; max?: number } = {}) {
  let rest = '';
  return {
    push(delta: string): string[] {
      const split = splitSentences(rest + delta, opts);
      rest = split.rest;
      return split.pieces;
    },
    end(): string[] {
      const split = splitSentences(rest, { ...opts, flush: true });
      rest = '';
      return split.pieces;
    },
    pending: () => rest,
  };
}

/**
 * What is said aloud for a piece: links become their text, addresses, emphasis marks, list bullets and pictographs are
 * dropped, white space is single. A piece with nothing left to say (a rule, a lone emoji) comes back empty.
 */
export function speakable(text: string): string {
  const clean = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+•])\s+/gm, '')
    .replace(/[*_~`#|]+/g, '')
    .replace(/\p{Extended_Pictographic}|\u200d|\ufe0f/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean : '';
}

// ---- Captions ---------------------------------------------------------------------------------------------------------

export type CaptionLine = { text: string; start: number };

/** Breaks what is being said into caption lines of at most `max` characters, at word gaps. */
export function captionLines(sentence: string, max = 64): CaptionLine[] {
  const lines: CaptionLine[] = [];
  const words = sentence.match(/\S+/g) ?? [];
  let line = '';
  let start = 0;
  let at = 0;
  for (const word of words) {
    const index = sentence.indexOf(word, at);
    at = index + word.length;
    if (line && line.length + 1 + word.length > max) {
      lines.push({ text: line, start });
      line = '';
    }
    if (!line) start = index;
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push({ text: line, start });
  return lines;
}

/** The caption line that holds the character being spoken. */
export function captionAt(lines: readonly CaptionLine[], charIndex: number): string {
  let current = lines[0]?.text ?? '';
  for (const line of lines) {
    if (line.start > charIndex) break;
    current = line.text;
  }
  return current;
}

// ---- What a stock voice costs ----------------------------------------------------------------------------------------

/** About 150 spoken words a minute at an even pace, spaces and punctuation included. */
export const CHARS_PER_MINUTE = 900;

export const PACES = [
  { id: 'calm', label: 'Calm', speed: 0.9 },
  { id: 'even', label: 'Even', speed: 1 },
  { id: 'brisk', label: 'Brisk', speed: 1.15 },
] as const;
export type PaceId = (typeof PACES)[number]['id'];
export const paceSpeed = (id: PaceId) => PACES.find((p) => p.id === id)?.speed ?? 1;

/**
 * What speaking `chars` characters costs in micro-USD. The gateway prices speech per 1,000 characters of input and
 * rounds up (gateway/src/anonymo/media/routes.ts `speechPrice`), so this rounds up too.
 */
export function speechCostMusd(usdPer1kChars: string | number, chars: number): MicroUsd {
  const per1k = usdToMusd(usdPer1kChars);
  if (!Number.isSafeInteger(per1k) || per1k < 0 || !Number.isSafeInteger(chars) || chars < 0) return Number.NaN;
  return Math.ceil((per1k * chars) / 1000);
}

/** Micro-USD for one minute of speech: the characters spoken in a minute at this pace, at the price per character. */
export function speechMusdPerMinute(usdPer1kChars: string | number, speed = 1): MicroUsd {
  if (!Number.isFinite(speed) || speed <= 0) return Number.NaN;
  return speechCostMusd(usdPer1kChars, Math.round(CHARS_PER_MINUTE * speed));
}

/** Small prices in cents: "1.4¢", "0.05¢", "12.5¢". A dollar or more is shown as dollars. */
export function formatCents(musd: MicroUsd): string {
  if (!Number.isSafeInteger(musd)) return '—';
  const abs = Math.abs(musd);
  const sign = musd < 0 ? '−' : '';
  if (abs >= MUSD_PER_USD) return formatUsd(musd);
  if (abs === 0) return '0¢';
  if (abs < 50) return `${sign}<0.01¢`;
  if (abs < 9950) {
    const hundredths = Math.round(abs / 100);
    return `${sign}0.${String(hundredths).padStart(2, '0').replace(/(\d)0$/, '$1')}¢`;
  }
  const tenths = Math.round(abs / 1000);
  if (tenths >= 1000) return formatUsd(musd);
  return `${sign}${Math.floor(tenths / 10)}${tenths % 10 ? `.${tenths % 10}` : ''}¢`;
}

/** What one call has cost so far: the voice (per clip) and the model's replies (from their receipts). */
export type CallCost = { voiceMusd: MicroUsd; replyMusd: MicroUsd; clips: number; chars: number; replies: number };
export const NO_COST: CallCost = { voiceMusd: 0, replyMusd: 0, clips: 0, chars: 0, replies: 0 };

const known = (musd: MicroUsd) => (Number.isSafeInteger(musd) && musd > 0 ? musd : 0);

export const addClip = (cost: CallCost, musd: MicroUsd, chars: number): CallCost => ({
  ...cost,
  voiceMusd: cost.voiceMusd + known(musd),
  clips: cost.clips + 1,
  chars: cost.chars + (Number.isSafeInteger(chars) && chars > 0 ? chars : 0),
});
export const addReply = (cost: CallCost, musd: MicroUsd): CallCost => ({ ...cost, replyMusd: cost.replyMusd + known(musd), replies: cost.replies + 1 });
export const totalMusd = (cost: CallCost): MicroUsd => cost.voiceMusd + cost.replyMusd;

/** "4:07" for a call or a timer; an hour or more is "1:02:07". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ---- WAV -------------------------------------------------------------------------------------------------------------

export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; frames: number; seconds: number };

/** Reads a RIFF/WAVE header. Null for anything that is not a WAV file with samples in it. */
export function wavInfo(input: ArrayBuffer | Uint8Array): WavInfo | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let format: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bitsPerSample: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!format) return null;
      const frameBytes = (format.channels * format.bitsPerSample) / 8;
      if (!frameBytes || !Number.isInteger(frameBytes) || !format.sampleRate) return null;
      // A streamed file may state a length it did not know: count the samples that are really there.
      const frames = Math.floor(Math.min(size, bytes.length - body) / frameBytes);
      return frames > 0 ? { ...format, frames, seconds: frames / format.sampleRate } : null;
    }
    at = body + size + (size % 2);
  }
  return null;
}

// ---- Stock voices ----------------------------------------------------------------------------------------------------

const ACCENTS: Record<string, string> = {
  a: 'American English',
  b: 'British English',
  j: 'Japanese',
  z: 'Mandarin',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  p: 'Portuguese',
};

const titled = (id: string) => id.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase()).trim();

/** A readable label for a stock voice id: "af_heart" is "Heart", in American English. Unknown shapes keep their id. */
export function stockVoiceLabel(id: string): { name: string; note: string | null } {
  const coded = /^([abjzefhip])([fm])_([a-z0-9]+)$/.exec(id);
  if (coded) return { name: titled(coded[3]), note: ACCENTS[coded[1]] };
  const prefixed = /^(?:vox|cb)-([a-z0-9]+)$/.exec(id);
  return { name: titled(prefixed ? prefixed[1] : id) || id, note: null };
}

// ---- This device's voices --------------------------------------------------------------------------------------------

export type VoiceLike = { name: string; lang: string; localService: boolean; voiceURI: string; default?: boolean };

const baseLang = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];

/**
 * The voices this device speaks itself. `localService` has to be exactly true: a voice that is spoken by a remote
 * service would send the reply's text off the device, so it is never offered. Voices in the person's language come
 * first, the system default before the rest.
 */
export function localVoices<T extends VoiceLike>(voices: readonly T[], lang = 'en'): T[] {
  const seen = new Set<string>();
  const mine = baseLang(lang);
  const rank = (v: T) => (baseLang(v.lang) === mine ? 0 : 2) + (v.default ? 0 : 1);
  return voices
    .filter((v) => {
      if (!v || v.localService !== true || !v.voiceURI || !v.name || seen.has(v.voiceURI)) return false;
      seen.add(v.voiceURI);
      return true;
    })
    .map((v, i) => ({ v, i }))
    .sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)
    .map(({ v }) => v);
}

/** How many of the listed voices are in the person's language (the rest sit under "More languages"). */
export const inLanguage = (voices: readonly VoiceLike[], lang = 'en') => voices.filter((v) => baseLang(v.lang) === baseLang(lang)).length;

// ---- Listening on the device -----------------------------------------------------------------------------------------

/** What `SpeechRecognition.available()` resolves to (Web Speech API), plus `unsupported` when the API is missing. */
export type OnDeviceStatus = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

/**
 * Whether a browser's recogniser can be held to this device. It needs all three: the `processLocally` switch on a
 * recogniser, and the static `available()` and `install()` that say whether the language pack is on the device.
 * A recogniser without them may send audio to a server, so it is treated as no recogniser at all.
 */
export function onDeviceSupport(ctor: unknown): boolean {
  if (typeof ctor !== 'function') return false;
  const c = ctor as { available?: unknown; install?: unknown; prototype?: object };
  return typeof c.available === 'function' && typeof c.install === 'function' && !!c.prototype && 'processLocally' in c.prototype;
}

/** Anything the browser answers that is not a known status counts as unavailable. */
export function onDeviceStatus(answer: unknown): OnDeviceStatus {
  return answer === 'available' || answer === 'downloadable' || answer === 'downloading' ? answer : 'unavailable';
}

/** Why the call shows a text box, in plain words. Null when the microphone can be used. */
export function textBoxReason(status: OnDeviceStatus, lang: string): string | null {
  switch (status) {
    case 'available':
      return null;
    case 'unsupported':
      return 'This browser can’t turn speech into text on the device, so type instead. Anonymo never sends your voice to a cloud recogniser.';
    case 'unavailable':
      return `This browser has no on-device speech pack for ${lang}, so type instead. Anonymo never sends your voice to a cloud recogniser.`;
    case 'downloading':
      return 'Your browser is still downloading its on-device speech pack. Type until it is ready.';
    case 'downloadable':
      return 'On-device listening is not set up in this browser yet. Type, or set it up before you call.';
  }
}

// ---- Sleep timer ("Read me to sleep") --------------------------------------------------------------------------------

/** Minutes offered. 0 is off. */
export const SLEEP_MINUTES = [0, 10, 20, 30, 45] as const;
export const STORY_MINUTES = 20;
/** How long the screen takes to dim once the voice has stopped. */
export const FADE_MS = 4000;
/** A sentence that never reports its end is not waited for longer than this. */
export const FINISH_LIMIT_MS = 30_000;
export const SLEEP_FAREWELL = 'Thank you. Sleep well.';

export type SleepState =
  | { phase: 'off' }
  | { phase: 'running'; minutes: number; endsAt: number }
  | { phase: 'finishing'; minutes: number; since: number } // time is up: the sentence being said ends, nothing new starts
  | { phase: 'fading'; minutes: number; until: number } // the voice has stopped and the screen dims
  | { phase: 'done'; minutes: number }; // the farewell is on screen and the call has ended

export type SleepEvent =
  | { type: 'set'; minutes: number; now: number }
  | { type: 'tick'; now: number; speaking: boolean }
  | { type: 'sentence-end'; now: number }
  | { type: 'cancel' };

export const SLEEP_OFF: SleepState = { phase: 'off' };

/**
 * The sleep timer. Running until its time is up; then the sentence being spoken is allowed to finish (`finishing`),
 * the screen dims (`fading`) and the call ends on the farewell (`done`). Setting it again before the farewell starts
 * the count over; once the farewell is showing the call is over and only `cancel` leaves it.
 */
export function sleepStep(state: SleepState, event: SleepEvent): SleepState {
  switch (event.type) {
    case 'cancel':
      return SLEEP_OFF;
    case 'set': {
      if (state.phase === 'done') return state;
      const minutes = Number.isFinite(event.minutes) ? Math.max(0, Math.floor(event.minutes)) : 0;
      return minutes ? { phase: 'running', minutes, endsAt: event.now + minutes * 60_000 } : SLEEP_OFF;
    }
    case 'tick':
      if (state.phase === 'running' && event.now >= state.endsAt)
        return event.speaking ? { phase: 'finishing', minutes: state.minutes, since: event.now } : { phase: 'fading', minutes: state.minutes, until: event.now + FADE_MS };
      if (state.phase === 'finishing' && (!event.speaking || event.now - state.since >= FINISH_LIMIT_MS))
        return { phase: 'fading', minutes: state.minutes, until: event.now + FADE_MS };
      if (state.phase === 'fading' && event.now >= state.until) return { phase: 'done', minutes: state.minutes };
      return state;
    case 'sentence-end':
      if (state.phase === 'finishing' || (state.phase === 'running' && event.now >= state.endsAt))
        return { phase: 'fading', minutes: state.minutes, until: event.now + FADE_MS };
      return state;
  }
}

/** Whether anything new may be said or sent: not once the timer has run out. */
export const sleepAllowsSpeech = (state: SleepState) => state.phase === 'off' || state.phase === 'running';
/** Milliseconds left on a running timer, else 0. */
export const sleepRemaining = (state: SleepState, now: number) => (state.phase === 'running' ? Math.max(0, state.endsAt - now) : 0);

// ---- The device voice, drawn ------------------------------------------------------------------------------------------

/**
 * Loudness from 0 to 1 for a device voice. Its audio never passes through the page, so it cannot be measured; this
 * draws a speech-shaped swell instead: a syllable rhythm that lifts on each word the browser reports.
 */
export function drawnLevel(msSinceStart: number, msSinceWord: number): number {
  if (!Number.isFinite(msSinceStart) || msSinceStart < 0) return 0;
  const word = Number.isFinite(msSinceWord) && msSinceWord >= 0 ? Math.exp(-msSinceWord / 240) : 0.45;
  const syllable = Math.abs(Math.sin((msSinceStart / 118) * Math.PI));
  const breath = 0.75 + 0.25 * Math.sin(msSinceStart / 530);
  return Math.min(1, Math.max(0, 0.16 + 0.42 * word + 0.3 * syllable * breath));
}

// ---- The thread, exactly as chat sends it ----------------------------------------------------------------------------

export type ThreadTurn = { status: string; prompt: string; content: string; recap?: boolean };

/**
 * The conversation so far as chat messages, built the way the chat page builds it (chat-workspace.tsx `history`):
 * finished and stopped turns only, and a recap turn (update "catchup") as context rather than something said.
 */
export function threadMessages(turns: readonly ThreadTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    if (t.status !== 'done' && t.status !== 'stopped') continue;
    if (t.recap) {
      if (t.content) out.push(...recapContext(t.content));
      continue;
    }
    out.push({ role: 'user', content: t.prompt });
    if (t.content) out.push({ role: 'assistant', content: t.content });
  }
  return out;
}

// ---- Words the call sends ---------------------------------------------------------------------------------------------

/** The bedtime starter. It is an ordinary message: it shows in the thread like anything else the person says. */
export const STORY_PROMPT = 'Tell me a calm bedtime story in a soft, slow voice. Keep it gentle, with nothing to solve, and let it wind down as it goes.';
/** Sent when "keep reading" is on and the last part has been read out before the timer ends. */
export const STORY_CONTINUE = 'Keep reading in the same calm voice. Pick the story up exactly where it stopped.';
/** What a voice's "Hear it" says. */
export const VOICE_SAMPLE = 'Hello. I am here, and I am listening.';
