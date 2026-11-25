'use client';

import Link from 'next/link';
import { BookOpen, Copy, Dices, DoorOpen, ImageIcon, Plus, ReceiptText, Send, UsersRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { AnonymoApiError } from '@/lib/anonymo/client';
import {
  campaignSave, PARTY_DICE, PARTY_HREF, partyNonce, readCampaignSave, readPartyInvite, verifyPartyRoll,
  type CampaignSave, type PartyAction, type PartyRoom, type PartySeat,
} from '@/lib/anonymo/party';
import { startVault, vault } from '@/lib/anonymo/vault-browser';
import { campaignsFromMemory } from '@/lib/anonymo/vault-memory/party';
import { saveVaultCampaign } from '@/lib/anonymo/vault-memory/store';
import { updateOn } from '@/lib/anonymo/updates';
import { mentionsSelfHarm } from '@/lib/anonymo/safety';
import { setupHref } from '@/lib/anonymo/setup-return';
import { CrisisNotice } from './companion-compliance';
import { useVaultMemory } from './vault-memory-state';
import './party.css';

function message(error: unknown) {
  return error instanceof AnonymoApiError ? error.message : 'Party could not complete that request. Try again.';
}

export function Party() {
  const { client, key, demo, refreshBalance } = useAnonymo();
  const vaultOn = updateOn('vaultsync', demo);
  const memory = useVaultMemory(demo, vaultOn);
  const [invite, setInvite] = useState<ReturnType<typeof readPartyInvite>>(null);
  const [options, setOptions] = useState<{ art: boolean; discord: boolean }>();
  const [seat, setSeat] = useState<PartySeat | null>(null);
  const [mature, setMature] = useState(false);
  const [art, setArt] = useState(false);
  const [discord, setDiscord] = useState(false);
  const [busy, setBusy] = useState(false);
  const [crisis, setCrisis] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [resume, setResume] = useState('');
  const [saveError, setSaveError] = useState('');
  const savedSignature = useRef('');
  const pending = useRef(false);
  const saved = new Map<string, CampaignSave>();
  for (const entry of [...(vaultOn ? campaignsFromMemory(memory.snapshot?.items ?? []) : []),
    ...vault.snapshotParty(demo).flatMap((item) => readCampaignSave(item) ?? [])]) {
    const id = entry.checkpoint.id;
    if (!saved.has(id) || saved.get(id)!.savedAt < entry.savedAt) saved.set(id, entry);
  }
  const resumeSave = saved.get(resume);
  const room = seat?.room;
  const id = room?.id;
  const credential = seat?.token;

  useEffect(() => {
    startVault();
    const read = () => setInvite(readPartyInvite(window.location.hash));
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  useEffect(() => {
    let alive = true;
    void client.partyOptions().then((result) => { if (alive) setOptions(result); }).catch((e: unknown) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [client]);

  function accept(next: PartyRoom) {
    setSeat((current) => current?.room.id === next.id && next.version >= current.room.version
      ? { ...current, room: next } : current);
  }

  useEffect(() => {
    if (!id || !credential) return;
    const controller = new AbortController();
    let ws: WebSocket | null = null;
    let inFlight = false;
    let queued = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      try {
        const view = await client.partyState(id, credential, controller.signal);
        if (!controller.signal.aborted) accept(view);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof AnonymoApiError && (e.status === 410 || [451, 403].includes(e.status))) {
          setSeat((current) => current?.room.id === id ? null : current);
          setError(message(e));
        }
      } finally {
        inFlight = false;
        if (queued) { queued = false; void refresh(); }
      }
    };
    function connect() {
      if (demo || controller.signal.aborted) return;
      try {
        ws = client.partySocket(id!);
        const socket = ws;
        socket.onopen = () => socket.send(credential!);
        socket.onmessage = () => void refresh();
        socket.onclose = () => {
          if (controller.signal.aborted) return;
          if (socket.readyState === WebSocket.CLOSED) void refresh();
          retry = setTimeout(connect, 30_000);
        };
      } catch {
        retry = setTimeout(connect, 30_000);
      }
    }
    connect();
    // Reconcile after interruptions in Redis pub/sub or an edge that does not upgrade sockets.
    const timer = setInterval(() => void refresh(), demo ? 1000 : 25_000);
    return () => {
      controller.abort();
      clearTimeout(retry);
      clearInterval(timer);
      ws?.close();
    };
  }, [id, credential, client, demo]);

  useEffect(() => {
    if (!room?.host || !room.checkpoint || memory.mode === 'locked' || memory.mode === 'loading' ||
        room.checkpoint === savedSignature.current) return;
    const save = campaignSave(room);
    if (!save) return;
    savedSignature.current = room.checkpoint;
    const store = async () => {
      await vault.updateParty(demo, (entries) => [
        save, ...entries.filter((entry) => readCampaignSave(entry)?.checkpoint.id !== save.checkpoint.id),
      ]);
      if (vaultOn) await saveVaultCampaign(demo, save);
    };
    void store().then(() => setSaveError(''), () => {
      setSaveError('The campaign could not be saved on this device or in Vault Memory.');
      savedSignature.current = '';
    });
  }, [room, demo, memory.mode, vaultOn]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    setCrisis(false);
    try {
      const next = invite ? await client.joinParty(invite.id, invite.invite) : await client.createParty({
        adult: true, mature: resumeSave?.checkpoint.mature ?? mature, art: !!options?.art && art, discord,
        checkpoint: resumeSave?.checkpoint,
      });
      if (invite) {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
        setInvite(null);
      }
      setSeat(next);
    } catch (e) {
      setError(message(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function act(action: PartyAction) {
    if (!seat || pending.current) return false;
    if (action.type === 'turn' && mentionsSelfHarm(action.text)) {
      setStatus('');
      setError('');
      setCrisis(true);
      return true;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    setCrisis(false);
    try {
      const result = await client.partyAction(seat.room.id, seat.token, action);
      if ('crisis' in result) {
        setCrisis(true);
        return true;
      }
      if (result.refused) {
        setStatus('The game master declined that action. The refused attempt cost $0.');
        return false;
      }
      if (result.room) accept(result.room);
      else setSeat(null);
      if (result.artError) setStatus(result.artError === 'art_blocked' ? 'Studio held the image back after a safety check.' : 'Studio couldn’t make an image for this turn.');
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
      if (key && action.type === 'turn') refreshBalance();
    }
  }

  async function copy() {
    if (!seat?.invite) return;
    const { id, discord } = seat.room;
    const text = discord ? seat.invite : new URL(`${PARTY_HREF}#invite=${id}.${seat.invite}`, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(discord ? 'Setup code copied.' : 'Invite link copied.');
    } catch {
      setError('Clipboard access is unavailable. Select and copy the link or code.');
    }
  }

  return (
    <div className="party">
      {!room ? (
        <form className="card party-entry" onSubmit={start}>
          <div>
            <Dices size={26} aria-hidden="true" />
            <h2>{invite ? 'You’re invited to Party' : 'Set the table'}</h2>
            <p className="muted">Up to six players. The host pays for turns and guests play free.</p>
          </div>
          {!invite && (
            <div className="party-fields">
              <label htmlFor="party-campaign">Campaign</label>
              <select id="party-campaign" className="input" value={resume} onChange={(event) => setResume(event.currentTarget.value)}>
                <option value="">New campaign</option>
                {[...saved.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).map(({ checkpoint, savedAt }) => (
                  <option key={checkpoint.id} value={checkpoint.id}>{checkpoint.campaign.scene.slice(0, 68)} · {new Date(savedAt).toLocaleDateString()}</option>
                ))}
              </select>
              {memory.mode === 'locked' && <Link href="/dashboard/vault">Unlock the device vault to see your campaigns</Link>}
              <div className="party-rules"><BookOpen size={16} aria-hidden="true" /> Open d20 · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></div>
              <label><input type="checkbox" checked={resumeSave?.checkpoint.mature ?? mature} disabled={!!resumeSave} onChange={(event) => setMature(event.currentTarget.checked)} /> Mature text campaign</label>
              {options?.discord && <label><input type="checkbox" checked={discord} onChange={(event) => setDiscord(event.currentTarget.checked)} /> Play in Discord</label>}
              {options?.art && <label><input type="checkbox" checked={art} onChange={(event) => setArt(event.currentTarget.checked)} /> Generate safe-for-work turn art</label>}
              {discord && <p className="faint">Discord keeps messages sent in Discord. Mature campaigns require an age-restricted server and channel.</p>}
            </div>
          )}
          {invite || key ? (
            <button className="btn btn-primary" disabled={busy || !options}><Plus size={16} aria-hidden="true" /> {invite ? 'Join room' : resumeSave ? 'Resume campaign' : 'Create room'}</button>
          ) : (
            <Link className="btn btn-primary" href={setupHref('key', PARTY_HREF)}>Set up a host key</Link>
          )}
          <p className="faint">Web rooms close after two hours of inactivity. The host’s device saves the campaign.</p>
        </form>
      ) : (
        <>
          <div className="party-bar">
            <span className="party-mode"><Dices size={16} aria-hidden="true" /> {room.discord ? 'Discord room' : room.mature ? 'Mature text' : 'Moderated room'}</span>
            <div className="party-room-actions">
              {seat?.invite && (!room.discord || !room.discordLinked) && <button type="button" className="btn btn-small" onClick={() => void copy()}><Copy size={14} aria-hidden="true" /> {room.discord ? 'Copy setup code' : 'Copy invite link'}</button>}
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void act({ type: room.host ? 'close' : 'leave' })}><DoorOpen size={14} aria-hidden="true" /> {room.host ? 'Close room' : 'Leave room'}</button>
            </div>
          </div>
          {room.discord && <section className="notice">
            <p>Discord keeps messages sent in Discord.</p>
            <p>Room ID <code>{room.id}</code></p>
            {!room.discordLinked && <label>Use this code with <code>/party host</code> in your channel <input className="input" readOnly value={seat?.invite ?? ''} onFocus={(event) => event.currentTarget.select()} /></label>}
          </section>}
          {!room.discord && seat?.invite && error.startsWith('Clipboard') && <input aria-label="Invite link" className="input" readOnly
            value={new URL(`${PARTY_HREF}#invite=${room.id}.${seat.invite}`, window.location.origin).href} onFocus={(event) => event.currentTarget.select()} />}
          <div className="party-table">
            <RoomScene key={room.id} room={room} busy={busy} act={act} />
            <aside className="party-side" aria-label="Table details">
              <section className="card party-panel">
                <h2><UsersRound size={17} aria-hidden="true" /> Players <span>{room.players.length}/6</span></h2>
                <ul>{room.players.map(({ slot, host }) => <li key={slot}>Player {slot}{host && ' · Host'}{slot === room.you && ' · You'}</li>)}</ul>
                {room.campaign.initiative.length > 0 && <p className="faint">Initiative · {room.campaign.initiative.join(' → ')}</p>}
              </section>
              <RoomDice room={room} busy={busy} act={act} />
              {room.campaign.inventory.length > 0 && <section className="card party-panel"><h2>Inventory</h2><ul>{room.campaign.inventory.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
            </aside>
          </div>
        </>
      )}
      {crisis && <div role="status"><CrisisNotice /></div>}
      {status && <p className="notice" role="status">{status}</p>}
      {error && <p className="notice" role="alert">{error}</p>}
      {saveError && <p className="notice" role="alert">{saveError}</p>}
    </div>
  );
}

type RoomProps = { room: PartyRoom; busy: boolean; act: (action: PartyAction) => Promise<boolean> };

function RoomScene({ room, busy, act }: RoomProps) {
  const [draft, setDraft] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim() && await act({ type: 'turn', text: draft.trim() })) setDraft('');
  }

  return (
    <section className="card party-scene">
      {room.art && <figure className="party-art">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/png;base64,${room.art}`} alt="Safe-for-work illustration of the current scene" />
        <figcaption>
          <ImageIcon size={14} aria-hidden="true" /> Turn art · Safe for work
          {room.artReceipt && <a download="art-receipt.json" href={`data:application/json,${encodeURIComponent(JSON.stringify(room.artReceipt))}`}>Art receipt</a>}
        </figcaption>
      </figure>}
      <header>
        <p className="faint">AI game master</p>
        <h2>Scene</h2>
      </header>
      <p className="party-narration" aria-live="polite">{room.campaign.scene}</p>
      {room.receipt && <Link className="party-receipt" href={`/dashboard/receipts/${encodeURIComponent(room.receipt)}`}><ReceiptText size={14} aria-hidden="true" /> Turn receipt</Link>}
      {room.campaign.log.length > 0 && <details className="party-log">
        <summary>Recent turns</summary>
        <ol>{room.campaign.log.map(({ player, action, scene }, i) => <li key={i}><strong>Player {player}</strong><p>{action}</p><p className="faint">{scene}</p></li>)}</ol>
      </details>}
      {!room.discord && <form className="party-turn" onSubmit={(event) => void submit(event)}>
        <label htmlFor="party-action">What do you do?</label>
        <textarea className="textarea" id="party-action" rows={3} maxLength={1200} value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)} placeholder="Describe your character’s action" />
        <button className="btn btn-primary" disabled={busy || !draft.trim()}><Send size={15} aria-hidden="true" /> {busy ? 'Working…' : 'Take a turn'}</button>
      </form>}
    </section>
  );
}

function RoomDice({ room, busy, act }: RoomProps) {
  const [sides, setSides] = useState<number>(20);
  const [verified, setVerified] = useState<{ reveal: string; valid: boolean } | null>(null);
  const roll = room.roll;
  const waiting = !!roll && roll.reveal === null;

  async function verify() {
    if (roll?.reveal) setVerified({ reveal: roll.reveal, valid: await verifyPartyRoll(room.id, roll) });
  }

  return (
    <section className="card party-panel party-dice">
      <h2><Dices size={17} aria-hidden="true" /> Dice</h2>
      {roll ? <>
        <p className="party-roll" aria-live="polite">{waiting ? `d${roll.sides} committed` : `d${roll.sides} rolled ${roll.value}`}</p>
        <p className="faint">Commitment</p>
        <code className="party-hash">{roll.commit}</code>
        {roll.reveal && <>
          <p className="faint">Reveal</p>
          <code className="party-hash">{roll.reveal}</code>
          <button className="btn btn-small" onClick={() => void verify()}>Verify roll</button>
          {verified?.reveal === roll.reveal && <p role="status">{verified.valid ? 'Roll verified' : 'Verification failed'}</p>}
        </>}
      </> : <p className="faint">The commitment appears before the result.</p>}
      {!room.discord && (waiting && roll ? (
        <div className="party-room-actions">
          {room.roller === room.you && <button className="btn btn-primary btn-small" disabled={busy}
            onClick={() => void act({ type: 'reveal', commit: roll.commit, nonce: partyNonce() })}>Reveal roll</button>}
          {room.host && <button className="btn btn-small" disabled={busy} onClick={() => void act({ type: 'discard' })}>Discard roll</button>}
        </div>
      ) : (
        <div className="party-room-actions">
          <select className="input" aria-label="Dice sides" value={sides} onChange={(event) => setSides(Number(event.currentTarget.value))}>
            {PARTY_DICE.map((side) => <option key={side} value={side}>d{side}</option>)}
          </select>
          <button className="btn btn-small" disabled={busy} onClick={() => void act({ type: 'commit', sides })}>Commit roll</button>
        </div>
      ))}
    </section>
  );
}
