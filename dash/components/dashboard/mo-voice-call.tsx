'use client';

import './mo-voice.css';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AudioLines, Download, Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CompanionDisclosure, CrisisNotice, RegionPage, useCompanionCompliance } from './companion-compliance';
import { buildCharacterMessages } from '@/lib/anonymo/card';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { describeError } from '@/lib/anonymo/client';
import { API_BASE } from '@/lib/anonymo/config';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { callOptions, voiceError, type CallReceipt, type VoiceEvent, type VoiceListing } from '@/lib/anonymo/mo-voice';
import { CallPlayback, connectCall, type CallConnection } from '@/lib/anonymo/mo-voice-browser';
import { AI_NOTICE } from '@/lib/anonymo/safety';
import { characterDestination, setupHref } from '@/lib/anonymo/setup-return';
import { updateOn } from '@/lib/anonymo/updates';
import { stockVoiceLabel } from '@/lib/anonymo/voice';

type Phase = 'lobby' | 'connecting' | 'live' | 'ending';
type Caption = { user?: string; assistant?: string };
const EMPTY = { stock: [], designed: [] };

export function MoVoiceCall() {
  const { client, demo, key, refreshBalance } = useAnonymo();
  const requested = useSearchParams().get('character');
  const characters = useDeviceStore(charactersStore);
  const [callee, setCallee] = useState(requested ?? '');
  const character = characters.find((item) => item.id === callee);
  const destination = characterDestination('mo-voice', character?.id);
  const [listing, setListing] = useState<VoiceListing>(EMPTY);
  const [selected, setSelected] = useState('');
  const [phase, setPhase] = useState<Phase>('lobby');
  const [line, setLine] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('Listening');
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [caption, setCaption] = useState<Caption>({});
  const [crisis, setCrisis] = useState(false);
  const [disclosed, setDisclosed] = useState(false);
  const [receipt, setReceipt] = useState<CallReceipt | null>(null);
  const [callId, setCallId] = useState('');
  const connection = useRef<CallConnection | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const playback = useRef<CallPlayback | null>(null);
  const pending = useRef<AbortController | null>(null);
  const ending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const receivedReceipt = useRef(false);
  const disclosure = useRef<(text: string) => { aiReminder: boolean; crisis: boolean }>(() => ({ aiReminder: false, crisis: false }));
  const compliance = useCompanionCompliance(client, updateOn('compliance', demo), phase === 'live', callId);
  useEffect(() => { disclosure.current = compliance.takeSignals; });

  const options = callOptions(listing);
  const voice = options.some((item) => item.id === selected) ? selected : options[0]?.id ?? '';
  const who = character?.card.data.name ?? 'Mo';

  useEffect(() => {
    const ctl = new AbortController();
    if (key) {
      const load = demo
        ? import('@/lib/anonymo/mock/mo-voice').then((module) => module.demoVoiceList(client, ctl.signal))
        : client.moVoiceList(ctl.signal);
      void load.then((list) => { if (!ctl.signal.aborted) setListing(list); },
        (error) => { if (!ctl.signal.aborted) setNote(describeError(error)); });
    }
    return () => ctl.abort();
  }, [client, demo, key]);

  function release() {
    clearTimeout(ending.current);
    pending.current?.abort();
    pending.current = null;
    connection.current?.close();
    connection.current = null;
    playback.current?.stop();
    playback.current = null;
    if (audio.current) void audio.current.close().catch(() => undefined);
    audio.current = null;
  }

  useEffect(() => {
    setPhase('lobby');
    setCaption({});
    setReceipt(null);
    setListing(EMPTY);
    window.addEventListener('pagehide', release);
    return () => { window.removeEventListener('pagehide', release); release(); };
  }, [client]);

  useEffect(() => {
    if (!compliance.restricted) return;
    release();
    setPhase('lobby');
    setCaption({});
  }, [compliance.restricted]);

  function event(message: VoiceEvent) {
    switch (message.type) {
      case 'ready':
        setCallId(message.id);
        setPhase('live');
        break;
      case 'interrupt':
        playback.current?.stop();
        setCaption({});
        setCrisis(false);
        setDisclosed(false);
        break;
      case 'listening': case 'idle':
        setStatus('Listening');
        break;
      case 'thinking':
        setStatus('Thinking');
        break;
      case 'caption':
        setCaption((old) => ({ ...old, [message.role]: message.text }));
        if (message.role === 'user' && message.final) {
          const signals = disclosure.current(message.text);
          setDisclosed(signals.aiReminder);
          if (signals.crisis) setCrisis(true);
        }
        break;
      case 'crisis':
        playback.current?.stop();
        setCrisis(true);
        setStatus('Listening');
        break;
      case 'error':
        setNote(voiceError(message.code));
        setStatus('Listening');
        break;
      case 'receipt':
        receivedReceipt.current = true;
        setReceipt(message.receipt);
        setCaption({});
        setCrisis(false);
        setDisclosed(false);
        release();
        setPhase('lobby');
        refreshBalance();
        break;
    }
  }

  async function start() {
    if (pending.current || !voice) return;
    const ctl = new AbortController();
    pending.current = ctl;
    receivedReceipt.current = false;
    setReceipt(null);
    setNote('');
    setMuted(false);
    setCrisis(false);
    setDisclosed(false);
    setCaption({});
    setStatus('Listening');
    setPhase('connecting');
    const direction = character ? buildCharacterMessages(character.card, []).messages
      .filter((m) => m.role === 'system').map((m) => m.content).join('\n\n').slice(0, 4000) : undefined;
    try {
      if (demo) {
        const { demoCall } = await import('@/lib/anonymo/mock/mo-voice');
        if (!ctl.signal.aborted) connection.current = demoCall(client, direction, event);
        return;
      }
      const sound = new AudioContext({ sampleRate: 48_000 });
      audio.current = sound;
      const output = new CallPlayback(sound, setPlaying);
      playback.current = output;
      await sound.resume();
      const call = await connectCall({
        base: API_BASE, ticket: () => client.moVoiceConnect(ctl.signal), audio: sound, voice, character: direction,
        signal: ctl.signal, event, audioOut: (wav) => output.append(wav),
        closed: () => {
          if (ctl.signal.aborted) return;
          release();
          setCaption({});
          setPhase('lobby');
          if (!receivedReceipt.current) setNote((old) => old || 'The call disconnected before its receipt arrived.');
          refreshBalance();
        },
      });
      if (ctl.signal.aborted) call.close();
      else connection.current = call;
    } catch (error) {
      if (ctl.signal.aborted) return;
      release();
      setPhase('lobby');
      setNote(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Allow microphone access to start the call.' : describeError(error));
    }
  }

  function hangup() {
    playback.current?.stop();
    setCaption({});
    if (!connection.current || phase === 'connecting') {
      release();
      setPhase('lobby');
      return;
    }
    setPhase('ending');
    ending.current = setTimeout(() => {
      release();
      setPhase('lobby');
      setNote('The call ended before its receipt arrived.');
      refreshBalance();
    }, 20_000);
    connection.current.hangup();
  }

  if (compliance.restricted) return <RegionPage client={client} mode={compliance.restricted} onVerified={compliance.refresh} />;

  return (
    <div className="panel-stack mv-workspace">
      <header className="ws-head"><h1>Mo Voice</h1><p>Call a character or talk with Mo.</p></header>
      {!key ? <div className="notice row"><span>Connect a funded API key to make a call.</span><Link className="btn btn-primary" href={setupHref('key', destination)}>Set up a key</Link></div> : (
        <section className="panel mv-stage" data-live={phase === 'live'}>
          <div className="mv-call-heading">
            <AudioLines size={32} aria-hidden="true" />
            <p className="muted">{AI_NOTICE} · Adults only</p>
            <h2>{who}</h2>
            <p role="status">{phase === 'connecting' ? 'Connecting…' : phase === 'ending' ? 'Preparing receipt…' : phase === 'live' ? muted ? 'Microphone muted' : playing ? 'Speaking' : status : 'Ready to call'}</p>
          </div>
          {phase === 'lobby' ? (
            <div className="mv-controls">
              <label className="field"><span>Call</span><select className="select" value={callee} onChange={(e) => setCallee(e.target.value)}>
                <option value="">Mo</option>
                {characters.map((item) => <option key={item.id} value={item.id}>{item.card.data.name}</option>)}
              </select></label>
              <label className="field"><span>Voice</span><select className="select" value={voice} onChange={(e) => setSelected(e.target.value)}>
                {!options.length && <option value="">No voices available</option>}
                {options.map((item) => <option key={item.id} value={item.id}>{item.engine === 'Designed voice' ? item.name : stockVoiceLabel(item.name).name} · {item.engine}</option>)}
              </select></label>
              <button className="btn btn-primary" disabled={!voice} onClick={() => void start()}><Phone size={17} aria-hidden="true" /> Start call</button>
              <p className="muted">Talk to interrupt. Audio and captions aren’t recorded. AI speech is $1.80 per hour, plus transcription and chat usage.</p>
              <Link href="/dashboard/voices">Design a voice</Link>
            </div>
          ) : (
            <div className="mv-controls">
              <div className="mv-captions" role="region" aria-label="Live captions" tabIndex={0}>
                {caption.user && <p><strong>You</strong>{caption.user}</p>}
                {caption.assistant && <p><strong>{who}</strong>{caption.assistant}</p>}
              </div>
              {crisis && <CrisisNotice />}
              {(disclosed || compliance.disclosure) && <CompanionDisclosure />}
              <div className="row">
                <button className="btn" disabled={phase !== 'live'} aria-pressed={muted} onClick={() => { connection.current?.mute(!muted); setMuted(!muted); }}>
                  {muted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />} {muted ? 'Unmute' : 'Mute'}
                </button>
                <button className="btn btn-primary" disabled={phase === 'ending'} onClick={hangup}><PhoneOff size={17} aria-hidden="true" /> Hang up</button>
              </div>
              {demo && phase === 'live' && <form className="row" onSubmit={(e) => { e.preventDefault(); connection.current?.typeLine?.(line); setLine(''); }}>
                <input className="input" aria-label="Type a line" value={line} onChange={(e) => setLine(e.target.value)} />
                <button className="btn" disabled={!line.trim()}>Send</button>
              </form>}
            </div>
          )}
        </section>
      )}
      {note && <p className="notice" role="alert">{note} {phase === 'lobby' && key && <Link href={setupHref('funds', destination)}>Add funds</Link>}</p>}
      {receipt && <Receipt receipt={receipt} />}
    </div>
  );
}

function Receipt({ receipt }: { receipt: CallReceipt }) {
  const { payload: p } = receipt;
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mo-voice-receipt.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="panel mv-receipt">
    <header className="row"><h2>Call receipt</h2><button className="btn btn-small" onClick={download}><Download size={15} aria-hidden="true" /> Download</button></header>
    <dl>
      <div><dt>Transcription seconds</dt><dd>{p.stt_seconds.toFixed(2)}</dd></div>
      <div><dt>LLM tokens</dt><dd>{(p.llm_tokens.in + p.llm_tokens.out).toLocaleString()}</dd></div>
      <div><dt>Speech characters</dt><dd>{p.tts_characters.toLocaleString()}</dd></div>
      <div><dt>Total charged</dt><dd>${p.cost}</dd></div>
    </dl>
    {p.routes.length > 0 && <ol aria-label="Routes used">{p.routes.map((route, index) =>
      <li key={`${index}-${route.route}`}>{route.route}{route.refused ? ' · refused · $0' : ''}</li>)}</ol>}
  </section>;
}
