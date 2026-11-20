// Typed client for the Anonymo gateway. It works against any `fetch`: the real gateway at NEXT_PUBLIC_ANONYMO_API, or
// the in-browser mock gateway (lib/anonymo/mock) in demo mode, so both paths run the same request and parsing code.
// Paths and shapes follow the gateway routes named in lib/anonymo/types.ts.
//
// The client never logs, stores or forwards prompt or output text. It holds the API key only in memory; persisting
// it on the device is the caller's choice (lib/anonymo/key-store.ts).

import type {
  CapsUpdate,
  KeyCapsInput,
  Runway,
  SpendGroup,
  SpendPeriod,
  SpendReport,
  ImageGeneration,
  ImageRequest,
  MediaModelList,
  ApiErrorBody,
  Balance,
  BtcpayInvoice,
  BtcpayInvoiceRequest,
  CharacterImportRequest,
  CharacterImportResponse,
  ChatChunk,
  ChatCompletion,
  ChatHeaders,
  ChatRequest,
  ChatResult,
  CreateKeyRequest,
  CreateKeyResponse,
  Deposits,
  KeyInfo,
  Leaderboard,
  Manifest,
  ModelList,
  ProofView,
  ReceiptView,
  WithdrawRequest,
  WithdrawResponse,
  Withdrawal,
} from './types.ts';

/** Every path the dashboard calls, in one place. */
export const API_PATHS = {
  keys: '/keys',
  keyInfo: '/keys/me',
  balance: '/balance',
  withdraw: '/withdraw',
  withdrawals: '/withdrawals',
  deposits: '/deposits',
  btcpayInvoice: '/deposits/btcpay',
  chat: '/v1/chat/completions',
  models: '/v1/models',
  receipt: (id: string) => `/v1/receipts/${encodeURIComponent(id)}`,
  receiptProof: (id: string) => `/v1/receipts/${encodeURIComponent(id)}/proof`,
  characters: '/api/v1/characters',
  manifest: '/manifest',
  leaderboard: '/leaderboard',
  mediaModels: '/v1/media/models',
  caps: '/keys/caps',
  spend: '/api/v1/spend',
  runway: '/api/v1/account/runway',
  activity: '/api/v1/activity',
  images: '/v1/images/generations',
} as const;

/** `anonymo-council` answers as one JSON body; the gateway refuses `stream: true` for it. */
export const NON_STREAMING_MODELS: readonly string[] = ['anonymo-council'];

export class AnonymoApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly category: string | null;
  readonly metadata: Record<string, unknown> | null;
  constructor(status: number, code: string | null, message: string, category: string | null = null, metadata: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'AnonymoApiError';
    this.status = status;
    this.code = code;
    this.category = category;
    this.metadata = metadata;
  }
}

const OUT_OF_CREDIT = new Set(['insufficient_credits', 'insufficient_credit', 'insufficient_balance', 'payment_required']);

/** The key has too little credit for the request (402 from the ledger), so the fix is adding funds. */
export function isOutOfCredit(error: unknown): boolean {
  return error instanceof AnonymoApiError && error.status === 402 && (error.code === null || OUT_OF_CREDIT.has(error.code));
}

/** Plain-language text for the errors a person can act on. Never echoes the prompt. */
export function describeError(error: unknown): string {
  if (error instanceof AnonymoApiError) {
    if (error.status === 451 || error.code === 'floor_blocked')
      return error.metadata?.stage === 'reply'
        ? "Blocked by the floor check. The model's reply crossed one of the four lines Anonymo never serves, so it was withheld and you were not charged."
        : 'Blocked by the floor check. This request falls under one of the four lines Anonymo never serves, so it was not sent to any model and you were not charged.';
    if (error.code === 'floor_unavailable') return 'The safety check could not run, so nothing was served and you were not charged. Try again in a moment.';
    if (error.code === 'sealed_unavailable')
      return 'No hardware-attested route is up right now. anonymo-sealed fails instead of downgrading, so nothing was sent and you were not charged. Try again shortly or pick another model.';
    if (error.code === 'model_not_found')
      return 'That model is not live yet, so nothing was sent and you were not charged. Pick anonymo-1 instead.';
    if (isOutOfCredit(error)) return 'Not enough credit for this request. Add funds and try again.';
    if (error.code === 'deposits_paused') return 'New deposits are paused right now. Withdrawals are not affected.';
    if (error.status === 401) return 'This key was not accepted. Check it, or create a new key.';
    if (error.status === 429) return 'Too many requests for this key right now. Wait a moment and try again.';
    return error.message || `The gateway answered ${error.status}.`;
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'Stopped.';
  if (error instanceof TypeError) return 'The gateway could not be reached.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export type ClientOptions = {
  baseUrl: string;
  key?: string | null;
  fetch?: typeof fetch;
};

export type AnonymoClient = ReturnType<typeof createAnonymoClient>;

/** A fresh Idempotency-Key for one withdrawal attempt (8–128 of [A-Za-z0-9_.:-]). */
export const newIdempotencyKey = () => `wd-${crypto.randomUUID()}`;

export function createAnonymoClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const key = options.key ?? null;

  async function request(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (init.auth !== false) {
      if (!key) throw new AnonymoApiError(401, 'missing_key', 'Create or paste an API key first.');
      headers.set('authorization', `Bearer ${key}`);
    }
    const { auth: _auth, ...rest } = init;
    const response = await doFetch(`${base}${path}`, { ...rest, headers, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw await toError(response);
    return response;
  }

  async function json<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    return (await (await request(path, init)).json()) as T;
  }
  const data = <T>(path: string, init: RequestInit & { auth?: boolean } = {}) => json<{ data: T }>(path, init).then((r) => r.data);

  return {
    hasKey: key !== null,

    createKey: (body: CreateKeyRequest = {}) =>
      json<CreateKeyResponse>(API_PATHS.keys, { method: 'POST', body: JSON.stringify(body), auth: false }),
    keyInfo: () => json<KeyInfo>(API_PATHS.keyInfo),
    balance: (signal?: AbortSignal) => json<Balance>(API_PATHS.balance, { signal }),
    deposits: (signal?: AbortSignal) => json<Deposits>(API_PATHS.deposits, { signal }),
    btcpayInvoice: (body: BtcpayInvoiceRequest) =>
      json<BtcpayInvoice>(API_PATHS.btcpayInvoice, { method: 'POST', body: JSON.stringify(body) }),
    /** `idempotencyKey` must be reused when retrying the same withdrawal, so a retry never pays twice. */
    withdraw: (body: WithdrawRequest, idempotencyKey: string) =>
      json<WithdrawResponse>(API_PATHS.withdraw, { method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': idempotencyKey } }),
    withdrawals: () => data<Withdrawal[]>(API_PATHS.withdrawals),

    models: () => json<ModelList>(API_PATHS.models, { auth: false }),
    receipt: (id: string) => data<ReceiptView>(API_PATHS.receipt(id), { auth: false }),
    receiptProof: (id: string) => data<ProofView>(API_PATHS.receiptProof(id), { auth: false }),
    manifest: () => json<Manifest>(API_PATHS.manifest, { auth: false, headers: { accept: 'application/json' } }),
    leaderboard: () => json<Leaderboard>(API_PATHS.leaderboard, { auth: false, headers: { accept: 'application/json' } }),

    spend: (period: SpendPeriod, groupBy: SpendGroup, signal?: AbortSignal) =>
      json<{ data: SpendReport }>(`${API_PATHS.spend}?period=${period}&group_by=${groupBy}`, { signal }).then((r) => r.data),
    runway: (signal?: AbortSignal) => json<Runway>(API_PATHS.runway, { signal }),
    /** The key's activity as CSV text (the gateway's own columns), for a download. */
    activityCsv: async () => (await request(`${API_PATHS.activity}?format=csv`)).text(),
    updateCaps: (caps: KeyCapsInput) => json<CapsUpdate>(API_PATHS.caps, { method: 'PATCH', body: JSON.stringify(caps) }),

    mediaModels: () => json<MediaModelList>(API_PATHS.mediaModels, { auth: false }),
    /** Images come back as base64 (`b64_json`): nothing is stored on the gateway, and the PNG carries its provenance. */
    generateImages: (body: ImageRequest, signal?: AbortSignal) =>
      json<ImageGeneration>(API_PATHS.images, { method: 'POST', body: JSON.stringify({ ...body, response_format: 'b64_json' }), signal }),

    importCharacter: (body: CharacterImportRequest) =>
      json<CharacterImportResponse>(API_PATHS.characters, { method: 'POST', body: JSON.stringify(body) }),

    /**
     * `/v1/chat/completions`. Streams (SSE) for every model except anonymo-council, which answers as one JSON body.
     * `onDelta` receives text as it arrives; the result carries the Anonymo receipt and its id.
     */
    async chat(
      body: ChatRequest,
      opts: { headers?: ChatHeaders; signal?: AbortSignal; onDelta?: (text: string) => void } = {},
    ): Promise<ChatResult> {
      const headers: Record<string, string> = {};
      if (opts.headers?.refusalCatch) headers['x-anonymo-refusal-catch'] = opts.headers.refusalCatch;
      if (opts.headers?.sealed || body.model === 'anonymo-sealed') headers['x-anonymo-sealed'] = 'required';
      const streaming = !NON_STREAMING_MODELS.includes(body.model);
      // The council mode goes in the body (`council.mode`): the gateway reads it there too, and the header form is not
      // on its CORS allow-list, so a browser could not send it.
      const payload = {
        ...body,
        stream: streaming,
        ...(body.model === 'anonymo-council' && opts.headers?.councilMode ? { council: { mode: opts.headers.councilMode } } : {}),
      };
      const response = await request(API_PATHS.chat, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { ...headers, accept: streaming ? 'text/event-stream' : 'application/json' },
        signal: opts.signal,
      });
      const result: ChatResult = {
        content: '',
        model: body.model,
        receiptId: null,
        receipt: null,
        councilMode: response.headers.get('x-anonymo-council-mode'),
        council: null,
        finishReason: null,
      };
      if (!streaming) {
        const done = (await response.json()) as ChatCompletion;
        const choice = done.choices?.[0];
        result.content = choice?.message?.content ?? '';
        if (result.content) opts.onDelta?.(result.content);
        result.finishReason = choice?.finish_reason ?? null;
        result.model = done.model ?? body.model;
        result.council = done.council ?? null;
        result.councilMode ??= done.council?.mode ?? null;
        result.receipt = done.anonymo_receipt?.payload ?? null;
        result.receiptId = result.receipt?.request_id ?? receiptIdFromHeader(response.headers.get('x-anonymo-receipt')) ?? done.id ?? null;
        return result;
      }
      // The stream's id is the request id; the final event carries the signed receipt (headers are sent before it exists).
      let streamId: string | null = null;
      if (!response.body) return result;
      for await (const chunk of readChatStream(response.body, opts.signal)) {
        // Headers went out before the reply existed, so a failure after that (a reply the floor withheld, a provider
        // that fell over) arrives as an error event inside the stream.
        if (chunk.error) throw errorFromBody(typeof chunk.error.code === 'number' ? chunk.error.code : 502, { error: chunk.error });
        streamId ??= chunk.id ?? null;
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content;
        if (text) {
          result.content += text;
          opts.onDelta?.(text);
        }
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
        if (chunk.anonymo_receipt?.payload) result.receipt = chunk.anonymo_receipt.payload;
      }
      result.receiptId = result.receipt?.request_id ?? receiptIdFromHeader(response.headers.get('x-anonymo-receipt')) ?? streamId;
      return result;
    },
  };
}

/** The request id inside an `x-anonymo-receipt` header (`<base64url(receipt)>.<base64url(sig)>.<key id>`), or null. */
export function receiptIdFromHeader(header: string | null): string | null {
  const part = header?.split('.')[0];
  if (!part) return null;
  try {
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as { request_id?: unknown };
    return typeof parsed.request_id === 'string' ? parsed.request_id : null;
  } catch {
    return null;
  }
}

async function toError(response: Response): Promise<AnonymoApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  return errorFromBody(response.status, body);
}

function errorFromBody(status: number, body: Partial<ApiErrorBody> | null): AnonymoApiError {
  const error = body?.error;
  // The gateway puts the machine code in `type` and the HTTP status in `code`; older shapes put the code in `code`.
  const code = typeof error?.type === 'string' ? error.type : typeof error?.code === 'string' ? error.code : null;
  const category = typeof error?.metadata?.category === 'string' ? error.metadata.category : null;
  return new AnonymoApiError(
    status,
    code,
    typeof error?.message === 'string' ? error.message.slice(0, 500) : `The gateway answered ${status}.`,
    category,
    error?.metadata ?? null,
  );
}

/** Parses an OpenAI-style SSE stream (`data: {…}` lines, `: comment` lines, `data: [DONE]` at the end). */
export async function* readChatStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return;
        const parsed = JSON.parse(data) as ChatChunk & Partial<ApiErrorBody>;
        if (parsed.error) {
          const status = typeof parsed.error.code === 'number' ? parsed.error.code : 502;
          throw errorFromBody(status, parsed as Partial<ApiErrorBody>);
        }
        yield parsed;
      }
    }
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
