import { pcmWav, SPEECH_MODEL, TRANSCRIPTION_MODEL, type SpeechModel, type TranscriptionModel } from '../talk.ts';

export const DEMO_VOICE_MODELS = [
  {
    id: SPEECH_MODEL, kind: 'speech', name: 'Kokoro', max_chars: 10_000, pricing: { usd_per_1k_chars: '0.003' },
    voices: [
      'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
      'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck',
      'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
      'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'if_sara', 'im_nicola',
    ],
  },
  {
    id: TRANSCRIPTION_MODEL, kind: 'transcription', name: 'Whisper Large V3', max_seconds: 300, max_request_bytes: 4_000_000,
    pricing: { usd_per_started_minute: '0.001' },
  },
] as const satisfies readonly [(SpeechModel & { name: string }), (TranscriptionModel & { name: string })];

export const DEMO_TRANSCRIPT = 'Describe a quiet morning beside the ocean.';
export const DEMO_VOICE_REPLY = 'The tide draws a thin silver line across the sand. Farther out, a fishing boat passes through the mist. For a while, the only sound is water slipping between the stones.';

let chime: Blob | undefined;
/** A short two-note sample bundled with the mock. Playback and demo capture work offline. */
export function demoVoiceWav() {
  if (chime) return chime;
  const rate = 16_000;
  const samples = new Float32Array(rate);
  const notes = [[0, 440], [0.24, 660]];
  for (let i = 0; i < samples.length; i++) {
    const at = i / rate;
    for (const [start, pitch] of notes) {
      const t = at - start;
      if (t >= 0) samples[i] += 0.22 * Math.min(1, t * 80) * Math.exp(-t * 9) * Math.sin(2 * Math.PI * pitch * t);
    }
  }
  return chime = pcmWav(samples, rate);
}

export async function demoSpeech(request: Request) {
  const body = await request.json().catch(() => null);
  const model = DEMO_VOICE_MODELS[0];
  if (body?.model !== model.id || typeof body.input !== 'string' || !body.input.trim() || body.input.length > model.max_chars || !model.voices.includes(body.voice))
    return Response.json({ error: { type: 'invalid_request', message: 'Choose a stock voice and enter text.' } }, { status: 400 });
  return new Response(demoVoiceWav(), {
    headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-anonymo-cost-usd': String(Number(model.pricing.usd_per_1k_chars) * body.input.length / 1000) },
  });
}

export async function demoTranscription(request: Request) {
  const body = await request.formData().catch(() => null);
  const file = body?.get('file');
  if (!(file instanceof File) || !file.size || body?.get('model') !== TRANSCRIPTION_MODEL)
    return Response.json({ error: { type: 'invalid_request', message: 'Send one audio file.' } }, { status: 400 });
  return Response.json({ text: DEMO_TRANSCRIPT }, {
    headers: { 'cache-control': 'no-store', 'x-anonymo-cost-usd': DEMO_VOICE_MODELS[1].pricing.usd_per_started_minute },
  });
}
