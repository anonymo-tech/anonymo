// A zip reader with no dependency: the central directory is read from the end of the file, and one entry at a time is
// inflated with the browser's own DecompressionStream('deflate-raw'). The archive is never loaded whole: a multi-gigabyte
// export costs only the bytes of the entries that are opened. Nothing is written anywhere, so entry names are only labels.

import { crc32 } from '../card.ts';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export type ZipEntry = {
  name: string;
  /** Uncompressed size in bytes, as the directory states it. */
  size: number;
  compressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else cannot be opened. */
  method: number;
  crc: number;
  /** Where the entry's local header starts. */
  offset: number;
  encrypted: boolean;
  directory: boolean;
};

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record is 22 bytes plus a comment of at most 65,535. */
const TAIL = 22 + 0xffff;
const MAX_ENTRIES = 200_000;
/** More than this in one entry is refused unless the caller streams it: a small zip can claim to inflate to anything. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const slice = async (blob: Blob, start: number, end: number) => new Uint8Array(await blob.slice(start, end).arrayBuffer());

function u64(v: DataView, at: number): number {
  const n = Number(v.getBigUint64(at, true));
  if (!Number.isSafeInteger(n)) throw new ZipError('The zip is too large to read here.');
  return n;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** Names are UTF-8 when the entry says so, and in practice usually when it does not; anything else is read byte for byte. */
function entryName(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  }
}

/** True when the bytes start like a zip (a local header, or the end record of an empty archive). */
export const looksLikeZip = (head: Uint8Array) => head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6));

/** Export zips often include hidden files written by the operating system. */
export function importableZipEntries(entries: ZipEntry[], transcripts: boolean): ZipEntry[] {
  const extensions = transcripts ? /\.(jsonl?|png|txt)$/i : /\.(jsonl?|png)$/i;
  return entries.filter((entry) => {
    const path = transcripts ? entry.name.replace(/\\/g, '/') : entry.name;
    return !entry.directory && !/(^|\/)(__MACOSX\/|\.)/.test(path) && extensions.test(path);
  });
}

/** Every entry of the archive, from its central directory. Throws ZipError when the file is not a readable zip. */
export async function readZipDirectory(blob: Blob): Promise<ZipEntry[]> {
  if (blob.size < 22) throw new ZipError('This is not a zip file.');
  const tailStart = Math.max(0, blob.size - TAIL);
  const tail = await slice(blob, tailStart, blob.size);
  const tv = view(tail);
  let at = tail.length - 22;
  while (at >= 0 && tv.getUint32(at, true) !== EOCD) at--;
  if (at < 0) throw new ZipError('This is not a zip file, or it is cut short.');

  let count = tv.getUint16(at + 10, true);
  let size = tv.getUint32(at + 12, true);
  let start = tv.getUint32(at + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    // Zip64: a locator sits just before the end record and points at the real one.
    const loc = at - 20;
    if (loc < 0 || tv.getUint32(loc, true) !== EOCD64_LOCATOR) throw new ZipError('The zip is damaged: its large-file record is missing.');
    const recordAt = u64(tv, loc + 8);
    const record = view(await slice(blob, recordAt, recordAt + 56));
    if (record.byteLength < 56 || record.getUint32(0, true) !== EOCD64) throw new ZipError('The zip is damaged: its large-file record cannot be read.');
    count = u64(record, 32);
    size = u64(record, 40);
    start = u64(record, 48);
  }
  if (count > MAX_ENTRIES) throw new ZipError('This zip holds more files than can be listed here.');
  if (start + size > blob.size) throw new ZipError('The zip is cut short: its file list is incomplete.');

  const dir = await slice(blob, start, start + size);
  const dv = view(dir);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dv.getUint32(p, true) !== CENTRAL) throw new ZipError('The zip is damaged: its file list cannot be read.');
    const flags = dv.getUint16(p + 8, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    if (p + 46 + nameLen + extraLen + commentLen > dir.length) throw new ZipError('The zip is damaged: its file list cannot be read.');
    let compressedSize = dv.getUint32(p + 20, true);
    let fullSize = dv.getUint32(p + 24, true);
    let offset = dv.getUint32(p + 42, true);
    // Zip64 extra field (id 1): only the values that overflowed above, in this order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = dv.getUint16(e, true);
      const len = dv.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        const take = () => {
          if (q + 8 > e + 4 + len) throw new ZipError('The zip is damaged: a large-file size is missing.');
          const n = u64(dv, q);
          q += 8;
          return n;
        };
        if (fullSize === 0xffffffff) fullSize = take();
        if (compressedSize === 0xffffffff) compressedSize = take();
        if (offset === 0xffffffff) offset = take();
      }
      e += 4 + len;
    }
    const name = entryName(dir.subarray(p + 46, p + 46 + nameLen));
    out.push({
      name,
      size: fullSize,
      compressedSize,
      method: dv.getUint16(p + 10, true),
      crc: dv.getUint32(p + 16, true),
      offset,
      encrypted: (flags & 1) === 1,
      directory: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Where an entry's data starts and ends in the archive (its local header carries its own name and extra lengths). */
async function dataRange(blob: Blob, entry: ZipEntry): Promise<[number, number]> {
  if (entry.encrypted) throw new ZipError(`“${entry.name}” is password-protected. Unzip it first, then drop the files.`);
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`“${entry.name}” uses a compression this browser cannot open. Unzip it first, then drop the files.`);
  const head = await slice(blob, entry.offset, entry.offset + 30);
  if (head.length < 30 || view(head).getUint32(0, true) !== LOCAL) throw new ZipError(`The zip is damaged at “${entry.name}”.`);
  const start = entry.offset + 30 + view(head).getUint16(26, true) + view(head).getUint16(28, true);
  if (start + entry.compressedSize > blob.size) throw new ZipError(`The zip is cut short at “${entry.name}”.`);
  return [start, start + entry.compressedSize];
}

/** An entry's bytes as a stream, inflated on the way: for files too large to hold at once. */
export async function openZipEntry(blob: Blob, entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
  const [start, end] = await dataRange(blob, entry);
  const raw = blob.slice(start, end).stream() as ReadableStream<Uint8Array>;
  if (entry.method === 0) return raw;
  return raw.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** An entry's bytes, whole, checked against the size and checksum the directory states. */
export async function readZipEntry(blob: Blob, entry: ZipEntry, maxBytes = MAX_ENTRY_BYTES): Promise<Uint8Array> {
  if (entry.size > maxBytes) throw new ZipError(`“${entry.name}” is too large to open here.`);
  const reader = (await openZipEntry(blob, entry)).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      // The directory's size is a claim; stop as soon as the data proves it wrong.
      if (total > entry.size) throw new ZipError(`The zip is damaged at “${entry.name}”: it holds more than it says.`);
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ZipError) throw error;
    throw new ZipError(`“${entry.name}” could not be unpacked. The zip may be damaged.`);
  }
  if (total !== entry.size) throw new ZipError(`The zip is damaged at “${entry.name}”: it is shorter than it says.`);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  if (crc32(out) !== entry.crc) throw new ZipError(`The zip is damaged at “${entry.name}”: its checksum does not match.`);
  return out;
}
