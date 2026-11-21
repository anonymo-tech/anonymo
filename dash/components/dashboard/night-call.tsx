'use client';

// Update "voice": Night Call. A full-screen voice call with the model, or with a character. The person talks (or
// types), the reply is spoken sentence by sentence as it streams, and the mascot listens in the middle of the screen.
//
// The conversation is the chat's own (`turns` in anonymo-provider.tsx), built the way chat-workspace.tsx `send` and
// `run` build it, so a call is an ordinary thread when the person goes back to Chat. Nothing is stored or sent beyond
// ordinary gateway calls: the chat request, and with a stock voice one speech request per sentence. Microphone audio
// stays on the device (lib/anonymo/voice-browser.ts), and what was heard goes through the content guard before it is
// sent. The AI notice, the 3-hourly reminder and the crisis lines are on the call screen, never only spoken.

import './voice.css';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlarmClock, BedDouble, Hand, Keyboard, Mic, Phone, PhoneOff, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { isLiveModel, useAnonymo } from '../anonymo-provider';
import { AdultsOnly } from '../brand';
import { Photo } from '../photo';
import type { Turn } from './chat-types';
import { CallStage, CrisisLines, VoicePicker } from './night-call-stage';
import { useContentGuard } from './use-content-guard';
import { applyMacros, buildCharacterMessages, greetingsOf } from '@/lib/anonymo/card';
import { charactersStore } from '@/lib/anonymo/characters-store';
import { describeError, isOutOfCredit } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { keepStore, saveChat } from '@/lib/anonymo/history';
import { usdToMusd } from '@/lib/anonymo/money';
import { modelStore } from '@/lib/anonymo/prefs';
import { AI_NOTICE, AI_REMINDER, mentionsSelfHarm, reminderDue } from '@/lib/anonymo/safety';
import type { AnonymoModelId, ChatMessage, MediaSpeechModel } from '@/lib/anonymo/types';
import { updateOn } from '@/lib/anonymo/updates';
import {
  addClip, addReply, captionAt, captionLines, clock, formatCents, localVoices, NO_COST, PACES, paceSpeed, sentenceFeed, SLEEP_FAREWELL, SLEEP_MINUTES,
  SLEEP_OFF, sleepAllowsSpeech, sleepRemaining, sleepStep, speakable, speechCostMusd, speechMusdPerMinute, splitSentences, stockVoiceLabel, STORY_CONTINUE,
  STORY_MINUTES, STORY_PROMPT, textBoxReason, threadMessages, totalMusd, VOICE_SAMPLE, type CallCost, type CaptionLine, type OnDeviceStatus, type SleepState,
} from '@/lib/anonymo/voice';
import {
  deviceVoices, installListening, keepAwake, listen, listeningLanguage, listeningStatus, MicMeter, onVoicesChanged, primeDeviceVoice, restAudio, Speaker,
  unlockAudio, type Clip, type Listening, type Scope, type VoiceChoice,
} from '@/lib/anonymo/voice-browser';
import { saveVoicePrefs, voicePrefsStore } from '@/lib/anonymo/voice-prefs';

type Phase = 'lobby' | 'live' | 'farewell';
type Mode = 'idle' | 'listening' | 'thinking' | 'speaking';
type Caption = { who: 'you' | 'voice' | 'hint'; text: string };
type Note = { text: string; funds?: boolean };
type Summary = { ms: number; cost: CallCost; reason: 'hangup' | 'sleep' };

/** A reply shorter than this while "keep reading" is on means the story has stopped: nothing more is asked for. */
const STORY_STALLED = 80;
/** With hands-free on and nobody talking, the microphone is given a rest after this long. */
const QUIET_LIMIT_MS = 5 * 60_000;

/** Always the value from the latest render, for timers and callbacks that outlive one. */
function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** State that callbacks can also read right away, before the next render. */
function useSynced<T>(initial: T): [T, RefObject<T>, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, set];
}

/** How many characters fit on one caption line at the caption's size (voice.css `.nc-caption`). */
function captionWidth() {
  const font = Math.min(30, Math.max(20, window.innerWidth * 0.031));
  return Math.max(18, Math.floor(Math.min(window.innerWidth - 44, font * 44) / (font * 0.56)));
}

export function NightCall() {
  const { key } = useAnonymo();
  if (!key)
    return (
      <div className="panel-stack">
        <div className="ws-head">
          <h1>Night Call</h1>
          <p>Talk out loud and hear the reply read back. Adults only.</p>
        </div>
        <div className="notice row">
          <span style={{ flex: 1 }}>Connect an API key to start a call.</span>
          <Link className="btn btn-primary btn-small" href="/dashboard/key">
            Create a key
          </Link>
        </div>
      </div>
    );
  return <Call />;
}

function Call() {
  const { demo, key, client, turns, setTurns, chatId, rememberReceipt, refreshBalance, liveModels } = useAnonymo();
  const stored = useDeviceStore(modelStore);
  // The council answers in one slow block and cannot stream; a call needs a streamed reply, so it uses anonymo-1 then.
  const model: AnonymoModelId = stored !== 'anonymo-council' && isLiveModel(liveModels, stored) ? stored : 'anonymo-1';
  const characters = useDeviceStore(charactersStore);
  const prefs = useDeviceStore(voicePrefsStore);
  const keep = useDeviceStore(keepStore);
  const scan = useContentGuard();
  const requested = useSearchParams().get('character');
  const [characterId, setCharacterId] = useState<string | null>(requested);
  const character = characters.find((c) => c.id === characterId) ?? null;
  const callee = character?.card.data.name ?? null;
  const lang = useMemo(() => listeningLanguage(), []);

  // ---- voices ------------------------------------------------------------------------------------------------------
  const [device, setDevice] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => setDevice(localVoices(deviceVoices(), lang));
    load();
    return onVoicesChanged(load);
  }, [lang]);
  const [stock, setStock] = useState<MediaSpeechModel[] | null>(null);
  useEffect(() => {
    const request = new AbortController();
    client.speechModels(request.signal).then(
      (list) => {
        if (!request.signal.aborted) setStock(list);
      },
      () => {
        if (!request.signal.aborted) setStock([]);
      },
    );
    return () => request.abort();
  }, [client]);

  // A paid voice is never picked for the person: without a saved choice the call starts on a free device voice, or
  // on captions when the device has none.
  const choice = useMemo<VoiceChoice>(() => {
    const saved = prefs.voice;
    if (saved?.kind === 'silent') return saved;
    if (saved?.kind === 'device' && device.some((v) => v.voiceURI === saved.uri)) return saved;
    if (saved?.kind === 'stock' && stock?.some((m) => m.id === saved.model && m.voices.includes(saved.voice))) return saved;
    return device[0] ? { kind: 'device', uri: device[0].voiceURI } : { kind: 'silent' };
  }, [prefs.voice, device, stock]);
  const deviceVoice = choice.kind === 'device' ? (device.find((v) => v.voiceURI === choice.uri) ?? null) : null;
  const stockModel = choice.kind === 'stock' ? (stock?.find((m) => m.id === choice.model) ?? null) : null;
  const speed = paceSpeed(prefs.pace);
  const minuteMusd = stockModel ? speechMusdPerMinute(stockModel.pricing.usd_per_1k_chars, speed) : 0;
  const voiceName = choice.kind === 'device' ? (deviceVoice?.name ?? 'Device voice') : choice.kind === 'stock' ? stockVoiceLabel(choice.voice).name : 'Captions only';
  const voicePrice = choice.kind === 'stock' ? `${formatCents(minuteMusd)} a minute of speech` : choice.kind === 'device' ? 'voice free' : 'captions only';

  const [speaker] = useState(() => new Speaker());
  const [sampler] = useState(() => new Speaker());
  const [mic] = useState(() => new MicMeter());
  useEffect(() => {
    speaker.configure({ choice, speed, deviceVoice, speech: key ? (body, signal) => client.speech(body, signal) : null });
  }, [speaker, choice, speed, deviceVoice, key, client]);

  // ---- listening ---------------------------------------------------------------------------------------------------
  const [listening, listeningRef, setListening] = useSynced<OnDeviceStatus>('unsupported');
  const [settingUp, setSettingUp] = useState(false);
  useEffect(() => {
    let stale = false;
    void listeningStatus(lang).then((status) => {
      if (!stale) setListening(status);
    });
    return () => {
      stale = true;
    };
  }, [lang, setListening]);
  useEffect(() => {
    if (listening !== 'downloading') return;
    const timer = window.setInterval(() => void listeningStatus(lang).then(setListening), 3000);
    return () => window.clearInterval(timer);
  }, [listening, lang, setListening]);

  // ---- the call ----------------------------------------------------------------------------------------------------
  const [phase, phaseRef, setPhase] = useSynced<Phase>('lobby');
  const [mode, modeRef, setMode] = useSynced<Mode>('idle');
  const [sleep, sleepRef, setSleep] = useSynced<SleepState>(SLEEP_OFF);
  const [cost, costRef, setCost] = useSynced<CallCost>(NO_COST);
  const [keepReading, keepReadingRef, setKeepReading] = useSynced(false);
  const [sleepPick, setSleepPick] = useState(0);
  const [caption, setCaption] = useState<Caption>({ who: 'hint', text: '' });
  const [note, setNote] = useState<Note | null>(null);
  const [guardNote, setGuardNote] = useState<{ redacted: string; message: string; original: string } | null>(null);
  const [panel, setPanel] = useState<'voice' | 'sleep' | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [flags, setFlags] = useState({ reminder: false, crisis: false });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sampling, setSampling] = useState<VoiceChoice | null>(null);
  const [sampleNote, setSampleNote] = useState('');
  const [scope, setScope] = useState<Scope | null>(null);

  const dialog = useRef<HTMLDialogElement>(null);
  const talkButton = useRef<HTMLButtonElement>(null);
  const textBox = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const listener = useRef<Listening | null>(null);
  const wake = useRef<(() => void) | null>(null);
  const lines = useRef<CaptionLine[]>([]);
  const pendingScan = useRef(0);
  const lastReply = useRef({ ok: false, chars: 0 });
  const quietSince = useRef(0);
  const press = useRef({ at: 0, ends: false });
  // The AI notice is always on the call screen; this marks when the thread last repeated it (as chat does).
  const noticedAt = useRef(Date.now());
  // This call's own turns, patched the moment they change, so the next message never reads a stale thread.
  const mine = useRef(new Map<string, Turn>());
  const turnsRef = useLatest(turns);
  useEffect(() => {
    mine.current.clear();
  }, [chatId]);

  const streaming = turns.some((t) => t.status === 'streaming');
  const historyOn = updateOn('history', demo);
  useEffect(() => {
    // Update "history": a call is saved like any chat, once the person has turned keeping on.
    if (historyOn && keep && !streaming && mine.current.size) void saveChat(demo, chatId, turns);
  }, [historyOn, keep, streaming, turns, demo, chatId]);

  function freshTurns(): Turn[] {
    const list = turnsRef.current.map((t) => mine.current.get(t.id) ?? t);
    for (const t of mine.current.values()) if (!list.some((x) => x.id === t.id)) list.push(t);
    return list;
  }

  function update(id: string, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) {
    const prior = mine.current.get(id);
    if (prior) mine.current.set(id, { ...prior, ...(typeof patch === 'function' ? patch(prior) : patch) });
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));
  }

  const hint = (): Caption => ({ who: 'hint', text: listeningRef.current === 'available' ? 'Hold Space or the mic, and talk.' : 'Type what you want to say.' });

  function speak(piece: string) {
    const text = speakable(piece);
    if (text && sleepAllowsSpeech(sleepRef.current) && phaseRef.current === 'live') speaker.say(text);
  }

  /** Builds the turn and its messages the way chat does, then runs it. */
  async function send(text: string) {
    const prompt = text.trim();
    if (running.current) {
      controller.current?.abort();
      await running.current.catch(() => undefined);
    }
    if (!prompt || !key || phaseRef.current !== 'live' || !sleepAllowsSpeech(sleepRef.current)) return;
    const thread = freshTurns();
    if (thread.some((t) => t.status === 'streaming')) {
      setNote({ text: 'Another reply is still being written. Give it a moment, then try again.' });
      setMode('idle');
      return;
    }
    setNote(null);
    let messages: ChatMessage[] = [...threadMessages(thread), { role: 'user', content: prompt }];
    if (character) {
      const built = buildCharacterMessages(character.card, messages);
      messages = built.messages.map((m) => ({ role: m.role as ChatMessage['role'], content: typeof m.content === 'string' ? m.content : '' }));
    }
    const id = crypto.randomUUID();
    const aiReminder = reminderDue(noticedAt.current);
    if (aiReminder) noticedAt.current = Date.now();
    const turn: Turn = {
      id,
      model,
      prompt,
      attachment: null,
      character: callee,
      content: '',
      status: 'streaming',
      error: null,
      receiptId: null,
      receipt: null,
      council: null,
      councilMode: null,
      aiReminder,
      crisis: mentionsSelfHarm(prompt),
    };
    mine.current.set(id, turn);
    setTurns((list) => [...list, turn]);
    setFlags((f) => ({ reminder: f.reminder || aiReminder, crisis: f.crisis || turn.crisis === true }));
    setMode('thinking');
    setCaption({ who: 'you', text: prompt });
    const job = run(turn, messages);
    running.current = job;
    await job;
  }

  /** Streams one turn's reply into the thread and the voice, then settles its receipt and the balance. */
  async function run(turn: Turn, messages: ChatMessage[]) {
    const { id } = turn;
    const abort = new AbortController();
    controller.current = abort;
    const feed = sentenceFeed();
    let receiptId: string | null = null;
    let haveReceipt = false;
    try {
      const result = await client.chat(
        { model: turn.model, messages },
        {
          signal: abort.signal,
          headers: { refusalCatch: 'on' },
          onDelta: (delta) => {
            update(id, (t) => ({ content: t.content + delta }));
            if (!abort.signal.aborted) for (const piece of feed.push(delta)) speak(piece);
          },
        },
      );
      receiptId = result.receiptId;
      haveReceipt = result.receipt !== null;
      update(id, { status: 'done', content: result.content, council: result.council, receiptId, receipt: result.receipt });
      lastReply.current = { ok: true, chars: result.content.length };
      if (result.receipt) setCost(addReply(costRef.current, usdToMusd(result.receipt.cost)));
      if (!abort.signal.aborted) for (const piece of feed.end()) speak(piece);
    } catch (error) {
      const stopped = abort.signal.aborted;
      update(id, { status: stopped ? 'stopped' : 'error', error: stopped ? null : describeError(error), needsFunds: !stopped && isOutOfCredit(error) });
      lastReply.current = { ok: false, chars: 0 };
      if (!stopped) {
        setNote({ text: describeError(error), funds: isOutOfCredit(error) });
        setKeepReading(false);
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      running.current = null;
      refreshBalance();
      // Whatever has been said so far plays out; then the floor goes back to the person. Not after a cut: they are
      // already talking.
      if (!abort.signal.aborted) speaker.close();
    }
    if (receiptId) {
      rememberReceipt({ id: receiptId, model: turn.model, at: new Date().toISOString() });
      if (!haveReceipt)
        client.receipt(receiptId).then(
          (view) => {
            update(id, { receipt: view.receipt });
            setCost(addReply(costRef.current, usdToMusd(view.receipt.cost)));
          },
          () => undefined,
        );
    }
  }

  /** What the person said or typed: checked by the content guard before anything is sent. */
  async function submit(text: string) {
    const prompt = text.trim();
    if (phaseRef.current !== 'live') return;
    if (!prompt || !sleepAllowsSpeech(sleepRef.current)) {
      setMode('idle');
      setCaption(prompt ? hint() : { who: 'hint', text: 'I didn’t catch that. Try again.' });
      return;
    }
    speaker.stop();
    controller.current?.abort();
    setGuardNote(null);
    setMode('thinking');
    setCaption({ who: 'you', text: prompt });
    const request = ++pendingScan.current;
    const result = await scan(prompt);
    if (request !== pendingScan.current || phaseRef.current !== 'live') return;
    const blocking = result.findings.filter((f) => f.severity === 'block');
    if (blocking.length) {
      setGuardNote({ redacted: result.redacted, message: blocking[0].message, original: prompt });
      setMode('idle');
      setCaption({ who: 'hint', text: 'Nothing was sent.' });
      return;
    }
    await send(prompt);
  }

  // ---- talking ------------------------------------------------------------------------------------------------------
  function stopListening() {
    listener.current?.abort();
    listener.current = null;
    mic.close();
    setScope((s) => (s === mic ? null : s));
  }

  function talkStart(hold = true) {
    if (phaseRef.current !== 'live' || !sleepAllowsSpeech(sleepRef.current) || listener.current) return;
    if (listeningRef.current !== 'available') {
      setTyping(true);
      requestAnimationFrame(() => textBox.current?.focus());
      return;
    }
    // The person has the floor: the voice stops at once, and so does the reply still being written.
    pendingScan.current++;
    speaker.stop();
    sampler.stop();
    controller.current?.abort();
    setGuardNote(null);
    setNote(null);
    const session = listen(
      lang,
      {
        onText: (text) => {
          if (text) quietSince.current = Date.now();
          setCaption({ who: 'you', text });
        },
        onEnd: (text) => {
          if (listener.current !== session) return;
          listener.current = null;
          mic.close();
          setScope((s) => (s === mic ? null : s));
          if (text) void fn.current.submit(text);
          else fn.current.heardNothing();
        },
        onError: (code) => fn.current.listenFailed(code),
      },
      hold,
    );
    if (!session) {
      setListening('unsupported');
      setTyping(true);
      return;
    }
    listener.current = session;
    setMode('listening');
    setCaption({ who: 'hint', text: 'Listening…' });
    setScope(mic);
    void mic.open();
  }

  function talkEnd() {
    listener.current?.stop();
  }

  function heardNothing() {
    if (phaseRef.current !== 'live') return;
    setMode('idle');
    if (prefs.handsFree && sleepAllowsSpeech(sleepRef.current) && Date.now() - quietSince.current < QUIET_LIMIT_MS) {
      setCaption({ who: 'hint', text: 'Listening…' });
      window.setTimeout(() => fn.current.resumeHandsFree(), 400);
      return;
    }
    setCaption(prefs.handsFree ? { who: 'hint', text: 'Still there? Tap the mic to go on.' } : { who: 'hint', text: 'I didn’t catch that. Try again.' });
  }

  function resumeHandsFree() {
    if (phaseRef.current === 'live' && modeRef.current === 'idle' && prefs.handsFree && !panel) talkStart(false);
  }

  function listenFailed(code: string) {
    stopListening();
    setMode('idle');
    if (code === 'service-not-allowed' || code === 'language-not-supported') {
      // The browser cannot recognise this on the device after all. There is no other recogniser to fall back to.
      setListening('unavailable');
      setNote({ text: textBoxReason('unavailable', lang) ?? '' });
    } else if (code === 'not-allowed' || code === 'audio-capture') {
      setNote({ text: 'The microphone is blocked or missing. Allow it for this site in your browser, or type instead.' });
    } else {
      setNote({ text: 'Listening stopped unexpectedly. Try again, or type instead.' });
    }
    setTyping(true);
    setCaption(hint());
  }

  // ---- the voice's side ---------------------------------------------------------------------------------------------
  function onSay(text: string) {
    if (phaseRef.current !== 'live') return;
    lines.current = captionLines(text, captionWidth());
    setMode('speaking');
    setScope(speaker);
    setCaption({ who: 'voice', text: lines.current[0]?.text ?? text });
  }

  function onDrained() {
    if (phaseRef.current !== 'live' || modeRef.current === 'listening' || controller.current) return;
    if (!sleepAllowsSpeech(sleepRef.current)) return; // the sleep timer is winding the call down
    setScope((s) => (s === speaker ? null : s));
    // "Keep reading": the last part has been read out and the timer still has time on it, so ask for the next part.
    if (keepReadingRef.current && sleepRef.current.phase === 'running' && lastReply.current.ok) {
      if (lastReply.current.chars >= STORY_STALLED) {
        lastReply.current = { ok: false, chars: 0 };
        void send(STORY_CONTINUE);
        return;
      }
      setKeepReading(false);
    }
    setMode('idle');
    setCaption(hint());
    quietSince.current = Date.now();
    if (prefs.handsFree) window.setTimeout(() => fn.current.resumeHandsFree(), 350);
  }

  function onClip(clip: Clip) {
    const estimate = stockModel ? speechCostMusd(stockModel.pricing.usd_per_1k_chars, clip.chars) : Number.NaN;
    const charged = clip.costMusd ?? estimate;
    if (phaseRef.current === 'lobby') {
      setSampleNote(`Sample played${clip.demo ? ' (a demo tone)' : ''}: ${formatCents(charged)} charged.`);
      refreshBalance();
      return;
    }
    setCost(addClip(costRef.current, charged, clip.chars));
  }

  function onVoiceError(error: unknown) {
    setSampling(null);
    setNote({
      text: isOutOfCredit(error)
        ? 'Not enough credit for the stock voice, so the reply is shown as captions. Add funds, or pick one of this device’s voices.'
        : `${describeError(error)} The stock voice could not speak, so the reply is shown as captions.`,
      funds: isOutOfCredit(error),
    });
  }

  function hear(value: VoiceChoice) {
    unlockAudio();
    if (phaseRef.current === 'live') {
      pendingScan.current++;
      controller.current?.abort();
      stopListening();
      setMode('idle');
      setCaption(hint());
    }
    speaker.stop();
    sampler.stop();
    setSampleNote('');
    const voice = value.kind === 'device' ? (device.find((v) => v.voiceURI === value.uri) ?? null) : null;
    sampler.configure({ choice: value, speed, deviceVoice: voice, speech: key ? (body, signal) => client.speech(body, signal) : null });
    setSampling(value);
    sampler.say(VOICE_SAMPLE);
    sampler.close();
  }

  function pick(value: VoiceChoice) {
    saveVoicePrefs({ voice: value });
    setNote(null);
  }

  // ---- the sleep timer ----------------------------------------------------------------------------------------------
  function applySleep(next: SleepState) {
    const prior = sleepRef.current;
    if (next === prior) return;
    setSleep(next);
    if (next.phase === prior.phase) return;
    if (next.phase === 'finishing') {
      // Time is up: the sentence being said finishes, and nothing new is written, said or heard.
      pendingScan.current++;
      controller.current?.abort();
      stopListening();
      speaker.hold();
    } else if (next.phase === 'fading') {
      pendingScan.current++;
      controller.current?.abort();
      stopListening();
      speaker.stop();
      sampler.stop();
      setScope(null);
      setPanel(null);
      setMode('idle');
      setCaption({ who: 'hint', text: '' });
    } else if (next.phase === 'done') {
      endCall('sleep');
    } else if (next.phase === 'running' && prior.phase !== 'off') {
      // More time was asked for while the call was winding down: it carries on.
      setCaption(hint());
    }
  }

  function setTimer(minutes: number) {
    if (phaseRef.current === 'live') applySleep(sleepStep(sleepRef.current, { type: 'set', minutes, now: Date.now() }));
    else setSleepPick(minutes);
    if (!minutes) setKeepReading(false);
  }

  // ---- starting and ending -------------------------------------------------------------------------------------------
  function start(story: boolean) {
    if (!key || phaseRef.current !== 'lobby' || streaming) return;
    unlockAudio();
    primeDeviceVoice(deviceVoice);
    sampler.stop();
    setSampling(null);
    mine.current.clear();
    const t = Date.now();
    const minutes = story ? STORY_MINUTES : sleepPick;
    setStartedAt(t);
    setNow(t);
    setCost(NO_COST);
    setSummary(null);
    setSampleNote('');
    setNote(null);
    setGuardNote(null);
    setPanel(null);
    setTyped('');
    setTyping(listeningRef.current !== 'available');
    setFlags({ reminder: false, crisis: false });
    setSleep(sleepStep(SLEEP_OFF, { type: 'set', minutes, now: t }));
    setKeepReading(story);
    setPhase('live');
    setMode('idle');
    setScope(null);
    quietSince.current = t;
    lastReply.current = { ok: false, chars: 0 };
    wake.current?.();
    wake.current = keepAwake();
    const greeting = character && !freshTurns().length ? greetingsOf(character.card)[0] : undefined;
    if (story) {
      void send(STORY_PROMPT);
    } else if (greeting && callee) {
      // The character's greeting opens the call, as it opens the chat. It is part of what the model is sent already.
      for (const piece of splitSentences(applyMacros(greeting, { char: callee, user: 'you' }), { flush: true }).pieces) speak(piece);
      speaker.close();
    } else {
      setCaption(hint());
      if (prefs.handsFree) window.setTimeout(() => fn.current.resumeHandsFree(), 500);
    }
  }

  function endCall(reason: 'hangup' | 'sleep') {
    if (phaseRef.current !== 'live') return;
    pendingScan.current++;
    controller.current?.abort();
    speaker.stop();
    sampler.stop();
    stopListening();
    wake.current?.();
    wake.current = null;
    restAudio();
    setSummary({ ms: Date.now() - startedAt, cost: costRef.current, reason });
    setScope(null);
    setPanel(null);
    setGuardNote(null);
    setMode('idle');
    setCaption({ who: 'hint', text: '' });
    refreshBalance();
    if (reason === 'sleep') {
      setPhase('farewell');
    } else {
      setSleep(SLEEP_OFF);
      setKeepReading(false);
      setPhase('lobby');
    }
  }

  function closeFarewell() {
    setSleep(SLEEP_OFF);
    setKeepReading(false);
    setPhase('lobby');
  }

  // Timers, the speech engine and key handlers call through here, so they always reach the latest render.
  const fn = useLatest({ submit, heardNothing, resumeHandsFree, listenFailed, onSay, onDrained, onClip, onVoiceError, applySleep, talkStart, talkEnd });

  useEffect(() => {
    speaker.events = {
      onSay: (text) => fn.current.onSay(text),
      onSentenceEnd: () => fn.current.applySleep(sleepStep(sleepRef.current, { type: 'sentence-end', now: Date.now() })),
      onDrained: () => fn.current.onDrained(),
      onClip: (clip) => fn.current.onClip(clip),
      onError: (error) => fn.current.onVoiceError(error),
    };
    sampler.events = {
      onClip: (clip) => fn.current.onClip(clip),
      onError: (error) => fn.current.onVoiceError(error),
      onDrained: () => setSampling(null),
    };
    return () => {
      speaker.stop();
      sampler.stop();
      mic.close();
    };
  }, [speaker, sampler, mic, fn, sleepRef]);

  // Leaving the page, or losing the key, ends everything at once.
  useEffect(
    () => () => {
      controller.current?.abort();
      listener.current?.abort();
      listener.current = null;
      wake.current?.();
      wake.current = null;
      restAudio();
    },
    [key, demo],
  );

  // The call clock, and the sleep timer's ticks.
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow((shown) => (Math.floor(shown / 1000) === Math.floor(t / 1000) ? shown : t));
      fn.current.applySleep(sleepStep(sleepRef.current, { type: 'tick', now: t, speaking: speaker.audible }));
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase, fn, sleepRef, speaker]);

  // The caption follows the word being said.
  useEffect(() => {
    if (phase !== 'live' || mode !== 'speaking') return;
    const timer = window.setInterval(() => {
      const text = captionAt(lines.current, speaker.position());
      setCaption((c) => (c.who === 'voice' && text && c.text !== text ? { who: 'voice', text } : c));
    }, 120);
    return () => window.clearInterval(timer);
  }, [phase, mode, speaker]);

  // Hold Space to talk. On a text box or any other control Space keeps its usual job.
  useEffect(() => {
    if (phase !== 'live') return;
    let held = false;
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, a[href], summary, label, [contenteditable="true"]')) return;
      const button = el?.closest('button');
      if (button && !button.hasAttribute('data-talk')) return;
      e.preventDefault();
      held = true;
      fn.current.talkStart();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !held) return;
      e.preventDefault();
      held = false;
      fn.current.talkEnd();
    };
    const blur = () => {
      if (!held) return;
      held = false;
      fn.current.talkEnd();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [phase, fn]);

  // The call is a modal dialog: it covers the workspace, holds the keyboard, and Escape hangs up.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (phase !== 'lobby' && !el.open) {
      el.showModal();
      talkButton.current?.focus({ preventScroll: true });
    } else if (phase === 'lobby' && el.open) {
      el.close();
    }
  }, [phase]);

  const paid = choice.kind === 'stock';
  const remaining = sleepRemaining(sleep, now);
  const total = totalMusd(cost);
  const costDetail = `Voice ${formatCents(cost.voiceMusd)} for ${cost.clips} ${cost.clips === 1 ? 'clip' : 'clips'}, replies ${formatCents(cost.replyMusd)}.`;
  const dimmed = sleep.phase === 'fading' || sleep.phase === 'done';
  const canTalk = listening === 'available';
  const status = mode === 'listening' ? 'Listening' : mode === 'thinking' ? 'Thinking' : mode === 'speaking' ? 'Speaking' : 'Your turn';
  const storyNote = `Keeps reading until the timer ends. Each part is an ordinary paid reply${paid ? `, read at about ${formatCents(minuteMusd)} a minute` : ''}.`;

  const sleepChoices = (
    <fieldset className="segmented nc-sleep-choices">
      <legend className="sr-only">Sleep timer</legend>
      {SLEEP_MINUTES.map((m) => {
        const on = phase === 'live' ? (sleep.phase === 'off' ? m === 0 : 'minutes' in sleep && sleep.minutes === m) : sleepPick === m;
        return (
          <button key={m} type="button" aria-pressed={on} onClick={() => setTimer(m)}>
            {m ? `${m} min` : 'Off'}
          </button>
        );
      })}
    </fieldset>
  );
  const picker = <VoicePicker device={device} lang={lang} stock={stock} choice={choice} speed={speed} demo={demo} sampling={sampling} onPick={pick} onHear={hear} />;

  return (
    <div className="nc-lobby">
      {summary && phase === 'lobby' && (
        <section className="notice nc-summary" aria-label="Last call">
          <div>
            <strong>{summary.reason === 'sleep' ? 'The sleep timer ended the call.' : 'Call ended.'}</strong>{' '}
            <span className="muted">
              {clock(summary.ms)} · {formatCents(totalMusd(summary.cost))} (voice {formatCents(summary.cost.voiceMusd)}, replies {formatCents(summary.cost.replyMusd)})
            </span>
          </div>
          <Link className="btn btn-small" href="/dashboard/chat">
            Open it in Chat
          </Link>
        </section>
      )}
      {flags.crisis && phase === 'lobby' && <CrisisLines />}

      <section className="nc-hero">
        <Photo src="/mascot/headphones.jpg" alt="" width={640} height={640} />
        <div className="nc-hero-copy">
          <p className="nc-kicker">Night Call · adults only</p>
          <h1>{callee ? `Call ${callee}` : 'Talk out loud. Hear the answer.'}</h1>
          <p className="lede">
            Hold Space or the mic and say it; let go and the reply is read back to you, sentence by sentence. The call lands in Chat as an ordinary thread, with a receipt for every
            reply.
          </p>
          <div className="nc-start">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => start(false)} disabled={streaming}>
              <span className="nc-start-label">
                <Phone size={18} aria-hidden="true" />
                Start the call
              </span>
              <span className="studio-cost">{voicePrice}</span>
            </button>
            <button type="button" className="btn btn-lg" onClick={() => start(true)} disabled={streaming} title={storyNote}>
              <span className="nc-start-label">
                <BedDouble size={18} aria-hidden="true" />
                Read me to sleep
              </span>
              <span className="studio-cost">
                {STORY_MINUTES} min · {voicePrice}
              </span>
            </button>
          </div>
          <p className="nc-fine">
            {paid ? (
              <>
                {voiceName} is a stock voice: about <strong>{formatCents(minuteMusd)} a minute of speech</strong> ({stockModel?.name}, ${stockModel?.pricing.usd_per_1k_chars} per 1,000
                characters).{' '}
              </>
            ) : choice.kind === 'device' ? (
              <>{voiceName} is one of this device’s voices, so speech is free. </>
            ) : (
              <>No voice is picked, so replies are shown as captions. </>
            )}
            Replies come from <code>{model}</code> and cost what they cost in Chat. “Read me to sleep” asks for a calm bedtime story and keeps reading until its timer ends; each
            part is an ordinary paid reply.
          </p>
          {streaming && <p className="nc-fine">A reply is still being written in Chat. Wait for it to finish before you call.</p>}
          {sampleNote && (
            <output className="nc-fine">{sampleNote}</output>
          )}
          {note && phase === 'lobby' && (
            <p className="notice notice-amber" role="alert">
              {note.text} {note.funds && <Link href="/dashboard/funds">Add funds</Link>}
            </p>
          )}
          <p className="ai-notice">{AI_NOTICE}</p>
        </div>
      </section>

      <div className="nc-setup">
        <section className="panel" aria-labelledby="nc-voice-title">
          <header>
            <h2 id="nc-voice-title">Voice</h2>
            <label className="nc-pace">
              <span>Pace</span>
              <select className="select" value={prefs.pace} onChange={(e) => saveVoicePrefs({ pace: PACES.find((p) => p.id === e.target.value)?.id ?? 'even' })}>
                {PACES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </header>
          {phase === 'lobby' && picker}
        </section>

        <div className="panel-stack">
          <section className="panel" aria-labelledby="nc-who-title">
            <header>
              <h2 id="nc-who-title">Who you call</h2>
            </header>
            <label className="field">
              <span>Character</span>
              <select className="select" value={characterId ?? ''} onChange={(e) => setCharacterId(e.target.value || null)}>
                <option value="">No character: the model itself</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.card.data.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="lede">
              {characters.length ? 'Character cards stay on this device and work with any model.' : 'No character cards on this device yet.'}{' '}
              <Link href="/dashboard/characters">Characters</Link>
            </p>
          </section>

          <section className="panel" aria-labelledby="nc-sleep-title">
            <header>
              <h2 id="nc-sleep-title">Sleep timer</h2>
            </header>
            {phase === 'lobby' && sleepChoices}
            <p className="lede">When it runs out the voice finishes its sentence, the screen dims, and the call ends by itself.</p>
          </section>

          <section className="panel" aria-labelledby="nc-listen-title">
            <header>
              <h2 id="nc-listen-title">Listening</h2>
              <span className={canTalk ? 'chip chip-signal' : 'chip'}>{canTalk ? 'On this device' : 'Text box'}</span>
            </header>
            {canTalk ? (
              <p className="lede">Your speech is turned into text on this device ({lang}). The microphone’s audio is never sent anywhere, and what you say is checked for secrets before it is sent as text.</p>
            ) : (
              <p className="lede">{textBoxReason(listening, lang)}</p>
            )}
            {(listening === 'downloadable' || listening === 'downloading') && (
              <div className="row">
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={settingUp || listening === 'downloading'}
                  onClick={() => {
                    setSettingUp(true);
                    void installListening(lang).then((next) => {
                      setListening(next);
                      setSettingUp(false);
                    });
                  }}
                >
                  {settingUp || listening === 'downloading' ? 'Setting up…' : 'Set up on-device listening'}
                </button>
                <span className="faint">Your browser downloads its own speech pack once. Nothing you say is part of that.</span>
              </div>
            )}
          </section>
        </div>
      </div>

      <dialog
        ref={dialog}
        className="nc"
        aria-labelledby="nc-title"
        data-phase={phase}
        data-mode={mode}
        data-dim={dimmed}
        onCancel={(e) => {
          if (panel) {
            e.preventDefault();
            setPanel(null);
          }
        }}
        onClose={() => (phaseRef.current === 'farewell' ? closeFarewell() : endCall('hangup'))}
      >
        {phase === 'farewell' && (
          <div className="nc-farewell">
            <Photo src="/mascot/headphones.jpg" alt="" width={640} height={640} loading="eager" />
            <h2 id="nc-title">{SLEEP_FAREWELL}</h2>
            {summary && (
              <p className="muted">
                {clock(summary.ms)} · {formatCents(totalMusd(summary.cost))}
              </p>
            )}
            {flags.crisis && <CrisisLines />}
            <p className="ai-notice">{AI_NOTICE}</p>
            <button type="button" className="btn btn-small btn-ghost" onClick={closeFarewell}>
              Close
            </button>
          </div>
        )}
        {phase === 'live' && (
          <div className="nc-screen">
            <header className="nc-top">
              <div className="nc-who">
                <h2 id="nc-title">{callee ? `Night Call with ${callee}` : 'Night Call'}</h2>
                <AdultsOnly compact />
                {demo && <span className="chip chip-amber">Demo</span>}
              </div>
              <div className="nc-meter">
                <span aria-label={`Call time ${clock(now - startedAt)}`}>{clock(now - startedAt)}</span>
                <span className="nc-cost" title={costDetail} aria-label={`This call so far ${formatCents(total)}. ${costDetail}`}>
                  {formatCents(total)}
                </span>
              </div>
            </header>

            <CallStage scope={scope} mode={mode} dim={dimmed} />

            <div className="nc-words">
              <output className="sr-only">{status}</output>
              <p className="nc-caption" data-who={caption.who} aria-live={caption.who === 'voice' && (choice.kind === 'silent' || speaker.failed) ? 'polite' : 'off'}>
                {caption.text || ' '}
              </p>
              <div className="nc-notes">
                {flags.reminder && (
                  <p className="ai-reminder" role="note">
                    {AI_REMINDER}
                  </p>
                )}
                {flags.crisis && <CrisisLines />}
                {guardNote && (
                  <div className="notice notice-amber row" role="alert">
                    <span style={{ flex: 1, minWidth: 200 }}>{guardNote.message}</span>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        const text = guardNote.redacted;
                        setGuardNote(null);
                        void send(text);
                      }}
                    >
                      Send with it redacted
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      onClick={() => {
                        setTyped(guardNote.original);
                        setTyping(true);
                        setGuardNote(null);
                        requestAnimationFrame(() => textBox.current?.focus());
                      }}
                    >
                      Edit
                    </button>
                  </div>
                )}
                {note && (
                  <div className="notice notice-amber row" role="alert">
                    <span style={{ flex: 1, minWidth: 200 }}>
                      {note.text} {note.funds && <Link href="/dashboard/funds">Add funds</Link>}
                    </span>
                    <button type="button" className="btn btn-small btn-ghost" aria-label="Dismiss" onClick={() => setNote(null)}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                )}
                {sleep.phase === 'finishing' && (
                  <output className="notice row">
                    <span style={{ flex: 1 }}>Time’s up. Finishing this sentence.</span>
                    <button type="button" className="btn btn-small" onClick={() => setTimer(10)}>
                      10 more minutes
                    </button>
                  </output>
                )}
                {demo && paid && <p className="nc-fine">Demo mode: the stock voice is a soft tone, not speech. The captions carry the words.</p>}
              </div>
              {(typing || !canTalk) && (
                <form
                  className="nc-type"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = typed;
                    setTyped('');
                    void submit(text);
                  }}
                >
                  <label className="sr-only" htmlFor="nc-say">
                    Type what you want to say
                  </label>
                  <input id="nc-say" ref={textBox} className="input" value={typed} autoComplete="off" placeholder={callee ? `Say something to ${callee}…` : 'Type what you want to say…'} onChange={(e) => setTyped(e.target.value)} />
                  <button type="submit" className="btn btn-primary" disabled={!typed.trim()}>
                    Send
                  </button>
                  {!canTalk && <p className="nc-fine">{textBoxReason(listening, lang)}</p>}
                </form>
              )}
            </div>

            {panel && (
              <section className="nc-panel" aria-label={panel === 'voice' ? 'Voice' : 'Sleep timer'}>
                <header>
                  <h3>{panel === 'voice' ? 'Voice' : 'Read me to sleep'}</h3>
                  <button type="button" className="btn btn-small btn-ghost" aria-label="Close" onClick={() => setPanel(null)}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </header>
                {panel === 'voice' ? (
                  picker
                ) : (
                  <>
                    {sleepChoices}
                    <p className="lede">When it runs out the voice finishes its sentence, the screen dims, and the call ends by itself.</p>
                    <label className="checkbox">
                      <input type="checkbox" checked={keepReading} disabled={sleep.phase !== 'running'} onChange={(e) => setKeepReading(e.target.checked)} />
                      Keep reading until the timer ends
                    </label>
                    <p className="nc-fine">{storyNote}</p>
                  </>
                )}
              </section>
            )}

            <footer className="nc-foot">
              <div className="nc-controls">
                {canTalk ? (
                  <button
                    ref={talkButton}
                    type="button"
                    className="nc-control nc-talk"
                    data-talk=""
                    aria-pressed={mode === 'listening'}
                    aria-label={mode === 'listening' ? 'Stop and send' : 'Talk: hold, or tap to start and tap again to send'}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      press.current = { at: performance.now(), ends: listener.current !== null };
                      if (!press.current.ends) talkStart(!prefs.handsFree);
                    }}
                    onPointerUp={() => {
                      // A long press is hold-to-talk. A tap leaves the mic open until it is tapped again.
                      if (press.current.ends || performance.now() - press.current.at > 400) talkEnd();
                    }}
                    onPointerCancel={talkEnd}
                    onContextMenu={(e) => e.preventDefault()}
                    onClick={(e) => {
                      if (e.detail !== 0) return; // pointer presses are handled above; this is the keyboard and assistive tech
                      if (listener.current) talkEnd();
                      else talkStart(false);
                    }}
                  >
                    <span className="nc-control-icon">
                      <Mic size={24} aria-hidden="true" />
                    </span>
                    <span className="nc-control-label">{mode === 'listening' ? 'Listening' : 'Hold to talk'}</span>
                  </button>
                ) : (
                  <button ref={talkButton} type="button" className="nc-control nc-talk" aria-label="Type what you want to say" onClick={() => textBox.current?.focus()}>
                    <span className="nc-control-icon">
                      <Keyboard size={24} aria-hidden="true" />
                    </span>
                    <span className="nc-control-label">Type</span>
                  </button>
                )}
                <button type="button" className="nc-control" aria-expanded={panel === 'voice'} aria-label={`Voice: ${voiceName}, ${voicePrice}`} onClick={() => setPanel(panel === 'voice' ? null : 'voice')}>
                  <span className="nc-control-icon">
                    <Volume2 size={22} aria-hidden="true" />
                  </span>
                  <span className="nc-control-label">{voiceName}</span>
                </button>
                <button
                  type="button"
                  className="nc-control"
                  aria-expanded={panel === 'sleep'}
                  aria-label={sleep.phase === 'running' ? `Sleep timer: ${clock(remaining)} left` : 'Sleep timer: off'}
                  onClick={() => setPanel(panel === 'sleep' ? null : 'sleep')}
                >
                  <span className="nc-control-icon">
                    <AlarmClock size={22} aria-hidden="true" />
                  </span>
                  <span className="nc-control-label">{sleep.phase === 'running' ? clock(remaining) : sleep.phase === 'off' ? 'Sleep' : 'Winding down'}</span>
                </button>
                <button type="button" className="nc-control nc-hangup" aria-label="Hang up" title="Hang up (Esc)" onClick={() => endCall('hangup')}>
                  <span className="nc-control-icon">
                    <PhoneOff size={22} aria-hidden="true" />
                  </span>
                  <span className="nc-control-label">Hang up</span>
                </button>
              </div>
              <div className="nc-tools">
                {canTalk && (
                  <>
                    <button type="button" className="nc-tool" aria-pressed={prefs.handsFree} onClick={() => saveVoicePrefs({ handsFree: !prefs.handsFree })}>
                      <Hand size={13} aria-hidden="true" />
                      Hands-free: {prefs.handsFree ? 'on' : 'off'}
                    </button>
                    <button type="button" className="nc-tool" aria-pressed={typing} onClick={() => setTyping((t) => !t)}>
                      <Keyboard size={13} aria-hidden="true" />
                      Type instead
                    </button>
                  </>
                )}
                {keepReading && sleep.phase === 'running' && <span className="chip chip-amber">Reading until the timer ends</span>}
              </div>
              <p className="ai-notice">{AI_NOTICE}</p>
            </footer>
          </div>
        )}
      </dialog>
    </div>
  );
}
