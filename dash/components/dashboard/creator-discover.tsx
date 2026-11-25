'use client';

import Link from 'next/link';
import { Compass, Heart, MessageSquare, Search, Zap } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { describeError } from '@/lib/anonymo/client';
import { boostCreator, tipCreator } from '@/lib/anonymo/creator-wallet';
import { creatorThumb, type CreatorCard, type CreatorContracts } from '@/lib/anonymo/creators';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { freeContext } from '@/lib/anonymo/free-chat';
import { adultStore } from '@/lib/anonymo/prefs';
import { parseUsd } from '@/lib/anonymo/money';
import type { ChatMessage } from '@/lib/anonymo/types';
import { updateOn } from '@/lib/anonymo/updates';
import { CompanionDisclosure, CrisisNotice, RegionPage, useCompanionCompliance } from './companion-compliance';
import { useFreeChat } from './use-free-chat';

function Thumbnail({ seed }: { seed: string }) {
  const { hue, angle, x } = creatorThumb(seed);
  return <div aria-hidden="true" className="creator-thumb" style={{
    '--creator-hue': hue, '--creator-angle': `${angle}deg`, '--creator-x': `${x}%`,
  } as CSSProperties}><Compass size={42} strokeWidth={1} /></div>;
}

export function CreatorDiscover() {
  const { client, balanceVersion } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const [discovery, setResult] = useState<{ client: typeof client; cards: CreatorCard[]; mature: boolean } | null>(null);
  const result = discovery?.client === client ? discovery : null;
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [filter, setFilter] = useState({ query: '', tag: '' });
  const [active, setActive] = useState<CreatorCard | null>(null);
  const [contracts, setContracts] = useState<CreatorContracts | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void client.discover(filter.query, filter.tag, adult, abort.signal).then(
      ({ data, mature }) => { if (!abort.signal.aborted) setResult({ client, cards: data, mature }); },
      (error) => { if (!abort.signal.aborted) setError(describeError(error)); },
    );
    return () => abort.abort();
  }, [client, filter, adult, balanceVersion]);
  useEffect(() => {
    let current = true;
    void client.creatorContracts().then((value) => { if (current) setContracts(value); }, () => {});
    return () => { current = false; };
  }, [client]);

  return <div className="panel-stack">
    <form className="creator-filters panel" onSubmit={(event) => { event.preventDefault(); setFilter({ query, tag }); }}>
      <label className="field">Search characters<input className="input" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={80} /></label>
      <label className="field">Tag<input className="input" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={32} /></label>
      <button className="btn btn-primary"><Search size={16} /> Search</button>
    </form>
    {result && !result.mature && <p className="muted">Adult-tagged characters are available to funded 18+ sessions. <Link href="/dashboard/funds">Add funds</Link></p>}
    {error ? <p className="notice notice-rose" role="alert">{error}</p> : !result ? <p className="muted" role="status">Loading characters…</p> : null}
    {active && (!active.adult || result?.mature) && <DiscoverChat key={active.id} card={active} close={() => setActive(null)} />}
    {result && (result.cards.length === 0 ? <p className="notice">No characters match this search.</p> :
      <div className="creator-grid">{result.cards.map((card) => <article key={card.id} className="card creator-listing">
        <Thumbnail seed={card.seed} />
        <div className="creator-listing-copy">
          <header className="row"><h2>{card.name}</h2>{card.adult && <span className="chip">18+</span>}</header>
          <p className="lede">{card.description}</p>
          <div className="row">{card.tags.map((label) => <button key={label} className="chip" type="button"
            onClick={() => { setTag(label); setFilter({ query, tag: label }); }}>{label}</button>)}</div>
          <div className="row">
            <button className="btn btn-primary btn-small" type="button" onClick={() => setActive(card)}><MessageSquare size={15} /> Chat</button>
            <SupportCreator card={card} contracts={contracts} />
          </div>
        </div>
      </article>)}</div>)}
  </div>;
}

function DiscoverChat({ card, close }: { card: CreatorCard; close: () => void }) {
  const { key, demo, client, refreshBalance, rememberReceipt } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const guest = !key && !card.adult && adult && updateOn('free', demo);
  const free = useFreeChat(client, guest, demo);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signals, setSignals] = useState<{ aiReminder: boolean; crisis: boolean } | null>(null);
  const compliance = useCompanionCompliance(client, updateOn('compliance', demo), messages.length > 0, card.id);
  const active = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
    return () => active.current?.abort();
  }, []);

  async function send() {
    if (active.current || !draft.trim() || (!key && !guest)) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    setReply('');
    setBusy(true);
    setSignals(compliance.takeSignals(draft));
    const history = [...messages, { role: 'user' as const, content: draft.trim() }];
    try {
      const access = guest ? await free.authorize(controller.signal) : null;
      const result = await client.chat({
        model: access?.model ?? 'anonymo-1', messages: access ? freeContext(history) : history.slice(-31),
        characterId: card.id, creatorAdult: adult,
      }, {
        signal: controller.signal,
        ...(access ? { free: { ...access, onRemaining: free.setRemaining } } : {}),
        onDelta: (delta) => setReply((text) => text + delta),
      });
      setMessages([...history, { role: 'assistant', content: result.content }]);
      setDraft('');
      if (result.receiptId) rememberReceipt({ id: result.receiptId, model: result.model, at: new Date().toISOString() });
    } catch (error) {
      if (!controller.signal.aborted) setError(describeError(error));
    } finally {
      active.current = null;
      setBusy(false);
      setReply('');
      if (key) refreshBalance();
    }
  }

  if (compliance.restricted) return <RegionPage client={client} mode={compliance.restricted} onVerified={compliance.refresh} />;
  return <section className="panel" aria-label={`Chat with ${card.name}`}>
    <header><h2>Chat with {card.name}</h2><button className="btn btn-small" type="button" onClick={close}>Close chat</button></header>
    <p className="lede">This is an AI character. We don’t store your chats.</p>
    {(signals?.aiReminder || compliance.disclosure) && <CompanionDisclosure />}
    {signals?.crisis && <CrisisNotice />}
    <div className="creator-thread" aria-live="polite" aria-busy={busy}>
      {messages.map((message, index) => <p key={index}><strong>{message.role === 'user' ? 'You' : card.name}</strong> {message.content}</p>)}
      {reply && <p><strong>{card.name}</strong> {reply}</p>}
    </div>
    {error && <p className="notice notice-rose" role="alert">{error}</p>}
    {(!key && !guest) || free.remaining === 0 ? <Link className="btn" href="/dashboard/key">Set up an API key</Link> :
      <form className="panel-stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="field">Message<textarea ref={input} className="textarea" rows={3} maxLength={8000} value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
        <div className="row"><button className="btn btn-primary" disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Send'}</button>
          {busy && <button className="btn" type="button" onClick={() => active.current?.abort()}>Stop</button>}
        </div>
      </form>}
  </section>;
}

function SupportCreator({ card, contracts }: { card: CreatorCard; contracts: CreatorContracts | null }) {
  const { demo } = useAnonymo();
  const [action, setAction] = useState<'tip' | 'boost' | 'unlock' | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  function choose(next: typeof action) { setAction(next); setNote(''); setError(''); setAmount(''); }

  async function send() {
    if (!action || !contracts) return;
    const value = parseUsd(amount);
    if (!value || value < 0) { setError('Enter a positive amount with up to six decimal places.'); return; }
    setBusy(true);
    setError('');
    setNote('');
    try {
      if (demo) {
        const path = action === 'tip' ? 'tip' : 'boost';
        const endpoint = await import('@/lib/anonymo/mock/creator-actions');
        await endpoint.demoCreatorAction(path, card.wallet, value, action === 'unlock');
      } else if (action === 'tip') await tipCreator(contracts, card.wallet, BigInt(value));
      else await boostCreator(contracts, card.wallet, BigInt(value) * 10n ** 12n, action === 'unlock');
      setNote(action === 'tip' ? 'Tip confirmed. The whole amount goes into the creator payout hold.' : action === 'boost' ? 'Boost confirmed.' : 'Boost unlocked.');
      setAction(null);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button className="btn btn-small" type="button" onClick={() => choose('tip')}><Heart size={15} /> Tip</button>
    {contracts?.boosts && <button className="btn btn-small" type="button" onClick={() => choose('boost')}><Zap size={15} /> Boost</button>}
    {note && <p role="status">{note}</p>}
    {action && <form className="creator-support" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {action === 'tip' && !contracts?.payouts ? <p>Tips are unavailable right now.</p> : <>
        <p className="muted">{action === 'tip' ? 'The creator gets the whole tip in USDG after the payout hold.' : 'Boosts change Discover ranking only.'}</p>
        <label className="field">{action === 'tip' ? 'USDG amount' : '$NYMO amount'}<input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <div className="row">
          <button className="btn btn-small btn-primary" disabled={busy}>{busy ? 'Confirming…' : action === 'tip' ? 'Send tip' : action === 'boost' ? 'Lock boost' : 'Unlock boost'}</button>
          {action !== 'tip' && <button className="btn btn-small" disabled={busy} type="button" onClick={() => choose(action === 'boost' ? 'unlock' : 'boost')}>{action === 'boost' ? 'Unlock instead' : 'Boost instead'}</button>}
        </div>
      </>}
      <button className="btn btn-small" type="button" disabled={busy} onClick={() => choose(null)}>Close</button>
      {error && <p className="notice notice-rose" role="alert">{error}</p>}
    </form>}
  </>;
}
