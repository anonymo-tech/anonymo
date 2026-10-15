import { getAccountSession } from './service.ts';

export class SecondLookError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'SecondLookError';
  }
}

export type SecondLookOptions = {
  accountId: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Trusted caller may shorten, never extend, the complete request deadline. */
  timeoutMs?: number;
};

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const SECOND_LOOK_REQUEST_TIMEOUT_MS = 60_000;
const knownErrors: Record<string, string> = {
  PLANNING_REVISION_CONFLICT: 'Your planning settings changed in another view. Refresh, then review your changes before saving again.',
  EXIT_PLAN_EXISTS: 'A plan already exists for this wallet and token. Remove it before saving a replacement.',
  EXIT_PLAN_LIMIT: 'You can save up to 25 reminder plans. Remove one before adding another.',
  INVALID_BUDGET: 'Enter a positive daily budget with up to six decimal places and a valid timezone.',
  INVALID_EXIT_PLAN: 'Check the mint, target and stop prices, and position percentages.',
  TOKEN_CHECK_UNAVAILABLE:
    'Live Token Check is not connected yet. Saved reports remain available.',
  TOKEN_DEEP_UNAVAILABLE:
    'Deep Check needs fresh launch and claim evidence for this token. Try a standard check.',
  ACTION_NOT_REVIEWED:
    'This Action endpoint has not been reviewed. Inspect its website address or transaction bytes instead.',
  ACTION_SELECTION_REQUIRED:
    'This Action has multiple choices. Enter the exact linked action URL to inspect.',
  RPC_UNAVAILABLE:
    'Transaction simulation is not connected yet. Website, message and app checks are still available.',
  WALLET_INGEST_UNAVAILABLE:
    'Wallet history sync is not connected yet. Your saved wallet links remain available.',
  SENSITIVE_INPUT:
    'Remove private keys, recovery phrases and credentials before inspection.',
};

export async function secondLookRequest<T>(
  path: string,
  options: SecondLookOptions & {
    body?: unknown;
    cursor?: string;
    method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
    validate: (value: unknown) => value is T;
  },
): Promise<T> {
  if (!/^second-look\/[a-z0-9/-]+$/.test(path) || path.includes('..'))
    throw new SecondLookError('INVALID_PATH', 'This request is not supported.');
  if (options.cursor && !/^[A-Za-z0-9_=.-]{1,2048}$/.test(options.cursor))
    throw new SecondLookError(
      'INVALID_CURSOR',
      'The report cursor is invalid.',
    );
  const timeoutMs = options.timeoutMs ?? SECOND_LOOK_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > SECOND_LOOK_REQUEST_TIMEOUT_MS
  )
    throw new SecondLookError(
      'INVALID_TIMEOUT',
      'The request deadline is invalid.',
    );
  const controller = new AbortController();
  let timedOut = false;
  const abortError = () =>
    timedOut
      ? new SecondLookError(
          'REQUEST_TIMEOUT',
          'This request timed out. Its outcome may be unknown. Refresh saved status before trying again.',
        )
      : new DOMException('The request was cancelled.', 'AbortError');
  const assertActive = () => {
    if (controller.signal.aborted) throw abortError();
  };
  const abort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const disposals = new Set<() => void>();
  // Racing every read makes the deadline work even with a custom transport that
  // ignores AbortSignal. A late response is cancelled instead of being consumed.
  const wait = <R>(promise: Promise<R>) =>
    new Promise<R>((resolve, reject) => {
      const cancelled = () => reject(abortError());
      if (controller.signal.aborted) {
        void promise.catch(() => {});
        cancelled();
        return;
      }
      controller.signal.addEventListener('abort', cancelled, { once: true });
      void promise
        .then(resolve, reject)
        .finally(() =>
          controller.signal.removeEventListener('abort', cancelled),
        );
    });
  const transport = options.fetch ?? globalThis.fetch;
  const fetcher: typeof fetch = async (input, init) => {
    assertActive();
    const response = await wait(
      transport(input, { ...init, signal: controller.signal }).then((value) => {
        if (controller.signal.aborted)
          void value.body?.cancel().catch(() => {});
        return value;
      }),
    );
    assertActive();
    if (!response.body) return response;
    const upstream = response.body.getReader();
    let closed = false;
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const dispose = () => {
      if (closed) return;
      closed = true;
      disposals.delete(dispose);
      controller.signal.removeEventListener('abort', cancelStream);
      void upstream.cancel().catch(() => {});
      try {
        upstream.releaseLock();
      } catch {
        /* A custom stream may retain a pending read. */
      }
    };
    const cancelStream = () => {
      if (closed) return;
      streamController?.error(abortError());
      dispose();
    };
    disposals.add(dispose);
    const body = new ReadableStream<Uint8Array>(
      {
        start(stream) {
          streamController = stream;
          controller.signal.addEventListener('abort', cancelStream, {
            once: true,
          });
          if (controller.signal.aborted) cancelStream();
        },
        async pull(stream) {
          try {
            assertActive();
            const part = await wait(upstream.read());
            assertActive();
            if (closed) return;
            if (part.done) {
              stream.close();
              dispose();
            } else stream.enqueue(part.value);
          } catch (error) {
            if (!closed) {
              stream.error(error);
              dispose();
            }
          }
        },
        cancel() {
          dispose();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const checkOwner = async () => {
    assertActive();
    const session = await wait(
      getAccountSession({ signal: controller.signal, fetch: fetcher }),
    );
    assertActive();
    if (!session || session.accountId !== options.accountId)
      throw new SecondLookError(
        'SESSION_CHANGED',
        'Your account changed. Sign in again before continuing.',
        401,
      );
  };
  try {
    await checkOwner();
    let response: Response;
    try {
      response = await fetcher(
        `/api/${path}${options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ''}`,
        {
          method:
            options.method ?? (options.body === undefined ? 'GET' : 'POST'),
          credentials: 'same-origin',
          mode: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'X-Conclave-Account-Id': options.accountId,
            ...(options.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        },
      );
    } catch (error) {
      assertActive();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new SecondLookError(
        'NETWORK_ERROR',
        'The check could not reach the service. Its outcome may be unknown. Refresh saved status before trying again.',
      );
    }
    if (
      response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      throw new SecondLookError(
        'INVALID_RESPONSE',
        'The service returned an unreadable response.',
      );
    const reader = response.body?.getReader();
    if (!reader)
      throw new SecondLookError('INVALID_RESPONSE', 'The response was empty.');
    let size = 0,
      text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (true) {
        const part = await wait(reader.read());
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1_048_576)
          throw new SecondLookError(
            'INVALID_RESPONSE',
            'The response was too large.',
          );
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SecondLookError(
        'INVALID_RESPONSE',
        'The service returned an unreadable response.',
      );
    }
    if (!response.ok) {
      const error = object(value) && object(value.error) ? value.error : null;
      const code =
        typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
          ? error.code
          : 'REQUEST_FAILED';
      const message =
        response.status === 401
          ? 'Sign in to run this check.'
          : (knownErrors[code] ??
            (response.status === 402
              ? 'Your usage balance is too low for this check.'
              : response.status === 429
                ? 'You’ve reached the request limit. Try again shortly.'
                : response.status >= 500
                  ? 'The service could not finish this request. Its outcome may be unknown. Refresh saved status before starting another check.'
                  : response.status === 409
                    ? 'This request changed or expired. Review it again.'
                    : response.status === 404
                      ? 'This record is no longer available.'
                      : response.status === 400
                        ? 'Check the address or request format and try again.'
                        : 'The request could not be completed. Please try again.'));
      throw new SecondLookError(code, message, response.status);
    }
    await checkOwner();
    assertActive();
    if (!options.validate(value))
      throw new SecondLookError(
        'INVALID_RESPONSE',
        'The service response could not be verified.',
      );
    return value;
  } catch (error) {
    assertActive();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    for (const dispose of disposals) dispose();
  }
}

export function secondLookError(error: unknown) {
  return error instanceof SecondLookError
    ? error.message
    : 'The request could not be completed. Try again.';
}

/** Exact integer formatting; large token and USD values are never coerced to Number. */
export function decimalAmount(value: string, decimals: number, places = 2) {
  if (
    !/^-?\d+$/.test(value) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  )
    return '—';
  const negative = value.startsWith('-');
  const absolute = BigInt(negative ? value.slice(1) : value);
  const scale = 10n ** BigInt(decimals);
  const whole = (absolute / scale)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (absolute % scale)
    .toString()
    .padStart(decimals, '0')
    .slice(0, places)
    .padEnd(places, '0');
  return `${negative && absolute ? '−' : ''}${whole}${places ? `.${fraction}` : ''}`;
}
export const usd6 = (value: string | null | undefined) =>
  value == null
    ? '—'
    : `${value.startsWith('-') ? '−' : ''}$${decimalAmount(value.replace(/^-/, ''), 6)}`;
export const shortAddress = (value: string) =>
  value.length > 14 ? `${value.slice(0, 5)}…${value.slice(-5)}` : value;
