'use client';

import { ArrowUpRight, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { describeError, type AnonymoClient } from '@/lib/anonymo/client';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { freeDevice, type FreeChallenge } from '@/lib/anonymo/free-chat';
import { CRISIS_LINES, mentionsSelfHarm } from '@/lib/anonymo/safety';
import { adultStore } from '@/lib/anonymo/prefs';
import { telegramEvent, telegramInitFromFragment, telegramWorkspaceUrl, takeTelegramFragment, TELEGRAM_NOTICE } from '@/lib/anonymo/telegram';
import { useAnonymo } from './anonymo-provider';
import { solveFreeChallenge } from './dashboard/use-free-chat';

async function tryReply(client: AnonymoClient, initData: string | null, mode: 'chat' | 'arm', text: string, signal: AbortSignal) {
  const device = initData ? '' : freeDevice(localStorage, true);
  const puzzle = initData
    ? await client.telegramMini<FreeChallenge>(initData, 'challenge', { adult: true }, signal)
    : await client.freeChallenge(device, signal);
  if (puzzle.remaining === 0) throw new Error('You’ve used today’s free messages. Come back after midnight UTC.');
  if (!puzzle.challenge || !puzzle.model) throw new Error('Free chat is temporarily unavailable.');
  const nonce = await solveFreeChallenge({ ...puzzle, challenge: puzzle.challenge }, signal);
  const work = `${puzzle.challenge}:${nonce}:0`;
  if (mode === 'arm') {
    if (initData) await client.telegramMini(initData, 'arm', { adult: true, work }, signal);
    return null;
  }
  if (initData) return client.telegramMini<{ text: string; remaining: number }>(initData, 'chat', { adult: true, work, text }, signal);
  let remaining = puzzle.remaining;
  const result = await client.chat({ model: puzzle.model, messages: [{ role: 'user', content: text }] },
    { signal, free: { token: device, proof: work, onRemaining: (left) => { remaining = left; } } });
  return { text: result.content, remaining };
}

const WORKSPACE = '/dashboard/chat';

export function TelegramMini() {
  const { client, demo, ready } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const init = useRef<string | null | undefined>(undefined);
  const request = useRef<AbortController | null>(null);
  const [verified, setVerified] = useState(false);
  const [fullApp, setFullApp] = useState<{ url: string; until: number } | null>(null);
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState('');
  const [crisis, setCrisis] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (init.current === undefined) init.current = telegramInitFromFragment(takeTelegramFragment(window.location, window.history));
    if (init.current) telegramEvent(window, 'web_app_ready');
  }, []);

  useEffect(() => {
    if (!ready || !adult || demo) return;
    const initData = init.current;
    if (!initData) { setError('Open the Mini App from the Anonymo bot in Telegram.'); return; }
    const abort = new AbortController();
    // A fresh link is ready before the tap so Telegram can open the external browser in the same user gesture.
    client.telegramMini<{ url: string }>(initData, 'handoff', {}, abort.signal).then(({ url }) => {
      if (abort.signal.aborted) return;
      const target = telegramWorkspaceUrl(url, window.location.origin);
      if (!target) throw new Error('The workspace link is unavailable.');
      setFullApp({ url: target, until: Date.now() + 105_000 });
      setVerified(true);
    }).catch((error) => { if (!abort.signal.aborted) setError(describeError(error)); });
    return () => abort.abort();
  }, [adult, client, demo, ready]);

  useEffect(() => () => request.current?.abort(), []);

  async function run(mode: 'chat' | 'arm') {
    const prompt = text.trim();
    if (!adult || (!verified && !demo) || request.current || (mode === 'chat' && !prompt)) return;
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError('');
    setArmed(false);
    if (mode === 'chat') {
      setAnswer('');
      setCrisis(mentionsSelfHarm(prompt));
    }
    try {
      const reply = await tryReply(client, demo ? null : init.current ?? null, mode, prompt, abort.signal);
      if (reply) {
        setAnswer(reply.text);
        setRemaining(reply.remaining);
        setText('');
      } else {
        setArmed(true);
      }
    } catch (error) {
      if (!abort.signal.aborted) setError(describeError(error));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
      request.current = null;
    }
  }

  return (
    <main className="telegram-page panel">
      <header>
        <h1>Anonymo in Telegram</h1>
        <p className="lede">{TELEGRAM_NOTICE}</p>
      </header>
      <p className="faint">AI chat for adults. {remaining === null ? 'Try a free reply.' : `${remaining} free today.`}</p>
      {(verified || demo) && (
        <>
          <form className="panel-stack" onSubmit={(event) => { event.preventDefault(); void run('chat'); }}>
            <label className="field">
              Message
              <textarea className="textarea" value={text} maxLength={4096} onChange={(event) => setText(event.target.value)} />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
              <Send size={15} aria-hidden="true" /> Send
            </button>
          </form>
          {busy && <p className="muted" role="status">Working on your free reply…</p>}
          {crisis && <div className="notice" role="status">If you may hurt yourself, call your local emergency number now. <a href={CRISIS_LINES[0].href}>{CRISIS_LINES[0].action} in the U.S.</a></div>}
          {answer && <div role="status" className="notice telegram-answer">{answer}</div>}
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={() => void run('arm')}>Enable a bot reply</button>
            <a className="btn" href={fullApp?.url ?? WORKSPACE} target="_blank" rel="noreferrer"
              onClick={(event) => {
                if (fullApp && fullApp.until <= Date.now() && init.current) {
                  event.preventDefault();
                  setError('');
                  void client.telegramMini<{ url: string }>(init.current, 'handoff', {}).then(({ url }) => {
                    const target = telegramWorkspaceUrl(url, window.location.origin);
                    if (!target) throw new Error('The workspace link is unavailable.');
                    setFullApp({ url: target, until: Date.now() + 105_000 });
                    setError('Your new link is ready. Tap Open the full app.');
                  }).catch((error) => setError(describeError(error)));
                } else if (init.current && !demo && telegramEvent(window, 'web_app_open_link', { url: event.currentTarget.href })) {
                  event.preventDefault();
                }
              }}><ArrowUpRight size={16} aria-hidden="true" /> Open the full app</a>
          </div>
          {armed && <p className="notice" role="status">One bot reply is ready. Return to the bot and send a message within three minutes.</p>}
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </main>
  );
}
