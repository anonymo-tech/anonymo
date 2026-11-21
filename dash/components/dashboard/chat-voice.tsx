'use client';

import { Square, Volume2 } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { AnonymoClient } from '@/lib/anonymo/client';
import { speechChunks, speechQuote, speechRate, transcriptionRate, type VoiceModels } from '@/lib/anonymo/talk';
import type { Turn } from './chat-types';

async function playBuffer(context: AudioContext, buffer: AudioBuffer, signal: AbortSignal) {
  if (signal.aborted) return;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const stop = () => source.stop();
  await new Promise<void>((resolve) => {
    source.onended = () => {
      signal.removeEventListener('abort', stop);
      source.disconnect();
      resolve();
    };
    source.start();
    signal.addEventListener('abort', stop, { once: true });
  });
}

export function useChatVoice({ enabled, client, chatId, turns, refreshBalance }: {
  enabled: boolean; client: AnonymoClient; chatId: string | null; turns: Turn[]; refreshBalance: () => void;
}) {
  const [models, setModels] = useState<VoiceModels>({});
  const [available, setAvailable] = useState(false);
  const [selectedVoice, setVoice] = useState('af_alloy');
  const [speed, setSpeed] = useState(1);
  const [autoRead, setAutoRead] = useState(false);
  const [playing, setPlaying] = useState<{ id: string; waiting: boolean } | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const context = useRef<AudioContext | null>(null);
  const playback = useRef<AbortController | null>(null);
  const before = useRef({ chatId, turns, enabled });
  const speech = enabled ? models.speech : undefined;
  const voice = speech?.voices.includes(selectedVoice) ? selectedVoice : speech?.voices[0];

  useEffect(() => {
    setModels({});
    setAvailable(false);
    if (!enabled) return;
    const abort = new AbortController();
    client.voiceModels(abort.signal).then(
      (list) => { if (!abort.signal.aborted) { setModels(list); setAvailable(true); } },
      () => { if (!abort.signal.aborted) setAvailable(true); },
    );
    return () => {
      abort.abort();
      const audio = context.current;
      context.current = null;
      if (audio) void audio.close().catch(() => {});
    };
  }, [client, enabled]);

  const stop = useCallback(() => {
    playback.current?.abort();
    playback.current = null;
    setPlaying(null);
  }, []);
  useEffect(() => {
    stop();
    setFailure(null);
    return () => { playback.current?.abort(); };
  }, [chatId, client, enabled, stop]);

  function arm() {
    try {
      const audio = context.current ??= new AudioContext();
      return audio.state === 'running' ? Promise.resolve() : audio.resume();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function read(turn: Turn, automatic = false) {
    if (!speech || !voice || turn.model === 'anonymo-sealed' || !turn.content.trim()) return;
    if (automatic && context.current?.state !== 'running') return;
    stop();
    const controller = new AbortController();
    const { signal } = controller;
    playback.current = controller;
    setFailure(null);
    setPlaying({ id: turn.id, waiting: true });
    let requested = false;
    try {
      await arm();
      const audio = context.current;
      if (signal.aborted || !audio) return;
      for (const chunk of speechChunks(turn.content, speech.max_chars)) {
        setPlaying({ id: turn.id, waiting: true });
        requested = true;
        const wav = await client.speak(chunk, voice, speed, signal, speech.id);
        if (signal.aborted) break;
        const decoded = await audio.decodeAudioData(wav);
        if (signal.aborted) break;
        setPlaying({ id: turn.id, waiting: false });
        await playBuffer(audio, decoded, signal);
        if (signal.aborted) break;
      }
    } catch {
      if (!signal.aborted) setFailure({ id: turn.id, message: 'Could not play this reply.' });
    } finally {
      if (requested) refreshBalance();
      if (playback.current === controller) stop();
    }
  }

  useEffect(() => {
    const previous = before.current;
    before.current = { chatId, turns, enabled };
    if (!autoRead || !enabled || !previous.enabled || previous.chatId !== chatId) return;
    const latest = turns.at(-1);
    if (!latest || latest.status !== 'done') return;
    if (previous.turns.at(-1)?.id === latest.id && previous.turns.at(-1)?.status === 'done') return;
    void read(latest, true);
  });

  return {
    speech, transcription: enabled ? models.transcription : undefined, available, voice, setVoice, speed, setSpeed,
    autoRead, playing, failure, read, stop,
    prepare: () => { if (speech && autoRead) void arm().catch(() => {}); },
    toggleAutoRead: (on: boolean) => {
      setAutoRead(on);
      if (on) void arm().catch(() => {});
    },
  };
}

export const ChatVoiceContext = createContext<ReturnType<typeof useChatVoice> | null>(null);

export function VoiceReply({ turn }: { turn: Turn }) {
  const voice = useContext(ChatVoiceContext);
  if (!voice?.speech || turn.model === 'anonymo-sealed' || !turn.content.trim()) return null;
  const active = voice.playing?.id === turn.id;
  const label = active ? (voice.playing?.waiting ? 'Cancel audio' : 'Stop audio') : 'Read reply';
  const amount = speechQuote(voice.speech, turn.content);
  return (
    <span className="voice-reply">
      <button type="button" className="btn btn-small btn-ghost" aria-label={active ? label : `${label}, ${amount}`}
        onClick={() => active ? voice.stop() : void voice.read(turn)}>
        {active ? <Square size={13} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
        {active ? label : amount}
      </button>
      {voice.failure?.id === turn.id && <span role="status">{voice.failure.message}</span>}
    </span>
  );
}

export function VoiceSettings({ sealed }: { sealed: boolean }) {
  const voice = useContext(ChatVoiceContext);
  if (!voice?.available) return null;
  return (
    <details className="voice-settings">
      <summary>Voice settings</summary>
      <div>
        {sealed && <p>Voice is unavailable in sealed chat.</p>}
        {voice.transcription && <p>Hold to talk · {transcriptionRate(voice.transcription)}</p>}
        {voice.speech && (
          <>
            <p>Read replies · {speechRate(voice.speech)}</p>
            <label>
              Voice
              <select value={voice.voice} onChange={(e) => voice.setVoice(e.target.value)}>
                {voice.speech.voices.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
            <label>
              Speed
              <select value={voice.speed} onChange={(e) => voice.setSpeed(Number(e.target.value))}>
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
              </select>
            </label>
            <label><input type="checkbox" checked={voice.autoRead} onChange={(e) => voice.toggleAutoRead(e.target.checked)} /> Auto-read replies</label>
          </>
        )}
        {!voice.speech && !voice.transcription && <p>Voice is unavailable on this gateway.</p>}
      </div>
    </details>
  );
}
