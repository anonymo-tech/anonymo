// Update "movein": the zip reader, each source's parser against a small fixture, turn pairing, the memory request
// builders, the on-device archive, and the demo gateway's answers. Every name in a fixture is invented.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import fc from 'fast-check';
import { buildCharacterMessages, crc32, summaryRequest, writeCardToPng } from '../lib/anonymo/card.ts';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { DEMO_PRICES } from '../lib/anonymo/mock/fixtures.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { moveInReply, perTokenUsd } from '../lib/anonymo/mock/movein.ts';
import { clearArchive, historyOf, loadArchive, memoryDisk, readChat, removeCharacter, sweepOrphans } from '../lib/anonymo/movein/archive.ts';
import { buildCard, detectCard, readCardBytes, ringOf } from '../lib/anonymo/movein/cards.ts';
import { caiRow, chatsFromRows, detectCaiCharacters, detectCaiRow, detectCharacterAi, isGreeting, parseCaiCharacters, parseCharacterAi } from '../lib/anonymo/movein/characterai.ts';
import { ASSISTANT_PROMPT, chatGptCharacter, detectChatGptConversation, parseChatGptConversation, threadOf } from '../lib/anonymo/movein/chatgpt.ts';
import { readChatGptSetup } from '../lib/anonymo/movein/chatgpt-setup.ts';
import { claudeCharacter, detectClaudeConversation, detectClaudeMemories, parseClaudeConversation, parseClaudeMemories } from '../lib/anonymo/movein/claude.ts';
import { detectGeneric, genericMessage, parseGeneric, parseGenericLines } from '../lib/anonymo/movein/generic.ts';
import { importFiles, ImportStopped } from '../lib/anonymo/movein/importer.ts';
import { arrayItems, firstJsonByte, JsonStreamError } from '../lib/anonymo/movein/json-stream.ts';
import {
  addPatch,
  applyBuild,
  boardMemory,
  chunkLog,
  CHUNK_CHARS,
  editPatch,
  emptyBoard,
  estimateMusd,
  FACTS_MARKER,
  FACTS_MAX,
  factsRequest,
  isProtected,
  listedPrice,
  parseFacts,
  perTokenToPerMillion,
  pinPatch,
  planBuild,
  planFrom,
  removePatch,
  SENT_FACTS,
  SUMMARY_MARKER,
  SUMMARY_MAX_TOKENS,
  summaryStep,
  toLog,
  withExportMemory,
} from '../lib/anonymo/movein/memory.ts';
import { SAMPLE_MEMORY, sampleFiles } from '../lib/anonymo/movein/sample.ts';
import { chatFolderOf, detectSillyTavernChat, parseSillyTavernChat } from '../lib/anonymo/movein/sillytavern.ts';
import { lastTurns, openingLine, pairTurns, RESUME_TURNS, toChatTurns } from '../lib/anonymo/movein/turns.ts';
import { nameKey, parseWhen, shortId, snippetTitle, SOURCES } from '../lib/anonymo/movein/types.ts';
import { looksLikeZip, openZipEntry, readZipDirectory, readZipEntry, ZipError } from '../lib/anonymo/movein/zip.ts';
import { parseUpdates, UPDATE_IDS } from '../lib/anonymo/updates.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- a small zip writer, for fixtures -------------------------------------------------------------------------------

function zipOf(files, opts = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const method = file.stored ? 0 : 8;
    const body = method === 0 ? data : new Uint8Array(deflateRawSync(data));
    const crc = file.badCrc ? 1 : crc32(data);
    const flags = 0x0800 | (file.encrypted ? 1 : 0);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    // A local header may carry extra bytes the directory does not mention; the reader must skip them.
    const extra = file.localExtra ? new Uint8Array(file.localExtra) : new Uint8Array();
    local.setUint16(28, extra.length, true);
    parts.push(new Uint8Array(local.buffer), name, extra, body);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, flags, true);
    dir.setUint16(10, method, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + extra.length + body.length;
  }
  const dirSize = central.reduce((n, p) => n + p.length, 0);
  const comment = enc.encode(opts.comment ?? '');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, comment.length, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer), comment]);
}

/** The same archive as zipOf would write for one stored file, but with Zip64 records and sizes. */
function zip64Of(name, text) {
  const nameBytes = enc.encode(name);
  const data = enc.encode(text);
  const crc = crc32(data);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 45, true);
  local.setUint16(6, 0x0800, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, nameBytes.length, true);
  const extra = new DataView(new ArrayBuffer(28));
  extra.setUint16(0, 1, true);
  extra.setUint16(2, 24, true);
  extra.setBigUint64(4, BigInt(data.length), true);
  extra.setBigUint64(12, BigInt(data.length), true);
  extra.setBigUint64(20, 0n, true);
  const dir = new DataView(new ArrayBuffer(46));
  dir.setUint32(0, 0x02014b50, true);
  dir.setUint16(8, 0x0800, true);
  dir.setUint32(16, crc, true);
  dir.setUint32(20, 0xffffffff, true);
  dir.setUint32(24, 0xffffffff, true);
  dir.setUint16(28, nameBytes.length, true);
  dir.setUint16(30, 28, true);
  dir.setUint32(42, 0xffffffff, true);
  const dirStart = 30 + nameBytes.length + data.length;
  const dirSize = 46 + nameBytes.length + 28;
  const end64 = new DataView(new ArrayBuffer(56));
  end64.setUint32(0, 0x06064b50, true);
  end64.setBigUint64(4, 44n, true);
  end64.setBigUint64(24, 1n, true);
  end64.setBigUint64(32, 1n, true);
  end64.setBigUint64(40, BigInt(dirSize), true);
  end64.setBigUint64(48, BigInt(dirStart), true);
  const locator = new DataView(new ArrayBuffer(20));
  locator.setUint32(0, 0x07064b50, true);
  locator.setBigUint64(8, BigInt(dirStart + dirSize), true);
  locator.setUint32(16, 1, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 0xffff, true);
  end.setUint16(10, 0xffff, true);
  end.setUint32(12, 0xffffffff, true);
  end.setUint32(16, 0xffffffff, true);
  return new Blob([new Uint8Array(local.buffer), nameBytes, data, new Uint8Array(dir.buffer), nameBytes, new Uint8Array(extra.buffer), new Uint8Array(end64.buffer), new Uint8Array(locator.buffer), new Uint8Array(end.buffer)]);
}

const streamOf = (text, sizes = [text.length]) => {
  const bytes = typeof text === 'string' ? enc.encode(text) : text;
  let at = 0;
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const step = Math.max(1, sizes[i++ % sizes.length]);
      controller.enqueue(bytes.slice(at, at + step));
      at += step;
    },
  });
};
const collect = async (iterable) => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};
const drop = (name, text) => ({ name, blob: new Blob([text]) });
const byName = (a, b) => String(a[0]).localeCompare(String(b[0]));
let ids = 0;
const options = () => ({ now: () => Date.UTC(2026, 10, 20, 12), newId: () => `id-${++ids}` });

// ---- zip ----------------------------------------------------------------------------------------------------------

test('the zip reader lists entries and inflates them, stored or deflated, with no dependency', async () => {
  const long = 'felt and thread '.repeat(4000);
  const blob = zipOf(
    [
      { name: 'chats/Juniper/first.jsonl', data: long },
      { name: 'characters/Brämble.json', data: '{"name":"Bramble"}', stored: true, localExtra: [0xca, 0xfe, 2, 0, 1, 2] },
      { name: 'characters/', data: '', stored: true },
    ],
    { comment: 'a comment at the very end of the file' },
  );
  assert.equal(looksLikeZip(new Uint8Array(await blob.slice(0, 4).arrayBuffer())), true);
  const entries = await readZipDirectory(blob);
  assert.deepEqual(entries.map((e) => [e.name, e.method, e.size, e.directory]), [
    ['chats/Juniper/first.jsonl', 8, long.length, false],
    ['characters/Brämble.json', 0, 18, false],
    ['characters/', 0, 0, true],
  ]);
  assert.ok(entries[0].compressedSize < long.length / 10);
  assert.equal(dec.decode(await readZipEntry(blob, entries[0])), long);
  assert.equal(dec.decode(await readZipEntry(blob, entries[1])), '{"name":"Bramble"}', 'the local header’s own extra bytes are skipped');
  // The same entry as a stream, for files too large to hold at once.
  const chunks = [];
  for await (const chunk of await openZipEntry(blob, entries[0])) chunks.push(chunk);
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), long.length);
});

test('the zip reader follows Zip64 records, which large exports use', async () => {
  const blob = zip64Of('conversations.json', '[{"title":"a long one"}]');
  const [entry] = await readZipDirectory(blob);
  assert.deepEqual([entry.name, entry.size, entry.compressedSize, entry.offset], ['conversations.json', 24, 24, 0]);
  assert.equal(dec.decode(await readZipEntry(blob, entry)), '[{"title":"a long one"}]');
});

test('the zip reader refuses what it cannot read, in plain words', async () => {
  await assert.rejects(readZipDirectory(new Blob(['not a zip at all, just some text that is long enough'])), ZipError);
  await assert.rejects(readZipDirectory(new Blob(['PK'])), /not a zip/);
  const whole = zipOf([{ name: 'a.json', data: '{"a":1}' }]);
  await assert.rejects(readZipDirectory(whole.slice(0, whole.size - 30)), ZipError, 'cut short');
  const bad = zipOf([{ name: 'a.json', data: '{"a":1}', badCrc: true }]);
  await assert.rejects(readZipEntry(bad, (await readZipDirectory(bad))[0]), /checksum/);
  const locked = zipOf([{ name: 'data/message.json', data: '[]', encrypted: true }]);
  const [entry] = await readZipDirectory(locked);
  assert.equal(entry.encrypted, true);
  await assert.rejects(readZipEntry(locked, entry), /password-protected/);
  const big = zipOf([{ name: 'big.json', data: 'x'.repeat(5000) }]);
  await assert.rejects(readZipEntry(big, (await readZipDirectory(big))[0], 1000), /too large/);
  // A directory that understates an entry's size is caught while unpacking, before the rest is read.
  const lying = zipOf([{ name: 'a.json', data: 'y'.repeat(200_000) }]);
  const [claims] = await readZipDirectory(lying);
  await assert.rejects(readZipEntry(lying, { ...claims, size: 10 }), /more than it says/);
});

// ---- JSON arrays as a stream ------------------------------------------------------------------------------------------

test('a list is read one element at a time, however the bytes are cut', async () => {
  const value = [{ a: 'x,y]"z', b: [1, [2, 3], { c: '\\' }] }, 'plain "quoted" text', 42, null, { deep: { er: ['}', '{'] } }, 'ünïcödé ✂'];
  const text = `﻿ \n${JSON.stringify(value, null, 1)}\n `;
  for (const sizes of [[1], [2, 3], [7], [64], [text.length * 3]]) assert.deepEqual(await collect(arrayItems(streamOf(text, sizes))), value);
  assert.deepEqual(await collect(arrayItems(streamOf('[]'))), []);
  assert.deepEqual(await collect(arrayItems(streamOf('[1,2,]'))), [1, 2]);
  assert.equal(firstJsonByte(enc.encode('﻿  [1]')), 0x5b);
  assert.equal(firstJsonByte(enc.encode('\n{"a":1}')), 0x7b);
  assert.equal(firstJsonByte(enc.encode('   ')), null);
  await assert.rejects(collect(arrayItems(streamOf('{"a":1}'))), JsonStreamError);
  await assert.rejects(collect(arrayItems(streamOf('[{"a":1}, {"b":'))), /ends early/);
  await assert.rejects(collect(arrayItems(streamOf('[{"a":1}} ]'))), JsonStreamError);
  await assert.rejects(collect(arrayItems(streamOf('[1,,2]'))), JsonStreamError);
  await assert.rejects(collect(arrayItems(streamOf(''))), /empty/);
});

test('property: any JSON list survives any chunking', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.jsonValue(), { maxLength: 12 }), fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 6 }), async (items, sizes) => {
      const text = JSON.stringify(items);
      assert.deepEqual(await collect(arrayItems(streamOf(text, sizes))), JSON.parse(text));
    }),
    { numRuns: 150 },
  );
});

// ---- SillyTavern --------------------------------------------------------------------------------------------------

const stChat = (header, rows) => [header, ...rows].map((r) => JSON.stringify(r)).join('\n');
const stRows = [
  { name: 'Juniper', is_user: false, is_system: false, send_date: 'October 2, 2026 11:10pm', mes: 'Night Desk. You are up late too, then.' },
  { name: 'Ash', is_user: true, is_system: false, send_date: 'October 2, 2026 11:12pm', mes: 'Could not sleep.' },
  { name: 'System', is_user: false, is_system: true, send_date: 'October 2, 2026 11:12pm', mes: 'A hidden note.' },
  { name: 'Juniper', is_user: false, is_system: false, send_date: 'October 2, 2026 11:13pm', mes: 'Sit down, then.', swipes: ['Sit down, then.', 'Go home.'], swipe_id: 0 },
];

test('SillyTavern: a chat log from an older build, with names in its first line', () => {
  const source = stChat({ user_name: 'Ash', character_name: 'Juniper', create_date: '2026-10-2@23h10m04s', chat_metadata: {} }, stRows);
  assert.equal(detectSillyTavernChat(source), true);
  const chat = parseSillyTavernChat(source, 'default-user/chats/Juniper/Juniper - 2026-10-2@23h10m04s.jsonl');
  assert.equal(chat.source, 'sillytavern');
  assert.equal(chat.character, 'Juniper');
  assert.deepEqual(chat.messages.map((m) => [m.role, m.name, m.text]), [
    ['assistant', 'Juniper', 'Night Desk. You are up late too, then.'],
    ['user', 'Ash', 'Could not sleep.'],
    ['assistant', 'Juniper', 'Sit down, then.'],
  ]);
  assert.equal(chat.title, 'Could not sleep.', 'a file name that is only a time stamp gives way to what was said');
  assert.equal(new Date(chat.createdAt).getFullYear(), 2026);
  assert.ok(chat.updatedAt > chat.createdAt);
  assert.equal(chatFolderOf('default-user/chats/Juniper/x.jsonl'), 'Juniper');
  assert.equal(chatFolderOf('chats/x.jsonl'), '');
});

test('SillyTavern: a current log says "unused" where names were, so the speakers name the character', () => {
  const source = stChat({ chat_metadata: { note: 1 }, user_name: 'unused', character_name: 'unused' }, [
    { name: 'Bramble', is_user: false, is_system: false, send_date: '2026-11-08T16:05:12.000Z', mes: 'Workshop is open.' },
    { name: 'Ash', is_user: true, is_system: false, send_date: '2026-11-08T16:06:00.000Z', mes: 'My headphones went quiet.' },
    'this line is damaged',
    { name: 'Bramble', is_user: false, is_system: false, send_date: 1794153960000, mes: 'A pop is a wire.' },
  ]);
  assert.equal(detectSillyTavernChat(source), true);
  const chat = parseSillyTavernChat(source, 'The clock question.jsonl');
  assert.equal(chat.character, 'Bramble');
  assert.equal(chat.title, 'The clock question', 'a name the person gave the chat is kept');
  assert.equal(chat.messages.length, 3);
  assert.equal(chat.createdAt, Date.parse('2026-11-08T16:05:12.000Z'));
  // A group chat goes to whoever spoke most; every line keeps its speaker.
  const group = parseSillyTavernChat(stChat({ chat_metadata: {} }, [
    { name: 'Ash', is_user: true, mes: 'Evening, both.' },
    { name: 'Juniper', is_user: false, mes: 'Evening.' },
    { name: 'Bramble', is_user: false, mes: 'Hm.' },
    { name: 'Juniper', is_user: false, mes: 'He means hello.' },
  ]));
  assert.equal(group.character, 'Juniper');
  assert.deepEqual(group.messages.map((m) => m.name), ['Ash', 'Juniper', 'Bramble', 'Juniper']);
  assert.equal(detectSillyTavernChat('{"role":"user","content":"hi"}\n{"role":"assistant","content":"hello"}'), false);
  assert.equal(parseSillyTavernChat(stChat({ chat_metadata: {} }, [{ name: 'X', is_user: false, is_system: true, mes: 'only hidden' }])), null);
});

test('times are read in every form the exports write them', () => {
  assert.equal(parseWhen(1794153960), 1794153960000);
  assert.equal(parseWhen(1794153960000), 1794153960000);
  assert.equal(parseWhen('1794153960000'), 1794153960000);
  assert.equal(parseWhen('2026-11-08T16:05:12.000Z'), Date.UTC(2026, 10, 8, 16, 5, 12));
  assert.equal(parseWhen('2026-02-14 14:22:12.770533+00:00'), Date.UTC(2026, 1, 14, 14, 22, 12, 770), 'a space, microseconds and +00:00');
  assert.equal(parseWhen('2026-02-14T14:22:12+0100'), Date.UTC(2026, 1, 14, 13, 22, 12));
  assert.equal(parseWhen('June 19, 2023 2:20pm'), new Date(2023, 5, 19, 14, 20).getTime());
  assert.equal(parseWhen('June 19, 2023 12:05am'), new Date(2023, 5, 19, 0, 5).getTime());
  assert.equal(parseWhen('2024-07-12@01h31m37s123ms'), new Date(2024, 6, 12, 1, 31, 37).getTime());
  assert.equal(parseWhen('2024-6-5 @14h 56m 50s 682ms'), new Date(2024, 5, 5, 14, 56, 50).getTime());
  for (const junk of ['', 'yesterday', 'unused', null, undefined, {}, -5, Number.NaN]) assert.equal(parseWhen(junk), undefined);
});

// ---- ChatGPT ------------------------------------------------------------------------------------------------------

const node = (id, parent, message, children) => ({ id, parent, message, ...(children ? { children } : {}) });
const said = (role, parts, extra = {}) => ({ id: `m-${Math.random()}`, author: { role }, create_time: extra.at ?? 1_790_000_000, content: { content_type: extra.type ?? 'text', parts }, recipient: extra.recipient ?? 'all', metadata: extra.metadata ?? {} });
const gptConversation = () => ({
  title: 'Soldering a headphone wire',
  create_time: 1_790_000_000.5,
  update_time: 1_790_000_900,
  conversation_id: 'conv-0001',
  current_node: 'n6',
  mapping: {
    root: node('root', null, null, ['sys']),
    sys: node('sys', 'root', { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } }, ['ctx']),
    ctx: node('ctx', 'sys', { author: { role: 'user' }, content: { content_type: 'user_editable_context', user_profile: 'The user provided the following information about themselves.\nUser profile:\n```I repair radios.```', user_instructions: 'The user provided the additional info about how they would like you to respond:\n```Be brief. No lists.```' }, metadata: { is_visually_hidden_from_conversation: true } }, ['mem']),
    mem: node('mem', 'ctx', { author: { role: 'system' }, content: { content_type: 'model_editable_context', model_set_context: '1. [2026-03-01]. Prefers metric units.\n2. [2026-04-11]. Owns a loud workshop clock.' } }, ['n1']),
    n1: node('n1', 'mem', said('user', ['How do I fix a loose wire?'], { at: 1_790_000_010 }), ['n2', 'n2b']),
    n2: node('n2', 'n1', said('assistant', ['An abandoned first answer.']), []),
    n2b: node('n2b', 'n1', said('assistant', ['Tin the wire first.'], { at: 1_790_000_020 }), ['n3']),
    n3: node('n3', 'n2b', said('assistant', ['search("solder")'], { recipient: 'browser' }), ['n4']),
    n4: node('n4', 'n3', { author: { role: 'tool' }, content: { content_type: 'tether_browsing_display', result: 'pages' } }, ['n5']),
    n5: node('n5', 'n4', said('user', [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-000' }, 'Like this?', { content_type: 'audio_transcription', text: 'and is that enough heat' }], { type: 'multimodal_text', at: 1_790_000_030 }), ['n6']),
    n6: node('n6', 'n5', said('assistant', ['Yes. Hold it for two seconds.'], { at: 1_790_000_040 }), []),
    hidden: node('hidden', 'n6', said('assistant', ['never shown'], { type: 'thoughts' }), []),
  },
});

test('ChatGPT: the thread last shown is followed from current_node back through the parents', () => {
  const item = gptConversation();
  assert.equal(detectChatGptConversation(item), true);
  assert.equal(detectChatGptConversation({ title: 'x', messages: [] }), false);
  assert.deepEqual(threadOf(item.mapping, 'n6'), ['root', 'sys', 'ctx', 'mem', 'n1', 'n2b', 'n3', 'n4', 'n5', 'n6']);
  const { chat, setup } = parseChatGptConversation(item);
  assert.deepEqual(chat.messages.map((m) => [m.role, m.text]), [
    ['user', 'How do I fix a loose wire?'],
    ['assistant', 'Tin the wire first.'],
    ['user', 'Like this?\nand is that enough heat'],
    ['assistant', 'Yes. Hold it for two seconds.'],
  ]);
  assert.equal(chat.key, 'conv-0001');
  assert.equal(chat.title, 'Soldering a headphone wire');
  assert.equal(chat.character, 'ChatGPT');
  assert.equal(chat.createdAt, 1_790_000_000_500);
  assert.equal(chat.messages[1].at, 1_790_000_020_000);
  assert.deepEqual(setup, { aboutModel: 'Be brief. No lists.', aboutUser: 'I repair radios.', saved: ['Prefers metric units.', 'Owns a loud workshop clock.'] });
});

test('ChatGPT: exports since late 2026 list no children and may lack current_node', () => {
  const item = gptConversation();
  for (const n of Object.values(item.mapping)) delete n.children;
  delete item.current_node;
  // A leaf is a node nobody names as parent: here the abandoned answer (n2) and the reasoning after n6 (hidden).
  // They are equally new in this fixture, so the longer thread wins, which is the one that was on screen.
  assert.deepEqual(threadOf(item.mapping, undefined).slice(-2), ['n6', 'hidden']);
  item.mapping.n2.message.create_time = 1_790_000_999;
  assert.equal(threadOf(item.mapping, undefined).at(-1), 'n2', 'the newest leaf wins outright');
  item.mapping.n2.message.create_time = 1_790_000_000;
  assert.equal(parseChatGptConversation(item).chat.messages.length, 4);
  // A cycle in the parents cannot hang the reader.
  const loop = { a: { parent: 'b', message: null }, b: { parent: 'a', message: null } };
  assert.ok(threadOf(loop, 'a').length <= 2);
  assert.equal(parseChatGptConversation({ mapping: {}, current_node: 'gone', title: 'Empty' }).chat, null);
});

test('ChatGPT: how it was asked to respond becomes the card; what it knew becomes memory patches', () => {
  const { setup } = parseChatGptConversation(gptConversation());
  const character = chatGptCharacter(setup);
  assert.equal(character.name, 'ChatGPT');
  assert.match(character.description, /Be brief\. No lists\./);
  assert.doesNotMatch(character.description, /repair radios/, 'what the person said about themselves is a patch they can delete, not card text');
  assert.deepEqual(character.memory.facts, ['About you, from your ChatGPT settings: I repair radios.', 'Prefers metric units.', 'Owns a loud workshop clock.']);
  const card = buildCard(character);
  const built = buildCharacterMessages(card, [{ role: 'user', content: 'hello' }], { userName: 'Ash' });
  assert.match(built.messages[0].content, /^You are an AI on Anonymo, continuing conversations Ash brought over from ChatGPT\./);
  assert.match(ASSISTANT_PROMPT, /You are not \{\{char\}\} itself/);
  assert.equal(chatGptCharacter({}).description, '');
  assert.equal(chatGptCharacter({}).memory, undefined);
});

test('About you reads setup from split ZIPs and conversations.json, and Move In offers the same preview only when enabled', async () => {
  const original = gptConversation();
  const later = { ...gptConversation(), conversation_id: 'conv-0002', update_time: original.update_time + 10 };
  later.mapping.ctx.message.content.user_instructions = 'Use short headings.';
  const json = JSON.stringify([later, original]);
  const zip = zipOf([
    { name: 'export/conversations-001.json', data: JSON.stringify([later]) },
    { name: 'export/user.json', data: 'The account file must never be read' },
    { name: 'export/conversations-000.json', data: JSON.stringify([original]) },
  ]);
  const expected = { aboutModel: 'Use short headings.', aboutUser: 'I repair radios.', saved: ['Prefers metric units.', 'Owns a loud workshop clock.'] };
  assert.deepEqual(await readChatGptSetup({ name: 'export.zip', blob: zip }), expected);
  assert.deepEqual(await readChatGptSetup({ name: 'conversations.json', blob: new Blob([json]) }), expected);
  assert.deepEqual(await readChatGptSetup({ name: 'user.json', blob: new Blob([json]) }), {});
  const files = [{ name: 'export.zip', blob: zip }];
  assert.equal((await importFiles(files, memoryDisk(), false, options())).aboutYou, undefined);
  const summary = await importFiles(files, memoryDisk(), false, { ...options(), aboutYou: true });
  assert.deepEqual(summary.aboutYou.map(({ field, text }) => [field, text]), [
    ['aboutMe', expected.aboutUser], ['answerStyle', expected.aboutModel],
    ...expected.saved.map((text) => ['fact', text]),
  ]);
});

// ---- Claude -------------------------------------------------------------------------------------------------------

const claudeConversation = () => ({
  uuid: '00000000-aaaa-4bbb-8ccc-000000000001',
  name: 'Naming a radio station',
  summary: '',
  created_at: '2026-09-01T10:00:00.000000Z',
  updated_at: '2026-09-01T10:05:00.000000Z',
  account: { uuid: '00000000-aaaa-4bbb-8ccc-00000000ffff' },
  chat_messages: [
    { uuid: 'u1', sender: 'human', text: 'Names for a night radio show?', content: [{ type: 'text', text: 'Names for a night radio show?' }], created_at: '2026-09-01T10:00:00.000000Z', attachments: [], files: [] },
    { uuid: 'a1', sender: 'assistant', text: 'ignored when blocks exist', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'The Night Desk.' }, { type: 'tool_use', name: 'search', input: {} }, { type: 'text', text: 'Or: Line Seven.' }], created_at: '2026-09-01T10:00:20.000000Z' },
    { uuid: 'u2', sender: 'human', text: 'Line Seven it is.', created_at: '2026-09-01T10:04:00.000000Z' },
    { uuid: 'x', sender: 'system', text: 'not a speaker' },
    { uuid: 'e', sender: 'assistant', text: '   ', content: [] },
  ],
});

test('Claude: chat_messages in order, with only what was said', () => {
  const item = claudeConversation();
  assert.equal(detectClaudeConversation(item), true);
  assert.equal(detectClaudeConversation({ mapping: {} }), false);
  const chat = parseClaudeConversation(item);
  assert.deepEqual(chat.messages.map((m) => [m.role, m.text]), [
    ['user', 'Names for a night radio show?'],
    ['assistant', 'The Night Desk.\n\nOr: Line Seven.'],
    ['user', 'Line Seven it is.'],
  ]);
  assert.equal(chat.key, item.uuid);
  assert.equal(chat.title, 'Naming a radio station');
  assert.equal(chat.character, 'Claude');
  assert.equal(chat.createdAt, Date.UTC(2026, 8, 1, 10, 0, 0));
  assert.equal(parseClaudeConversation({ chat_messages: [] }), null);
  const memories = [{ conversations_memory: ' Ash repairs radios and prefers short answers. ', project_memories: {}, account_uuid: 'x' }];
  assert.equal(detectClaudeMemories(memories), true);
  assert.equal(detectClaudeMemories([{ uuid: 'p', name: 'A project', description: 'd' }]), false);
  assert.equal(parseClaudeMemories(memories), 'Ash repairs radios and prefers short answers.');
  assert.deepEqual(claudeCharacter('It knows Ash.').memory, { summary: 'It knows Ash.' });
  assert.equal(claudeCharacter().memory, undefined);
});

// ---- Character.AI (early) -----------------------------------------------------------------------------------------

const caiMessages = () => [
  // Rows of two chats, mixed and out of order, exactly the five keys the export has.
  { chat_id: 'chat-b', candidate_id: 'c5', raw_content: 'It went quiet last week.', create_time: '2026-03-02 09:01:10.120000+00:00', tti_image_rel_path: null },
  { chat_id: 'chat-a', candidate_id: 'c2', raw_content: 'Could not sleep.', create_time: '2026-02-14 14:23:40.000001+00:00', tti_image_rel_path: null },
  { chat_id: 'chat-a', candidate_id: 'c1', raw_content: 'Night Desk. You are up late too, Ash.', create_time: '2026-02-14 14:22:12.770533+00:00', tti_image_rel_path: null },
  { chat_id: 'chat-b', candidate_id: 'c4', raw_content: 'Workshop is open. Put it on the bench.', create_time: '2026-03-02 09:00:00.000000+00:00', tti_image_rel_path: null },
  { chat_id: 'chat-a', candidate_id: 'c3', raw_content: 'Sit down, then.', create_time: '2026-02-14 14:23:44.500000+00:00', tti_image_rel_path: null },
];
const caiCharacters = () => [{ name: 'Juniper', title: 'Keeper of the Night Desk', description: 'A felt fox at a switchboard.', greeting: 'Night Desk. You are up late too, {{user}}.', definition: '{{char}}: Line seven rang again.' }];

test('Character.AI (early): message.json names no speaker, so rows are grouped, ordered and taken turn about', () => {
  const rows = caiMessages();
  assert.ok(rows.every(detectCaiRow));
  assert.equal(detectCaiRow({ chat_id: 'x', raw_content: 'hi', author: { is_human: true } }), false, 'a row with an author is a tool export, not the official one');
  const chats = chatsFromRows(rows.map(caiRow));
  assert.deepEqual(chats.map((c) => c.key), ['chat-b', 'chat-a']);
  const a = chats.find((c) => c.key === 'chat-a');
  assert.deepEqual(a.messages.map((m) => [m.role, m.text]), [
    ['assistant', 'Night Desk. You are up late too, Ash.'],
    ['user', 'Could not sleep.'],
    ['assistant', 'Sit down, then.'],
  ]);
  assert.equal(a.character, '', 'the export names no character');
  assert.equal(a.title, 'Could not sleep.');
  assert.equal(a.createdAt, Date.UTC(2026, 1, 14, 14, 22, 12, 770));
  // An empty row still takes its turn, so the sides after it stay right.
  const gap = chatsFromRows([{ chat: 'g', text: 'Hello.', at: 1, order: 0 }, { chat: 'g', text: '  ', at: 2, order: 1 }, { chat: 'g', text: 'Anyone there?', at: 3, order: 2 }]);
  assert.deepEqual(gap[0].messages.map((m) => m.role), ['assistant', 'assistant']);
  // Rows without times keep the order of the file.
  assert.deepEqual(chatsFromRows([{ chat: 'n', text: 'one', at: undefined, order: 0 }, { chat: 'n', text: 'two', at: undefined, order: 1 }])[0].messages.map((m) => m.text), ['one', 'two']);
});

test('Character.AI (early): character.json, and a chat found by its opening line', () => {
  assert.equal(detectCaiCharacters(caiCharacters()), true);
  assert.equal(detectCharacterAi(caiCharacters()), true);
  assert.equal(detectCaiCharacters([{ name: 'A project', description: 'not a character' }]), false);
  assert.equal(detectCaiCharacters([{ name: 'Juniper', first_mes: 'hi', greeting: 'hi' }]), false, 'a Tavern card is not read as this');
  const [juniper] = parseCaiCharacters(caiCharacters());
  assert.deepEqual(juniper, { source: 'characterai', name: 'Juniper', description: 'A felt fox at a switchboard.', greeting: 'Night Desk. You are up late too, {{user}}.', personality: 'Keeper of the Night Desk', examples: '{{char}}: Line seven rang again.' });
  assert.equal(isGreeting('Night Desk.  You are up late too, Ash.', juniper.greeting), true, 'the name stands where {{user}} was');
  assert.equal(isGreeting('Night Desk. You are up late.', juniper.greeting), false);
  assert.equal(isGreeting('Workshop is open.', 'Workshop is open.'), true);
  assert.equal(isGreeting('anything at all', '{{user}}'), false, 'a greeting that is only a placeholder matches nothing');
  assert.equal(isGreeting('', ''), false);
});

test('Character.AI (early): what browser tools saved, in three shapes', () => {
  const dump = {
    info: { character: { name: 'Bramble', title: 'Radio repair', greeting: 'Workshop is open.', description: 'A corduroy bear.', definition: '' } },
    histories: { histories: [{ external_id: 'h1', created: '2026-01-05T08:00:00Z', last_interaction: '2026-01-05T08:10:00Z', msgs: [
      { text: 'Workshop is open.', src: { is_human: false, name: 'Bramble' } },
      { text: 'A swiped-away reply.', src: { is_human: false, name: 'Bramble' }, is_alternative: true },
      { text: 'My headphones went quiet.', src: { is_human: true, name: 'Ash' } },
      { text: 'A pop is a wire.', src: { is_human: false, name: 'Bramble' } },
    ] }] },
  };
  assert.equal(detectCharacterAi(dump), true);
  const fromDump = parseCharacterAi(dump, 'Bramble_CaiDump');
  assert.equal(fromDump.characters[0].name, 'Bramble');
  assert.deepEqual(fromDump.chats[0].messages.map((m) => [m.role, m.text]), [['assistant', 'Workshop is open.'], ['user', 'My headphones went quiet.'], ['assistant', 'A pop is a wire.']]);
  assert.equal(fromDump.chats[0].character, 'Bramble');
  assert.equal(fromDump.chats[0].key, 'h1');

  // The current site lists turns newest first, each with its candidates; the one shown is the primary.
  const turns = { turns: [
    { turn_key: { chat_id: 'neo-1', turn_id: 't3' }, create_time: '2026-05-01T12:00:09Z', author: { author_id: 'c', name: 'Juniper', is_human: false }, candidates: [{ candidate_id: 'x1', raw_content: 'A discarded draft.' }, { candidate_id: 'x2', raw_content: 'Sit down, then.', is_final: true }], primary_candidate_id: 'x2' },
    { turn_key: { chat_id: 'neo-1', turn_id: 't2' }, create_time: '2026-05-01T12:00:05Z', author: { author_id: 'u', name: 'Ash', is_human: true }, candidates: [{ candidate_id: 'y1', raw_content: 'Could not sleep.' }], primary_candidate_id: 'y1' },
    { turn_key: { chat_id: 'neo-1', turn_id: 't1' }, create_time: '2026-05-01T12:00:00Z', author: { author_id: 'c', name: 'Juniper', is_human: false }, candidates: [{ candidate_id: 'z1', raw_content: 'Night Desk.' }], primary_candidate_id: 'z1' },
  ] };
  assert.equal(detectCharacterAi(turns), true);
  const fromTurns = parseCharacterAi(turns);
  assert.deepEqual(fromTurns.chats[0].messages.map((m) => [m.role, m.text]), [['assistant', 'Night Desk.'], ['user', 'Could not sleep.'], ['assistant', 'Sit down, then.']]);
  assert.equal(fromTurns.chats[0].character, 'Juniper');
  assert.equal(fromTurns.chats[0].key, 'neo-1');

  const authored = { characters: [{ external_id: 'ch-9', name: 'Juniper', greeting: 'Night Desk.', definition: '' }], chats: [{ chat_id: 'k1', character_id: 'ch-9', messages: [
    { raw_content: 'Night Desk.', author: { name: 'Juniper', is_human: false }, create_time: '2026-05-01T12:00:00Z' },
    { raw_content: 'Hello.', author: { name: 'Ash', is_human: true }, create_time: '2026-05-01T12:00:05Z' },
  ] }] };
  const fromAuthored = parseCharacterAi(authored);
  assert.equal(fromAuthored.chats[0].character, 'Juniper');
  assert.deepEqual(fromAuthored.chats[0].messages.map((m) => m.role), ['assistant', 'user']);
  assert.equal(fromAuthored.characters.length, 1);
  assert.equal(detectCharacterAi({ messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(SOURCES.characterai.early, true, 'the page labels this source early');
});

// ---- generic --------------------------------------------------------------------------------------------------------

test('generic: any JSON that holds a list of messages with a speaker and some text', () => {
  const openai = [{ role: 'system', content: 'be kind' }, { role: 'user', content: 'Hello there' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }], name: 'Wren' }];
  assert.equal(detectGeneric(openai), true);
  const [chat] = parseGeneric(openai, 'wren-log');
  assert.deepEqual(chat.messages.map((m) => [m.role, m.text]), [['user', 'Hello there'], ['assistant', 'Hello.']]);
  assert.equal(chat.character, 'Wren');
  assert.equal(chat.source, 'generic');
  const held = { title: 'Tea order', character_name: 'Juniper', messages: [{ sender: 'human', text: 'Chamomile.', timestamp: 1_790_000_000 }, { sender: 'bot', text: 'One sugar?', timestamp: 1_790_000_060 }] };
  assert.equal(detectGeneric(held), true);
  assert.deepEqual([parseGeneric(held)[0].title, parseGeneric(held)[0].character, parseGeneric(held)[0].updatedAt], ['Tea order', 'Juniper', 1_790_000_060_000]);
  const many = [{ conversations: [{ from: 'human', value: 'One' }, { from: 'gpt', value: 'Two' }] }, { id: 'c2', conversations: [{ from: 'human', value: 'Three' }, { from: 'gpt', value: 'Four' }] }];
  assert.deepEqual(parseGeneric(many, 'set').map((c) => [c.title, c.messages.length]), [['set', 2], ['set 2', 2]]);
  assert.equal(parseGeneric(many, 'set')[1].key, 'c2');
  const nested = { character: { name: 'Bramble' }, chat: { messages: [{ index: 0, role: 'assistant', text: 'Workshop is open.' }, { index: 1, role: 'user', text: 'Hello.' }] } };
  assert.equal(detectGeneric(nested), true);
  assert.equal(parseGeneric(nested, 'file')[0].character, 'Bramble');
  assert.deepEqual(genericMessage({ is_user: true, mes: 'flagged, not labelled' }), { role: 'user', text: 'flagged, not labelled' });
  assert.equal(genericMessage({ role: 'tool', content: 'x' }), null);
  assert.equal(genericMessage({ role: 'user', content: '   ' }), null);
  for (const not of [[{ id: 1, rating: 'good' }], { name: 'A project', description: 'words' }, 'text', 42, null, [], [{ title: 'x', is_anonymous: true }]]) assert.equal(detectGeneric(not), false);
  assert.deepEqual(parseGenericLines('{"role":"user","content":"hi"}\nnot json\n{"role":"assistant","content":"hello"}', 'log').map((c) => c.messages.length), [2]);
  assert.deepEqual(parseGenericLines('{"nothing":"here"}'), []);
});

// ---- cards ----------------------------------------------------------------------------------------------------------

test('cards: a Tavern card is recognized, a built one is a valid V2 card, and other JSON is not mistaken for one', () => {
  assert.equal(detectCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Juniper' } }), true);
  assert.equal(detectCard({ name: 'Juniper', description: 'a fox', first_mes: 'Night Desk.' }), true, 'V1, flat');
  assert.equal(detectCard({ char_name: 'Bramble', name: 'Bramble', description: '', personality: 'gruff', scenario: '', mes_example: '' }), true, 'a tool export with no greeting');
  assert.equal(detectCard({ uuid: 'p1', name: 'A project', description: 'notes', prompt_template: '', docs: [] }), false, 'a name and a description are not enough');
  assert.equal(detectCard({ spec: 'something_else', data: { name: 'x' } }), false);
  const card = buildCard({ source: 'characterai', name: '  Bramble ', description: 'A corduroy bear.', greeting: 'Workshop is open.', personality: 'gruff', examples: '{{char}}: Hm.' });
  assert.deepEqual([card.spec, card.data.name, card.data.first_mes, card.data.personality, card.data.mes_example], ['chara_card_v2', 'Bramble', 'Workshop is open.', 'gruff', '{{char}}: Hm.']);
  assert.match(card.data.creator_notes, /Built on this device by Move In from a Character\.AI export\./);
  assert.equal(buildCard({ source: 'generic', name: '   ' }).data.name, 'Unnamed character');
  const png = writeCardToPng(card);
  assert.deepEqual(readCardBytes(png).data.name, 'Bramble');
  assert.deepEqual(readCardBytes(enc.encode(JSON.stringify(card))).data.first_mes, 'Workshop is open.');
  assert.match(ringOf('Juniper'), /^#[0-9a-f]{6}$/);
  assert.equal(ringOf('Juniper'), ringOf('  juniper '), 'the same name always wears the same colour');
  assert.equal(nameKey('  Ju niper  '), 'ju niper');
  assert.notEqual(shortId('chatgpt|a'), shortId('chatgpt|b'));
  assert.equal(snippetTitle([{ role: 'assistant', text: 'Greeting.' }, { role: 'user', text: 'word '.repeat(30) }], 'x').length, 60);
});

// ---- turns ----------------------------------------------------------------------------------------------------------

const message = fc.record({ role: fc.constantFrom('user', 'assistant'), text: fc.oneof(fc.string({ maxLength: 30 }), fc.constantFrom('', '   ', 'hello', 'a\n\nb')) });

test('turns: paired the way the chat page expects', () => {
  const paired = pairTurns([
    { role: 'assistant', text: 'Night Desk. You are up late.' },
    { role: 'assistant', text: 'Well?' },
    { role: 'user', text: 'Could not sleep.' },
    { role: 'user', text: 'Is the lamp meant to flicker?' },
    { role: 'assistant', text: 'No.' },
    { role: 'assistant', text: 'It has threatened me all week.' },
    { role: 'user', text: '  ' },
    { role: 'user', text: 'It just went out.' },
  ]);
  assert.deepEqual(paired, [
    { prompt: 'Could not sleep.\n\nIs the lamp meant to flicker?', content: 'No.\n\nIt has threatened me all week.' },
    { prompt: 'It just went out.', content: '' },
  ]);
  assert.equal(openingLine([{ role: 'assistant', text: ' Night Desk. ' }, { role: 'user', text: 'hi' }]), 'Night Desk.');
  assert.equal(openingLine([{ role: 'user', text: 'hi' }]), '');
  assert.deepEqual(pairTurns([{ role: 'assistant', text: 'only a greeting' }]), []);
  const many = Array.from({ length: 50 }, (_, i) => ({ prompt: `q${i}`, content: `a${i}` }));
  assert.equal(RESUME_TURNS, 20);
  assert.deepEqual(lastTurns(many).map((t) => t.prompt), many.slice(30).map((t) => t.prompt));
  assert.deepEqual(lastTurns(many, 0), []);
  let n = 0;
  const turns = toChatTurns([{ prompt: 'I want to die sometimes', content: 'I am here.' }, { prompt: 'Tea?', content: '' }], { character: 'Juniper', label: 'from SillyTavern' }, () => `t${++n}`);
  assert.deepEqual(turns[0], { id: 't1', model: 'from SillyTavern', prompt: 'I want to die sometimes', attachment: null, character: 'Juniper', content: 'I am here.', status: 'done', error: null, receiptId: null, receipt: null, council: null, councilMode: null, crisis: true });
  assert.equal('crisis' in turns[1], false);
  assert.equal(turns[1].status, 'done');
});

test('property: pairing keeps the order, loses nothing after the first prompt, and never makes an empty prompt', () => {
  fc.assert(
    fc.property(fc.array(message, { maxLength: 40 }), (messages) => {
      const turns = pairTurns(messages);
      for (const turn of turns) assert.ok(turn.prompt.trim().length > 0, 'no empty prompt');
      // Everything from the first thing the person wrote onward is still there, in the same order.
      const said = messages.map((m) => ({ role: m.role, text: m.text.trim() })).filter((m) => m.text);
      const from = said.findIndex((m) => m.role === 'user');
      const expected = from < 0 ? [] : said.slice(from);
      const flat = turns.flatMap((t) => [['user', t.prompt], ...(t.content ? [['assistant', t.content]] : [])]);
      const merged = [];
      for (const m of expected) {
        const last = merged.at(-1);
        if (last && last[0] === m.role) last[1] = `${last[1]}\n\n${m.text}`;
        else merged.push([m.role, m.text]);
      }
      assert.deepEqual(flat, merged);
      // Only the last turn can be unanswered.
      assert.ok(turns.slice(0, -1).every((t) => t.content.length > 0));
      assert.ok(lastTurns(turns).length <= RESUME_TURNS);
      assert.deepEqual(lastTurns(turns), turns.slice(-RESUME_TURNS));
    }),
    { numRuns: 400 },
  );
});

// ---- memory ---------------------------------------------------------------------------------------------------------

const history = (count, size = 40) => Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i} ${'word '.repeat(size)}`.trim() }));

test('memory: the running summary uses card.ts’s request, in chunks, with a capped reply', () => {
  const log = toLog([{ role: 'user', text: 'Tea?', name: 'Ash' }, { role: 'assistant', text: ' Chamomile. ' }, { role: 'user', text: '  ' }], 'Juniper');
  assert.deepEqual(log, [{ role: 'user', content: 'Tea?', name: 'Ash' }, { role: 'assistant', content: 'Chamomile.', name: 'Juniper' }]);
  const step = summaryStep('anonymo-rp', 'They met at the desk.', log);
  const plain = summaryRequest('anonymo-rp', 'They met at the desk.', log, 200);
  assert.deepEqual(step.messages, plain.messages);
  assert.equal(step.max_tokens, SUMMARY_MAX_TOKENS);
  assert.equal(step.temperature, 0.2);
  assert.ok(step.messages[0].content.startsWith(SUMMARY_MARKER), 'the demo gateway finds a summary request by this');
  assert.match(step.messages[1].content, /^Summary so far:\nThey met at the desk\.\n\nNew turns:\nAsh: Tea\?\nJuniper: Chamomile\.$/);
  assert.match(summaryStep('m', '', log).messages[1].content, /^Summary so far:\n\(none\)/);

  const chunks = chunkLog(toLog(history(200), 'Juniper'), 4000);
  assert.ok(chunks.length > 5);
  assert.equal(chunks.flat().length, 200, 'no message is lost or split');
  for (const chunk of chunks) assert.ok(chunk.map((l) => `${l.name}: ${String(l.content)}`).join('\n').length <= 4000);
  const long = chunkLog(toLog([{ role: 'user', text: 'x'.repeat(9000) }, { role: 'assistant', text: 'short' }], 'J'), 1000);
  assert.equal(long.length, 2);
  assert.ok(long[0][0].content.length < 1000 && long[0][0].content.endsWith('[…]'), 'one message longer than a chunk is shortened');
  assert.equal(CHUNK_CHARS, 24_000);
});

test('memory: the facts request, and reading its reply', () => {
  const request = factsRequest('anonymo-1', 'Juniper', 'They met at the desk.', toLog([{ role: 'user', text: 'Chamomile, one sugar.' }], 'Juniper'));
  assert.ok(request.messages[0].content.startsWith(FACTS_MARKER));
  assert.match(request.messages[0].content, /at most 12 short facts Juniper should remember/);
  assert.equal(request.messages[1].content, 'Summary:\nThey met at the desk.\n\nNewest turns:\nUser: Chamomile, one sugar.');
  assert.ok(request.max_tokens > 0 && request.model === 'anonymo-1');
  assert.match(factsRequest('m', 'J', '', []).messages[1].content, /^Summary:\n\(none\)\n\nNewest turns:\n\(none\)$/);
  assert.deepEqual(parseFacts('Here are the facts:\n- You drink chamomile.\n2. She calls you her lamp hand.\n• “Line seven rings nightly.”\n\n* you drink chamomile.\n3) The window seat is yours.'), ['You drink chamomile.', 'She calls you her lamp hand.', 'Line seven rings nightly.', 'The window seat is yours.']);
  assert.equal(parseFacts(Array.from({ length: 40 }, (_, i) => `Fact number ${i}`).join('\n')).length, FACTS_MAX);
  assert.deepEqual(parseFacts(`${'z'.repeat(400)}\nkept`), ['kept']);
  assert.deepEqual(parseFacts(''), []);
});

test('memory: the plan says what a build sends, and the estimate is shown before anything is spent', () => {
  const plan = planBuild(history(300), 'Juniper', { maxChars: 6000 });
  assert.equal(plan.messages, 300);
  assert.equal(plan.requests, plan.chunks.length + 1, 'one request per chunk, plus one for the facts');
  assert.equal(plan.tokensOut, plan.chunks.length * SUMMARY_MAX_TOKENS + 360);
  const chars = history(300).reduce((n, m) => n + m.text.length, 0);
  assert.ok(plan.tokensIn > chars / 4 && plan.tokensIn < (chars / 4) * 1.6, 'about a token for every four characters, plus the instructions and the summary carried along');
  const roomy = planBuild(history(300), 'Juniper');
  assert.ok(roomy.requests < plan.requests && roomy.tokensIn < plan.tokensIn, 'larger chunks carry the summary fewer times');
  const newest = planBuild(history(300), 'Juniper', { newest: 40, maxChars: 6000 });
  assert.equal(newest.messages, 40);
  assert.ok(newest.requests < plan.requests);
  assert.notEqual(newest.id, plan.id, 'a stopped build can only resume the plan it stopped in');
  assert.equal(planBuild(history(300), 'Juniper', { maxChars: 6000 }).id, plan.id);
  // A build that was stopped carries on where it stopped, and is charged only for what is left.
  assert.deepEqual(planFrom(plan, 0), { requests: plan.requests, tokensIn: plan.tokensIn, tokensOut: plan.tokensOut });
  const rest = planFrom(plan, 3);
  assert.equal(rest.requests, plan.requests - 3);
  assert.ok(rest.tokensIn < plan.tokensIn && rest.tokensOut === plan.tokensOut - 3 * SUMMARY_MAX_TOKENS);
  assert.deepEqual(planFrom(plan, plan.requests), { requests: 0, tokensIn: 0, tokensOut: 0 });
  const factsOnly = planBuild(history(300), 'Juniper', { summary: false });
  assert.deepEqual([factsOnly.chunks.length, factsOnly.requests], [0, 1]);
  assert.deepEqual([planBuild([], 'J').requests, planBuild([], 'J').tokensIn], [0, 0]);

  assert.equal(perTokenToPerMillion('0.00000045'), 450_000);
  assert.equal(perTokenToPerMillion('0.0000018'), 1_800_000);
  assert.equal(perTokenToPerMillion(0.00000008), 80_000);
  assert.equal(perTokenToPerMillion('0'), 0);
  for (const bad of ['', 'free', '-1', '1e-7', null, undefined, Number.NaN]) assert.equal(perTokenToPerMillion(bad), null);
  assert.deepEqual(listedPrice({ id: 'anonymo-1', pricing: { prompt: '0.00000045', completion: '0.0000018' } }), { in: 450_000, out: 1_800_000 });
  assert.equal(listedPrice({ id: 'x' }), null);
  assert.equal(listedPrice({ id: 'x', pricing: { prompt: '0', completion: '0' } }), null, 'no price listed means no estimate, and no build');
  assert.equal(estimateMusd({ tokensIn: 1_000_000, tokensOut: 0 }, { in: 450_000, out: 1_800_000 }), 450_000);
  assert.equal(estimateMusd({ tokensIn: 1, tokensOut: 1 }, { in: 450_000, out: 1_800_000 }), 3, 'rounded up to a whole micro-dollar');
  for (const [id, price] of Object.entries(DEMO_PRICES)) assert.deepEqual(listedPrice({ pricing: { prompt: perTokenUsd(price.in), completion: perTokenUsd(price.out) } }), price, id);
});

test('memory: the board is the person’s to edit, pin, delete and add to, and a rebuild respects that', () => {
  let n = 0;
  const id = () => `p${++n}`;
  let board = applyBuild(emptyBoard(), { summary: ' They met at the desk. ', facts: ['You drink chamomile.', 'She calls you her lamp hand.', 'you drink chamomile.'] }, id, 100);
  assert.deepEqual(board.patches.map((p) => [p.kind, p.text, p.by, p.pinned]), [
    ['summary', 'They met at the desk.', 'model', false],
    ['fact', 'You drink chamomile.', 'model', false],
    ['fact', 'She calls you her lamp hand.', 'model', false],
  ]);
  const [summary, tea, hand] = board.patches;
  board = addPatch(board, '  The window seat is mine.  ', id(), 110);
  board = addPatch(board, '   ', id(), 111);
  board = pinPatch(board, hand.id, true);
  board = editPatch(board, tea.id, 'You drink chamomile, one sugar.', 120);
  assert.equal(board.patches.find((p) => p.id === tea.id).by, 'you', 'an edited patch is the person’s own');
  assert.equal(board.patches.length, 4);
  assert.deepEqual(boardMemory(board), { summary: 'They met at the desk.', facts: ['She calls you her lamp hand.', 'You drink chamomile, one sugar.', 'The window seat is mine.'] }, 'pinned facts go first');

  // A rebuild replaces the model's summary and unpinned facts; everything else stays.
  board = applyBuild(board, { summary: 'They are friends now.', facts: ['Line seven rings nightly.', 'She calls you her lamp hand.'] }, id, 200);
  assert.deepEqual(board.patches.map((p) => p.text), ['They are friends now.', 'You drink chamomile, one sugar.', 'She calls you her lamp hand.', 'The window seat is mine.', 'Line seven rings nightly.']);
  assert.equal(board.patches[0].id, summary.id, 'the summary patch keeps its place');
  // A summary the person pinned or wrote is never replaced.
  const pinned = applyBuild(pinPatch(board, summary.id, true), { summary: 'Replaced?' }, id, 300);
  assert.equal(pinned.patches[0].text, 'They are friends now.');
  assert.ok(isProtected(pinned.patches[0]));
  board = removePatch(board, hand.id);
  board = editPatch(board, tea.id, '   ', 400);
  assert.deepEqual(board.patches.map((p) => p.text), ['They are friends now.', 'The window seat is mine.', 'Line seven rings nightly.']);

  // What an export itself carried becomes patches, once.
  let carried = withExportMemory(emptyBoard(), { summary: 'It knows Ash.', facts: ['Prefers metric units.', ' ', 'Prefers metric units.'] }, id, 500);
  assert.deepEqual(carried.patches.map((p) => [p.kind, p.by, p.text]), [['summary', 'export', 'It knows Ash.'], ['fact', 'export', 'Prefers metric units.']]);
  assert.equal(withExportMemory(carried, { summary: 'It knows Ash.', facts: ['Prefers metric units.'] }, id, 600), carried);
  carried = applyBuild(carried, { summary: 'A model’s summary.', facts: ['New fact.'] }, id, 700);
  assert.deepEqual(carried.patches.map((p) => p.text), ['It knows Ash.', 'Prefers metric units.', 'New fact.'], 'memory that came with the export is not overwritten');

  assert.equal(boardMemory(undefined), undefined);
  assert.equal(boardMemory(emptyBoard()), undefined);
  const crowded = Array.from({ length: 40 }, (_, i) => `Fact ${i}`).reduce((b, t, i) => addPatch(b, t, `c${i}`, i), emptyBoard());
  assert.equal(boardMemory(crowded).facts.length, SENT_FACTS);
  assert.equal(addPatch(emptyBoard(), 'x'.repeat(5000), 'long', 1).patches[0].text.length, 2000);
});

test('memory reaches the model: the chat page passes it to buildCharacterMessages', () => {
  const card = buildCard({ source: 'sillytavern', name: 'Juniper', description: 'A felt fox.', greeting: 'Night Desk.' });
  const board = applyBuild(emptyBoard(), { summary: 'You are her regular late caller.', facts: ['You drink chamomile.'] }, () => 'x', 1);
  const built = buildCharacterMessages(card, [{ role: 'user', content: 'Evening.' }], { memory: boardMemory(board) });
  assert.match(built.messages[0].content, /Memory of earlier chats \(summary\): You are her regular late caller\./);
  assert.match(built.messages[0].content, /Things Juniper remembers:\n- You drink chamomile\./);
  assert.deepEqual(built.messages.slice(1).map((m) => m.role), ['assistant', 'user'], 'the card still opens with its greeting');
  assert.doesNotMatch(buildCharacterMessages(card, [{ role: 'user', content: 'Evening.' }], { memory: undefined }).messages[0].content, /Memory of earlier chats/);
});

// ---- the importer and the archive -----------------------------------------------------------------------------------

test('the sample export moves in: two characters, three chats, nothing uploaded', async () => {
  const disk = memoryDisk();
  const files = sampleFiles().map((f) => drop(f.name, f.text));
  const summary = await importFiles(files, disk, true, options());
  assert.deepEqual([summary.characters, summary.chats, summary.messages], [2, 3, 33]);
  assert.deepEqual(summary.sources, ['sillytavern']);
  assert.deepEqual(summary.skipped, []);
  const view = await loadArchive(disk, true);
  assert.deepEqual(view.characters.map((c) => [c.name, c.chats.length, c.messages, c.built]).sort(byName), [['Bramble', 1, 11, false], ['Juniper', 2, 22, false]]);
  const juniper = view.characters.find((c) => c.name === 'Juniper');
  assert.equal(juniper.id, juniper.hash.slice(0, 16), 'the same id the Characters page gives this card');
  assert.ok(juniper.chats[0].updatedAt > juniper.chats[1].updatedAt, 'newest chat first');
  assert.equal(juniper.chats[1].title, 'Couldn’t sleep, so I walked over. Is the lamp supposed to f…');
  const chat = await readChat(disk, true, juniper.chats[1].id);
  assert.equal(chat.messages.length, 13);
  assert.equal(chat.messages[0].text, juniper.card.data.first_mes, 'the log opens with the card’s greeting');
  assert.equal(pairTurns(chat.messages).length, 6, 'which is not repeated when the chat is continued');
  assert.deepEqual((await loadArchive(disk, false)).characters, [], 'demo and live are kept apart');
  assert.equal((await historyOf(disk, true, juniper)).length, 22);
  assert.equal((await historyOf(disk, true, juniper, 5)).length, 5);
  assert.equal((await historyOf(disk, true, juniper))[0].text, juniper.card.data.first_mes, 'oldest first');

  // Importing it again doubles nothing.
  const again = await importFiles(files, disk, true, options());
  assert.deepEqual([again.characters, again.chats], [2, 3]);
  const after = await loadArchive(disk, true);
  assert.deepEqual(after.characters.map((c) => [c.name, c.chats.length, c.messages]).sort(byName), [['Bramble', 1, 11], ['Juniper', 2, 22]]);
  assert.equal(await sweepOrphans(disk, true), 0);

  await removeCharacter(disk, true, after.characters.find((c) => c.name === 'Bramble'));
  assert.deepEqual((await loadArchive(disk, true)).characters.map((c) => c.name), ['Juniper']);
  await clearArchive(disk, true);
  assert.equal(disk.size(), 0, 'removing everything leaves nothing behind');
  assert.ok(Object.keys(SAMPLE_MEMORY).every((name) => ['Juniper', 'Bramble'].includes(name)));
});

test('a SillyTavern zip: cards and chats find each other by folder, whatever order the zip lists them in', async () => {
  const card = buildCard({ source: 'sillytavern', name: 'Juniper of the Desk', description: 'A felt fox.', greeting: 'Night Desk.' });
  const chat = stChat({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' }, [
    { name: 'Juniper of the Desk', is_user: false, mes: 'Night Desk.', send_date: '2026-10-02T23:10:00.000Z' },
    { name: 'Ash', is_user: true, mes: 'Evening.', send_date: '2026-10-02T23:11:00.000Z' },
  ]);
  const zip = zipOf([
    { name: 'default-user/chats/JuniperCard/night one.jsonl', data: chat },
    { name: 'default-user/settings.json', data: '{"theme":"plum"}' },
    { name: 'default-user/characters/JuniperCard.png', data: writeCardToPng(card), stored: true },
    { name: 'default-user/backgrounds/desk.png', data: writeCardToPng(card).slice(0, 60), stored: true },
    { name: '__MACOSX/default-user/._settings.json', data: 'junk' },
    { name: 'default-user/user.json', data: '{"email":"never-read@example.invalid"}' },
  ]);
  const disk = memoryDisk();
  const summary = await importFiles([{ name: 'backup.zip', blob: zip }], disk, false, options());
  assert.deepEqual([summary.characters, summary.chats, summary.messages], [1, 1, 2]);
  assert.deepEqual(summary.skipped, [], 'files inside a zip that are not chats are passed over quietly');
  const [character] = (await loadArchive(disk, false)).characters;
  assert.deepEqual([character.name, character.built, character.chats[0].title], ['Juniper of the Desk', false, 'night one']);
});

test('Lifeboat checks and deduplicates V2 and V3 PNG and JSON cards by normalized hash in a ZIP', async () => {
  const v2 = buildCard({ source: 'sillytavern', name: 'Stone Lantern', greeting: 'Welcome to the ridge.' });
  const v3 = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: {
      ...v2.data, name: 'Sky Lantern', alternate_greetings: ['Walk with me.'], group_only_greetings: ['Hello crew.'],
      character_book: { entries: [{ keys: ['ridge'], content: 'The observatory overlooks the ridge.', enabled: true }] },
    },
  };
  const blocked = { ...v3, data: { ...v3.data, name: 'Storm Lantern', alternate_greetings: ['fixture-floor-block-marker'] } };
  const zip = zipOf([
    { name: 'characters/storm.json', data: JSON.stringify(blocked) },
    { name: 'characters/stone.png', data: writeCardToPng(v2) },
    { name: 'characters/stone-copy.json', data: JSON.stringify(v2) },
    { name: 'characters/sky.png', data: writeCardToPng(v3) },
    { name: 'characters/sky-copy.json', data: JSON.stringify({ data: v3.data, spec: v3.spec }) },
  ]);
  const disk = memoryDisk();
  const seen = [];
  const checkCard = async (card) => {
    seen.push(card);
    return card.data.alternate_greetings.includes('fixture-floor-block-marker') ? 'Card rejected. Fixture category.' : null;
  };
  const files = [{ name: 'cards.zip', blob: zip }];
  const result = await importFiles(files, disk, false, { ...options(), checkCard });
  assert.equal(result.duplicates, 2);
  assert.equal(result.characters, 2);
  assert.equal(seen.length, 3);
  assert.deepEqual(result.skipped, [{ name: 'storm.json', why: 'Card rejected. Fixture category.' }]);
  const view = await loadArchive(disk, false);
  const stored = view.characters.find((character) => character.name === 'Sky Lantern').card;
  assert.equal(stored.spec, 'chara_card_v3', 'ccv3 wins over the PNG’s V2 fallback');
  assert.deepEqual(stored.data.group_only_greetings, ['Hello crew.']);
  const built = buildCharacterMessages(stored, [{ role: 'user', content: 'Show me the ridge.' }], { greeting: 1 });
  assert.match(built.messages[0].content, /The observatory overlooks the ridge/);
  assert.equal(built.messages[1].content, 'Walk with me.');
  const again = await importFiles(files, disk, false, { ...options(), checkCard });
  assert.equal(again.characters, 0);
  assert.equal(again.duplicates, 4);
  assert.deepEqual(await loadArchive(disk, false), view);
});

test('Lifeboat links a chat through a duplicate card alias and never recreates a rejected card from its chats', async () => {
  const card = buildCard({ source: 'sillytavern', name: 'Stone Lantern', greeting: 'Welcome to the ridge.' });
  const denied = buildCard({ source: 'sillytavern', name: 'Cloud Lantern', description: 'fixture-floor-block-marker' });
  const chat = (character, key) => stChat({ chat_metadata: {}, user_name: 'unused', character_name: character }, [
    { name: character, is_user: false, mes: 'Welcome to the ridge.' },
    { name: 'Visitor', is_user: true, mes: `We painted the telescope ${key}.` },
  ]);
  const first = { name: 'stone.json', blob: new Blob([JSON.stringify(card)]) };
  const disk = memoryDisk();
  const checkCard = async (candidate) => candidate.data.description === denied.data.description ? 'Card rejected. Fixture category.' : null;
  await importFiles([first], disk, false, { ...options(), checkCard });
  const zip = zipOf([
    { name: 'chats/alias/night.jsonl', data: chat('Unknown', 'green') },
    { name: 'chats/denied/night.jsonl', data: chat('Cloud Lantern', 'silver') },
    { name: 'characters/alias.json', data: JSON.stringify(card) },
    { name: 'characters/denied.json', data: JSON.stringify(denied) },
  ]);
  const result = await importFiles([{ name: 'cards.zip', blob: zip }], disk, false, { ...options(), checkCard });
  assert.deepEqual([result.duplicates, result.chats, result.messages], [1, 1, 2]);
  const { characters, boards } = await loadArchive(disk, false);
  assert.deepEqual(characters.map(({ name }) => name), ['Stone Lantern']);
  assert.equal((await disk.keys('chats', 'live:')).length, 1);
  const prompt = buildCharacterMessages(characters[0].card, [{ role: 'user', content: 'Do you remember?' }], { memory: boardMemory(boards[characters[0].id]) });
  assert.match(prompt.messages[0].content, /painted the telescope green/);
  assert.doesNotMatch(JSON.stringify(boards), /silver/);
});

test('a ChatGPT export: every conversation under one character, with its settings and saved memories', async () => {
  const second = { ...gptConversation(), conversation_id: 'conv-0002', title: 'A later chat', update_time: 1_790_500_000 };
  const json = JSON.stringify([{}, gptConversation(), second, { title: 'no messages', mapping: {}, current_node: null }]);
  const zip = zipOf([
    { name: 'conversations-000.json', data: json },
    { name: 'user.json', data: '{"email":"never-read@example.invalid"}' },
    { name: 'message_feedback.json', data: '[{"id":"f1","rating":"thumbs_up"}]' },
    { name: 'file-0001.png', data: 'not really a picture' },
    { name: 'chat.html', data: '<html></html>' },
  ]);
  const disk = memoryDisk();
  const seen = [];
  const summary = await importFiles([{ name: 'export.zip', blob: zip }], disk, false, { ...options(), onProgress: (p) => seen.push(p) });
  assert.deepEqual([summary.characters, summary.chats, summary.messages, summary.sources], [1, 2, 8, ['chatgpt']]);
  assert.ok(seen.some((p) => p.file === 'conversations-000.json' && p.chats === 2));
  const view = await loadArchive(disk, false);
  const [gpt] = view.characters;
  assert.deepEqual([gpt.name, gpt.built, gpt.source, gpt.chats.map((c) => c.title)], ['ChatGPT', true, 'chatgpt', ['A later chat', 'Soldering a headphone wire']]);
  assert.equal(gpt.card.data.first_mes, '', 'an assistant has no greeting');
  assert.match(gpt.card.data.description, /Be brief\. No lists\./);
  assert.deepEqual(view.boards[gpt.id].patches.map((p) => [p.by, p.text]), [
    ['export', 'About you, from your ChatGPT settings: I repair radios.'],
    ['export', 'Prefers metric units.'],
    ['export', 'Owns a loud workshop clock.'],
  ]);
  // The same export again, with the settings gone: the character keeps its id, its card and its board.
  const bare = gptConversation();
  delete bare.mapping.ctx.message;
  delete bare.mapping.mem.message;
  await importFiles([drop('conversations.json', JSON.stringify([bare]))], disk, false, options());
  const later = await loadArchive(disk, false);
  assert.equal(later.characters.length, 1);
  assert.equal(later.characters[0].id, gpt.id);
  assert.match(later.characters[0].card.data.description, /Be brief/);
  assert.equal(later.boards[gpt.id].patches.length, 3);
  assert.equal(later.characters[0].chats.length, 2);
});

test('a Claude export: conversations and what it remembered; the account file is never opened', async () => {
  const zip = zipOf([
    { name: 'conversations.json', data: JSON.stringify([claudeConversation()]) },
    { name: 'memories.json', data: JSON.stringify([{ conversations_memory: 'Ash repairs radios.', project_memories: {}, account_uuid: 'x' }]) },
    { name: 'users.json', data: 'this is deliberately not JSON: opening it would fail the import' },
    { name: 'projects/one.json', data: JSON.stringify({ uuid: 'p1', name: 'Shop notes', description: 'bench notes', prompt_template: '', docs: [] }) },
  ]);
  const disk = memoryDisk();
  const summary = await importFiles([{ name: 'data.zip', blob: zip }], disk, false, options());
  assert.deepEqual([summary.characters, summary.chats, summary.messages, summary.skipped], [1, 1, 3, []]);
  const view = await loadArchive(disk, false);
  assert.deepEqual(view.characters.map((c) => [c.name, c.source]), [['Claude', 'claude']], 'a project is not mistaken for a character');
  assert.deepEqual(view.boards[view.characters[0].id].patches.map((p) => [p.kind, p.by, p.text]), [['summary', 'export', 'Ash repairs radios.']]);
  // Dropped on its own, the account file is named and left shut.
  const alone = await importFiles([drop('users.json', '[{"full_name":"x"}]')], memoryDisk(), false, options());
  assert.deepEqual(alone.skipped, [{ name: 'users.json', why: 'Your account file. It was not opened.' }]);
});

test('a Character.AI export (early): chats find their character by greeting, the rest stay unnamed', async () => {
  const disk = memoryDisk();
  const summary = await importFiles([drop('message.json', JSON.stringify(caiMessages())), drop('character.json', JSON.stringify(caiCharacters())), drop('user.json', '{"email":"never-read@example.invalid"}')], disk, false, options());
  assert.deepEqual([summary.characters, summary.chats, summary.messages, summary.sources], [2, 2, 5, ['characterai']]);
  assert.deepEqual(summary.skipped, [{ name: 'user.json', why: 'Your account file. It was not opened.' }]);
  assert.match(summary.notes.join(' '), /does not say who wrote each message/);
  const view = await loadArchive(disk, false);
  const juniper = view.characters.find((c) => c.name === 'Juniper');
  const unnamed = view.characters.find((c) => c.name === 'Unnamed character 1');
  assert.deepEqual([juniper.chats.length, juniper.messages, juniper.card.data.personality], [1, 3, 'Keeper of the Night Desk']);
  assert.equal(juniper.card.data.first_mes, 'Night Desk. You are up late too, {{user}}.', 'the greeting from character.json, placeholder and all');
  assert.deepEqual([unnamed.chats.length, unnamed.built, unnamed.card.data.first_mes], [1, true, 'Workshop is open. Put it on the bench.']);
  // More chats with the same opening line later join the same unnamed character instead of making a new one.
  const more = [{ chat_id: 'chat-c', candidate_id: 'c9', raw_content: 'Workshop is open. Put it on the bench.', create_time: '2026-04-01 10:00:00+00:00' }, { chat_id: 'chat-c', candidate_id: 'c10', raw_content: 'Back again.', create_time: '2026-04-01 10:01:00+00:00' }];
  await importFiles([drop('message.json', JSON.stringify(more))], disk, false, options());
  const later = await loadArchive(disk, false);
  assert.deepEqual(later.characters.map((c) => [c.name, c.chats.length]).sort(byName), [['Juniper', 1], ['Unnamed character 1', 2]]);
  assert.equal(later.characters.find((c) => c.name === 'Unnamed character 1').id, unnamed.id);
  // The official zip is locked with the account's email, which nothing here asks for.
  const locked = await importFiles([{ name: 'export.zip', blob: zipOf([{ name: 'sample-user/data/message.json', data: '[]', encrypted: true }, { name: 'sample-user/data/user.json', data: '{}', encrypted: true }]) }], memoryDisk(), false, options());
  assert.equal(locked.chats, 0);
  assert.match(locked.skipped[0].why, /locked with a password \(your account email, in lowercase\)\. Unzip it on your device, then drop message\.json and character\.json here\./);
});

test('a card that arrives after its chats takes them over, with the memory', async () => {
  const disk = memoryDisk();
  const log = stChat({ chat_metadata: {} }, [{ name: 'Wren', is_user: false, mes: 'Kettle is on.' }, { name: 'Ash', is_user: true, mes: 'Good.' }]);
  await importFiles([drop('Wren - 2026-01-01@10h00m00s.jsonl', log)], disk, false, options());
  const [built] = (await loadArchive(disk, false)).characters;
  assert.deepEqual([built.name, built.built, built.card.data.first_mes], ['Wren', true, 'Kettle is on.'], 'a card is built from the name and the opening line');
  const { writeBoard } = await import('../lib/anonymo/movein/archive.ts');
  await writeBoard(disk, false, built.id, applyBuild(emptyBoard(), { summary: 'Wren keeps the kettle.' }, () => 'b1', 1));
  const real = buildCard({ source: 'sillytavern', name: 'wren', description: 'The real card.', greeting: 'Kettle is on.' });
  const summary = await importFiles([drop('wren.json', JSON.stringify(real))], disk, false, options());
  assert.equal(summary.replaced.length, 1);
  assert.equal(summary.replaced[0].from, built.id);
  const view = await loadArchive(disk, false);
  assert.equal(view.characters.length, 1);
  assert.deepEqual([view.characters[0].built, view.characters[0].chats.length, view.characters[0].card.data.description], [false, 1, 'The real card.']);
  assert.equal(view.boards[view.characters[0].id].patches[0].text, 'Wren keeps the kettle.');
  assert.equal(view.boards[built.id], undefined);
  // A later chat log for that name goes to the card.
  await importFiles([drop('Wren - 2026-02-01@10h00m00s.jsonl', stChat({ chat_metadata: {} }, [{ name: 'Wren', is_user: false, mes: 'Kettle is on.' }, { name: 'Ash', is_user: true, mes: 'Again?' }]))], disk, false, options());
  assert.deepEqual((await loadArchive(disk, false)).characters.map((c) => [c.built, c.chats.length]), [[false, 2]]);
});

test('files that hold nothing are named; a stopped import leaves no chat text behind', async () => {
  const disk = memoryDisk();
  const summary = await importFiles([drop('notes.txt', 'hello'), drop('empty.json', '[]'), drop('broken.json', '{"a":'), drop('odd.json', '"just a string"'), drop('picture.png', 'not a png'), drop('rows.json', JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, rating: 'good' }))))], disk, false, options());
  assert.deepEqual(summary.skipped.map((s) => s.name), ['notes.txt', 'empty.json', 'broken.json', 'odd.json', 'picture.png', 'rows.json']);
  assert.match(summary.skipped[0].why, /\.zip, \.json, \.jsonl and \.png/);
  assert.match(summary.skipped[4].why, /no character card/);
  assert.deepEqual([summary.characters, summary.chats, disk.size()], [0, 0, 0]);

  const stop = new AbortController();
  const big = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ ...claudeConversation(), uuid: `u-${i}` })));
  await assert.rejects(importFiles([drop('conversations.json', big)], disk, false, { ...options(), signal: stop.signal, onProgress: (p) => p.chats === 90 && stop.abort() }), ImportStopped);
  assert.equal(disk.size(), 0, 'what was written before the stop is removed');
});

// ---- the demo gateway -----------------------------------------------------------------------------------------------

test('the demo gateway answers memory requests in kind, charges for them and gives a receipt', async () => {
  const mock = createMockGateway({ delayMs: 0 });
  const open = createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch });
  const created = await open.createKey();
  const client = createAnonymoClient({ baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch, key: created.key });
  await mock.simulateDeposit(created.key, 'rhc', 'USDG', 2_000_000);

  // Prices are listed the way the real gateway lists them, so the estimate can be shown before a build starts.
  const models = (await open.models()).data;
  assert.deepEqual(listedPrice(models.find((m) => m.id === 'anonymo-rp')), DEMO_PRICES['anonymo-rp']);
  assert.deepEqual(listedPrice(models.find((m) => m.id === 'anonymo-1')), DEMO_PRICES['anonymo-1']);

  const disk = memoryDisk();
  await importFiles(sampleFiles().map((f) => drop(f.name, f.text)), disk, true, options());
  const juniper = (await loadArchive(disk, true)).characters.find((c) => c.name === 'Juniper');
  const plan = planBuild(await historyOf(disk, true, juniper), 'Juniper');
  assert.equal(plan.requests, 2, 'the sample fits one chunk: one summary request and one for the facts');
  const estimate = estimateMusd(plan, DEMO_PRICES['anonymo-1']);
  const before = (await client.balance()).available_usd;

  const first = await client.chat(summaryStep('anonymo-1', '', plan.chunks[0]));
  assert.equal(first.content, SAMPLE_MEMORY.Juniper.summary);
  assert.ok(first.receiptId && first.receipt);
  const second = await client.chat(factsRequest('anonymo-1', 'Juniper', first.content, plan.recent));
  assert.deepEqual(parseFacts(second.content), SAMPLE_MEMORY.Juniper.facts.slice(0, FACTS_MAX));
  const spent = Math.round((before - (await client.balance()).available_usd) * 1e6);
  assert.ok(spent > 0 && spent <= estimate, `charged ${spent} micro-USD, within the estimate of ${estimate}`);

  // Chats that are not the sample get a plain demo summary built from what was said.
  const other = moveInReply(summaryStep('anonymo-1', '', toLog([{ role: 'user', text: 'Is the kettle on?' }, { role: 'assistant', text: 'Always.' }], 'Wren')).messages);
  assert.match(other, /^Demo summary \(a real model writes this from the chats\): User and Wren went on: User said “Is the kettle on\?”, and it ends with Wren saying “Always\.”\.$/);
  const facts = moveInReply(factsRequest('anonymo-1', 'Wren', other, toLog([{ role: 'user', text: 'Is the kettle on?' }, { role: 'assistant', text: 'Always.' }], 'Wren')).messages);
  assert.ok(parseFacts(facts).length >= 3);
  assert.equal(moveInReply([{ role: 'user', content: 'An ordinary question' }]), null, 'ordinary chat is left alone');
  assert.equal(moveInReply([{ role: 'system', content: 'You are a pirate.' }, { role: 'user', content: 'hi' }]), null);
  assert.equal(perTokenUsd(450_000), '0.00000045');
  assert.equal(perTokenUsd(2_000_000), '0.000002');
  assert.equal(perTokenUsd(0), '0');
});

test('the update is off unless listed, and every id the others use is still there', () => {
  assert.equal(parseUpdates('').has('movein'), false);
  assert.equal(parseUpdates('movein').has('movein'), true);
  for (const id of ['history', 'images', 'usage', 'catchup', 'status', 'compare', 'vanish', 'vault', 'video', 'faces', 'voice', 'movein', 'sidebyside', 'tickets']) assert.ok(UPDATE_IDS.includes(id), id);
});
