export const SPEECH_MODEL = 'kokoro/kokoro-82m';
export const TRANSCRIPTION_MODEL = 'openai/whisper-large-v3';

export type SpeechModel = { id: string; kind: 'speech'; voices: string[]; max_chars: number; pricing: { usd_per_1k_chars: string } };
export type TranscriptionModel = {
  id: typeof TRANSCRIPTION_MODEL; kind: 'transcription'; max_seconds: number; max_request_bytes: number;
  pricing: { usd_per_started_minute: string };
};
export type VoiceModels = { speech?: SpeechModel; transcription?: TranscriptionModel };

export const voiceUsd = (amount: number | string) => `$${Number(amount).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')}`;
export const transcriptionRate = (model: TranscriptionModel) => `${voiceUsd(model.pricing.usd_per_started_minute)} / started minute`;
export const speechRate = (model: SpeechModel) => `${voiceUsd(model.pricing.usd_per_1k_chars)} / 1,000 characters`;
export const speechQuote = (model: SpeechModel, text: string) => voiceUsd(Number(model.pricing.usd_per_1k_chars) * text.trim().length / 1000);

export function* speechChunks(text: string, limit: number) {
  let rest = text.trim();
  while (rest.length > limit) {
    const space = rest.lastIndexOf(' ', limit - 1);
    const end = space > limit / 2 ? space + 1 : limit - Number(/[\uD800-\uDBFF]/.test(rest[limit - 1]));
    yield rest.slice(0, end);
    rest = rest.slice(end);
  }
  if (!rest.trim()) return;
  yield rest;
}

export function pcmWav(samples: Float32Array, rate: number): Blob {
  const bytes = new ArrayBuffer(44 + 2 * samples.length);
  const view = new DataView(bytes);
  view.setUint32(0, 0x52494646); // RIFF
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(8, 0x57415645); // WAVE
  view.setUint32(12, 0x666d7420); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461); // data
  view.setUint32(40, bytes.byteLength - 44, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.min(1, Math.max(-1, samples[i]));
    view.setInt16(44 + 2 * i, sample * (sample < 0 ? 32768 : 32767), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
