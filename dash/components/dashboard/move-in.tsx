'use client';

// Update "movein": people bring their characters and chats from other apps. The export is read in this browser
// (lib/anonymo/movein), kept in an on-device archive, and nothing is uploaded: the only requests this page ever makes
// are the ordinary chat calls of "Build memory", each behind a button that shows its price.

import './movein.css';
import { useRouter, useSearchParams } from 'next/navigation';
import { PackageOpen, Square } from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { MoveInFace } from './move-in-face';
import { startImport, type RunningImport } from './move-in-import';
import { MemoryBoard } from './move-in-memory';
import { useVault } from './vault-controls';
import { greetingsOf } from '@/lib/anonymo/card';
import { MAX_CARDS } from '@/lib/anonymo/characters-store';
import { readChat, type ArchiveCharacter, type ChatHead } from '@/lib/anonymo/movein/archive';
import { ImportStopped, type ImportProgress, type ImportSummary } from '@/lib/anonymo/movein/importer';
import { dropReady, makeReady } from '@/lib/anonymo/movein/ready';
import { sampleFiles } from '@/lib/anonymo/movein/sample';
import { archiveDisk, forgetAll, forgetCharacter, moveInPersists, renameCharacter, useMoveIn } from '@/lib/anonymo/movein/store';
import { lastTurns, pairTurns, toChatTurns } from '@/lib/anonymo/movein/turns';
import { nameKey, SOURCES } from '@/lib/anonymo/movein/types';
import { AI_NOTICE } from '@/lib/anonymo/safety';
import { updateOn } from '@/lib/anonymo/updates';

const ACCEPT = '.zip,.json,.jsonl,.png,application/zip,application/json,image/png';
const SHOWN_CHATS = 3;
const LISTED_CHATS = 150;

const n = (value: number) => value.toLocaleString('en-US');
const count = (value: number, one: string, many = `${one}s`) => `${n(value)} ${value === 1 ? one : many}`;
const day = (ms: number | undefined) => (ms === undefined ? '' : new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }));
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

const BROUGHT: { name: string; what: string; early?: boolean }[] = [
  { name: 'SillyTavern', what: 'character cards (.png or .json), chat logs (.jsonl), or a zip of both' },
  { name: 'ChatGPT', what: 'the export zip, or its conversations.json' },
  { name: 'Claude', what: 'the export zip, or its conversations.json' },
  { name: 'Character.AI', what: 'message.json and character.json, after you unzip the export', early: true },
  { name: 'Anything else', what: 'a .json or .jsonl file with a list of messages' },
];

export function MoveIn() {
  const { demo, turns, openChat } = useAnonymo();
  const router = useRouter();
  const archive = useMoveIn(demo);
  const vault = useVault();
  const picker = useRef<HTMLInputElement>(null);
  const running = useRef<RunningImport | null>(null);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [problem, setProblem] = useState('');
  const requestedCharacter = useSearchParams().get('character');
  const [boardFor, setBoardFor] = useState<string | null>(requestedCharacter);
  const [confirmAll, setConfirmAll] = useState(false);
  const reading = progress !== null;
  const streaming = turns.some((turn) => turn.status === 'streaming');

  async function read(files: { name: string; blob: Blob }[]) {
    if (!files.length || running.current) return;
    setProblem('');
    setResult(null);
    setProgress({ file: files[0]!.name, chats: 0, messages: 0 });
    const run = startImport(files, demo, setProgress);
    running.current = run;
    try {
      setResult(await run.done);
    } catch (error) {
      setProblem(error instanceof ImportStopped ? 'Stopped. Nothing from that drop was kept.' : 'That could not be read. Nothing from it was kept.');
    } finally {
      running.current = null;
      setProgress(null);
    }
  }
  const drop = (list: FileList | null | undefined) => void read(Array.from(list ?? [], (file) => ({ name: file.name, blob: file })));

  /** Puts the character among the ones chat can pick. Says why when it cannot. */
  function ready(character: ArchiveCharacter): boolean {
    const state = makeReady(character, archive.characters);
    if (state === 'ready') return true;
    setProblem(
      state === 'full'
        ? `This browser keeps ${MAX_CARDS} characters ready for chat, and every place is taken by a card from the Characters page. Remove one there to make room for ${character.name}.`
        : `This browser would not store ${character.name}’s card. Its storage is full or blocked.`,
    );
    return false;
  }

  async function open(character: ArchiveCharacter, head: ChatHead | null) {
    setProblem('');
    if (streaming) return setProblem('A reply is still arriving in chat. Stop it or let it finish, then continue here.');
    if (!ready(character)) return;
    let chatTurns: ReturnType<typeof toChatTurns> = [];
    if (head) {
      const chat = await readChat(archiveDisk(), demo, head.id).catch(() => null);
      if (!chat) return setProblem('That chat is no longer on this device.');
      // The last turns are loaded; everything before them is carried by the character's memory, not sent again.
      chatTurns = toChatTurns(lastTurns(pairTurns(chat.messages)), { character: character.name, label: `from ${SOURCES[head.source].label}` }, () => crypto.randomUUID());
    }
    openChat(null, chatTurns);
    router.push(`/dashboard/chat?character=${encodeURIComponent(character.id)}`);
  }

  async function remove(character: ArchiveCharacter) {
    await forgetCharacter(demo, character);
    dropReady([character.id]);
    if (boardFor === character.id) setBoardFor(null);
  }

  async function rename(character: ArchiveCharacter, name: string): Promise<string | null> {
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) return 'Give the character a name.';
    if (archive.characters.some((c) => c.id !== character.id && nameKey(c.name) === nameKey(clean))) return 'Another character here already has that name.';
    const next = await renameCharacter(demo, character, clean);
    // A card that is already in the chat list is replaced there, so chat uses the new name too.
    if (next) makeReady(next, archive.characters);
    return null;
  }

  const total = archive.characters.reduce((sum, c) => sum + c.messages, 0);
  const shown = archive.characters.find((c) => c.id === boardFor) ?? null;
  const vaultOn = updateOn('vault', demo) && (vault.mode === 'locked' || vault.mode === 'unlocked');

  return (
    <div className="panel-stack mi">
      <section className="panel">
        <header>
          <h2>Bring them with you</h2>
          <span className="faint">.zip · .json · .jsonl · .png</span>
        </header>
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept={ACCEPT}
          onChange={(event) => {
            drop(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="dropzone mi-drop"
          data-over={over}
          disabled={reading}
          onClick={() => picker.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            drop(event.dataTransfer.files);
          }}
        >
          <PackageOpen size={26} aria-hidden="true" />
          <span>Drop your export here, or choose files</span>
          <span className="faint">It is read in this browser. Nothing is uploaded.</span>
        </button>

        {reading && (
          <output className="mi-reading" aria-live="polite">
            <span className="mi-spool" aria-hidden="true" />
            <span className="mono">
              Reading {clip(progress.file, 40)} · {count(progress.chats, 'chat')} · {count(progress.messages, 'message')}
            </span>
            <button type="button" className="btn btn-small" onClick={() => running.current?.stop()}>
              <Square size={13} fill="currentColor" aria-hidden="true" /> Stop
            </button>
          </output>
        )}
        {result && <Outcome result={result} />}
        {problem && (
          <p className="error-text" role="alert">
            {problem}
          </p>
        )}

        <ul className="mi-sources">
          {BROUGHT.map((source) => (
            <li key={source.name}>
              <strong>{source.name}</strong>
              {source.early && (
                <span className="chip chip-amber" title="Built from public descriptions of the export, not yet checked against a real file.">
                  early
                </span>
              )}
              <span className="muted">{source.what}</span>
            </li>
          ))}
        </ul>
        <div className="row">
          {demo && (
            <button type="button" className="btn" disabled={reading} onClick={() => void read(sampleFiles().map((file) => ({ name: file.name, blob: new Blob([file.text]) })))}>
              Try a sample export
            </button>
          )}
          <span className="faint">Anonymo is for adults only. What you bring is checked like any other message when you send it, never before.</span>
        </div>
        {archive.loaded && !moveInPersists() && <p className="notice notice-amber">This browser is blocking its storage, so what you bring over lasts only until this tab is closed.</p>}
        {vaultOn && <p className="notice">The vault passphrase does not cover Move In yet. What moves in is stored in this browser without it, and Wipe removes it with everything else.</p>}
      </section>

      {archive.loaded && archive.characters.length > 0 && (
        <section className="mi-moved" aria-label="Who moved in">
          <p className="mono mi-count">
            {count(archive.characters.length, 'character')} · {count(total, 'message')} · 0 uploaded
          </p>
          <ul className="mi-wall">
            {archive.characters.map((character, i) => (
              <Resident
                key={character.id}
                character={character}
                order={i}
                patches={archive.boards[character.id]?.patches.length ?? 0}
                waiting={streaming}
                onOpen={(head) => void open(character, head)}
                onBoard={() => setBoardFor(character.id)}
                onRename={(name) => rename(character, name)}
                onRemove={() => void remove(character)}
              />
            ))}
          </ul>
          <p className="ai-notice">{AI_NOTICE}</p>
          <div className="row mi-all">
            {confirmAll ? (
              <>
                <span>Remove all {count(archive.characters.length, 'character')} that moved in, with their chats and memory?</span>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  onClick={() => {
                    dropReady(archive.characters.map((c) => c.id));
                    setBoardFor(null);
                    setConfirmAll(false);
                    setResult(null);
                    void forgetAll(demo);
                  }}
                >
                  Remove them
                </button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirmAll(false)}>
                  Keep them
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirmAll(true)}>
                Remove everything that moved in
              </button>
            )}
          </div>
        </section>
      )}

      {shown && <MemoryBoard key={shown.id} character={shown} board={archive.boards[shown.id]} onClose={() => setBoardFor(null)} />}
    </div>
  );
}

/** What one drop brought, and what was left out of it. */
function Outcome({ result }: { result: ImportSummary }) {
  const nothing = result.characters === 0 && result.chats === 0;
  return (
    <div className={nothing ? 'notice notice-amber mi-outcome' : 'notice notice-signal mi-outcome'}>
      <output>
        {nothing
          ? 'Nothing in that drop could be moved in.'
          : `Moved in: ${count(result.characters, 'character')}, ${count(result.chats, 'chat')}, ${count(result.messages, 'message')}. They are below.`}
      </output>
      {result.notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {result.skipped.length > 0 && (
        <details>
          <summary>{count(result.skipped.length, 'file')} left out</summary>
          <ul>
            {result.skipped.slice(0, 40).map((file, i) => (
              <li key={`${file.name}-${i}`}>
                <span className="mono">{clip(file.name, 48)}</span> {file.why}
              </li>
            ))}
            {result.skipped.length > 40 && <li>And {n(result.skipped.length - 40)} more.</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

function Resident({
  character,
  order,
  patches,
  waiting,
  onOpen,
  onBoard,
  onRename,
  onRemove,
}: {
  character: ArchiveCharacter;
  order: number;
  patches: number;
  waiting: boolean;
  onOpen: (head: ChatHead | null) => void;
  onBoard: () => void;
  onRename: (name: string) => Promise<string | null>;
  onRemove: () => void;
}) {
  const [all, setAll] = useState(false);
  const [find, setFind] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');
  const [removing, setRemoving] = useState(false);
  const { name, card, chats } = character;
  const source = SOURCES[character.source];
  const blurb = card.data.description.trim() || card.data.personality.trim() || (character.built ? `Chats brought over from ${source.label === 'another app' ? 'another app' : `a ${source.label} export`}.` : '');
  const greeting = greetingsOf(card)[0] ?? '';
  const wanted = find.trim().toLowerCase();
  const matching = wanted ? chats.filter((chat) => chat.title.toLowerCase().includes(wanted)) : chats;
  const listed = all ? matching.slice(0, LISTED_CHATS) : chats.slice(0, SHOWN_CHATS);
  const listId = `mi-chats-${character.id}`;

  return (
    <li className="card mi-card" style={{ '--mi-order': Math.min(order, 18) } as CSSProperties}>
      <div className="mi-card-head">
        <MoveInFace characterId={character.id} name={name} />
        <div className="mi-card-title">
          {naming === null ? (
            <h3>{name}</h3>
          ) : (
            <form
              className="mi-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void onRename(naming).then((error) => {
                  setNameError(error ?? '');
                  if (!error) setNaming(null);
                });
              }}
            >
              <label className="sr-only" htmlFor={`mi-name-${character.id}`}>
                Character name
              </label>
              <input id={`mi-name-${character.id}`} className="input" value={naming} maxLength={60} autoComplete="off" onChange={(event) => setNaming(event.target.value)} />
              <button type="submit" className="btn btn-small btn-primary">
                Save
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                onClick={() => {
                  setNaming(null);
                  setNameError('');
                }}
              >
                Cancel
              </button>
            </form>
          )}
          <div className="mi-card-tags">
            <span className="chip">{character.built ? `from ${source.label}` : 'Character card'}</span>
            {source.early && (
              <span className="chip chip-amber" title="Built from public descriptions of the export, not yet checked against a real file.">
                early
              </span>
            )}
            <span className="faint">
              {count(chats.length, 'chat')} · {count(character.messages, 'message')}
            </span>
          </div>
        </div>
      </div>
      {nameError && (
        <p className="error-text" role="alert">
          {nameError}
        </p>
      )}
      {blurb && <p className="muted mi-blurb">{clip(blurb, 170)}</p>}
      {(card.data.description.trim().length > 170 || greeting) && (
        <details className="mi-says">
          <summary>What the card says</summary>
          {card.data.description.trim() && <p>{card.data.description.trim()}</p>}
          {greeting && <p className="mi-greeting">{greeting}</p>}
        </details>
      )}

      <div className="row mi-card-tools">
        <button type="button" className="btn btn-small" onClick={onBoard}>
          What {clip(name, 22)} remembers
          {patches > 0 && <span className="mi-badge">{n(patches)}</span>}
        </button>
        {chats.length === 0 && (
          <button type="button" className="btn btn-small btn-primary" disabled={waiting} onClick={() => onOpen(null)}>
            Start a chat
          </button>
        )}
        {character.built && naming === null && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setNaming(name)}>
            Rename
          </button>
        )}
        {removing ? (
          <>
            <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
              Remove {clip(name, 18)} from this browser
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setRemoving(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setRemoving(true)}>
            Remove
          </button>
        )}
      </div>

      {chats.length > 0 && (
        <div className="mi-chats">
          {all && chats.length > 12 && (
            <>
              <label className="sr-only" htmlFor={`mi-find-${character.id}`}>
                Find a chat with {name}
              </label>
              <input id={`mi-find-${character.id}`} className="input" type="search" placeholder="Find a chat" value={find} onChange={(event) => setFind(event.target.value)} />
            </>
          )}
          <ul id={listId} className="list">
            {listed.map((chat) => (
              <li key={chat.id}>
                <span className="mi-chat-title">
                  <span>{chat.title}</span>
                  <span className="faint">
                    {count(chat.messages, 'message')}
                    {day(chat.updatedAt ?? chat.createdAt) && ` · ${day(chat.updatedAt ?? chat.createdAt)}`}
                  </span>
                </span>
                <button type="button" className="btn btn-small btn-primary" disabled={waiting} aria-label={`Continue “${clip(chat.title, 60)}” with ${name}`} onClick={() => onOpen(chat)}>
                  Continue
                </button>
              </li>
            ))}
            {all && matching.length === 0 && <li className="faint">No chat by that name.</li>}
            {all && matching.length > LISTED_CHATS && <li className="faint">Showing the newest {n(LISTED_CHATS)} of {n(matching.length)}. Search to find an older one.</li>}
          </ul>
          {chats.length > SHOWN_CHATS && (
            <button type="button" className="btn btn-small btn-ghost" aria-expanded={all} aria-controls={listId} onClick={() => setAll((value) => !value)}>
              {all ? 'Show fewer' : `Show all ${n(chats.length)} chats`}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
