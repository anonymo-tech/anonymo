// One drop, from files to the archive. Every file is read here in the browser (in a worker when it is large): zips are
// opened entry by entry, each file goes to the parser whose detector accepts it, conversations are written to the
// archive as they are read so a huge export never sits in memory whole, and at the end chats are tied to characters.
//
// Lifeboat can check card text before saving it. Chats are parsed and saved on the device.

import { mapChatGptSetup, type AboutYouImport } from '../about-you.ts';
import { cardHash, greetingsOf, type CharacterCard } from '../card.ts';
import { byNewest, loadArchive, readChat, scopeOf, sweepOrphans, writeCharacters, writeChats, type ArchiveCharacter, type ArchiveChat, type ArchiveDisk, type ChatHead } from './archive.ts';
import { buildCard, CardError, detectCard, normalizeCard, readCardBytes } from './cards.ts';
import { chatGptCharacter, CHATGPT_NAME, detectChatGptConversation, emptyChatGptSetup, latestChatGptSetup, parseChatGptConversation } from './chatgpt.ts';
import { caiRow, chatsFromRows, detectCaiRow, detectCharacterAi, isGreeting, parseCharacterAi, UNNAMED, type CaiRow } from './characterai.ts';
import { claudeCharacter, CLAUDE_NAME, detectClaudeConversation, detectClaudeMemories, parseClaudeConversation, parseClaudeMemories } from './claude.ts';
import { detectGeneric, parseGeneric, parseGenericLines, parseTranscript } from './generic.ts';
import { CARD_CHECK_UNAVAILABLE, type CardCheck } from './floor.ts';
import { arrayItems, firstJsonByte, JsonStreamError } from './json-stream.ts';
import { emptyBoard, withExportMemory, withImportedHistory, type Board } from './memory.ts';
import { chatFolderOf, detectSillyTavernChat, parseSillyTavernChat } from './sillytavern.ts';
import { openingLine } from './turns.ts';
import { isObj, nameKey, shortId, type Found, type FoundCharacter, type FoundChat, type SourceId } from './types.ts';
import { importableZipEntries, looksLikeZip, openZipEntry, readZipDirectory, readZipEntry, ZipError, type ZipEntry } from './zip.ts';

export type DropFile = { name: string; blob: Blob };
export type ImportProgress = { file: string; chats: number; messages: number };
export type Skipped = { name: string; why: string };
export type ImportSummary = {
  /** Characters this import added or added chats to. */
  ids: string[];
  characters: number;
  chats: number;
  messages: number;
  sources: SourceId[];
  /** A built character whose chats and memory a real card took over: the old id, and the card's. */
  replaced: { from: string; to: string }[];
  skipped: Skipped[];
  notes: string[];
  duplicates?: number;
  aboutYou?: AboutYouImport[];
};

export class ImportStopped extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'ImportStopped';
  }
}

/** A whole file held in memory at once (a card, a chat log, a JSON object) may be at most this large. */
const MAX_WHOLE_BYTES = 64 * 1024 * 1024;
const MAX_CARD_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_IMAGES = 2000;
/** Conversations are written in batches of about this much text. */
const BATCH_CHARS = 2_000_000;
const BATCH_CHATS = 60;
/** A list that is neither messages nor conversations is given up on after this many elements. */
const GENERIC_PROBE = 40;
const GENERIC_MAX_ITEMS = 200_000;

/** One readable thing: a dropped file, or an entry inside a dropped zip. */
type Item = {
  path: string;
  size: number;
  inZip: boolean;
  bytes: () => Promise<Uint8Array>;
  stream: () => Promise<ReadableStream<Uint8Array>>;
};

const baseOf = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? path;
const stemOf = (path: string) => baseOf(path).replace(/\.[^.]+$/, '');
const extOf = (path: string) => /\.([a-z0-9]+)$/i.exec(baseOf(path))?.[1]?.toLowerCase() ?? '';
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const importKeyOf = (head: ChatHead) => head.importKey ?? head.id;

async function firstBytes(item: Item, count = 64): Promise<Uint8Array> {
  const reader = (await item.stream()).getReader();
  try {
    const { value } = await reader.read();
    return value ? value.subarray(0, count) : new Uint8Array();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

type Group = { source: SourceId; name: string; folder: string; heads: ChatHead[]; opening: { at: number; text: string } | null };
type FoundCard = { card: CharacterCard; fileBase: string; label: string };

export async function importFiles(
  files: DropFile[],
  disk: ArchiveDisk,
  demo: boolean,
  opts: { onProgress?: (progress: ImportProgress) => void; signal?: AbortSignal; now?: () => number; newId?: () => string; aboutYou?: boolean; checkCard?: CardCheck } = {},
): Promise<ImportSummary> {
  const lifeboat = !!opts.checkCard;
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const skipped: Skipped[] = [];
  const notes = new Set<string>();
  const sources = new Set<SourceId>();
  const cards: FoundCard[] = [];
  const parts = new Map<string, FoundCharacter>(); // characters a source described without a card
  const groups = new Map<string, Group>();
  const seenChats = new Set<string>();
  const archivedChatKeys = new Set<string>();
  const verdicts = new Map<string, string | null>();
  let duplicates = 0;
  let batch: ArchiveChat[] = [];
  let batchChars = 0;
  let chats = 0;
  let messages = 0;
  let current = '';
  let newestChatGptSetup = emptyChatGptSetup();
  let claudeMemory = '';
  const caiRows: CaiRow[] = []; // Character.AI's message list names no chat's character, so it waits for every file

  const check = () => {
    if (opts.signal?.aborted) throw new ImportStopped();
  };
  const progress = () => opts.onProgress?.({ file: current, chats, messages });
  async function cardRejection(card: CharacterCard, hash: string): Promise<string | null> {
    check();
    if (!opts.checkCard) return null;
    if (verdicts.has(hash)) return verdicts.get(hash) ?? null;
    const reason = await opts.checkCard(card, opts.signal).catch(() => CARD_CHECK_UNAVAILABLE);
    check();
    verdicts.set(hash, reason);
    return reason;
  }
  const flush = async () => {
    if (!batch.length) return;
    const writing = batch;
    batch = [];
    batchChars = 0;
    await writeChats(disk, demo, writing);
  };

  async function addChat(found: FoundChat, folder = '') {
    check();
    if (!found.messages.length) return;
    const importKey = shortId(`${found.source}|${found.key}`);
    if (seenChats.has(importKey)) return; // the same conversation twice in one drop
    seenChats.add(importKey);
    // Stage a revision separately so a rejected card or failed import cannot overwrite the saved log.
    const id = archivedChatKeys.has(importKey) ? `${importKey}-${newId()}` : importKey;
    sources.add(found.source);
    const groupKey = `${found.source}|${nameKey(folder) || nameKey(found.character)}`;
    let group = groups.get(groupKey);
    if (!group) groups.set(groupKey, (group = { source: found.source, name: found.character, folder, heads: [], opening: null }));
    group.heads.push({
      id,
      ...(id !== importKey ? { importKey } : {}),
      title: found.title.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Untitled chat',
      source: found.source,
      messages: found.messages.length,
      ...(found.createdAt !== undefined ? { createdAt: found.createdAt } : {}),
      ...(found.updatedAt !== undefined ? { updatedAt: found.updatedAt } : {}),
    });
    const opening = openingLine(found.messages);
    const at = found.createdAt ?? Number.MAX_SAFE_INTEGER;
    if (opening && (!group.opening || at < group.opening.at)) group.opening = { at, text: opening };
    batch.push({ id, messages: found.messages });
    batchChars += found.messages.reduce((sum, m) => sum + m.text.length, 0);
    chats++;
    messages += found.messages.length;
    progress();
    if (batch.length >= BATCH_CHATS || batchChars >= BATCH_CHARS) await flush();
  }

  const addCharacter = (found: FoundCharacter) => {
    sources.add(found.source);
    if (found.card) cards.push({ card: found.card, fileBase: found.fileBase ?? '', label: current || found.name });
    else parts.set(`${found.source}|${nameKey(found.name)}`, { ...parts.get(`${found.source}|${nameKey(found.name)}`), ...found });
  };

  async function addFound(found: Found) {
    for (const character of found.characters) addCharacter(character);
    for (const chat of found.chats) await addChat(chat);
    for (const note of found.notes) notes.add(note);
  }

  /** A parsed JSON value that is not a list of conversations: a card, one conversation, or a small export file. */
  async function readValue(value: unknown, item: Item): Promise<boolean> {
    if (detectCard(value)) {
      cards.push({ card: normalizeCard(value), fileBase: stemOf(item.path), label: baseOf(item.path) });
      sources.add('sillytavern');
      return true;
    }
    if (detectChatGptConversation(value)) {
      await addChatGpt(value);
      return true;
    }
    if (detectClaudeConversation(value)) {
      const chat = parseClaudeConversation(value);
      if (chat) await addChat(chat);
      return true;
    }
    if (detectClaudeMemories(value)) {
      claudeMemory = parseClaudeMemories(value) || claudeMemory;
      return true;
    }
    if (detectCharacterAi(value)) {
      await addFound(parseCharacterAi(value, stemOf(item.path)));
      return true;
    }
    if (detectGeneric(value)) {
      for (const chat of parseGeneric(value, stemOf(item.path))) await addChat(chat);
      return true;
    }
    return false;
  }

  async function addChatGpt(conversation: Record<string, unknown>) {
    const parsed = parseChatGptConversation(conversation);
    // The newest conversation's settings are the ones the person last had.
    newestChatGptSetup = latestChatGptSetup(newestChatGptSetup, parsed);
    sources.add('chatgpt');
    if (parsed.chat) await addChat(parsed.chat);
  }

  /** A JSON file whose top level is a list: read one element at a time, routed by what its first real element is. */
  async function readList(item: Item): Promise<boolean> {
    let kind: 'chatgpt' | 'claude' | 'memories' | 'cairows' | 'other' | null = null;
    const other: unknown[] = [];
    for await (const element of arrayItems(await item.stream())) {
      check();
      // Exports carry the odd empty entry; it says nothing about what the list holds.
      if (isObj(element) && Object.keys(element).length === 0) continue;
      kind ??= detectChatGptConversation(element) ? 'chatgpt' : detectClaudeConversation(element) ? 'claude' : detectClaudeMemories(element) ? 'memories' : detectCaiRow(element) ? 'cairows' : 'other';
      if (kind === 'chatgpt') {
        if (detectChatGptConversation(element)) await addChatGpt(element);
      } else if (kind === 'claude') {
        const chat = detectClaudeConversation(element) ? parseClaudeConversation(element) : null;
        sources.add('claude');
        if (chat) await addChat(chat);
      } else if (kind === 'memories') {
        claudeMemory = parseClaudeMemories(element) || claudeMemory;
      } else if (kind === 'cairows') {
        sources.add('characterai');
        if (detectCaiRow(element)) caiRows.push(caiRow(element, caiRows.length));
      } else {
        other.push(element);
        // A long list of something else (feedback rows, shared links) is not worth holding on to.
        if (other.length === GENERIC_PROBE && !detectCharacterAi(other) && !detectGeneric(other)) return false;
        if (other.length > GENERIC_MAX_ITEMS) break;
      }
    }
    if (kind === null) return false;
    if (kind !== 'other') return true;
    if (detectCharacterAi(other)) {
      await addFound(parseCharacterAi(other, stemOf(item.path)));
      return true;
    }
    if (!detectGeneric(other)) return false;
    for (const chat of parseGeneric(other, stemOf(item.path))) await addChat(chat);
    return true;
  }

  async function readItem(item: Item) {
    check();
    current = baseOf(item.path);
    progress();
    const ext = extOf(item.path);
    const skip = (why: string) => {
      // Inside a zip most files are not chats (settings, pictures, pages); only the dropped files themselves are reported.
      if (!item.inZip) skipped.push({ name: baseOf(item.path), why });
    };
    try {
      if (ext === 'png') {
        if (item.size > MAX_CARD_BYTES) return skip('Larger than 8 MB, so it was not read as a character card.');
        const bytes = await item.bytes();
        try {
          cards.push({ card: readCardBytes(bytes), fileBase: stemOf(item.path), label: baseOf(item.path) });
          sources.add('sillytavern');
        } catch {
          skip('This picture holds no character card that can be read.');
        }
        return;
      }
      if (lifeboat && ext === 'txt') {
        if (item.size > MAX_WHOLE_BYTES) return skip('This transcript is too large to read here.');
        const chat = parseTranscript(decode(await item.bytes()), stemOf(item.path));
        if (chat) await addChat(chat);
        else skip('No speaker turns found. Use the transcript paste guide.');
        return;
      }
      if (ext === 'jsonl') {
        if (item.size > MAX_WHOLE_BYTES) return skip('This chat log is too large to read here.');
        const source = decode(await item.bytes());
        if (detectSillyTavernChat(source)) {
          const chat = parseSillyTavernChat(source, item.path);
          if (chat) await addChat(chat, chatFolderOf(item.path));
          else skip('No messages in this chat log.');
          return;
        }
        const found = parseGenericLines(source, stemOf(item.path));
        if (!found.length) return skip('No chat messages were found in this file.');
        for (const chat of found) await addChat(chat);
        return;
      }
      if (ext === 'json') {
        // The account files of a ChatGPT or Claude export hold a name and an address. They are never opened.
        if (/^users?\.json$/i.test(baseOf(item.path))) return skip('Your account file. It was not opened.');
        const first = firstJsonByte(await firstBytes(item));
        if (first === 0x5b) {
          if (!(await readList(item))) skip('No chats or characters were found in this file.');
          return;
        }
        if (first !== 0x7b) return skip('This file is not JSON.');
        if (item.size > MAX_WHOLE_BYTES) return skip('This file is too large to read here.');
        let value: unknown;
        try {
          value = JSON.parse(decode(await item.bytes()));
        } catch {
          return skip('This file is not valid JSON.');
        }
        if (!(await readValue(value, item))) skip('No chats or characters were found in this file.');
        return;
      }
      skip(lifeboat ? 'Lifeboat reads .zip, .json, .jsonl, .txt and .png files.' : 'Move In reads .zip, .json, .jsonl and .png files.');
    } catch (error) {
      if (error instanceof ImportStopped) throw error;
      if (error instanceof CardError || error instanceof ZipError || error instanceof JsonStreamError) skipped.push({ name: baseOf(item.path), why: error.message });
      else skipped.push({ name: baseOf(item.path), why: 'This file could not be read.' });
    }
  }

  async function readZip(file: DropFile) {
    let entries: ZipEntry[];
    try {
      entries = await readZipDirectory(file.blob);
    } catch (error) {
      skipped.push({ name: file.name, why: error instanceof ZipError ? error.message : 'This zip could not be opened.' });
      return;
    }
    const wanted = importableZipEntries(entries, lifeboat);
    if (wanted.length && wanted.every((e) => e.encrypted)) {
      // Character.AI locks its export with the account's email address. Nothing here asks for an address, so the
      // person unlocks it with their own computer and drops what is inside.
      const isCai = wanted.some((e) => /(^|\/)message\.json$/i.test(e.name));
      skipped.push({
        name: file.name,
        why: isCai
          ? 'This Character.AI export is locked with a password (your account email, in lowercase). Unzip it on your device, then drop message.json and character.json here.'
          : 'This zip is locked with a password. Unzip it on your device, then drop the files here.',
      });
      return;
    }
    // Move In skips pictures in known assistant exports. Lifeboat also accepts mixed bundles.
    const isAssistantExport = !lifeboat && wanted.some((e) => /^conversations(-\d+)?\.json$/i.test(baseOf(e.name)));
    const images = wanted.filter((e) => extOf(e.name) === 'png');
    if (entries.some((e) => extOf(e.name) === 'zip')) notes.add('A zip inside the zip was not opened. Unzip it and drop it on its own.');
    if (!isAssistantExport && images.length > MAX_ZIP_IMAGES) notes.add(`Only the first ${MAX_ZIP_IMAGES.toLocaleString('en-US')} pictures in the zip were checked for character cards.`);
    // Cards first, so a chat finds its character whatever order the zip lists them in.
    const ordered = [...(isAssistantExport ? [] : images.slice(0, MAX_ZIP_IMAGES)), ...wanted.filter((e) => extOf(e.name) !== 'png')];
    if (!ordered.length) skipped.push({ name: file.name, why: lifeboat ? 'This zip holds no supported cards or chat files.' : 'This zip holds no .json, .jsonl or .png files.' });
    for (const entry of ordered) {
      await readItem({
        path: entry.name,
        size: entry.size,
        inZip: true,
        bytes: () => readZipEntry(file.blob, entry, MAX_WHOLE_BYTES),
        stream: () => openZipEntry(file.blob, entry),
      });
    }
  }

  let finished = false;
  try {
    await sweepOrphans(disk, demo);
    const priorArchive = lifeboat ? await loadArchive(disk, demo) : null;
    for (const character of priorArchive?.characters ?? []) for (const head of character.chats) archivedChatKeys.add(importKeyOf(head));
    for (const file of files) {
      check();
      const head = new Uint8Array(await file.blob.slice(0, 4).arrayBuffer());
      if (extOf(file.name) === 'zip' || looksLikeZip(head)) await readZip(file);
      else
        await readItem({
          path: file.name,
          size: file.blob.size,
          inZip: false,
          bytes: async () => new Uint8Array(await file.blob.arrayBuffer()),
          stream: async () => file.blob.stream() as ReadableStream<Uint8Array>,
        });
    }
    const existing = priorArchive ?? await loadArchive(disk, demo);

    // Character.AI: a chat is known only by its opening line, so each one goes to the character whose greeting that
    // is (from character.json, a card, or an earlier import), and the rest share an unnamed character per greeting.
    if (caiRows.length) {
      current = 'Character.AI chats';
      const known: { name: string; greeting: string }[] = [
        ...[...parts.values()].map((c) => ({ name: c.name, greeting: c.greeting ?? '' })),
        ...cards.flatMap((c) => (lifeboat ? greetingsOf(c.card) : [c.card.data.first_mes]).map((greeting) => ({ name: c.card.data.name, greeting }))),
        ...existing.characters.flatMap((c) => (lifeboat ? greetingsOf(c.card) : [c.card.data.first_mes]).map((greeting) => ({ name: c.name, greeting }))),
      ].filter((k) => k.greeting.trim());
      let unnamed = Math.max(0, ...known.map((k) => Number(new RegExp(`^${UNNAMED} (\\d+)$`).exec(k.name)?.[1] ?? 0)));
      for (const chat of chatsFromRows(caiRows)) {
        const opening = openingLine(chat.messages);
        let who = known.find((k) => isGreeting(opening, k.greeting));
        if (!who) known.push((who = { name: `${UNNAMED} ${++unnamed}`, greeting: opening }));
        await addChat({ ...chat, character: who.name });
      }
      caiRows.length = 0;
      notes.add(`Character.AI’s export does not say who wrote each message. ${lifeboat ? 'Lifeboat' : 'Move In'} took the character to speak first and the two of you to take turns, so read a chat through before you rely on it.`);
    }
    await flush();
    check();

    // ---- tie chats to characters --------------------------------------------------------------------------------
    const chatGptSetup = newestChatGptSetup.setup;
    if (chatGptSetup.aboutModel || chatGptSetup.aboutUser || chatGptSetup.saved || groups.has(`chatgpt|${nameKey(CHATGPT_NAME)}`)) addCharacter(chatGptCharacter(chatGptSetup));
    if (claudeMemory || groups.has(`claude|${nameKey(CLAUDE_NAME)}`)) addCharacter(claudeCharacter(claudeMemory));

    const byId = new Map(existing.characters.map((c) => [c.id, c]));
    const out = new Map<string, ArchiveCharacter>();
    const boards: Record<string, Board> = {};
    const touched = new Set<string>();
    const dropped = new Set<string>();
    const replaced: ImportSummary['replaced'] = [];
    const retired = new Set<string>();
    const stamp = new Date(now()).toISOString();
    const total = (heads: ChatHead[]) => heads.reduce((sum, head) => sum + head.messages, 0);
    const mergeChats = (record: ArchiveCharacter, heads: ChatHead[]) => {
      const merged = new Map(record.chats.map((head) => [importKeyOf(head), head]));
      for (const head of heads) {
        const key = importKeyOf(head);
        const prior = merged.get(key);
        if (prior && prior.id !== head.id) retired.add(prior.id);
        merged.set(key, head);
      }
      record.chats = [...merged.values()].sort(byNewest);
      record.messages = total(record.chats);
    };

    /** The record a card is kept under: the one already in the archive, or a new one. */
    const recordFor = async (card: CharacterCard, source: SourceId, built: boolean, reuse?: ArchiveCharacter, knownHash?: string): Promise<ArchiveCharacter> => {
      const hash = knownHash ?? await cardHash(card);
      const id = reuse?.id ?? hash.slice(0, 16);
      const prior = out.get(id) ?? byId.get(id);
      const record: ArchiveCharacter = { id, hash, name: card.data.name, source: prior?.source ?? source, card, built, importedAt: stamp, chats: prior?.chats ?? [], messages: prior?.messages ?? 0 };
      out.set(id, record);
      touched.add(id);
      return record;
    };

    // Cards that came in this drop, by the file they were in and by name.
    const byFile = new Map<string, ArchiveCharacter>();
    const byName = new Map<string, ArchiveCharacter>();
    const byHash = new Map(lifeboat ? existing.characters.map((c) => [c.hash, c] as const) : []);
    const rejectedFiles = new Set<string>();
    const rejectedNames = new Set<string>();
    for (const found of cards) {
      const hash = lifeboat ? await cardHash(found.card) : undefined;
      if (hash) {
        current = found.label;
        progress();
        const reason = await cardRejection(found.card, hash);
        if (reason) {
          skipped.push({ name: found.label, why: reason });
          if (found.fileBase) rejectedFiles.add(nameKey(found.fileBase));
          rejectedNames.add(nameKey(found.card.data.name));
          continue;
        }
        const duplicate = byHash.get(hash);
        if (duplicate) {
          duplicates++;
          if (found.fileBase) byFile.set(nameKey(found.fileBase), duplicate);
          byName.set(nameKey(duplicate.name), duplicate);
          continue;
        }
      }
      const record = await recordFor(found.card, 'sillytavern', false, undefined, hash);
      if (hash) byHash.set(hash, record);
      // A card for a character that so far only had a built one takes over that one's chats and memory.
      for (const old of existing.characters) {
        if (!old.built || old.id === record.id || dropped.has(old.id) || nameKey(old.name) !== nameKey(record.name)) continue;
        mergeChats(record, old.chats);
        const board = existing.boards[old.id];
        if (board && !existing.boards[record.id]) boards[record.id] ??= board;
        dropped.add(old.id);
        replaced.push({ from: old.id, to: record.id });
      }
      if (found.fileBase) byFile.set(nameKey(found.fileBase), record);
      byName.set(nameKey(record.name), record);
    }

    // Characters with no card of their own get one built, once per source and name, here or in an earlier import.
    const builtNow = new Map<string, ArchiveCharacter | null>();
    const builtFor = async (found: FoundCharacter): Promise<ArchiveCharacter | null> => {
      const key = `${found.source}|${nameKey(found.name)}`;
      if (builtNow.has(key)) return builtNow.get(key) ?? null;
      const prior = existing.characters.find((c) => c.built && !dropped.has(c.id) && c.source === found.source && nameKey(c.name) === nameKey(found.name));
      // A later import with less to go on (a chat log without the description) keeps the card built the first time.
      const card = prior && !found.description?.trim() ? prior.card : buildCard(found);
      const hash = lifeboat ? await cardHash(card) : undefined;
      if (hash && card !== prior?.card) {
        const reason = await cardRejection(card, hash);
        if (reason) {
          skipped.push({ name: found.name, why: reason });
          builtNow.set(key, null);
          return null;
        }
      }
      const record = await recordFor(card, found.source, true, prior, hash);
      if (found.memory) boards[record.id] = withExportMemory(boards[record.id] ?? existing.boards[record.id] ?? emptyBoard(), found.memory, newId, now());
      builtNow.set(key, record);
      return record;
    };

    const withNewChats = new Set<ArchiveCharacter>();
    const omittedChats: ChatHead[] = [];
    for (const group of groups.values()) {
      const key = `${group.source}|${nameKey(group.name)}`;
      const described = parts.get(key);
      parts.delete(key);
      const byFolder = group.folder ? byFile.get(nameKey(group.folder)) : undefined;
      let record: ArchiveCharacter | null | undefined = byFolder ?? byName.get(nameKey(group.name));
      if (lifeboat && ((!byFolder && rejectedFiles.has(nameKey(group.folder))) || (!record && rejectedNames.has(nameKey(group.name))))) record = null;
      if (record) record = out.get(record.id) ?? await recordFor(record.card, record.source, record.built, record, record.hash);
      if (record === undefined) {
        // A card with this name that moved in earlier takes the new chats too.
        const carded = existing.characters.find((c) => !c.built && nameKey(c.name) === nameKey(group.name));
        if (carded) record = out.get(carded.id) ?? (await recordFor(carded.card, carded.source, false, carded));
        else {
          // Lifeboat leaves log-derived greetings in local memory, outside the card check.
          const opening = lifeboat || group.source === 'chatgpt' || group.source === 'claude' ? '' : (group.opening?.text ?? '');
          const greeting = described?.greeting?.trim() || opening;
          record = await builtFor({ source: group.source, name: group.name, ...described, ...(greeting ? { greeting } : {}) });
        }
      }
      if (!record) {
        for (const head of group.heads) omittedChats.push(head);
        chats -= group.heads.length;
        messages -= total(group.heads);
        continue;
      }
      mergeChats(record, group.heads);
      if (lifeboat) withNewChats.add(record);
    }
    // Characters a source described but that have no chats in this drop still move in.
    for (const found of parts.values()) await builtFor(found);

    for (const record of withNewChats) {
      const head = record.chats[0];
      const chat = head && await readChat(disk, demo, head.id);
      if (!chat) continue;
      const board = boards[record.id] ?? existing.boards[record.id] ?? emptyBoard();
      const next = withImportedHistory(board, chat.messages, newId, now());
      if (next !== board) boards[record.id] = next;
    }
    check();
    if (omittedChats.length) await disk.commit(omittedChats.map(({ id }) => ({ store: 'chats', key: scopeOf(demo) + id })));
    check();
    const records = [...out.values()];
    if (records.length || dropped.size) await writeCharacters(disk, demo, records, boards, [...dropped]);
    finished = true;
    if (retired.size) {
      const unchanged = existing.characters.filter((character) => !out.has(character.id) && !dropped.has(character.id));
      for (const character of [...unchanged, ...records]) for (const head of character.chats) retired.delete(head.id);
      if (retired.size) await disk.commit([...retired].map((id) => ({ store: 'chats', key: scopeOf(demo) + id }))).catch(() => undefined);
    }
    const aboutYou = opts.aboutYou ? mapChatGptSetup(chatGptSetup) : [];
    return { ids: [...touched], characters: touched.size, chats, messages, sources: [...sources], replaced, skipped, notes: [...notes], ...(duplicates ? { duplicates } : {}), ...(aboutYou.length ? { aboutYou } : {}) };
  } finally {
    // A stopped or failed import leaves no chat text behind that no character lists.
    if (!finished) await sweepOrphans(disk, demo).catch(() => undefined);
  }
}
