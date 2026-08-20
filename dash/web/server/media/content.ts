import { MEDIA_CHUNK_BYTES } from './asset-crypto.ts';
import type { OwnedMediaReader } from './reader.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';

export type MediaByteRange = { start: number; end: number; partial: boolean };
/** One RFC9110 byte range. Multipart ranges are intentionally unsupported. */
export function mediaByteRange(
  value: string | null,
  length: number,
): MediaByteRange {
  requireCondition(
    Number.isSafeInteger(length) && length > 0,
    503,
    'MEDIA_CONTENT_UNAVAILABLE',
    'This saved media could not be verified.',
  );
  if (value === null) return { start: 0, end: length - 1, partial: false };
  const match = value.length <= 100 && /^bytes=(\d*)-(\d*)$/.exec(value);
  const invalid = () =>
    new ServiceError(
      416,
      'MEDIA_RANGE_UNAVAILABLE',
      'This media byte range is unavailable.',
    );
  if (!match || (!match[1] && !match[2])) throw invalid();
  const number = (text: string) => {
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 0) throw invalid();
    return n;
  };
  if (!match[1]) {
    const suffix = number(match[2]);
    if (suffix === 0) throw invalid();
    return {
      start: Math.max(0, length - suffix),
      end: length - 1,
      partial: true,
    };
  }
  const start = number(match[1]),
    end = match[2] ? number(match[2]) : length - 1;
  if (start >= length || end < start) throw invalid();
  return { start, end: Math.min(end, length - 1), partial: true };
}

export type MediaContentDependencies = {
  reader: OwnedMediaReader;
  /** Revalidate the original session, including revocation, before each emission. */
  authorize: () => Promise<void>;
  dispose: () => Promise<void>;
  /** Trusted test/runtime bound only; cannot exceed one minute. */
  timeoutMs?: number;
};

/** Lifecycle owned by this response, not a request-scoped withDatabase callback.
 * Backpressure permits only one decrypted storage chunk per pull. No plaintext
 * bytes are emitted before authentication; a later storage/session error aborts
 * the body with a fixed error, never provider details or partial corrupt chunks. */
export async function mediaContentResponse(
  request: Request,
  dependencies: MediaContentDependencies,
) {
  const { reader, authorize } = dependencies;
  let cleanup: Promise<void> | undefined;
  const dispose = () => (cleanup ??= dependencies.dispose());
  try {
    requireCondition(
      ['GET', 'HEAD'].includes(request.method),
      405,
      'METHOD_NOT_ALLOWED',
      'Use GET or HEAD for saved media.',
    );
    requireCondition(
      !request.signal.aborted,
      499,
      'MEDIA_READ_INTERRUPTED',
      'Media playback was interrupted.',
    );
    const timeout = dependencies.timeoutMs ?? 60000;
    requireCondition(
      Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 60000,
      503,
      'MEDIA_CONTENT_UNAVAILABLE',
      'Media delivery is unavailable.',
    );
    await authorize();
    const query = new URL(request.url).searchParams;
    const download = query.get('download') === '1';
    const extension = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
    }[reader.contentType];
    const etag = `"${reader.id}.${reader.sha256}"`;
    const headers = new Headers({
      'Content-Type': reader.contentType,
      'Cache-Control': 'private, no-store, no-transform',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="conclave-${reader.id}.${extension}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'Accept-Ranges': 'bytes',
      Vary: 'Cookie, X-Conclave-Account-Id',
      ETag: etag,
    });
    const ifRange = request.headers.get('if-range');
    let range: MediaByteRange;
    try {
      range = mediaByteRange(
        request.method === 'HEAD' || (ifRange !== null && ifRange !== etag)
          ? null
          : request.headers.get('range'),
        reader.byteLength,
      );
    } catch (error) {
      if (!(error instanceof ServiceError && error.status === 416)) throw error;
      headers.set('Content-Range', `bytes */${reader.byteLength}`);
      headers.set('Content-Length', '0');
      await dispose();
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Length', String(range.end - range.start + 1));
    if (range.partial)
      headers.set(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${reader.byteLength}`,
      );
    if (request.method === 'HEAD') {
      await dispose();
      return new Response(null, { status: 200, headers });
    }
    let index = Math.floor(range.start / MEDIA_CHUNK_BYTES),
      stopped = false;
    let control: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = async (terminal: 'error' | 'close' | 'cancel') => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      // Settle the body before cleanup: a failed pool close must never leave a
      // completed response hanging, or expose a raw database error to readers.
      if (terminal === 'error')
        control.error(new Error('MEDIA_CONTENT_UNAVAILABLE'));
      else if (terminal === 'close') control.close();
      await dispose();
    };
    const abort = () => {
      void stop('error').catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          control = controller;
          timer = setTimeout(abort, timeout);
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) abort();
        },
        async pull(controller) {
          if (stopped) return;
          try {
            await authorize();
            if (stopped) return;
            const chunk = await reader.readChunk(index);
            // Recheck after an in-flight storage read, before sending its bytes.
            await authorize();
            if (stopped) return;
            const offset = index * MEDIA_CHUNK_BYTES;
            const expected = Math.min(
              MEDIA_CHUNK_BYTES,
              reader.byteLength - offset,
            );
            requireCondition(
              chunk.byteLength === expected,
              503,
              'MEDIA_CONTENT_UNAVAILABLE',
              'This saved media could not be verified.',
            );
            const start = Math.max(0, range.start - offset),
              end = Math.min(chunk.byteLength, range.end + 1 - offset);
            controller.enqueue(chunk.subarray(start, end));
            index++;
            if (offset + end > range.end) {
              await stop('close');
            }
          } catch {
            await stop('error').catch(() => {});
          }
        },
        async cancel() {
          await stop('cancel').catch(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    // Workers derives Content-Length from the stream implementation and ignores
    // a manual length on a generic ReadableStream. Preserve bounded streaming,
    // cancellation propagation and byte-count enforcement in that runtime.
    let delivered: ReadableStream = body;
    if (typeof FixedLengthStream !== 'undefined') {
      const fixed = new FixedLengthStream(range.end - range.start + 1);
      void body.pipeTo(fixed.writable).catch(() => {});
      delivered = fixed.readable;
    }
    return new Response(delivered, {
      status: range.partial ? 206 : 200,
      headers,
    });
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
