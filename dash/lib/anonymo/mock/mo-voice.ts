import type { AnonymoClient } from '../client';
import type { DesignedVoice, VoiceEvent, VoiceListing } from '../mo-voice';
import type { CallConnection } from '../mo-voice-browser';
import { companionSignals } from '../safety';
import type { ChatMessage, ReceiptRoute } from '../types';
import { deviceVoices, listen, listeningLanguage, type Listening } from '../voice-browser';
import { stockVoiceLabel } from '../voice';

const saved = new WeakMap<AnonymoClient, DesignedVoice[]>();

export async function demoVoiceList(client: AnonymoClient, signal?: AbortSignal): Promise<VoiceListing> {
  const models = await client.speechModels(signal);
  return {
    stock: models.flatMap((m) => m.voices.map((id) => ({ id, name: stockVoiceLabel(id).name, engine: m.name }))),
    designed: saved.get(client) ?? [],
  };
}

export function saveDemoVoice(client: AnonymoClient, id: string, name: string) {
  const voice = { id, name, created_at: new Date().toISOString() };
  saved.set(client, [voice, ...(saved.get(client) ?? [])]);
  return voice;
}

export function demoSpeech(text: string, traits: string) {
  const voice = deviceVoices().find((v) => v.localService);
  if (!voice) return false;
  const line = new SpeechSynthesisUtterance(text);
  line.voice = voice;
  line.pitch = /low|deep|husky/i.test(traits) ? 0.75 : /high|bright/i.test(traits) ? 1.25 : 1;
  line.rate = /slow|measured|calm/i.test(traits) ? 0.85 : /fast|lively/i.test(traits) ? 1.15 : 1;
  speechSynthesis.speak(line);
  return true;
}

export function demoCall(client: AnonymoClient, character: string | undefined, event: (event: VoiceEvent) => void): CallConnection {
  const id = crypto.randomUUID();
  const routes: ReceiptRoute[] = [];
  const tokens = { in: 0, out: 0 };
  let characters = 0;
  let cost = 0;
  let seconds = 0;
  let speechAt = 0;
  let history: ChatMessage[] = [];
  let muted = false;
  let closed = false;
  let generation: AbortController | undefined;
  let mic: Listening | null = null;
  let restart: ReturnType<typeof setTimeout>;
  const stopReply = () => { generation?.abort(); window.speechSynthesis?.cancel(); event({ type: 'interrupt' }); };

  async function answer(text: string) {
    text = text.trim();
    if (!text || closed) return;
    stopReply();
    event({ type: 'caption', role: 'user', text, final: true });
    if (companionSignals(text).crisis) { event({ type: 'crisis' }); return; }
    const now = new AbortController();
    generation = now;
    const user: ChatMessage = { role: 'user', content: text };
    let reply = '';
    event({ type: 'thinking' });
    try {
      const result = await client.chat({
        model: 'anonymo-1', max_tokens: 120,
        messages: [{ role: 'system', content: `Speak in short sentences. ${character ?? ''}` }, ...history, user],
      }, {
        signal: now.signal,
        onDelta(delta) {
          if (now.signal.aborted) return;
          reply += delta;
          event({ type: 'caption', role: 'assistant', text: reply });
        },
      });
      if (now.signal.aborted) return;
      history = [...history, user, { role: 'assistant' as const, content: reply }].slice(-8);
      if (result.receipt) {
        routes.push(...result.receipt.routes);
        tokens.in += result.receipt.tokens.in;
        tokens.out += result.receipt.tokens.out;
        cost += Number(result.receipt.cost);
      }
      if (demoSpeech(reply, '')) characters += reply.length;
    } catch {
      if (!now.signal.aborted) event({ type: 'error', code: 'voice_unavailable' });
    } finally {
      if (!now.signal.aborted) event({ type: 'idle' });
    }
  }

  function listenAgain() {
    if (muted || closed) return;
    speechAt = 0;
    let unavailable = false;
    mic = listen(listeningLanguage(), {
      onText(text) {
        if (!speechAt && text) {
          speechAt = performance.now();
          stopReply();
          event({ type: 'listening' });
        }
        if (text) event({ type: 'caption', role: 'user', text });
      },
      onEnd(text) {
        mic = null;
        if (text && speechAt) seconds += Math.max(0.02, (performance.now() - speechAt) / 1000);
        void answer(text);
        if (!unavailable) restart = setTimeout(listenAgain, 180);
      },
      onError() { unavailable = true; },
    }, false);
  }

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(restart);
    mic?.abort();
    generation?.abort();
    window.speechSynthesis?.cancel();
    history = [];
  };
  event({ type: 'ready', id });
  listenAgain();
  return {
    mute(value) {
      muted = value;
      clearTimeout(restart);
      if (value) { mic?.abort(); mic = null; }
      else listenAgain();
    },
    close,
    hangup() {
      close();
      event({ type: 'receipt', receipt: { payload: {
        v: 'anonymo-voice/1', id, ts: new Date().toISOString(), model: 'anonymo-1',
        llm_tokens: tokens, tts_characters: characters, stt_seconds: seconds, routes, cost: cost.toFixed(8),
      }, key_id: '', sig: null, alg: 'Ed25519' } });
    },
    typeLine(text) { void answer(text); },
  };
}
