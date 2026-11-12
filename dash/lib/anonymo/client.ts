// Typed client for the Anonymo gateway (Backend §11). It works against any `fetch`: the real gateway at
// NEXT_PUBLIC_ANONYMO_API, or the in-browser mock gateway (lib/anonymo/mock) in demo mode, so both paths run the
// same request and parsing code.
//
// The client never logs, stores or forwards prompt or output text. It holds the API key only in memory; persisting
// it on the device is the caller's choice (lib/anonymo/key-store.ts).

import type {
  ApiErrorBody,
  Balance,
  CharacterImportRequest,
  CharacterImportResponse,
  ChatChunk,
  ChatHeaders,
  ChatRequest,
  ChatResult,
  CouncilResult,
  CreateKeyRequest,
  CreateKeyResponse,
  DepositAddress,
  InclusionProof,
  Leaderboard,
  LightningInvoice,
  LightningInvoiceRequest,
  Manifest,
  ModelList,
  SignedReceipt,
  Withdrawal,
  WithdrawRequest,
} from './types.ts';

/** Every path the dashboard calls, in one place so it can follow the gateway as WS05/WS09 settle. */
export const API_PATHS = {
  keys: '/keys',
  balance: '/balance',
  withdraw: '/withdraw',
  depositAddresses: '/deposit-addresses',
  lightningInvoice: '/deposits/lightning',
  chat: '/v1/chat/completions',
  models: '/v1/models',
  receipt: (id: string) => `/v1/receipts/${encodeURIComponent(id)}`,
  receiptProof: (id: string) => `/v1/receipts/${encodeURIComponent(id)}/proof`,
  characters: '/v1/characters',
  manifest: '/manifest',
  leaderboard: '/leaderboard',
} as const;

export class AnonymoApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly category: string | null;
  constructor(status: number, code: string | null, message: string, category: string | null = null) {
    super(message);
    this.name = 'AnonymoApiError';
    this.status = status;
    this.code = code;
    this.category = category;
  }
}

/** Plain-language text for the errors a person can act on. Never echoes the prompt. */
export function describeError(error: unknown): string {
  if (error instanceof AnonymoApiError) {
    if (error.status === 451 || error.code === 'floor_blocked')
      return 'Blocked by the floor check. This request falls under one of the four lines Anonymo never serves, so it was not sent to any model and you were not charged.';
    if (error.status === 409 || error.code === 'sealed_unavailable')
      return 'No hardware-attested route is up right now. anonymo-sealed fails instead of downgrading, so nothing was sent and you were not charged. Try again shortly or pick another model.';
    if (error.status === 402 || error.code === 'insufficient_balance')
      return 'Not enough credit for this request. Add funds and try again.';
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

  return {
    hasKey: key !== null,

    createKey: (body: CreateKeyRequest = {}) =>
      json<CreateKeyResponse>(API_PATHS.keys, { method: 'POST', body: JSON.stringify(body), auth: false }),
    balance: (signal?: AbortSignal) => json<Balance>(API_PATHS.balance, { signal }),
    depositAddresses: () =>
      json<{ data: DepositAddress[] }>(API_PATHS.depositAddresses).then((r) => r.data),
    lightningInvoice: (body: LightningInvoiceRequest) =>
      json<LightningInvoice>(API_PATHS.lightningInvoice, { method: 'POST', body: JSON.stringify(body) }),
    withdraw: (body: WithdrawRequest) =>
      json<Withdrawal>(API_PATHS.withdraw, { method: 'POST', body: JSON.stringify(body) }),

    models: () => json<ModelList>(API_PATHS.models, { auth: false }),
    receipt: (id: string) => json<SignedReceipt>(API_PATHS.receipt(id), { auth: false }),
    receiptProof: (id: string) => json<InclusionProof>(API_PATHS.receiptProof(id), { auth: false }),
    manifest: () => json<Manifest>(API_PATHS.manifest, { auth: false }),
    leaderboard: () => json<Leaderboard>(API_PATHS.leaderboard, { auth: false }),

    importCharacter: (body: CharacterImportRequest) =>
      json<CharacterImportResponse>(API_PATHS.characters, { method: 'POST', body: JSON.stringify(body) }),

    /** Streams `/v1/chat/completions`. `onDelta` receives text as it arrives; the result carries the receipt id. */
    async chat(
      body: ChatRequest,
      opts: { headers?: ChatHeaders; signal?: AbortSignal; onDelta?: (text: string) => void } = {},
    ): Promise<ChatResult> {
      const headers: Record<string, string> = {};
      if (opts.headers?.refusalCatch) headers['x-anonymo-refusal-catch'] = opts.headers.refusalCatch;
      if (opts.headers?.councilMode) headers['x-anonymo-council-mode'] = opts.headers.councilMode;
      if (opts.headers?.sealed || body.model === 'anonymo-sealed') headers['x-anonymo-sealed'] = 'required';
      const response = await request(API_PATHS.chat, {
        method: 'POST',
        body: JSON.stringify({ ...body, stream: true }),
        headers: { ...headers, accept: 'text/event-stream' },
        signal: opts.signal,
      });
      const result: ChatResult = {
        content: '',
        model: body.model,
        receiptId: response.headers.get('x-anonymo-receipt'),
        councilMode: response.headers.get('x-anonymo-council-mode'),
        council: null,
        finishReason: null,
      };
      if (!response.body) return result;
      for await (const chunk of readChatStream(response.body, opts.signal)) {
        const choice = chunk.choices[0];
        const text = choice?.delta.content;
        if (text) {
          result.content += text;
          opts.onDelta?.(text);
        }
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
        if (chunk.model) result.model = chunk.model;
        if (chunk.anonymo_council) result.council = chunk.anonymo_council as CouncilResult;
      }
      return result;
    },
  };
}

async function toError(response: Response): Promise<AnonymoApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  const error = body?.error;
  return new AnonymoApiError(
    response.status,
    error?.code ?? null,
    typeof error?.message === 'string' ? error.message.slice(0, 500) : `The gateway answered ${response.status}.`,
    error?.metadata?.category ?? null,
  );
}

/** Parses an OpenAI-style SSE stream (`data: {…}` lines, `data: [DONE]` at the end). */
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
        if (parsed.error) throw new AnonymoApiError(500, parsed.error.code ?? null, parsed.error.message ?? 'Stream error.');
        yield parsed;
      }
    }
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
