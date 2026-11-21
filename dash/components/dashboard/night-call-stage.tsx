'use client';

// Update "voice" (Night Call): what the call looks like. The mascot in its gold headphones in the middle of the
// screen, soft rings that swell from the headphone cups with the loudness of the voice, and a line of gold stitches
// across the screen that follows the microphone while the person talks and the voice while it speaks. Also the voice
// picker and the crisis lines, which the lobby and the call screen share.

import { Volume2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Photo } from '@/components/photo';
import { CRISIS_LINES } from '@/lib/anonymo/safety';
import type { MediaSpeechModel } from '@/lib/anonymo/types';
import { formatCents, inLanguage, speechCostMusd, speechMusdPerMinute, stockVoiceLabel, VOICE_SAMPLE } from '@/lib/anonymo/voice';
import type { Scope, VoiceChoice } from '@/lib/anonymo/voice-browser';

const STITCH = 11; // length of one stitch, in CSS pixels
const GAP = 8;
/** How far the outer face of a headphone cup is from the middle of the photo, as a share of the wave's height (voice.css). */
const CUP_REACH = 0.56;

/**
 * The mascot, its rings and the stitched wave. `scope` is whatever is making sound right now (the microphone or the
 * voice), or null in silence. Loudness is written to a CSS variable and the wave to a canvas, so nothing here
 * re-renders while a call runs. With reduced motion the stitches lie flat and the rings hold still.
 */
export function CallStage({ scope, mode, dim }: { scope: Scope | null; mode: string; dim: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<Scope | null>(scope);
  useEffect(() => {
    source.current = scope;
  }, [scope]);

  useEffect(() => {
    const el = stage.current;
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!el || !cv || !ctx) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const samples = new Float32Array(256);
    let frame = 0;
    let width = 0;
    let height = 0;
    let level = 0;
    const gold = getComputedStyle(el).getPropertyValue('--amber').trim() || '#f6b84b';

    const draw = (time: number) => {
      const scopeNow = still.matches ? null : source.current;
      const target = scopeNow ? scopeNow.level() : 0;
      level += (target - level) * (target > level ? 0.35 : 0.12);
      el.style.setProperty('--nc-level', level.toFixed(3));
      if (scopeNow) scopeNow.wave(samples);
      else samples.fill(0);
      ctx.clearRect(0, 0, width, height);
      const mid = height / 2;
      const reach = height * 0.42;
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = gold;
      const breath = still.matches ? 0 : Math.sin(time / 1400) * 1.6;
      // The canvas is centred on the mascot and half as tall as it, so the headphone cups sit this far either side of
      // the middle. The thread runs into one cup and out of the other; it is never drawn across the face.
      const centre = width / 2;
      const cup = height * CUP_REACH;
      const y = (x: number) => {
        const u = Math.min(1, Math.max(0, x / width));
        // Still where it meets a cup and at both edges of the screen, so it looks sewn in at each end.
        const fromCup = Math.min(1, Math.max(0, (Math.abs(x - centre) - cup) / Math.max(40, width * 0.1)));
        const taper = Math.sin(u * Math.PI) ** 0.6 * fromCup ** 0.8;
        const i = Math.min(samples.length - 1, Math.floor(u * samples.length));
        return mid + (samples[i] * reach + breath * Math.sin(u * 9 + time / 900)) * taper;
      };
      for (let x = GAP / 2; x < width; x += STITCH + GAP) {
        if (Math.abs(x + STITCH / 2 - centre) < cup) continue;
        const u = x / width;
        ctx.globalAlpha = 0.28 + 0.6 * Math.sin(u * Math.PI) ** 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y(x));
        ctx.lineTo(Math.min(width, x + STITCH), y(x + STITCH));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (!still.matches) frame = requestAnimationFrame(draw);
    };

    const size = () => {
      const box = cv.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = box.width;
      height = box.height;
      cv.width = Math.max(1, Math.round(width * ratio));
      cv.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (still.matches) draw(0);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      size();
      if (!still.matches) frame = requestAnimationFrame(draw);
    };
    const watch = new ResizeObserver(size);
    watch.observe(cv);
    still.addEventListener('change', restart);
    restart();
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      still.removeEventListener('change', restart);
    };
  }, []);

  return (
    <div className="nc-stage" ref={stage} data-mode={mode} data-dim={dim}>
      <div className="nc-mascot">
        <Photo src="/mascot/headphones.jpg" alt="The Anonymo plush in a sleep mask and gold headphones, listening." width={640} height={640} loading="eager" />
        <canvas className="nc-wave" ref={canvas} aria-hidden="true" />
        <span className="nc-rings nc-rings-left" aria-hidden="true"><i /><i /><i /></span>
        <span className="nc-rings nc-rings-right" aria-hidden="true"><i /><i /><i /></span>
      </div>
    </div>
  );
}

const same = (a: VoiceChoice, b: VoiceChoice) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Both kinds of voice, each with a "Hear it" sample. This device's voices are free and keep the reply's text in the
 * browser. Stock voices are paid, so every stock row and its sample show the price before they are pressed.
 */
export function VoicePicker({ device, lang, stock, choice, speed, demo, sampling, onPick, onHear }: {
  device: SpeechSynthesisVoice[];
  lang: string;
  stock: MediaSpeechModel[] | null;
  choice: VoiceChoice;
  speed: number;
  demo: boolean;
  /** The voice whose sample is playing, so its button can say so. */
  sampling: VoiceChoice | null;
  onPick: (choice: VoiceChoice) => void;
  onHear: (choice: VoiceChoice) => void;
}) {
  const near = inLanguage(device, lang);
  const row = (key: string, value: VoiceChoice, name: string, note: string | null, price: string | null, sample: string | null) => (
    <li key={key} className="nc-voice" data-on={same(choice, value)}>
      <label>
        <input type="radio" name="nc-voice" checked={same(choice, value)} onChange={() => onPick(value)} />
        <span className="nc-voice-name">{name}</span>
        {note && <small>{note}</small>}
        {price && <span className="chip chip-amber">{price}</span>}
      </label>
      <button type="button" className="btn btn-small" onClick={() => onHear(value)} aria-label={`Hear ${name}${sample ? `, ${sample}` : ''}`}>
        <Volume2 size={14} aria-hidden="true" />
        {sampling && same(sampling, value) ? 'Playing…' : `Hear it${sample ? ` · ${sample}` : ''}`}
      </button>
    </li>
  );
  const deviceRow = (v: SpeechSynthesisVoice) => row(`d:${v.voiceURI}`, { kind: 'device', uri: v.voiceURI }, v.name, v.lang, null, null);
  return (
    <div className="nc-voices">
      <section aria-labelledby="nc-voices-device">
        <header>
          <h3 id="nc-voices-device">This device</h3>
          <span className="chip chip-signal">Free</span>
        </header>
        <p className="lede">Spoken by your device. The words of the reply never leave this browser.</p>
        {device.length === 0 ? (
          <p className="nc-empty">This browser offers no voice that runs on the device, so there is nothing free to pick here.</p>
        ) : (
          <>
            <ul>{device.slice(0, near || device.length).map(deviceRow)}</ul>
            {near > 0 && near < device.length && (
              <details className="field-help">
                <summary>More languages ({device.length - near})</summary>
                <ul>{device.slice(near).map(deviceRow)}</ul>
              </details>
            )}
          </>
        )}
      </section>
      <section aria-labelledby="nc-voices-stock">
        <header>
          <h3 id="nc-voices-stock">Stock voices</h3>
          <span className="chip chip-amber">Paid</span>
        </header>
        <p className="lede">
          Spoken by the gateway. Each sentence of the reply is sent to be read aloud and charged by its length. Stock voices only: Anonymo never takes a voice sample.
          {demo && ' In demo mode a stock voice plays a soft tone instead of speech.'}
        </p>
        {stock === null ? (
          <p className="nc-empty">Looking for stock voices…</p>
        ) : stock.length === 0 ? (
          <p className="nc-empty">No stock voice is switched on for this gateway yet.</p>
        ) : (
          stock.map((m) => {
            const minute = `${formatCents(speechMusdPerMinute(m.pricing.usd_per_1k_chars, speed))} a minute`;
            const sample = formatCents(speechCostMusd(m.pricing.usd_per_1k_chars, VOICE_SAMPLE.length));
            return (
              <div key={m.id} className="nc-voice-model">
                <p className="nc-voice-price">
                  <strong>{m.name}</strong> · about {minute} of speech
                </p>
                <ul>
                  {m.voices.map((id) => {
                    const { name, note } = stockVoiceLabel(id);
                    return row(`s:${m.id}:${id}`, { kind: 'stock', model: m.id, voice: id }, name, note, minute, sample);
                  })}
                </ul>
              </div>
            );
          })
        )}
      </section>
      <section aria-labelledby="nc-voices-none">
        <header>
          <h3 id="nc-voices-none">No voice</h3>
          <span className="chip chip-signal">Free</span>
        </header>
        <ul>
          <li className="nc-voice" data-on={choice.kind === 'silent'}>
            <label>
              <input type="radio" name="nc-voice" checked={choice.kind === 'silent'} onChange={() => onPick({ kind: 'silent' })} />
              <span className="nc-voice-name">Captions only</span>
              <small>The reply is shown, not spoken</small>
            </label>
          </li>
        </ul>
      </section>
    </div>
  );
}

/** Shown with any message that mentions suicide or self-harm, as in the chat thread. It never blocks the call. */
export function CrisisLines() {
  return (
    <aside className="notice crisis-notice" aria-label="Crisis support">
      <strong>If you’re thinking about suicide or hurting yourself, you can talk to a person right now.</strong>
      <p className="muted">Free and confidential. If you’re in immediate danger, call your local emergency number.</p>
      <ul>
        {CRISIS_LINES.map((l) => (
          <li key={l.href}>
            <span className="crisis-where">{l.where} ·</span> {l.what}:{' '}
            <a href={l.href} {...(l.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
              {l.action}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
