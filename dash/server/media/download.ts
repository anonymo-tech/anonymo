import { gatewayApiOrigin, parseGatewayOrigin } from '../gateway/origin.ts';
import type { GatewayMedia } from '../gateway/index.ts';

export const MEDIA_DOWNLOAD_LIMITS = Object.freeze({
  imageBytes: 20 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  timeoutMs: 60_000,
  urlCharacters: 4096,
});

const messages = {
  unavailable: 'Media acquisition is only available on the server.',
  invalid_request: 'The media acquisition request is unsupported.',
  invalid_url: 'The media address is not an approved provider result.',
  unavailable_media: 'The provider media could not be retrieved.',
  invalid_response: 'The provider returned unsupported media.',
  too_large: 'The provider media exceeds the acquisition limit.',
  timeout: 'Media acquisition timed out.',
  cancelled: 'Media acquisition was interrupted.',
} as const;

export type MediaDownloadErrorCode = keyof typeof messages;

/** Never retain provider URLs, bodies, headers, errors or causes. */
export class MediaDownloadError extends Error {
  readonly code: MediaDownloadErrorCode;
  constructor(code: MediaDownloadErrorCode) {
    super(messages[code]);
    this.name = 'MediaDownloadError';
    this.code = code;
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export type MediaDownloadOptions = {
  /** Test/runtime dependency injection only; never take this from a request. */
  fetch?: typeof globalThis.fetch;
  apiOrigin?: string;
  signal?: AbortSignal;
  /** May shorten, but cannot increase, the acquisition deadline. */
  timeoutMs?: number;
};

export type AcquiredMedia = {
  bytes: Uint8Array;
  contentType: GatewayMedia['contentType'];
};

function approvedUrl(value: unknown, apiOrigin: string): string {
  if (
    typeof value !== 'string' ||
    value.length > MEDIA_DOWNLOAD_LIMITS.urlCharacters ||
    /[\s\\]/.test(value) ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new MediaDownloadError('invalid_url');
  try {
    const url = new URL(value);
    const entries = [...url.searchParams];
    const signature = url.searchParams.get('sig');
    const expiry = url.searchParams.get('exp');
    if (
      url.href !== value ||
      url.origin !== apiOrigin ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/v1\/media\/[A-Za-z0-9_-]{1,128}\/(?:0|[1-9][0-9]{0,8})$/.test(
        url.pathname,
      ) ||
      entries.length !== 2 ||
      entries.some(([key]) => key !== 'sig' && key !== 'exp') ||
      url.searchParams.getAll('sig').length !== 1 ||
      url.searchParams.getAll('exp').length !== 1 ||
      !signature ||
      !/^[A-Za-z0-9_+/=-]{1,1024}$/.test(signature) ||
      !expiry ||
      !/^(?:0|[1-9][0-9]{0,15})$/.test(expiry) ||
      url.searchParams.toString() !== url.search.slice(1)
    )
      throw new MediaDownloadError('invalid_url');
    // Expiry is enforced by GATEWAY, not by the worker's clock.
    return url.href;
  } catch {
    throw new MediaDownloadError('invalid_url');
  }
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** A format signature check, not a decoder, metadata scrubber or safety audit. */
function hasSignature(bytes: Uint8Array, type: GatewayMedia['contentType']) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'image/png')
    return (
      bytes.length >= 33 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) &&
      view.getUint32(8) === 13 &&
      ascii(bytes, 12, 16) === 'IHDR' &&
      view.getUint32(16) > 0 &&
      view.getUint32(20) > 0
    );
  if (type === 'image/jpeg')
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes[3] !== 0x00 &&
      bytes[3] !== 0xff
    );
  if (type === 'image/webp')
    return (
      bytes.length >= 20 &&
      ascii(bytes, 0, 4) === 'RIFF' &&
      view.getUint32(4, true) + 8 === bytes.length &&
      ascii(bytes, 8, 12) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 16))
    );
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return false;
  const boxSize = view.getUint32(0);
  if (boxSize < 16 || boxSize > bytes.length || (boxSize - 16) % 4 !== 0)
    return false;
  const mp4Brands = new Set([
    'isom',
    'iso2',
    'iso3',
    'iso4',
    'iso5',
    'iso6',
    'iso7',
    'iso8',
    'iso9',
    'mp41',
    'mp42',
    'avc1',
    'M4V ',
    'MSNV',
    'dash',
  ]);
  // Major brand must itself be MP4: a compatible isom entry cannot turn HEIF
  // or QuickTime into one. Codec/container validation belongs to sanitization.
  return mp4Brands.has(ascii(bytes, 8, 12));
}

/**
 * Acquire only an owned generation's server-persisted GATEWAY result, never a
 * client-supplied URL. The bytes are UNSANITIZED and must not be stored as a
 * deliverable or sent to a browser until the separate sanitizer accepts them.
 * This GET never generates media and must not change inference billing state.
 */
export async function downloadGatewayMedia(
  media: GatewayMedia,
  options: MediaDownloadOptions = {},
): Promise<AcquiredMedia> {
  const apiOrigin =
    options.apiOrigin === undefined
      ? gatewayApiOrigin()
      : parseGatewayOrigin(options.apiOrigin);
  if (typeof window !== 'undefined' || !apiOrigin)
    throw new MediaDownloadError('unavailable');
  const url = approvedUrl(media?.url, apiOrigin);
  const type = media?.contentType;
  if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(type))
    throw new MediaDownloadError('invalid_request');
  const timeoutMs = options.timeoutMs ?? MEDIA_DOWNLOAD_LIMITS.timeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MEDIA_DOWNLOAD_LIMITS.timeoutMs
  )
    throw new MediaDownloadError('invalid_request');
  if (options.signal?.aborted) throw new MediaDownloadError('cancelled');
  const maximum =
    type === 'video/mp4'
      ? MEDIA_DOWNLOAD_LIMITS.videoBytes
      : MEDIA_DOWNLOAD_LIMITS.imageBytes;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let timedOut = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  const interruption = () =>
    new MediaDownloadError(timedOut ? 'timeout' : 'cancelled');
  const checkDeadline = () => {
    // Buffered reads can resolve without yielding to timers.
    if (performance.now() >= deadline) {
      timedOut = true;
      controller.abort();
    }
    if (controller.signal.aborted) throw interruption();
  };
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const interrupted = () => reject(interruption());
      if (controller.signal.aborted) {
        void promise.catch(() => {});
        interrupted();
        return;
      }
      controller.signal.addEventListener('abort', interrupted, { once: true });
      promise.then(resolve, reject).finally(() => {
        controller.signal.removeEventListener('abort', interrupted);
      });
    });
  try {
    response = await wait<Response>(
      (options.fetch ?? globalThis.fetch)(url, {
        method: 'GET',
        headers: { Accept: type, 'Accept-Encoding': 'identity' },
        credentials: 'omit',
        redirect: 'error',
        referrer: '',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      }).then((result) => {
        if (controller.signal.aborted)
          void result.body?.cancel().catch(() => {});
        return result;
      }),
    );
    checkDeadline();
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url)
    )
      throw new MediaDownloadError('unavailable_media');
    if (
      response.headers.get('content-type')?.trim().toLowerCase() !== type ||
      (response.headers.has('content-encoding') &&
        response.headers.get('content-encoding')?.toLowerCase() !==
          'identity') ||
      !response.body
    )
      throw new MediaDownloadError('invalid_response');
    const declared = response.headers.get('content-length');
    if (declared !== null && !/^(?:0|[1-9][0-9]{0,15})$/.test(declared))
      throw new MediaDownloadError('invalid_response');
    if (declared !== null && Number(declared) > maximum)
      throw new MediaDownloadError('too_large');
    reader = response.body.getReader();
    let count = 0;
    const chunks: Uint8Array[] = [];
    const blockBytes = 1024 * 1024;
    let block: Uint8Array | undefined;
    let filled = 0;
    while (true) {
      const next = await wait(reader.read());
      checkDeadline();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > maximum) throw new MediaDownloadError('too_large');
      // Coalesce tiny network chunks to bound allocation overhead as well as
      // bytes. Copy them immediately; do not retain mutable transport buffers.
      let consumed = 0;
      while (consumed < next.value.byteLength) {
        block ??= new Uint8Array(blockBytes);
        const size = Math.min(
          blockBytes - filled,
          next.value.byteLength - consumed,
        );
        block.set(next.value.subarray(consumed, consumed + size), filled);
        filled += size;
        consumed += size;
        if (filled === blockBytes) {
          chunks.push(block);
          block = undefined;
          filled = 0;
        }
      }
    }
    if (block && filled) chunks.push(block.subarray(0, filled));
    if (declared !== null && count !== Number(declared))
      throw new MediaDownloadError('invalid_response');
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (!hasSignature(bytes, type))
      throw new MediaDownloadError('invalid_response');
    checkDeadline();
    return { bytes, contentType: type };
  } catch (error) {
    if (controller.signal.aborted) throw interruption();
    if (error instanceof MediaDownloadError) throw error;
    throw new MediaDownloadError('unavailable_media');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else {
      void response?.body?.cancel().catch(() => {});
    }
  }
}
