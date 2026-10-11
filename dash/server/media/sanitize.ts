import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredMediaType } from './asset-crypto.ts';

export const MEDIA_SANITIZE_LIMITS = Object.freeze({
  imageBytes: 20 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  imagePixels: 16_777_216,
  imageSide: 8192,
  videoWidth: 4096,
  videoHeight: 2160,
  videoSeconds: 30,
  videoFrames: 1800,
  timeoutMs: 60_000,
});
const messages = {
  invalid: 'The media could not be decoded or sanitized.',
  unsupported: 'This media format, stream or color profile is unsupported.',
  too_large: 'The media exceeds the supported processing limits.',
  unavailable: 'The media processing runtime is unavailable.',
  timeout: 'Media processing exceeded its deadline.',
  cancelled: 'Media processing was interrupted.',
} as const;
export class MediaSanitizeError extends Error {
  readonly code: keyof typeof messages;
  constructor(code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'MediaSanitizeError';
    this.code = code;
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}
export type SanitizedMedia = {
  bytes: Uint8Array;
  contentType: StoredMediaType;
  width: number;
  height: number;
  durationMs: number | null;
  hasAudio: boolean;
  sanitizerVersion: 'media-canonical-v1';
};
export type MediaSanitizeOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Trusted runtime configuration, never caller input. */ ffmpegPath?: string;
  ffprobePath?: string;
};
function fail(code: keyof typeof messages = 'invalid'): never {
  throw new MediaSanitizeError(code);
}
const text = (b: Uint8Array, a: number, z: number) =>
  Buffer.from(b.buffer, b.byteOffset + a, z - a).toString('latin1');
const u32 = (b: Uint8Array, at: number, little = false) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, little);

function imageFormat(b: Uint8Array): string {
  if (b.length >= 33 && text(b, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return 'jpeg';
  if (b.length >= 20 && text(b, 0, 4) === 'RIFF' && text(b, 8, 12) === 'WEBP')
    return 'webp';
  return fail('unsupported');
}
function pngChunks(b: Uint8Array) {
  const result: { type: string; start: number; size: number }[] = [];
  let at = 8;
  while (at < b.length) {
    if (at + 12 > b.length || result.length >= 10000) fail();
    const size = u32(b, at),
      type = text(b, at + 4, at + 8);
    if (at + size + 12 > b.length) fail();
    result.push({ type, start: at + 8, size });
    at += size + 12;
    if (type === 'IEND') {
      if (at !== b.length || size) fail();
      break;
    }
  }
  if (
    result[0]?.type !== 'IHDR' ||
    result[0]?.size !== 13 ||
    result.at(-1)?.type !== 'IEND'
  )
    fail();
  return result;
}
function webpChunks(b: Uint8Array) {
  if (u32(b, 4, true) + 8 !== b.length) fail();
  const result: { type: string; start: number; size: number }[] = [];
  for (let at = 12; at < b.length;) {
    if (at + 8 > b.length || result.length >= 10000) fail();
    const size = u32(b, at + 4, true);
    if (at + 8 + size + (size % 2) > b.length) fail();
    result.push({ type: text(b, at, at + 4), start: at + 8, size });
    at += 8 + size + (size % 2);
  }
  return result;
}
/** Independent output container audit; does not attempt to classify visible content. */
export function auditSanitizedImage(bytes: Uint8Array, type: StoredMediaType) {
  const format = imageFormat(bytes);
  if (`image/${format}` !== type) fail();
  if (format === 'png') {
    const chunks = pngChunks(bytes);
    if (
      chunks.some((c) => !['IHDR', 'IDAT', 'IEND'].includes(c.type)) ||
      !chunks.some((c) => c.type === 'IDAT')
    )
      fail();
  } else if (format === 'webp') {
    const chunks = webpChunks(bytes);
    if (chunks.some((c) => !['VP8X', 'VP8 ', 'VP8L', 'ALPH'].includes(c.type)))
      fail();
    const extended = chunks.find((c) => c.type === 'VP8X');
    if (
      extended &&
      (extended.size !== 10 || (bytes[extended.start] & ~0x10) !== 0)
    )
      fail();
  } else {
    let at = 2,
      ended = false;
    while (at < bytes.length) {
      if (bytes[at++] !== 255) fail();
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217) {
        ended = true;
        break;
      }
      if (
        ![192, 196, 219, 221, 218, 224].includes(marker) ||
        at + 2 > bytes.length
      )
        fail();
      const length = (bytes[at] << 8) | bytes[at + 1];
      if (length < 2 || at + length > bytes.length) fail();
      if (
        marker === 224 &&
        (length !== 16 ||
          text(bytes, at + 2, at + 7) !== 'JFIF\0' ||
          bytes[at + 14] ||
          bytes[at + 15])
      )
        fail();
      at += length;
      if (marker === 218) {
        while (at < bytes.length) {
          if (bytes[at] !== 255) {
            at++;
            continue;
          }
          if (
            bytes[at + 1] === 0 ||
            (bytes[at + 1] >= 208 && bytes[at + 1] <= 215)
          ) {
            at += 2;
            continue;
          }
          break;
        }
      }
    }
    if (!ended || at !== bytes.length) fail();
  }
}

// Fixed worker program. Raw decoded pixels cross into a new encoder so input
// metadata cannot be retained accidentally through a future keep-metadata call.
const imageProgram = `
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
sharp.concurrency(1);
sharp.cache(false);
const [input, output, format] = process.argv.slice(1);
try {
 const bytes = await readFile(input);
 const opts = {failOn:'warning',limitInputPixels:16777216,pages:1};
 const meta = await sharp(bytes,opts).metadata();
 if(meta.format!==format || (meta.pages??1)!==1 || !meta.width || !meta.height || meta.width>8192 || meta.height>8192 || meta.width*meta.height>16777216 || meta.depth!=='uchar') process.exit(3);
 const decoded = await sharp(bytes,opts).autoOrient().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
 let image = sharp(decoded.data,{raw:{width:decoded.info.width,height:decoded.info.height,channels:decoded.info.channels}});
 image = format==='png' ? image.png({compressionLevel:9,palette:false}) : format==='jpeg' ? image.jpeg({quality:92,chromaSubsampling:'4:4:4',progressive:false}) : image.webp({lossless:true,effort:4});
 const encoded = await image.toBuffer();
 if(encoded.length>20971520) process.exit(4);
 await writeFile(output,encoded,{mode:0o600});
 process.stdout.write(JSON.stringify({width:decoded.info.width,height:decoded.info.height}));
} catch { process.exit(2); }
`;

type Box = {
  type: string;
  start: number;
  payload: number;
  end: number;
  children: Box[];
};
const containers = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'dinf',
  'stbl',
  'edts',
]);
function mp4Boxes(bytes: Uint8Array): Box[] {
  let count = 0;
  function parse(start: number, end: number, depth: number): Box[] {
    if (depth > 12) fail();
    const boxes: Box[] = [];
    for (let at = start; at < end;) {
      if (++count > 20000 || at + 8 > end) fail();
      let size = u32(bytes, at),
        header = 8;
      if (size === 1) {
        if (at + 16 > end) fail();
        const big = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).getBigUint64(at + 8);
        if (big > BigInt(bytes.length)) fail();
        size = Number(big);
        header = 16;
      }
      if (size < header || at + size > end) fail();
      const type = text(bytes, at + 4, at + 8),
        payload = at + header;
      const box: Box = {
        type,
        start: at,
        payload,
        end: at + size,
        children: [],
      };
      if (containers.has(type))
        box.children = parse(payload, box.end, depth + 1);
      else if (type === 'stsd' || type === 'dref') {
        if (payload + 8 > box.end) fail();
        box.children = parse(payload + 8, box.end, depth + 1);
        if (u32(bytes, payload + 4) !== box.children.length) fail();
      } else if (type === 'avc1' || type === 'avc3') {
        if (payload + 78 > box.end) fail();
        box.children = parse(payload + 78, box.end, depth + 1);
      } else if (type === 'mp4a') {
        if (payload + 28 > box.end || bytes[payload + 8] || bytes[payload + 9])
          fail('unsupported');
        box.children = parse(payload + 28, box.end, depth + 1);
      }
      boxes.push(box);
      at = box.end;
    }
    return boxes;
  }
  return parse(0, bytes.length, 0);
}
function flatten(boxes: Box[]): Box[] {
  return boxes.flatMap((b) => [b, ...flatten(b.children)]);
}
function preflightMp4(bytes: Uint8Array) {
  const tree = mp4Boxes(bytes),
    boxes = flatten(tree);
  if (
    tree[0]?.type !== 'ftyp' ||
    tree.filter((b) => b.type === 'moov').length !== 1 ||
    !tree.some((b) => b.type === 'mdat')
  )
    fail('unsupported');
  if (
    boxes.some((b) =>
      ['moof', 'mvex', 'cmov', 'sinf', 'senc', 'encv', 'enca'].includes(b.type),
    )
  )
    fail('unsupported');
  for (const b of boxes.filter((b) => b.type === 'dref'))
    if (
      b.children.length !== 1 ||
      b.children[0].type !== 'url ' ||
      b.children[0].end - b.children[0].payload !== 4 ||
      u32(bytes, b.children[0].payload) !== 1
    )
      fail('unsupported');
  return { tree, boxes };
}
function cleanMp4(bytes: Uint8Array) {
  const { boxes } = preflightMp4(bytes);
  for (const box of boxes) {
    const p = box.payload;
    if (['udta', 'meta', 'uuid', 'free', 'skip', 'cprt'].includes(box.type)) {
      bytes.set(Buffer.from('free'), box.start + 4);
      bytes.fill(0, p, box.end);
    } else if (['mvhd', 'tkhd', 'mdhd'].includes(box.type)) {
      const length = bytes[p] === 0 ? 8 : bytes[p] === 1 ? 16 : fail();
      if (p + 4 + length > box.end) fail();
      bytes.fill(0, p + 4, p + 4 + length);
      if (box.type === 'mdhd') {
        const lang = p + (bytes[p] === 1 ? 32 : 20);
        if (lang + 4 > box.end) fail();
        bytes[lang] = 0x55;
        bytes[lang + 1] = 0xc4;
      }
    } else if (box.type === 'hdlr') {
      if (p + 24 > box.end) fail();
      bytes.fill(0, p + 24, box.end);
    } else if (box.type === 'avc1' || box.type === 'avc3')
      bytes.fill(0, p + 42, p + 74);
  }
  auditMp4(bytes);
}
function auditMp4(bytes: Uint8Array) {
  const { boxes } = preflightMp4(bytes);
  const allowed = new Set([
    'ftyp',
    'moov',
    'mdat',
    'free',
    'mvhd',
    'trak',
    'tkhd',
    'edts',
    'elst',
    'mdia',
    'mdhd',
    'hdlr',
    'minf',
    'vmhd',
    'smhd',
    'dinf',
    'dref',
    'url ',
    'stbl',
    'stsd',
    'avc1',
    'avcC',
    'mp4a',
    'esds',
    'btrt',
    'pasp',
    'colr',
    'stts',
    'ctts',
    'stss',
    'stsc',
    'stsz',
    'stco',
    'co64',
    'sgpd',
    'sbgp',
  ]);
  const zero = (a: number, z: number) =>
    bytes.subarray(a, z).every((v) => v === 0);
  for (const b of boxes) {
    if (!allowed.has(b.type)) fail('unsupported');
    if (b.type === 'free' && !zero(b.payload, b.end)) fail();
    if (
      ['mvhd', 'tkhd', 'mdhd'].includes(b.type) &&
      !zero(b.payload + 4, b.payload + 4 + (bytes[b.payload] === 1 ? 16 : 8))
    )
      fail();
    if (b.type === 'hdlr' && !zero(b.payload + 24, b.end)) fail();
    if (b.type === 'avc1' && !zero(b.payload + 42, b.payload + 74)) fail();
    if (
      b.type === 'colr' &&
      !(
        (text(bytes, b.payload, b.payload + 4) === 'nclx' &&
          b.end - b.payload === 11) ||
        (text(bytes, b.payload, b.payload + 4) === 'nclc' &&
          b.end - b.payload === 10)
      )
    )
      fail('unsupported');
    if (b.type === 'avcC') auditAvcConfig(bytes, b);
  }
}
function auditAvcConfig(bytes: Uint8Array, box: Box) {
  let at = box.payload;
  if (
    box.end - at < 7 ||
    bytes[at] !== 1 ||
    (bytes[at + 4] & 0xfc) !== 0xfc ||
    (bytes[at + 5] & 0xe0) !== 0xe0
  )
    fail();
  at += 5;
  const sps = bytes[at++] & 31;
  const units = (count: number, type: number) => {
    if (!count) fail();
    for (let i = 0; i < count; i++) {
      if (at + 2 > box.end) fail();
      const length = (bytes[at] << 8) | bytes[at + 1];
      at += 2;
      if (
        !length ||
        at + length > box.end ||
        (bytes[at] & 31) !== type ||
        bytes[at] & 128
      )
        fail();
      at += length;
    }
  };
  units(sps, 7);
  if (at >= box.end) fail();
  units(bytes[at++], 8);
  // High-profile structural extension; no extra parameter-set payload is accepted.
  if (
    at !== box.end &&
    !(
      at + 4 === box.end &&
      (bytes[at] & 0xfc) === 0xfc &&
      (bytes[at + 1] & 0xf8) === 0xf8 &&
      (bytes[at + 2] & 0xf8) === 0xf8 &&
      bytes[at + 3] === 0
    )
  )
    fail('unsupported');
}

type Context = {
  signal: AbortSignal;
  remaining: () => number;
  check: () => void;
};
async function run(
  binary: string,
  args: string[],
  ctx: Context,
  maximum = 2 * 1024 * 1024,
) {
  ctx.check();
  if (!binary || binary.length > 4096 || binary.includes('\0'))
    fail('unavailable');
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false,
      outputSize = 0,
      errorSize = 0;
    const output: Buffer[] = [];
    const child = spawn(binary, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        PATH: process.env.PATH ?? '',
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
        NODE_ENV: 'production',
      },
    });
    let reason: MediaSanitizeError | undefined;
    const stop = () => {
      reason =
        ctx.signal.reason instanceof MediaSanitizeError
          ? ctx.signal.reason
          : new MediaSanitizeError('cancelled');
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      reason = new MediaSanitizeError('timeout');
      child.kill('SIGKILL');
    }, ctx.remaining());
    ctx.signal.addEventListener('abort', stop, { once: true });
    const finish = (error?: MediaSanitizeError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', stop);
      if (error) reject(error);
      else resolve(Buffer.concat(output, outputSize));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > maximum) {
        reason = new MediaSanitizeError('too_large');
        child.kill('SIGKILL');
      } else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > 65536) {
        reason = new MediaSanitizeError('invalid');
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => finish(new MediaSanitizeError('unavailable')));
    child.once('close', (code) =>
      finish(
        reason ??
          (code === 0 && errorSize === 0
            ? undefined
            : new MediaSanitizeError(
                code === 3
                  ? 'unsupported'
                  : code === 4
                    ? 'too_large'
                    : 'invalid',
              )),
      ),
    );
    if (ctx.signal.aborted) stop();
  });
}

type Probe = {
  streams: Record<string, unknown>[];
  format: Record<string, unknown>;
  chapters?: unknown[];
  packets?: Record<string, unknown>[];
};
const inputFlags = [
  '-protocol_whitelist',
  'file,pipe',
  '-enable_drefs',
  '0',
  '-use_absolute_path',
  '0',
  '-max_alloc',
  '67108864',
  '-threads',
  '1',
  '-f',
  'mov',
];
async function probe(
  binary: string,
  path: string,
  ctx: Context,
  full = false,
): Promise<Probe> {
  const args = [
    '-v',
    'error',
    ...inputFlags,
    ...(full
      ? [
          '-count_frames',
          '-show_packets',
          '-show_entries',
          'packet=stream_index,pos,size',
        ]
      : []),
    '-show_streams',
    '-show_format',
    '-show_chapters',
    '-of',
    'json',
    path,
  ];
  const result: unknown = JSON.parse(
    (await run(binary, args, ctx)).toString('utf8'),
  );
  if (!result || typeof result !== 'object') fail();
  const data = result as Probe;
  if (
    !Array.isArray(data.streams) ||
    !data.format ||
    typeof data.format !== 'object' ||
    data.streams.length < 1 ||
    data.streams.length > 2
  )
    fail('unsupported');
  return data;
}
function number(value: unknown) {
  const n =
    typeof value === 'string' || typeof value === 'number'
      ? Number(value)
      : NaN;
  if (!Number.isFinite(n)) fail();
  return n;
}
function videoInfo(data: Probe, full: boolean) {
  const videos = data.streams.filter((s) => s.codec_type === 'video'),
    audio = data.streams.filter((s) => s.codec_type === 'audio');
  if (
    videos.length !== 1 ||
    audio.length > 1 ||
    videos.length + audio.length !== data.streams.length
  )
    fail('unsupported');
  const video = videos[0],
    width = number(video.width),
    height = number(video.height);
  const duration = number(data.format.duration);
  const rate = String(video.avg_frame_rate).split('/');
  const fps = Number(rate[0]) / Number(rate[1]);
  if (
    video.codec_name !== 'h264' ||
    video.codec_tag_string !== 'avc1' ||
    video.pix_fmt !== 'yuv420p' ||
    video.field_order !== 'progressive' ||
    (video.closed_captions !== undefined && video.closed_captions !== 0) ||
    ['smpte2084', 'arib-std-b67'].includes(String(video.color_transfer)) ||
    String(video.color_primaries).startsWith('bt2020') ||
    (Array.isArray(video.side_data_list) && video.side_data_list.length)
  )
    fail('unsupported');
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 2160 ||
    duration <= 0 ||
    duration > 30 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 60 ||
    (full &&
      (number(video.nb_read_frames) < 1 || number(video.nb_read_frames) > 1800))
  )
    fail('too_large');
  for (const a of audio)
    if (
      a.codec_name !== 'aac' ||
      a.profile !== 'LC' ||
      number(a.channels) < 1 ||
      number(a.channels) > 2 ||
      number(a.sample_rate) > 48000 ||
      number(a.sample_rate) < 8000
    )
      fail('unsupported');
  return {
    width,
    height,
    durationMs: Math.round(duration * 1000),
    hasAudio: audio.length === 1,
    frames: full ? number(video.nb_read_frames) : 0,
    index: number(video.index),
  };
}
function auditVideoPackets(bytes: Uint8Array, data: Probe, index: number) {
  const { tree, boxes } = preflightMp4(bytes),
    avc = boxes.find((b) => b.type === 'avcC');
  if (
    !avc ||
    avc.payload + 5 > avc.end ||
    !Array.isArray(data.packets) ||
    data.packets.length > 6000
  )
    fail();
  const lengthBytes = (bytes[avc.payload + 4] & 3) + 1;
  const packets = data.packets.filter((p) => p.stream_index === index);
  if (!packets.length || packets.length > 1800) fail();
  for (const packet of packets) {
    const at = number(packet.pos),
      size = number(packet.size),
      end = at + size;
    if (
      !Number.isSafeInteger(at) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      !tree.some((b) => b.type === 'mdat' && at >= b.payload && end <= b.end)
    )
      fail();
    for (let cursor = at; cursor < end;) {
      if (cursor + lengthBytes >= end) fail();
      let length = 0;
      for (let i = 0; i < lengthBytes; i++)
        length = length * 256 + bytes[cursor++];
      if (
        !length ||
        cursor + length > end ||
        ![1, 5, 7, 8].includes(bytes[cursor] & 31)
      )
        fail();
      cursor += length;
    }
  }
}

/** Worker-only canonicalization. Visible text, audio speech and watermarks remain content.
 * This does not provide moderation, provenance authenticity or general malware certification. */
export async function sanitizeMedia(
  input: { bytes: Uint8Array; contentType: StoredMediaType },
  options: MediaSanitizeOptions = {},
): Promise<SanitizedMedia> {
  if (typeof window !== 'undefined') fail('unavailable');
  const limit =
    input?.contentType === 'video/mp4'
      ? MEDIA_SANITIZE_LIMITS.videoBytes
      : MEDIA_SANITIZE_LIMITS.imageBytes;
  if (
    !(input?.bytes instanceof Uint8Array) ||
    !input.bytes.length ||
    input.bytes.length > limit
  )
    fail('too_large');
  if (
    !['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(
      input.contentType,
    )
  )
    fail('unsupported');
  const bytes = new Uint8Array(input.bytes),
    timeout = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
    fail('unsupported');
  const deadline = performance.now() + timeout,
    controller = new AbortController();
  const abort = () => controller.abort(new MediaSanitizeError('cancelled'));
  const deadlineTimer = setTimeout(
    () => controller.abort(new MediaSanitizeError('timeout')),
    timeout,
  );
  options.signal?.addEventListener('abort', abort, { once: true });
  const ctx: Context = {
    signal: controller.signal,
    remaining: () => Math.max(1, Math.ceil(deadline - performance.now())),
    check: () => {
      if (performance.now() >= deadline) fail('timeout');
      if (controller.signal.reason instanceof MediaSanitizeError)
        throw controller.signal.reason;
      if (options.signal?.aborted || controller.signal.aborted)
        fail('cancelled');
    },
  };
  let directory: string | undefined;
  try {
    ctx.check();
    if (input.contentType === 'video/mp4') preflightMp4(bytes);
    else {
      const format = imageFormat(bytes);
      if (`image/${format}` !== input.contentType) fail('unsupported');
      if (
        format === 'png' &&
        pngChunks(bytes).some((c) => ['acTL', 'fcTL', 'fdAT'].includes(c.type))
      )
        fail('unsupported');
      if (
        format === 'webp' &&
        webpChunks(bytes).some(
          (c) =>
            c.type === 'ANIM' ||
            c.type === 'ANMF' ||
            (c.type === 'VP8X' && Boolean(bytes[c.start] & 2)),
        )
      )
        fail('unsupported');
    }
    directory = await mkdtemp(join(tmpdir(), 'conclave-media-'));
    const source = join(directory, 'input'),
      output = join(directory, 'output');
    await writeFile(source, bytes, { mode: 0o600, signal: controller.signal });
    ctx.check();
    let info: {
      width: number;
      height: number;
      durationMs: number | null;
      hasAudio: boolean;
    };
    if (input.contentType !== 'video/mp4') {
      const result = JSON.parse(
        (
          await run(
            process.execPath,
            [
              '--max-old-space-size=256',
              '--input-type=module',
              '-e',
              imageProgram,
              source,
              output,
              input.contentType.slice(6),
            ],
            ctx,
            4096,
          )
        ).toString('utf8'),
      );
      info = {
        width: number(result.width),
        height: number(result.height),
        durationMs: null,
        hasAudio: false,
      };
    } else {
      const ffmpeg = options.ffmpegPath ?? 'ffmpeg',
        ffprobe = options.ffprobePath ?? 'ffprobe';
      const original = videoInfo(await probe(ffprobe, source, ctx, true), true);
      await run(
        ffmpeg,
        [
          '-hide_banner',
          '-v',
          'error',
          '-nostdin',
          '-xerror',
          ...inputFlags,
          '-i',
          source,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-map_metadata',
          '-1',
          '-map_metadata:s',
          '-1',
          '-map_chapters',
          '-1',
          '-sn',
          '-dn',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '18',
          '-pix_fmt',
          'yuv420p',
          '-threads:v',
          '1',
          '-fps_mode',
          'passthrough',
          '-bsf:v',
          'filter_units=remove_types=6|9|10|11|12',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-fflags',
          '+bitexact',
          '-flags:a',
          '+bitexact',
          '-flags:v',
          '+bitexact',
          '-metadata',
          'encoder=',
          '-metadata:s:v',
          'encoder=',
          '-metadata:s:v',
          'handler_name=',
          '-metadata:s:a',
          'handler_name=',
          '-write_tmcd',
          '0',
          '-movflags',
          '+faststart',
          '-fs',
          String(limit + 1),
          '-f',
          'mp4',
          '-y',
          output,
        ],
        ctx,
      );
      if ((await stat(output)).size > limit) fail('too_large');
      const canonical = new Uint8Array(
        await readFile(output, { signal: controller.signal }),
      );
      cleanMp4(canonical);
      await writeFile(output, canonical, { signal: controller.signal });
      const decoded = await probe(ffprobe, output, ctx, true),
        final = videoInfo(decoded, true);
      if (
        final.width !== original.width ||
        final.height !== original.height ||
        final.hasAudio !== original.hasAudio ||
        final.frames !== original.frames ||
        Math.abs(final.durationMs - original.durationMs) > 250
      )
        fail();
      auditVideoPackets(canonical, decoded, final.index);
      // Decode every rebuilt frame/sample before allowing these output bytes to leave the worker.
      await run(
        ffmpeg,
        [
          '-hide_banner',
          '-v',
          'error',
          '-nostdin',
          '-xerror',
          '-err_detect',
          'explode',
          ...inputFlags,
          '-i',
          output,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-threads',
          '1',
          '-f',
          'null',
          '-',
        ],
        ctx,
      );
      info = {
        width: final.width,
        height: final.height,
        durationMs: final.durationMs,
        hasAudio: final.hasAudio,
      };
    }
    if ((await stat(output)).size > limit) fail('too_large');
    let result = new Uint8Array(
      await readFile(output, { signal: controller.signal }),
    );
    if (!result.length) fail();
    if (input.contentType === 'image/png')
      result = new Uint8Array(
        Buffer.concat([
          Buffer.from(result.subarray(0, 8)),
          ...pngChunks(result)
            .filter((c) => ['IHDR', 'IDAT', 'IEND'].includes(c.type))
            .map((c) =>
              Buffer.from(result.subarray(c.start - 8, c.start + c.size + 4)),
            ),
        ]),
      );
    if (input.contentType !== 'video/mp4')
      auditSanitizedImage(result, input.contentType);
    ctx.check();
    return {
      bytes: result,
      contentType: input.contentType,
      ...info,
      sanitizerVersion: 'media-canonical-v1',
    };
  } catch (error) {
    if (error instanceof MediaSanitizeError) throw error;
    if (controller.signal.reason instanceof MediaSanitizeError)
      throw controller.signal.reason;
    if (options.signal?.aborted) fail('cancelled');
    return fail();
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(() =>
        fail('unavailable'),
      );
  }
}
