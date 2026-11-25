import type { ReceiptRoute } from './types';

export const VOICE_PATH = '/v1/voice';

export type VoiceOption = { id: string; name: string; engine: string };
export type DesignedVoice = { id: string; name: string; created_at: string };
export type VoiceListing = { stock: VoiceOption[]; designed: DesignedVoice[] };
export type VoicePreview = { preview_id: string; audio: string; cost: string | null };
export type VoiceTicket = {
  transport: 'websocket'; ticket: string; path: string; protocol: string; sample_rate: number; frame_bytes: number;
};
export type CallReceipt = {
  payload: {
    v: 'anonymo-voice/1'; id: string; model: 'anonymo-1'; stt_seconds: number; llm_tokens: { in: number; out: number };
    tts_characters: number; routes: ReceiptRoute[]; cost: string; ts: string;
  };
  key_id: string;
  sig: string | null;
  alg: 'Ed25519';
};
export type VoiceEvent =
  | { type: 'ready'; id: string }
  | { type: 'listening' | 'thinking' | 'idle' | 'interrupt' | 'crisis' }
  | { type: 'caption'; role: 'user' | 'assistant'; text: string; final?: boolean }
  | { type: 'error'; code: string }
  | { type: 'receipt'; receipt: CallReceipt };

export function voiceSocketUrl(base: string, path: string) {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || url.pathname !== '/v1/voice/socket' || url.search || url.hash)
    throw new Error('Invalid call connection.');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function callOptions(list: VoiceListing) {
  return [...list.stock, ...list.designed.map((v) => ({ id: `designed:${v.id}`, name: v.name, engine: 'Designed voice' }))];
}

export function voiceError(code: string) {
  switch (code) {
    case 'floor_blocked': return 'The call’s safety check stopped this turn.';
    case 'floor_unavailable': return 'The safety check is temporarily unavailable.';
    case 'funded_key_required': case 'insufficient_credits': return 'Add funds to continue calling.';
    case 'key_budget_exceeded': case 'key_cap_reached': return 'This key reached its spend limit.';
    case 'region_blocked': case 'age_proof_required': return 'Voice access is restricted in your region.';
    case 'voice_not_found': return 'This voice is unavailable. Choose another voice.';
    case 'rate_limited': case 'voice_busy': return 'The call is busy. Try again shortly.';
    default: return 'The voice service couldn’t complete this turn.';
  }
}
