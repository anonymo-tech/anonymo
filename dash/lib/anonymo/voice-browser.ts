// Update "voice" (Night Call), the browser side: saying a reply sentence by sentence (one of this device's voices
// through speechSynthesis, or a stock voice fetched from the gateway and played through Web Audio), the loudness and
// waveform the call screen draws, and listening (on-device speech recognition only, plus a microphone meter).
//
// What leaves the device. With a stock voice, each sentence of the reply goes to the gateway's POST /v1/audio/speech,
// an ordinary gateway call. With a device voice, nothing: a voice is used only when its `localService` is true, and
// with no such voice the reply is shown as captions instead of being handed to whatever the browser's default voice
// is. Microphone audio never leaves in either case: the meter reads levels and throws them away, and the recogniser
// is started only with `processLocally` set and read back as set. There is no cloud recogniser fallback anywhere.

import type { SpeechReceipt, SpeechRequest, SpeechResult } from './types.ts';
import { drawnLevel, onDeviceStatus, onDeviceSupport, wavInfo, type OnDeviceStatus } from './voice.ts';

// ---- One audio context for the page ----------------------------------------------------------------------------------

let shared: AudioContext | null = null;

/** The page's audio context, made on first use (which must be inside a click). Null where Web Audio is missing. */
export function audioContext(): AudioContext | null {
  if (shared) return shared;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    shared = null;
  }
  return shared;
}

/** Call inside a click: browsers keep audio suspended until the person has acted. */
export function unlockAudio() {
  const context = audioContext();
  if (context?.state === 'suspended') void context.resume().catch(() => undefined);
}

/** Lets the audio device go once nothing is playing or listening. */
export function restAudio() {
  if (shared?.state === 'running') void shared.suspend().catch(() => undefined);
}

function loudness(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(scratch);
  let sum = 0;
  for (let i = 0; i < scratch.length; i++) sum += scratch[i] * scratch[i];
  return Math.min(1, Math.sqrt(sum / scratch.length) * 3.4);
}

function resample(from: Float32Array, out: Float32Array, gain: number) {
  const step = from.length / out.length;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, from[Math.floor(i * step)] * gain));
}

/** Something the call screen can draw: a loudness from 0 to 1 and a waveform. */
export type Scope = { level(): number; wave(out: Float32Array): void };

// ---- Speaking --------------------------------------------------------------------------------------------------------

export type VoiceChoice = { kind: 'device'; uri: string } | { kind: 'stock'; model: string; voice: string } | { kind: 'silent' };

/** One paid stock clip, as the gateway reported it. */
export type Clip = { costMusd: number | null; chars: number; requestId: string | null; demo: boolean; receipt: SpeechReceipt | null };

export type SpeakerConfig = {
  choice: VoiceChoice;
  /** 1 is an even pace. Sent to the gateway as `speed`, and used as the device voice's rate. */
  speed: number;
  /** The device voice picked. Used only when its `localService` is true. */
  deviceVoice: SpeechSynthesisVoice | null;
  /** `client.speech`. Missing with no key. */
  speech: ((body: SpeechRequest, signal?: AbortSignal) => Promise<SpeechResult>) | null;
};

export type SpeakerEvents = {
  /** A sentence starts being said (or shown, with no voice). */
  onSay?: (text: string) => void;
  /** The sentence being said has ended on its own. */
  onSentenceEnd?: () => void;
  /** The voice took or gave up the floor. */
  onSpeaking?: (speaking: boolean) => void;
  /** Everything queued for this reply has been said. */
  onDrained?: () => void;
  /** A stock clip was made and charged. */
  onClip?: (clip: Clip) => void;
  /** A stock clip could not be made: the rest is shown as captions until the voice is changed. */
  onError?: (error: unknown) => void;
};

type Item = { text: string; abort: AbortController; clip?: Promise<AudioBuffer | null> };

const SILENT: SpeakerConfig = { choice: { kind: 'silent' }, speed: 1, deviceVoice: null, speech: null };

/**
 * Says sentences in order. `say` queues one, `close` marks the end of a reply (then `onDrained` fires once the last
 * one has been said), `stop` silences everything at once, and `hold` lets the sentence being said finish and drops
 * the rest (the sleep timer). A stock clip is fetched one sentence ahead, so stopping wastes at most one clip.
 */
export class Speaker implements Scope {
  private config: SpeakerConfig = SILENT;
  private queue: Item[] = [];
  private current: Item | null = null;
  private closed = false;
  private holding = false;
  private broken = false;
  private speakingNow = false;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private scratch = new Float32Array(1024);
  private source: AudioBufferSourceNode | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0; // audio clock (stock) or page clock (device, captions)
  private duration = 0;
  private wordAt = Number.NEGATIVE_INFINITY;
  private charIndex = 0;
  events: SpeakerEvents;

  constructor(events: SpeakerEvents = {}) {
    this.events = events;
  }

  /** Applies to the next sentence. Changing the voice clears an earlier failure. */
  configure(config: SpeakerConfig) {
    if (JSON.stringify(this.config.choice) !== JSON.stringify(config.choice)) this.broken = false;
    this.config = config;
  }

  /** Whether a stock clip failed and replies are being shown as captions. */
  get failed() {
    return this.broken;
  }

  /** A sentence is sounding (or showing) right now. */
  get audible() {
    return this.current !== null && (this.source !== null || this.utterance !== null || this.timer !== undefined);
  }

  /** Something is being said or is waiting to be. */
  get busy() {
    return this.current !== null || this.queue.length > 0;
  }

  say(text: string) {
    if (!text) return;
    this.holding = false;
    this.queue.push({ text, abort: new AbortController() });
    this.pump();
    this.prefetch();
  }

  /** The reply has ended: once the queue is said, `onDrained` fires. */
  close() {
    this.closed = true;
    if (!this.current && !this.queue.length) this.pump();
  }

  /** Silence, at once: the sentence being said is cut, the queue and any clip on its way are dropped. */
  stop() {
    for (const item of this.queue) item.abort.abort();
    this.queue = [];
    this.current?.abort.abort();
    this.current = null;
    this.closed = false;
    this.holding = false;
    this.hush();
    this.restoreGain();
    this.setSpeaking(false);
  }

  /** Lets the sentence that is sounding finish, softening it, and drops everything after it. */
  hold() {
    this.holding = true;
    this.closed = false;
    for (const item of this.queue) item.abort.abort();
    this.queue = [];
    if (this.current && !this.audible) {
      this.current.abort.abort();
      this.current = null;
    }
    if (!this.current) {
      this.setSpeaking(false);
      return;
    }
    const context = audioContext();
    if (this.source && this.gain && context) {
      const left = Math.max(0.2, this.duration - (context.currentTime - this.startedAt));
      this.gain.gain.setTargetAtTime(0.3, context.currentTime, left / 3);
    }
  }

  /** The character being said inside the current sentence, for the caption. */
  position(): number {
    const text = this.current?.text ?? '';
    const context = audioContext();
    if (this.source && context) return Math.floor(Math.min(1, (context.currentTime - this.startedAt) / Math.max(0.05, this.duration)) * text.length);
    const elapsed = performance.now() - this.startedAt;
    if (this.utterance) return this.wordAt > 0 ? this.charIndex : Math.min(text.length, Math.floor((elapsed / 1000) * 14 * this.config.speed));
    if (this.timer !== undefined) return Math.floor(Math.min(1, elapsed / Math.max(1, this.duration)) * text.length);
    return 0;
  }

  level(): number {
    if (this.source && this.analyser) return loudness(this.analyser, this.scratch);
    if (this.utterance) return drawnLevel(performance.now() - this.startedAt, performance.now() - this.wordAt);
    return 0;
  }

  wave(out: Float32Array) {
    if (this.source && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.scratch);
      resample(this.scratch, out, 2.6);
      return;
    }
    if (!this.utterance) {
      out.fill(0);
      return;
    }
    // A device voice cannot be measured, so its wave is drawn: a few slow ripples scaled by the drawn loudness.
    const t = performance.now() - this.startedAt;
    const level = drawnLevel(t, performance.now() - this.wordAt);
    for (let i = 0; i < out.length; i++) {
      const x = i / out.length;
      out[i] = level * (0.55 * Math.sin(x * 19 + t / 95) + 0.3 * Math.sin(x * 43 - t / 61) + 0.15 * Math.sin(x * 83 + t / 37));
    }
  }

  dispose() {
    this.stop();
    this.events = {};
  }

  private setSpeaking(speaking: boolean) {
    if (speaking === this.speakingNow) return;
    this.speakingNow = speaking;
    this.events.onSpeaking?.(speaking);
  }

  private nodes(): AudioContext | null {
    const context = audioContext();
    if (!context) return null;
    if (!this.gain || !this.analyser) {
      this.gain = context.createGain();
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.55;
      this.gain.connect(this.analyser);
      this.analyser.connect(context.destination);
    }
    return context;
  }

  private restoreGain() {
    const context = audioContext();
    if (!this.gain || !context) return;
    this.gain.gain.cancelScheduledValues(context.currentTime);
    this.gain.gain.setValueAtTime(1, context.currentTime);
  }

  /** Forgets what was sounding, without cutting anything. */
  private clearSound() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.source) {
      this.source.onended = null;
      this.source.disconnect();
      this.source = null;
    }
    if (this.utterance) {
      this.utterance.onend = null;
      this.utterance.onerror = null;
      this.utterance.onboundary = null;
      this.utterance = null;
    }
  }

  /** Cuts whatever is sounding, without touching the queue. */
  private hush() {
    const wasSpeaking = this.utterance !== null;
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // already stopped
      }
    }
    this.clearSound();
    if (wasSpeaking) cancelSynthesis();
  }

  /** A device voice is used only if the browser says it is spoken on this device. */
  private localVoice(): SpeechSynthesisVoice | null {
    const voice = this.config.deviceVoice;
    return this.config.choice.kind === 'device' && voice && voice.localService === true && typeof window !== 'undefined' && 'speechSynthesis' in window ? voice : null;
  }

  private pump() {
    if (this.current) return;
    if (this.holding) {
      this.setSpeaking(false);
      return;
    }
    const item = this.queue.shift();
    if (!item) {
      this.setSpeaking(false);
      if (this.closed) {
        this.closed = false;
        this.events.onDrained?.();
      }
      return;
    }
    this.current = item;
    const voice = this.localVoice();
    if (this.config.choice.kind === 'stock' && !this.broken && this.config.speech) void this.playStock(item);
    else if (voice) this.playDevice(item, voice);
    else this.playSilent(item);
    this.prefetch();
  }

  private prefetch() {
    if (this.config.choice.kind !== 'stock' || this.broken || !this.config.speech) return;
    const next = this.queue[0];
    if (next && !next.clip) next.clip = this.fetchClip(next);
  }

  private finish(item: Item) {
    if (this.current !== item) return;
    this.current = null;
    this.clearSound();
    this.events.onSentenceEnd?.();
    this.pump();
  }

  private async fetchClip(item: Item): Promise<AudioBuffer | null> {
    const { choice, speed, speech } = this.config;
    const context = this.nodes();
    if (choice.kind !== 'stock' || !speech || !context) return null;
    try {
      const result = await speech({ model: choice.model, input: item.text, voice: choice.voice, speed }, item.abort.signal);
      // Charged as soon as the gateway answered, whether or not it ends up being played.
      this.events.onClip?.({ costMusd: result.costMusd, chars: item.text.length, requestId: result.requestId, demo: result.provenance === 'demo', receipt: result.receipt });
      if (!wavInfo(result.audio)) throw new Error('The voice reply was not audio.');
      return await context.decodeAudioData(result.audio.slice(0));
    } catch (error) {
      if (!item.abort.signal.aborted && !this.broken) {
        this.broken = true;
        this.events.onError?.(error);
      }
      return null;
    }
  }

  private async playStock(item: Item) {
    const buffer = await (item.clip ??= this.fetchClip(item));
    if (this.current !== item) return;
    const context = this.nodes();
    if (!buffer || !context || !this.gain) {
      this.playSilent(item);
      return;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => this.finish(item);
    this.source = source;
    this.startedAt = context.currentTime;
    this.duration = buffer.duration;
    this.events.onSay?.(item.text);
    this.setSpeaking(true);
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    source.start();
  }

  private playDevice(item: Item, voice: SpeechSynthesisVoice) {
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = this.config.speed;
    utterance.onboundary = (event) => {
      if (this.current !== item) return;
      this.charIndex = event.charIndex;
      this.wordAt = performance.now();
    };
    const done = () => this.finish(item);
    utterance.onend = done;
    utterance.onerror = done;
    // Held here until it ends: some browsers drop the end event of an utterance nothing refers to.
    this.utterance = utterance;
    this.startedAt = performance.now();
    this.wordAt = Number.NEGATIVE_INFINITY;
    this.charIndex = 0;
    this.events.onSay?.(item.text);
    this.setSpeaking(true);
    // A browser that never reports the end must not stall the call, or talk over the next sentence.
    this.timer = setTimeout(() => {
      cancelSynthesis();
      done();
    }, 8000 + item.text.length * 240);
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      done();
    }
  }

  /** No voice: the sentence is on screen for about as long as it takes to read. */
  private playSilent(item: Item) {
    this.startedAt = performance.now();
    this.duration = Math.max(1400, item.text.length * 58);
    this.events.onSay?.(item.text);
    this.setSpeaking(true);
    this.timer = setTimeout(() => this.finish(item), this.duration);
  }
}

function cancelSynthesis() {
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch {
    // no synthesiser
  }
}

/**
 * Some browsers only speak after a first utterance made inside a click. This says one silent space in the chosen
 * device voice. Without a voice that runs on this device it does nothing, so the browser's default voice is never used.
 */
export function primeDeviceVoice(voice: SpeechSynthesisVoice | null) {
  if (!voice || voice.localService !== true || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    const utterance = new SpeechSynthesisUtterance(' ');
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
  } catch {
    // no synthesiser
  }
}

/** This device's voices as the browser lists them now (the list can arrive late: see `onVoicesChanged`). */
export function deviceVoices(): SpeechSynthesisVoice[] {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis.getVoices() : [];
  } catch {
    return [];
  }
}

export function onVoicesChanged(listener: () => void): () => void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return () => undefined;
  const synth = window.speechSynthesis;
  synth.addEventListener?.('voiceschanged', listener);
  return () => synth.removeEventListener?.('voiceschanged', listener);
}

// ---- Listening, on this device only ----------------------------------------------------------------------------------

type RecognitionResult = { isFinal: boolean; 0?: { transcript: string } };
type RecognitionEvent = { results: ArrayLike<RecognitionResult> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type OnDeviceOptions = { langs: string[]; processLocally: boolean };
type RecognitionCtor = { new (): Recognition; available(options: OnDeviceOptions): Promise<unknown>; install(options: OnDeviceOptions): Promise<unknown> };

/** The browser's recogniser, only if it can be held to this device (`onDeviceSupport`). Otherwise null, always. */
function recogniser(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  for (const ctor of [w.SpeechRecognition, w.webkitSpeechRecognition]) if (onDeviceSupport(ctor)) return ctor as RecognitionCtor;
  return null;
}

/** The language the person's browser is set to, which is what they will most likely speak. */
export const listeningLanguage = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

/** Whether speech in `lang` can be recognised on this device right now. Asks the browser; sends nothing. */
export async function listeningStatus(lang: string): Promise<OnDeviceStatus> {
  const ctor = recogniser();
  if (!ctor) return 'unsupported';
  try {
    return onDeviceStatus(await ctor.available({ langs: [lang], processLocally: true }));
  } catch {
    return 'unavailable';
  }
}

/**
 * Asks the browser to put its speech pack for `lang` on this device. Call it from a click: a download needs one.
 * The browser fetches its own pack; the page neither sees nor sends it.
 */
export async function installListening(lang: string): Promise<OnDeviceStatus> {
  const ctor = recogniser();
  if (!ctor) return 'unsupported';
  try {
    if ((await ctor.install({ langs: [lang], processLocally: true })) !== true) return 'unavailable';
  } catch {
    // refused, or not started from a click: ask where things stand
  }
  return listeningStatus(lang);
}

export type ListenHandlers = {
  /** The words heard so far. */
  onText: (text: string) => void;
  /** Listening has ended; this is everything that was heard. */
  onEnd: (text: string) => void;
  /** `service-not-allowed` and `language-not-supported` mean on-device recognition is not there after all. */
  onError: (code: string) => void;
};

export type Listening = { stop(): void; abort(): void };

/**
 * Starts the recogniser on this device. Null when it cannot be held to the device: the switch is set, then read back,
 * and if it did not take the recogniser is never started. `hold` keeps listening until `stop` (hold to talk);
 * without it the recogniser ends by itself when the person stops speaking (hands-free).
 */
export function listen(lang: string, handlers: ListenHandlers, hold = true): Listening | null {
  const ctor = recogniser();
  if (!ctor) return null;
  let recognition: Recognition;
  try {
    recognition = new ctor();
    recognition.processLocally = true;
    if (recognition.processLocally !== true) return null;
  } catch {
    return null;
  }
  recognition.lang = lang;
  recognition.continuous = hold;
  recognition.interimResults = true;
  let heard = '';
  let over = false;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    if (over) return;
    over = true;
    clearTimeout(giveUp);
    handlers.onEnd(heard.trim());
  };
  recognition.onresult = (event) => {
    let text = '';
    for (let i = 0; i < event.results.length; i++) text += `${event.results[i][0]?.transcript ?? ''} `;
    heard = text.replace(/\s+/g, ' ').trim();
    if (!over) handlers.onText(heard);
  };
  recognition.onerror = (event) => {
    const code = event.error ?? 'unknown';
    if (code !== 'aborted' && code !== 'no-speech' && !over) handlers.onError(code);
  };
  recognition.onend = end;
  try {
    recognition.start();
  } catch {
    return null;
  }
  return {
    stop() {
      if (over) return;
      try {
        recognition.stop();
      } catch {
        end();
      }
      // The last words arrive just after stop. A recogniser that never says it ended is not waited for.
      giveUp = setTimeout(end, 2500);
    },
    abort() {
      over = true;
      clearTimeout(giveUp);
      try {
        recognition.abort();
      } catch {
        // already ended
      }
    },
  };
}

/**
 * A meter on the microphone, for the waveform while the person talks. The stream is measured and nothing else: it is
 * not connected to the speakers, not recorded and not sent. Closing it stops the microphone.
 */
export class MicMeter implements Scope {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private scratch = new Float32Array(1024);
  private wanted = false;

  async open() {
    this.wanted = true;
    const context = audioContext();
    if (!context || this.stream || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!this.wanted) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      this.source = context.createMediaStreamSource(stream);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      this.source.connect(this.analyser);
    } catch {
      // no microphone, or not allowed: the call still works, the wave just stays flat while the person talks
    }
  }

  close() {
    this.wanted = false;
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.source = null;
    this.analyser = null;
  }

  level(): number {
    return this.analyser ? loudness(this.analyser, this.scratch) : 0;
  }

  wave(out: Float32Array) {
    if (!this.analyser) {
      out.fill(0);
      return;
    }
    this.analyser.getFloatTimeDomainData(this.scratch);
    resample(this.scratch, out, 3);
  }
}

// ---- Keeping the screen on while a call is live ----------------------------------------------------------------------

type WakeLock = { release(): Promise<void> };

/** Holds the screen on (a story must not stop because the phone dimmed). Returns how to let it go. */
export function keepAwake(): () => void {
  let lock: WakeLock | null = null;
  let released = false;
  const wake = (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<WakeLock> } }).wakeLock;
  const take = () => {
    if (released || !wake || document.visibilityState !== 'visible') return;
    wake.request('screen').then(
      (held) => {
        if (released) void held.release().catch(() => undefined);
        else lock = held;
      },
      () => undefined,
    );
  };
  take();
  document.addEventListener('visibilitychange', take);
  return () => {
    released = true;
    document.removeEventListener('visibilitychange', take);
    void lock?.release().catch(() => undefined);
    lock = null;
  };
}
