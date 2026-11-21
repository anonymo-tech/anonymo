// Update "voice" (Night Call) in the demo gateway. One stock speech model with a few voices, listed, priced and
// refused the way the gateway does it (gateway/src/anonymo/media/routes.ts `runSpeech`): stock voices only, nothing that
// carries a voice sample, WAV out, the charge and a receipt on the response headers. No voice model runs in a browser,
// so the audio is a short soft tone about as long as the text would take to say. It is labelled as a demo tone
// (`x-anonymo-provenance: demo`) and the call screen says so. The demo chat also answers the bedtime starter with a
// story, so "Read me to sleep" has something to read.

import { musdToUsdString } from '../money.ts';
import type { MediaSpeechModel, SpeechReceipt } from '../types.ts';
import { speechCostMusd, STORY_CONTINUE, STORY_PROMPT } from '../voice.ts';

export const DEMO_SPEECH_MODELS: MediaSpeechModel[] = [
  {
    id: 'kokoro',
    object: 'model',
    kind: 'speech',
    name: 'Kokoro',
    family: 'kokoro',
    license: 'Apache-2.0',
    upstream: 'self-hosted',
    pricing: { usd_per_1k_chars: '0.015' },
    voices: ['af_heart', 'af_river', 'am_puck', 'bm_fable'],
    max_chars: 4096,
    response_formats: ['wav'],
  },
];

/** Fields that would carry a voice sample into the model. The gateway refuses them (`CLONE_FIELDS`); so does the demo. */
export const VOICE_SAMPLE_FIELDS = ['reference_audio', 'speaker_wav', 'voice_sample', 'audio', 'audio_prompt', 'prompt_audio', 'voice_url', 'clone', 'reference_text', 'speaker_audio', 'voice_file'];

const RATE = 16_000;

/** How long the demo tone lasts: about as long as the text would take to say, so a call's timing looks right. */
export const demoToneSeconds = (chars: number, speed: number) => Math.min(20, Math.max(0.6, chars / (15 * speed)));

/** A soft hum that swells like syllables, as 16-bit mono WAV. Each stock voice hums at its own pitch. */
export function demoTone(chars: number, voice: string, speed: number): Uint8Array<ArrayBuffer> {
  const seconds = demoToneSeconds(chars, speed);
  const frames = Math.round(seconds * RATE);
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, frames * 2, true);
  let hash = 0;
  for (let i = 0; i < voice.length; i++) hash = (hash * 31 + voice.charCodeAt(i)) >>> 0;
  const pitch = 150 + (hash % 9) * 12;
  for (let i = 0; i < frames; i++) {
    const t = i / RATE;
    const edge = Math.max(0, Math.min(1, t / 0.04, (seconds - t) / 0.12));
    const syllable = 0.3 + 0.7 * Math.abs(Math.sin(Math.PI * t * 3.6 * speed)) ** 1.5;
    const phase = 2 * Math.PI * pitch * t + 0.6 * Math.sin(2 * Math.PI * 0.7 * t);
    const hum = Math.sin(phase) * 0.6 + Math.sin(2 * phase) * 0.25 + Math.sin(3 * phase) * 0.1;
    view.setInt16(44 + i * 2, Math.round(hum * syllable * edge * 0.3 * 32767), true);
  }
  return bytes;
}

const base64Url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `POST /v1/audio/speech` for the demo gateway. The gateway file supplies its key, balance and error helpers. */
export function createDemoSpeech<Key extends object>(o: {
  id: () => string;
  fail: (status: number, type: string, message: string) => Response;
  check: (key: Key, cost: number) => Response | null;
  charge: (key: Key, cost: number, model: string, requestId: string) => void;
  /** How long a clip takes, in ms. */
  delayMs?: number;
}) {
  return {
    async speak(request: Request, key: Key): Promise<Response> {
      if (!(request.headers.get('content-type') ?? 'application/json').startsWith('application/json'))
        return o.fail(415, 'unsupported_media_type', 'Send a JSON body. Voice uploads are not accepted: stock voices only.');
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const model = DEMO_SPEECH_MODELS.find((m) => m.id === body?.model);
      if (!model || !body) return o.fail(404, 'model_not_found', 'Unknown speech model. GET /v1/media/models lists them.');
      if (VOICE_SAMPLE_FIELDS.some((f) => body[f] != null) || (body.voice != null && typeof body.voice !== 'string'))
        return o.fail(400, 'voice_clone_not_supported', "Voice cloning is not available. Choose one of the model's stock voices.");
      const input = typeof body.input === 'string' ? body.input : '';
      if (!input.trim() || input.length > model.max_chars) return o.fail(400, 'invalid_request', `Enter text of 1–${model.max_chars.toLocaleString('en-US')} characters.`);
      const voice = typeof body.voice === 'string' && body.voice ? body.voice : model.voices[0];
      if (!model.voices.includes(voice)) return o.fail(400, 'voice_not_available', "Choose one of this model's stock voices (GET /v1/media/models).");
      if (body.response_format != null && body.response_format !== 'wav') return o.fail(400, 'unsupported_format', 'response_format must be "wav".');
      const speed = body.speed == null ? 1 : Number(body.speed);
      if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return o.fail(400, 'invalid_request', 'speed must be 0.25–4.');
      const cost = speechCostMusd(model.pricing.usd_per_1k_chars, input.length);
      const refusal = o.check(key, cost);
      if (refusal) return refusal;
      const audio = demoTone(input.length, voice, speed);
      const delay = o.delayMs ?? 160;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (request.signal.aborted) return o.fail(499, 'client_closed', 'The request was cancelled. Nothing was charged.');
      // Another clip may have settled while this one was being made.
      const late = o.check(key, cost);
      if (late) return late;
      const requestId = o.id();
      const costUsd = musdToUsdString(cost);
      o.charge(key, cost, model.id, requestId);
      const receipt: SpeechReceipt = {
        payload: {
          v: 1, kind: 'media', request_id: requestId, model_id: model.id, routes: [`demo:${model.id}`],
          media_units: input.length, unit: 'character', cost_usd: costUsd, outputs_sha256: [await sha256Hex(audio)], provenance: 'demo', ts: new Date().toISOString(),
        },
        key_id: 'demo', sig: null,
      };
      return new Response(audio, {
        status: 200,
        headers: {
          'content-type': 'audio/wav',
          'cache-control': 'no-store',
          'x-anonymo-request-id': requestId,
          'x-anonymo-cost-usd': costUsd,
          'x-anonymo-provenance': 'demo',
          'x-anonymo-receipt': base64Url(JSON.stringify(receipt)),
        },
      });
    },
  };
}

// A bedtime story for the demo, in the mascot's world: the felt plush, its sleep mask and the receipt printer.
const DEMO_STORY = [
  [
    'Once the lamps were low, a small felt plush pushed its sleep mask up onto its forehead and listened.',
    'The house was quiet. Only the little printer by the window was awake, humming to itself, feeding out a ribbon of soft paper that curled across the floor like a slow river.',
    'The plush stepped onto it, and the paper held.',
    'It drifted past the bookshelf, where the stories were already asleep, and past the kettle, which gave one last warm sigh.',
    'Nothing here was in a hurry. The paper river turned gently, and the plush sat down, hugged its knees, and let the night carry it.',
  ],
  [
    'Along the bank, gold threads glowed in the dark, each one a stitch that somebody had sewn with care.',
    'The plush counted them without trying. One for the day that was done. One for the things that could wait until morning.',
    'One for the breath going in, and one for the breath going out.',
    'A paper boat came alongside, folded from an old receipt, and bobbed there like a friend who did not need to talk.',
    'The window was open a hand wide, and the air that came in smelled of rain that had already finished. The river grew wider, and slower, and softer.',
  ],
  [
    'Further on, the river passed a row of gold headphones hanging from a branch, each one playing a different quiet sound.',
    'One played rain on a tin roof. One played a cat asleep on a radiator. One played nothing at all, which was the best one.',
    'The plush chose that one and put it on, and the quiet settled over its ears like a warm hat.',
    'Somewhere behind it the printer kept writing, line after gentle line, and every line said the same thing: you can rest now.',
  ],
  [
    'At the end of the river there was a pillow as wide as a meadow.',
    'The paper slid up onto it and stopped, the way a wave stops on sand. The plush lay down.',
    'It pulled the sleep mask over its eyes, and the dark behind it was the kind, velvet sort of dark.',
    'There was nothing left to carry and nowhere left to go. The stitches glowed, then dimmed, one by one.',
    'And the plush, and the river, and the whole warm house, went gently to sleep.',
  ],
].map((part) => part.join(' '));

/**
 * The demo chat's reply to the Night Call bedtime starter and to each "keep reading" after it: the next part of the
 * story. Null for anything else, so every other message gets the usual demo reply.
 */
export function demoStoryReply(messages: readonly { role: string; content?: unknown }[]): string | null {
  const said = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : ''));
  const started = said.lastIndexOf(STORY_PROMPT);
  if (started === -1) return null;
  const last = said[said.length - 1];
  if (last === STORY_PROMPT) return DEMO_STORY[0];
  if (last !== STORY_CONTINUE) return null;
  const part = said.slice(started + 1).filter((s) => s === STORY_CONTINUE).length;
  // After the last part the story drifts on from its second part, so a long timer always has something to read.
  return DEMO_STORY[part < DEMO_STORY.length ? part : 1 + ((part - 1) % (DEMO_STORY.length - 1))];
}
