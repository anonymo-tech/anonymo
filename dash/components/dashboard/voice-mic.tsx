'use client';

import { Mic } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AnonymoClient } from '@/lib/anonymo/client';
import { demoVoiceWav } from '@/lib/anonymo/mock/talk';
import { captureVoice, microphoneError } from '@/lib/anonymo/voice-capture';
import { createVoiceRecorder, type RecorderState } from '@/lib/anonymo/voice-recorder';
import { transcriptionRate, type TranscriptionModel } from '@/lib/anonymo/talk';

export function VoiceMic({ model, client, demo, disabled, onText, beforeRecord, onCharge }: {
  model: TranscriptionModel;
  client: AnonymoClient;
  demo: boolean;
  disabled: boolean;
  onText: (text: string) => void;
  beforeRecord: () => void;
  onCharge: () => void;
}) {
  const [state, setState] = useState<RecorderState>('idle');
  const [reading, setReading] = useState({ level: 0, seconds: 0 });
  const [error, setError] = useState('');
  const callbacks = useRef({ onText, onCharge });
  const recorder = useRef<ReturnType<typeof createVoiceRecorder> | null>(null);
  const held = useRef<number | string | null>(null);
  useEffect(() => { callbacks.current = { onText, onCharge }; }, [onText, onCharge]);

  useEffect(() => {
    setState('idle');
    setError('');
    const onLevel = (level: number, seconds: number) => setReading({ level, seconds });
    const engine = createVoiceRecorder({
      async capture(signal, onLimit) {
        if (!demo) return captureVoice({ signal, model, onLimit, onLevel });
        const start = performance.now();
        onLevel(0, 0);
        const tick = setInterval(() => {
          const seconds = (performance.now() - start) / 1000;
          onLevel(0.2 + 0.52 * Math.abs(Math.sin(seconds * 7)), seconds);
          if (seconds >= model.max_seconds) onLimit();
        }, 80);
        const stop = () => clearInterval(tick);
        signal.addEventListener('abort', stop, { once: true });
        return { async stop() { stop(); return new File([demoVoiceWav()], 'clip.wav', { type: 'audio/wav' }); } };
      },
      async transcribe(file, signal) {
        try { return (await client.transcribe(file, signal)).text; }
        finally { callbacks.current.onCharge(); }
      },
      onState(phase) {
        if (phase === 'idle' || phase === 'transcribing') held.current = null;
        setState(phase);
      },
      onText(text) {
        if (text.trim()) callbacks.current.onText(text.trim());
        else setError('No speech heard. Try again.');
      },
      onError(error, duringCapture) {
        setError(duringCapture ? microphoneError(error) : 'Could not transcribe. Try again.');
      },
    });
    recorder.current = engine;
    const cancel = () => { held.current = null; engine.cancel(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    const hide = () => { if (document.hidden) cancel(); };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hide);
    return () => {
      held.current = null;
      engine.dispose();
      recorder.current = null;
      window.removeEventListener('keydown', escape);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [client, demo, model]);

  useEffect(() => {
    if (disabled) {
      held.current = null;
      recorder.current?.cancel();
    }
  }, [disabled]);

  const press = () => {
    beforeRecord();
    setError('');
    void recorder.current?.press();
  };
  const release = () => {
    held.current = null;
    if (state === 'requesting') setError('Hold again after allowing the microphone.');
    void recorder.current?.release();
  };
  const cancel = () => {
    held.current = null;
    recorder.current?.cancel();
  };
  const seconds = Math.floor(reading.seconds);
  return (
    <div className="voice-mic">
      {state === 'recording' && (
        <span className="voice-meter">
          <meter min={0} max={1} value={reading.level} aria-label="Microphone level" />
          <span className="mono">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
        </span>
      )}
      <button
        type="button" className="btn btn-ghost voice-mic-button" aria-label="Hold to talk"
        title={`Hold to talk · ${transcriptionRate(model)}`} disabled={disabled || state === 'transcribing'}
        aria-pressed={state === 'requesting' || state === 'recording'}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || held.current !== null || state !== 'idle') return;
          held.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          press();
        }}
        onPointerUp={(event) => { if (held.current === event.pointerId) release(); }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerCancel={cancel}
        onLostPointerCapture={(event) => { if (held.current === event.pointerId) cancel(); }}
        onKeyDown={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return;
          event.preventDefault();
          if (event.repeat || held.current !== null || state !== 'idle') return;
          held.current = event.key;
          press();
        }}
        onKeyUp={(event) => {
          if (event.key !== held.current) return;
          event.preventDefault();
          release();
        }}
        onBlur={() => { if (typeof held.current === 'string') cancel(); }}
        onClick={(event) => {
          if (event.detail !== 0) return;
          if (state === 'idle') press();
          else if (state === 'recording' || state === 'requesting') release();
        }}
      >
        <Mic size={17} aria-hidden="true" />
      </button>
      <span className="voice-mic-status" role="status">
        {error || (state === 'requesting' ? 'Waiting for microphone…' : state === 'transcribing' ? 'Transcribing…' : '')}
      </span>
    </div>
  );
}
