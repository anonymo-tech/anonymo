// Update "voice" (Night Call): the voice and pace last picked, kept on this device like the other small choices in
// lib/anonymo/prefs.ts. It names a voice and nothing else: no text, no audio. "Wipe this device" removes it.

import { deviceStore, readJson, writeJson } from './device-store.ts';
import { PACES, type PaceId } from './voice.ts';

const SLOT = 'anonymo.voice.v1';

export type SavedVoice = { kind: 'device'; uri: string } | { kind: 'stock'; model: string; voice: string } | { kind: 'silent' };
export type VoicePrefs = { voice: SavedVoice | null; pace: PaceId; handsFree: boolean };

const FALLBACK: VoicePrefs = { voice: null, pace: 'even', handsFree: false };

function read(): VoicePrefs {
  const raw = readJson<Partial<VoicePrefs> | null>(SLOT, null);
  const v = raw?.voice as Record<string, unknown> | null | undefined;
  let voice: SavedVoice | null = null;
  if (v?.kind === 'device' && typeof v.uri === 'string') voice = { kind: 'device', uri: v.uri };
  else if (v?.kind === 'stock' && typeof v.model === 'string' && typeof v.voice === 'string') voice = { kind: 'stock', model: v.model, voice: v.voice };
  else if (v?.kind === 'silent') voice = { kind: 'silent' };
  const pace = PACES.find((p) => p.id === raw?.pace)?.id ?? FALLBACK.pace;
  return { voice, pace, handsFree: raw?.handsFree === true };
}

export const voicePrefsStore = deviceStore<VoicePrefs>(read, FALLBACK);

export function saveVoicePrefs(change: Partial<VoicePrefs>) {
  writeJson(SLOT, { ...voicePrefsStore.get(), ...change });
  voicePrefsStore.changed();
}
