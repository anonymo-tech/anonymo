import { parseProviderJson } from './codec.ts';
import { GatewayError } from './errors.ts';

import { parseGatewayOrigin } from './origin.ts';
export const GATEWAY_LIMITS = Object.freeze({
  requestBytes: 256 * 1024,
  jsonBytes: 1024 * 1024,
  catalogBytes: 4 * 1024 * 1024,
  streamBytes: 8 * 1024 * 1024,
  frameBytes: 128 * 1024,
});

export type Fetcher = typeof globalThis.fetch;
export type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  chargeable?: boolean;
  stream?: boolean;
  requestId?: string;
};

export type GatewaySession = {
  response: Response;
  signal: AbortSignal;
  ambiguous: boolean;
  wait: <T>(promise: Promise<T>) => Promise<T>;
  fail: (error: unknown) => GatewayError;
  close: () => void;
};

function httpError(status: number, chargeable: boolean) {
  if (status === 401 || status === 403)
    return new GatewayError('authentication');
  if (status === 402) return new GatewayError('insufficient_credit');
  if (status === 409) return new GatewayError('conflict');
  if (status === 404) return new GatewayError('not_found');
  // GATEWAY bills only from upstream-reported usage. A 429 (observed: upstream
  // shared-pool rate limit) is returned before any generation, so it is unbilled.
  if (status === 429) return new GatewayError('provider_unavailable');
  // Other rejections can originate after upstream work, so retain the reservation.
  return new GatewayError('provider_unavailable', chargeable);
}

export function transport(
  apiKey: string | undefined,
  fetcher: Fetcher,
  apiOrigin: string | null,
) {
  return async function request(
    path: string,
    options: RequestOptions,
  ): Promise<GatewaySession> {
    if (
      typeof window !== 'undefined' ||
      !apiKey ||
      !parseGatewayOrigin(apiOrigin)
    )
      throw new GatewayError('unavailable');
    if (!/^[\x21-\x7e]{1,512}$/.test(apiKey))
      throw new GatewayError('unavailable');
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('://') ||
      /[\\#]/.test(path) ||
      new URL(path, apiOrigin!).origin !== apiOrigin
    )
      throw new GatewayError('invalid_request');
    if (options.signal?.aborted) throw new GatewayError('cancelled');
    if (
      options.requestId !== undefined &&
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.requestId)
    )
      throw new GatewayError('invalid_request');
    let body: string | undefined;
    try {
      body =
        options.body === undefined ? undefined : JSON.stringify(options.body);
    } catch {
      throw new GatewayError('invalid_request');
    }
    if (
      body &&
      new TextEncoder().encode(body).length > GATEWAY_LIMITS.requestBytes
    )
      throw new GatewayError('invalid_request');
    const controller = new AbortController();
    let timedOut = false;
    let sent = false;
    let closed = false;
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    const fail = (error: unknown): GatewayError => {
      if (error instanceof GatewayError) return error;
      const ambiguous = sent && Boolean(options.chargeable);
      if (timedOut) return new GatewayError('timeout', ambiguous);
      if (controller.signal.aborted)
        return new GatewayError('cancelled', ambiguous);
      return new GatewayError('provider_unavailable', ambiguous);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
    };
    const wait = <T>(promise: Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const interrupted = () => reject(fail(null));
        if (controller.signal.aborted) {
          // Attach a rejection handler even when cancellation won the race.
          void promise.catch(() => {});
          interrupted();
          return;
        }
        controller.signal.addEventListener('abort', interrupted, {
          once: true,
        });
        promise.then(resolve, reject).finally(() => {
          controller.signal.removeEventListener('abort', interrupted);
        });
      });
    try {
      sent = true;
      const response = await wait(
        fetcher(`${apiOrigin}${path}`, {
          method: options.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: options.stream ? 'text/event-stream' : 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.requestId ? { 'x-request-id': options.requestId } : {}),
          },
          body,
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        }).then((response) => {
          if (controller.signal.aborted)
            void response.body?.cancel().catch(() => {});
          return response;
        }),
      );
      if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== `${apiOrigin}${path}`)
      ) {
        void response.body?.cancel().catch(() => {});
        throw httpError(response.status, Boolean(options.chargeable));
      }
      return {
        response,
        signal: controller.signal,
        ambiguous: Boolean(options.chargeable),
        wait,
        fail,
        close,
      };
    } catch (error) {
      const sanitized = fail(error);
      close();
      throw sanitized;
    }
  };
}

async function* bytes(session: GatewaySession, maximum: number) {
  const body = session.response.body;
  if (!body) throw new GatewayError('invalid_response', session.ambiguous);
  const reader = body.getReader();
  let count = 0;
  try {
    const declared = session.response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum))
      throw new GatewayError('response_too_large', session.ambiguous);
    while (true) {
      const next = await session.wait(reader.read());
      if (next.done) return;
      count += next.value.byteLength;
      if (count > maximum)
        throw new GatewayError('response_too_large', session.ambiguous);
      yield next.value;
    }
  } catch (error) {
    throw session.fail(error);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readJson(
  session: GatewaySession,
  maximum = GATEWAY_LIMITS.jsonBytes,
) {
  try {
    if (
      session.response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      throw new GatewayError('invalid_response', session.ambiguous);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    for await (const chunk of bytes(session, maximum))
      text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
    try {
      return parseProviderJson(text);
    } catch {
      throw new GatewayError('invalid_response', session.ambiguous);
    }
  } catch (error) {
    throw session.fail(error);
  } finally {
    session.close();
  }
}

/** Implements SSE line framing, including CR, LF, CRLF, comments, and split UTF-8. */
export async function* readSse(
  session: GatewaySession,
): AsyncGenerator<string> {
  try {
    if (
      session.response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'text/event-stream'
    )
      throw new GatewayError('invalid_response', session.ambiguous);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let line = '';
    let data: string[] = [];
    let eventSize = 0;
    let afterCr = false;
    const finishLine = () => {
      let event: string | null = null;
      if (!line) {
        if (data.length) event = data.join('\n');
        data = [];
        eventSize = 0;
      } else if (line === 'data' || line.startsWith('data:')) {
        let value = line.slice(5);
        if (value.startsWith(' ')) value = value.slice(1);
        data.push(value);
      }
      line = '';
      return event;
    };
    for await (const chunk of bytes(session, GATEWAY_LIMITS.streamBytes)) {
      const text = decoder.decode(chunk, { stream: true });
      for (const character of text) {
        if (afterCr && character === '\n') {
          afterCr = false;
          continue;
        }
        afterCr = false;
        if (character === '\r' || character === '\n') {
          afterCr = character === '\r';
          const event = finishLine();
          if (event !== null) yield event;
        } else {
          line += character;
          const code = character.codePointAt(0)!;
          eventSize +=
            code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
          if (eventSize > GATEWAY_LIMITS.frameBytes)
            throw new GatewayError('response_too_large', session.ambiguous);
        }
      }
    }
    decoder.decode();
    // An unterminated final frame is not dispatched. The caller requires [DONE].
  } catch (error) {
    throw session.fail(error);
  } finally {
    session.close();
  }
}
