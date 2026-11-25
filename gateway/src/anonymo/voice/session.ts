import { randomUUID } from "node:crypto";
import { ANONYMO_1 } from "../models.ts";
import { FRAME_BYTES, FRAME_SAMPLES, SAMPLE_RATE, micWav, voiced } from "./audio.ts";
import { picoToUsdString, type Pico } from "../../lib/money.ts";
import type { ReceiptRoute } from "../../receipts/anonymo.ts";
import type { VoiceConnection } from "./transport.ts";

export type VoiceMessage = { role: "user" | "assistant" | "system"; content: string };
export type VoiceUsage = { routes: ReceiptRoute[]; tokens: { in: number; out: number }; cost: Pico };
export type ChatEvent = { text: string; captionOnly?: boolean } | { usage: VoiceUsage };
export type VoiceUpstreams = {
  transcribe(file: File, samples: number, signal: AbortSignal): Promise<{ text: string; cost: Pico }>;
  chat(messages: VoiceMessage[], signal: AbortSignal): AsyncIterable<ChatEvent>;
  speak(text: string, signal: AbortSignal): Promise<{ wav: ArrayBuffer; cost: Pico }>;
};
export type CallReceipt = {
  v: "anonymo-voice/1"; id: string; model: typeof ANONYMO_1; ts: string; stt_seconds: number;
  llm_tokens: { in: number; out: number }; tts_characters: number; routes: ReceiptRoute[]; cost: string;
};

const PREROLL = 8;
const START_FRAMES = 3;
const PHRASE_PAUSE = 12;
const TURN_PAUSE = 28;
const MAX_PHRASE = 300;
const MAX_TURN = 1500;

type Utterance = {
  frames: Uint8Array[]; count: number; voicedFrames: number; silence: number;
  text: string; done: Promise<void>; error: unknown; controller: AbortController;
};

function nextChunk(text: string, flush: boolean) {
  const punctuation = /[.!?…][”"')\]]*(?=\s|$)|[。？！]/u.exec(text);
  if (punctuation && punctuation.index + punctuation[0].length <= 220) return punctuation.index + punctuation[0].length;
  if (text.length <= 220) return flush ? text.length : 0;
  const space = text.lastIndexOf(" ", 220);
  return space > 100 ? space : 220 - Number(/[\uD800-\uDBFF]/.test(text[219]));
}

/** One call. Only counts and signed route metadata survive hangup. */
export class VoiceSession {
  readonly id = randomUUID();
  private history: VoiceMessage[] = [];
  private preroll: Uint8Array[] = [];
  private consecutive = 0;
  private utterance?: Utterance;
  private turn?: AbortController;
  private readonly work = new Set<Promise<void>>();
  private readonly routes: ReceiptRoute[] = [];
  private readonly tokens = { in: 0, out: 0 };
  private samples = 0;
  private characters = 0;
  private cost = 0n;
  private closed = false;
  private muted = false;
  private starting = true;

  constructor(
    private readonly transport: VoiceConnection,
    private readonly upstreams: VoiceUpstreams,
    private readonly sign: (receipt: CallReceipt) => unknown,
    private system: string,
    private readonly crisis: (text: string) => boolean,
  ) {}

  ready() {
    this.starting = false;
    this.transport.send({ type: "ready", id: this.id });
  }

  mic(frame: Uint8Array) {
    if (this.closed || this.starting || this.muted || frame.length !== FRAME_BYTES) return;
    const speech = voiced(frame);
    const current = this.utterance;
    if (!current) {
      this.preroll.push(frame.slice());
      if (this.preroll.length > PREROLL) this.preroll.shift();
      this.consecutive = speech ? this.consecutive + 1 : 0;
      if (this.consecutive < START_FRAMES) return;
      this.interrupt();
      const frames = this.preroll;
      this.preroll = [];
      this.utterance = {
        frames, count: frames.length, voicedFrames: START_FRAMES, silence: 0,
        text: "", done: Promise.resolve(), error: null, controller: new AbortController(),
      };
      this.transport.send({ type: "listening" });
      return;
    }

    current.frames.push(frame.slice());
    current.count++;
    current.silence = speech ? 0 : current.silence + 1;
    if (speech) current.voicedFrames++;
    if (current.silence === PHRASE_PAUSE || current.frames.length >= MAX_PHRASE) this.transcribe(current);
    if (current.silence >= TURN_PAUSE || current.count >= MAX_TURN) this.finishUtterance(current);
  }

  mute(muted: boolean) {
    this.muted = muted;
    this.preroll = [];
    this.consecutive = 0;
    if (muted && this.utterance) {
      this.utterance.controller.abort();
      this.utterance = undefined;
      if (!this.closed) this.transport.send({ type: "idle" });
    }
  }

  private interrupt() {
    this.turn?.abort();
    this.turn = undefined;
    this.transport.send({ type: "interrupt" });
  }

  private track(task: Promise<void>) {
    this.work.add(task);
    void task.then(() => this.work.delete(task), () => this.work.delete(task));
  }

  private transcribe(utterance: Utterance) {
    const frames = utterance.frames;
    const voicedFrames = utterance.voicedFrames;
    utterance.frames = [];
    utterance.voicedFrames = 0;
    if (!voicedFrames) return;
    const samples = frames.length * FRAME_SAMPLES;
    const { signal } = utterance.controller;
    utterance.done = utterance.done.then(async () => {
      if (signal.aborted || utterance.error) return;
      try {
        const part = await this.upstreams.transcribe(micWav(frames), samples, signal);
        this.samples += samples;
        this.cost += part.cost;
        if (signal.aborted) return;
        utterance.text = `${utterance.text} ${part.text}`.trim().slice(0, 6000);
        if (!this.closed && utterance.text) this.transport.send({ type: "caption", role: "user", text: utterance.text, final: false });
      } catch (error) {
        utterance.error = error;
      }
    });
    this.track(utterance.done);
  }

  private finishUtterance(utterance: Utterance) {
    this.utterance = undefined;
    this.consecutive = 0;
    this.transcribe(utterance);
    this.turn = utterance.controller;
    this.track(this.reply(utterance));
  }

  private async reply(utterance: Utterance) {
    const { signal } = utterance.controller;
    let talking = Promise.resolve();
    let outputError: unknown;
    let pending = "";
    let response = "";
    const speak = (flush: boolean) => {
      for (let end = nextChunk(pending, flush); end; end = nextChunk(pending, flush)) {
        const text = pending.slice(0, end).trim();
        pending = pending.slice(end);
        if (!text) continue;
        talking = talking.then(async () => {
          if (signal.aborted || outputError) return;
          try {
            const { wav, cost } = await this.upstreams.speak(text, signal);
            this.cost += cost;
            this.characters += text.length;
            if (!signal.aborted) this.transport.audio(wav);
          } catch (error) {
            outputError = error;
          }
        });
      }
    };

    try {
      await utterance.done;
      if (signal.aborted) return;
      if (utterance.error) throw utterance.error;
      if (!utterance.text) return;
      this.transport.send({ type: "caption", role: "user", text: utterance.text, final: true });
      if (this.crisis(utterance.text)) {
        this.transport.send({ type: "crisis" });
        return;
      }

      const user = { role: "user", content: utterance.text } as const;
      this.transport.send({ type: "thinking" });
      let receipted = false;
      for await (const event of this.upstreams.chat([
        { role: "system", content: this.system }, ...this.history, user,
      ], signal)) {
        if ("usage" in event) {
          this.routes.push(...event.usage.routes);
          this.tokens.in += event.usage.tokens.in;
          this.tokens.out += event.usage.tokens.out;
          this.cost += event.usage.cost;
          receipted = true;
        } else if (!signal.aborted) {
          response += event.text;
          this.transport.send({ type: "caption", role: "assistant", text: response });
          if (!event.captionOnly) {
            pending += event.text;
            speak(false);
          }
        }
      }
      if (signal.aborted) return;
      if (!receipted) throw new Error("missing_turn_receipt");
      speak(true);
      await talking;
      if (signal.aborted) return;
      if (outputError) throw outputError;
      this.history = [...this.history, user, { role: "assistant" as const, content: response }].slice(-12);
    } catch (error) {
      if (!signal.aborted) {
        const code = typeof error === "object" && error && "type" in error ? error.type : "voice_unavailable";
        this.interrupt();
        this.transport.send({ type: "error", code, status: typeof error === "object" && error && "status" in error ? error.status : 502 });
      }
    } finally {
      await talking;
      if (!this.closed && this.turn === utterance.controller) this.transport.send({ type: "idle" });
    }
  }

  async end(sendReceipt: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.turn?.abort();
    this.utterance?.controller.abort();
    this.utterance = undefined;
    this.history = [];
    this.system = "";
    this.preroll = [];
    try {
      if (sendReceipt) {
        await Promise.allSettled(this.work);
        const payload: CallReceipt = {
          v: "anonymo-voice/1", id: this.id, model: ANONYMO_1, ts: new Date().toISOString(),
          stt_seconds: this.samples / SAMPLE_RATE, llm_tokens: { ...this.tokens },
          tts_characters: this.characters, routes: this.routes, cost: picoToUsdString(this.cost),
        };
        this.transport.send({ type: "receipt", receipt: this.sign(payload) });
      }
    } finally {
      this.transport.close();
    }
  }
}
