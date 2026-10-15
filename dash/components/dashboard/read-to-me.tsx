'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {useClientReady} from './use-device-setting';
import { speechChunks } from '../../lib/read-aloud';
export function ReadToMe({ text }: { text: string }) {
  const id = useId(),
    ready=useClientReady(),
    supported=ready && 'speechSynthesis' in window,
    [state, setState] = useState<'idle' | 'reading' | 'paused'>('idle'),
    [rate, setRate] = useState(1),
    [error, setError] = useState('');
  const active = useRef(false),
    generation = useRef(0);
  function stop() {
    generation.current++;
    if (active.current) window.speechSynthesis.cancel();
    active.current = false;
    setState('idle');
  }
  useEffect(() => {
    const other = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) stop();
    };
    window.addEventListener('conclave:read-aloud', other);
    return () => {
      window.removeEventListener('conclave:read-aloud', other);
      // Operation tokens intentionally use the latest value when speech is cancelled.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      if (active.current) window.speechSynthesis.cancel();
    };
  }, [id]);
  function play() {
    const speech = window.speechSynthesis;
    if (state === 'paused') {
      speech.resume();
      setState('reading');
      return;
    }
    window.dispatchEvent(
      new CustomEvent('conclave:read-aloud', { detail: id }),
    );
    speech.cancel();
    const version = ++generation.current;
    active.current = true;
    setError('');
    setState('reading');
    const chunks = speechChunks(text);
    let cursor = 0;
    function next() {
      if (version !== generation.current) return;
      if (cursor === chunks.length) {
        active.current = false;
        setState('idle');
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[cursor++]);
      utterance.rate = rate;
      utterance.lang = document.documentElement.lang || 'en';
      utterance.onend = next;
      utterance.onerror = (e) => {
        if (version !== generation.current) return;
        active.current = false;
        setState('idle');
        if (e.error !== 'canceled' && e.error !== 'interrupted')
          setError('Your browser could not read this answer.');
      };
      speech.speak(utterance);
    }
    next();
  }
  if (!supported) return null;
  return (
    <div className="eu-controls" aria-label="Read to Me">
      <button
        type="button"
        onClick={() => {
          if (state === 'reading') {
            window.speechSynthesis.pause();
            setState('paused');
          } else play();
        }}
      >
        {state === 'reading'
          ? 'Pause'
          : state === 'paused'
            ? 'Resume'
            : 'Read to Me'}
      </button>
      {state !== 'idle' && (
        <button type="button" onClick={stop}>
          Stop
        </button>
      )}
      <select
        aria-label="Reading speed"
        disabled={state !== 'idle'}
        value={rate}
        onChange={(e) => setRate(Number(e.target.value))}
      >
        {[0.75, 1, 1.25, 1.5, 2].map((value) => (
          <option key={value} value={value}>
            {value}×
          </option>
        ))}
      </select>
      {error && (
        <output className="eu-error">
          {error}
        </output>
      )}
    </div>
  );
}
