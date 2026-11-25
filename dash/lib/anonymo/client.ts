// Typed client for the Anonymo gateway. It works against any `fetch`: the real gateway at NEXT_PUBLIC_ANONYMO_API, or
// the in-browser mock gateway (lib/anonymo/mock) in demo mode, so both paths run the same request and parsing code.
// Paths and shapes follow the gateway routes named in lib/anonymo/types.ts.
//
// The client never logs, stores or forwards prompt or output text. It holds the API key only in memory; persisting
// it on the device is the caller's choice (lib/anonymo/key-store.ts).

import { SPEECH_MODEL, TRANSCRIPTION_MODEL, type SpeechModel, type TranscriptionModel, type VoiceModels } from './talk.ts';
import { FREE_PROOF_HEADER, FREE_REMAINING_HEADER, FREE_TOKEN_HEADER, type FreeChallenge } from './free-chat.ts';
import { readAskMoReply, type AskMoRequest } from './askmo.ts';
import { citationsOf } from './search.ts'; // update "search"
import type { CodeRedemption } from './codes.ts';
import type {
  DepositContracts,
  NymoQuote,
  StatusSlo,
  CapsUpdate,
  KeyCapsInput,
  Runway,
  SpendGroup,
  SpendPeriod,
  SpendReport,
  ImageGeneration,
  ImageRequest,
  MediaModelList,
  MediaSpeechModel,
  SpeechReceipt,
  SpeechRequest,
  SpeechResult,
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
  PhotoChatRequest,
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
import type { VideoJob, VideoModel, VideoRequest } from './video.ts';
import type {
  ArtifactInfo,
  CreateVentureBody,
  CreatedVenture,
  Recipe,
  RecipeBody,
  RunModeBody,
  TierInfo,
  VentureReceipt,
  VentureSnapshot,
  VentureSummary,
} from './ventures.ts';
import { usdToMusd } from './money.ts';
import type { GenerationView } from './connect.ts';
import type { KeySafeIds, KeySafeUpload, WrappedKeySafe } from './key-safe.ts';

/** Every path the dashboard calls, in one place. */
export const API_PATHS = {
  keys: '/keys',
  keySafe: '/v1/key-safe',
  keySafeLookup: '/v1/key-safe/lookup',
  redeemCode: '/v1/codes/redeem',
  keyInfo: '/keys/me',
  balance: '/balance',
  withdraw: '/withdraw',
  withdrawals: '/withdrawals',
  deposits: '/deposits',
  btcpayInvoice: '/deposits/btcpay',
  depositContracts: '/deposits/contracts',
  nymoQuote: '/deposits/coin/quote',
  chat: '/v1/chat/completions',
  freeChallenge: '/v1/free/challenge',
  askMo: '/v1/ask',
  secondOpinion: '/v1/ask/second-opinion',
  models: '/v1/models',
  regionCompliance: '/v1/compliance/region',
  ageProof: '/v1/compliance/age-proof',
  receipt: (id: string) => `/v1/receipts/${encodeURIComponent(id)}`,
  receiptProof: (id: string) => `/v1/receipts/${encodeURIComponent(id)}/proof`,
  characters: '/api/v1/characters',
  lifeboatCard: '/v1/lifeboat/check-card',
  manifest: '/manifest',
  leaderboard: '/leaderboard',
  mediaModels: '/v1/media/models',
  caps: '/keys/caps',
  spend: '/api/v1/spend',
  runway: '/api/v1/account/runway',
  activity: '/api/v1/activity',
  health: '/health',
  statusSlo: '/api/v1/status/slo',
  incidentsRss: '/api/v1/status/incidents.rss',
  incidentsAtom: '/api/v1/status/incidents.atom',
  images: '/v1/images/generations',
  speech: '/v1/audio/speech',
  transcriptions: '/v1/audio/transcriptions',
  videos: '/v1/video/generations',
  video: (id: string) => `/v1/video/generations/${encodeURIComponent(id)}`,
  // Update "ventures" (gateway/src/anonymo/ventures/routes.ts).
  ventures: '/v1/ventures',
  venturesTier: '/v1/ventures/tier',
  venture: (id: string) => `/v1/ventures/${encodeURIComponent(id)}`,
  ventureEvents: (id: string) => `/v1/ventures/${encodeURIComponent(id)}/events`,
  ventureArtifacts: (id: string) => `/v1/ventures/${encodeURIComponent(id)}/artifacts`,
  ventureArtifact: (id: string, sha: string) => `/v1/ventures/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(sha)}`,
  ventureReceipt: (id: string) => `/v1/ventures/${encodeURIComponent(id)}/receipt`,
  ventureExport: (id: string) => `/v1/ventures/${encodeURIComponent(id)}/export`,
  ventureCancel: (id: string) => `/v1/ventures/${encodeURIComponent(id)}/cancel`,
  ventureRunMode: (id: string) => `/v1/ventures/${encodeURIComponent(id)}/run-mode`,
  ventureRecipe: (id: string) => `/v1/ventures/${encodeURIComponent(id)}/recipe`,
  recipes: '/v1/recipes',
  // Update 05: the owner-only generation lookup (gateway/src/api/generation.ts). 404 unless this key made the call.
  generation: (id: string) => `/api/v1/generation?id=${encodeURIComponent(id)}`,
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
    if (error.metadata?.region_page) return error.message;
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
    if (error.code === 'free_daily_limit') return error.message;
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
  declaredRegion?: string | null;
};

export type RegionCompliance = {
  mode: 'allowed' | 'blocked' | 'proof_required';
  disclosure_interval_min: number | null;
  access: boolean;
};

export type AnonymoClient = ReturnType<typeof createAnonymoClient>;

/** A fresh Idempotency-Key for one withdrawal attempt (8–128 of [A-Za-z0-9_.:-]). */
export const newIdempotencyKey = () => `wd-${crypto.randomUUID()}`;

export function createAnonymoClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const key = options.key ?? null;

  async function request(path: string, init: RequestInit & { auth?: boolean; onResponse?: (response: Response) => void } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (options.declaredRegion && /^\/(?:api\/)?v1\//.test(path)) headers.set('x-anonymo-declared-region', options.declaredRegion);
    if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (init.auth !== false) {
      if (!key) throw new AnonymoApiError(401, 'missing_key', 'Create or paste an API key first.');
      headers.set('authorization', `Bearer ${key}`);
    }
    const { auth: _auth, onResponse, ...rest } = init;
    const response = await doFetch(`${base}${path}`, { ...rest, headers, credentials: 'omit', referrerPolicy: 'no-referrer' });
    onResponse?.(response);
    if (!response.ok) throw await toError(response);
    return response;
  }

  async function json<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    return (await (await request(path, init)).json()) as T;
  }
  const data = <T>(path: string, init: RequestInit & { auth?: boolean } = {}) => json<{ data: T }>(path, init).then((r) => r.data);

  async function transcribeWithCost(file: File, signal?: AbortSignal) {
    const body = new FormData();
    body.set('file', file);
    body.set('model', TRANSCRIPTION_MODEL);
    const response = await request(API_PATHS.transcriptions, { method: 'POST', body, signal });
    const { text } = (await response.json()) as { text: string };
    return { text, costUsd: response.headers.get('x-anonymo-cost-usd') };
  }

  return {
    hasKey: key !== null,

    regionCompliance: (signal?: AbortSignal) =>
      json<RegionCompliance>(API_PATHS.regionCompliance, { signal, auth: key !== null, cache: 'no-store', headers: { accept: 'application/json' } }),
    submitAgeProof: (proof: string, signal?: AbortSignal) =>
      json<{ verified: true }>(API_PATHS.ageProof, { method: 'POST', body: JSON.stringify({ proof }), signal }),

    createKey: (body: CreateKeyRequest = {}) =>
      json<CreateKeyResponse>(API_PATHS.keys, { method: 'POST', body: JSON.stringify(body), auth: false }),
    async saveKeySafe({ safeId, credentialId, ciphertext, nonce }: KeySafeUpload, signal?: AbortSignal) {
      await request(API_PATHS.keySafe, { method: 'POST', body: JSON.stringify({ safeId, credentialId, ciphertext, nonce }), auth: false, signal });
    },
    findKeySafe: (credentialId: string, signal?: AbortSignal) =>
      json<WrappedKeySafe>(API_PATHS.keySafeLookup, { method: 'POST', body: JSON.stringify({ credentialId }), auth: false, cache: 'no-store', signal }),
    async deleteKeySafe({ safeId, credentialId }: KeySafeIds, signal?: AbortSignal) {
      await request(API_PATHS.keySafe, { method: 'DELETE', body: JSON.stringify({ safeId, credentialId }), auth: false, signal });
    },
    redeemCode: (code: string) =>
      json<CodeRedemption>(API_PATHS.redeemCode, { method: 'POST', body: JSON.stringify({ code }), auth: key !== null, cache: 'no-store' }),
    keyInfo: () => json<KeyInfo>(API_PATHS.keyInfo),
    balance: (signal?: AbortSignal) => json<Balance>(API_PATHS.balance, { signal }),
    deposits: (signal?: AbortSignal) => json<Deposits>(API_PATHS.deposits, { signal }),
    /** No key: the /pay page in a wallet app's browser reads the contracts from here, never from its link. */
    depositContracts: (signal?: AbortSignal) => json<DepositContracts>(API_PATHS.depositContracts, { signal, auth: false, cache: 'no-store' }),
    nymoQuote: (amountUsd: string, signal?: AbortSignal) =>
      json<NymoQuote>(`${API_PATHS.nymoQuote}?${new URLSearchParams({ amount_usd: amountUsd })}`, { signal, auth: false, cache: 'no-store' }),
    btcpayInvoice: (body: BtcpayInvoiceRequest) =>
      json<BtcpayInvoice>(API_PATHS.btcpayInvoice, { method: 'POST', body: JSON.stringify(body) }),
    /** `idempotencyKey` must be reused when retrying the same withdrawal, so a retry never pays twice. */
    withdraw: (body: WithdrawRequest, idempotencyKey: string) =>
      json<WithdrawResponse>(API_PATHS.withdraw, { method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': idempotencyKey } }),
    withdrawals: () => data<Withdrawal[]>(API_PATHS.withdrawals),

    models: (signal?: AbortSignal) => json<ModelList>(API_PATHS.models, { auth: false, cache: 'no-store', signal }),
    checkLifeboatCard: (fields: string[], signal?: AbortSignal) =>
      json<{ allowed: boolean }>(API_PATHS.lifeboatCard, { method: 'POST', auth: false, cache: 'no-store', body: JSON.stringify({ fields }), signal }),
    receipt: (id: string) => data<ReceiptView>(API_PATHS.receipt(id), { auth: false }),
    receiptProof: (id: string) => data<ProofView>(API_PATHS.receiptProof(id), { auth: false }),
    /** One of this key's own generations, with `origin: "mcp"` when it came through the MCP chat tool (update 05). */
    generation: (id: string, signal?: AbortSignal) => data<GenerationView>(API_PATHS.generation(id), { signal, cache: 'no-store' }),
    manifest: () => json<Manifest>(API_PATHS.manifest, { auth: false, headers: { accept: 'application/json' } }),
    leaderboard: () => json<Leaderboard>(API_PATHS.leaderboard, { auth: false, headers: { accept: 'application/json' } }),

    spend: (period: SpendPeriod, groupBy: SpendGroup, signal?: AbortSignal) =>
      json<{ data: SpendReport }>(`${API_PATHS.spend}?period=${period}&group_by=${groupBy}`, { signal }).then((r) => r.data),
    runway: (signal?: AbortSignal) => json<Runway>(API_PATHS.runway, { signal }),
    /** The key's activity as CSV text (the gateway's own columns), for a download. */
    activityCsv: async () => (await request(`${API_PATHS.activity}?format=csv`)).text(),
    updateCaps: (caps: KeyCapsInput) => json<CapsUpdate>(API_PATHS.caps, { method: 'PATCH', body: JSON.stringify(caps) }),

    /** The public status figures (no key). */
    statusSlo: (signal?: AbortSignal) => data<StatusSlo>(API_PATHS.statusSlo, { auth: false, signal }),
    /** Round trip to the gateway's health check from this browser, in milliseconds. Throws when it is down. */
    async ping(signal?: AbortSignal): Promise<number> {
      const started = performance.now();
      await request(API_PATHS.health, { auth: false, signal, cache: 'no-store' });
      return Math.round(performance.now() - started);
    },
    /** Absolute URL of a gateway path (for links such as the incident feeds). */
    url: (path: string) => `${base}${path}`,

    mediaModels: () => json<MediaModelList>(API_PATHS.mediaModels, { auth: false }),
    /** Images come back as base64 (`b64_json`): nothing is stored on the gateway, and the PNG carries its provenance. */
    generateImages: (body: ImageRequest, signal?: AbortSignal) =>
      json<ImageGeneration>(API_PATHS.images, { method: 'POST', body: JSON.stringify({ ...body, response_format: 'b64_json' }), signal }),

    async voiceModels(signal?: AbortSignal): Promise<VoiceModels> {
      const list = await data<(SpeechModel | TranscriptionModel)[]>(API_PATHS.mediaModels, { auth: false, signal });
      return {
        // Kokoro when the gateway lists it, else the first stock speech model (the demo lists Night Call's).
        speech: list.find((m): m is SpeechModel => m.id === SPEECH_MODEL && m.kind === 'speech')
          ?? list.find((m): m is SpeechModel => m.kind === 'speech' && Array.isArray((m as SpeechModel).voices) && (m as SpeechModel).voices.length > 0),
        transcription: list.find((m): m is TranscriptionModel => m.id === TRANSCRIPTION_MODEL && m.kind === 'transcription'),
      };
    },
    async speak(input: string, voice: string, speed: number, signal?: AbortSignal, model: string = SPEECH_MODEL) {
      const res = await request(API_PATHS.speech, {
        method: 'POST', body: JSON.stringify({ model, input, voice, speed, response_format: 'wav' }), signal,
      });
      return res.arrayBuffer();
    },
    transcribe: async (file: File, signal?: AbortSignal) => ({ text: (await transcribeWithCost(file, signal)).text }),
    transcribeWithCost,
    /** The speech models the gateway lists (`kind: "speech"`): none until a voice worker is configured. */
    async speechModels(signal?: AbortSignal): Promise<MediaSpeechModel[]> {
      const list = await data<(Partial<Omit<MediaSpeechModel, 'kind'>> & { kind: string })[]>(API_PATHS.mediaModels, { auth: false, signal });
      return list.filter((m): m is MediaSpeechModel => m.kind === 'speech' && !!m.id && !!m.name && !!m.pricing?.usd_per_1k_chars && !!m.voices?.length && !!m.max_chars);
    },
    /**
     * `POST /v1/audio/speech`: one of the model's stock voices reads `input` and the reply is a WAV file. The body is
     * built field by field, so nothing but the model, the text, a stock voice id and the pace can ever be sent: there
     * is no way to pass a voice sample through this client. The charge and the signed receipt arrive as headers.
     */
    async speech(body: SpeechRequest, signal?: AbortSignal): Promise<SpeechResult> {
      const payload = { model: String(body.model), input: String(body.input), voice: String(body.voice), speed: Number(body.speed ?? 1), response_format: 'wav' };
      const response = await request(API_PATHS.speech, { method: 'POST', body: JSON.stringify(payload), headers: { accept: 'audio/wav' }, signal });
      const audio = await response.arrayBuffer();
      const charged = response.headers.get('x-anonymo-cost-usd');
      const cost = charged ? Number(charged) : Number.NaN;
      const receipt = mediaReceiptFromHeader(response.headers.get('x-anonymo-receipt'));
      return {
        audio,
        requestId: response.headers.get('x-anonymo-request-id') ?? receipt?.payload.request_id ?? null,
        costUsd: charged,
        costMusd: Number.isFinite(cost) && cost >= 0 ? usdToMusd(cost) : null,
        provenance: response.headers.get('x-anonymo-provenance'),
        receipt,
      };
    },

    async videoModels(signal?: AbortSignal): Promise<VideoModel[]> {
      const list = await data<(Partial<Omit<VideoModel, 'kind'>> & { kind: string })[]>(API_PATHS.mediaModels, { auth: false, signal });
      return list.filter((m): m is VideoModel => m.kind === 'video' && !!m.id && !!m.name && !!m.pricing?.usd_per_second && !!m.seconds && !!m.sizes?.length);
    },
    generateVideo: (body: VideoRequest, signal?: AbortSignal) =>
      json<VideoJob>(API_PATHS.videos, { method: 'POST', body: JSON.stringify(body), signal }),
    videoStatus: (id: string, signal?: AbortSignal) => json<VideoJob>(API_PATHS.video(id), { signal, cache: 'no-store' }),
    videoMediaUrl: (url: string) => url.startsWith('/v1/media/') ? `${base}${url}` : url,

    // Update "ventures": the crew's runs. Every call but the Recipe list carries the key.
    ventureTier: (signal?: AbortSignal) => data<TierInfo>(API_PATHS.venturesTier, { signal }),
    ventures: (signal?: AbortSignal) => data<VentureSummary[]>(API_PATHS.ventures, { signal, cache: 'no-store' }),
    startVenture: (body: CreateVentureBody) => data<CreatedVenture>(API_PATHS.ventures, { method: 'POST', body: JSON.stringify(body) }),
    venture: (id: string, signal?: AbortSignal) => data<VentureSnapshot>(API_PATHS.venture(id), { signal, cache: 'no-store' }),
    /** The run's events as an SSE stream. `after` is the last event id seen, sent as Last-Event-ID to resume. */
    async ventureEvents(id: string, after: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
      const headers: Record<string, string> = { accept: 'text/event-stream' };
      if (after > 0) headers['last-event-id'] = String(after);
      const response = await request(API_PATHS.ventureEvents(id), { headers, signal, cache: 'no-store' });
      if (!response.body) throw new AnonymoApiError(502, 'no_stream', 'The gateway sent no event stream.');
      return response.body;
    },
    ventureArtifacts: (id: string, signal?: AbortSignal) => data<ArtifactInfo[]>(API_PATHS.ventureArtifacts(id), { signal, cache: 'no-store' }),
    /** A CLEAN artifact's body as text (HTML pages and JSON reports). SCOUT ones answer 403 by design. */
    ventureArtifact: async (id: string, sha: string, signal?: AbortSignal) => (await request(API_PATHS.ventureArtifact(id, sha), { signal })).text(),
    ventureReceipt: (id: string, signal?: AbortSignal) => data<VentureReceipt>(API_PATHS.ventureReceipt(id), { signal }),
    /** The run's repo as a .tar.gz. */
    ventureExport: async (id: string) => (await request(API_PATHS.ventureExport(id))).blob(),
    cancelVenture: (id: string) => data<{ id: string; cancelling: boolean }>(API_PATHS.ventureCancel(id), { method: 'POST', body: '{}' }),
    startRunMode: (id: string, body: RunModeBody) =>
      data<{ id: string; tasks: string[]; available_tasks: string[] }>(API_PATHS.ventureRunMode(id), { method: 'POST', body: JSON.stringify(body) }),
    /** Turns Run Mode off. `id` is the Run Mode venture (the one POST …/run-mode returned). */
    stopRunMode: (id: string) => data<{ id: string; enabled: false }>(API_PATHS.ventureRunMode(id), { method: 'DELETE' }),
    saveRecipe: (id: string, body: RecipeBody) => data<{ id: string; recipeHash: string }>(API_PATHS.ventureRecipe(id), { method: 'POST', body: JSON.stringify(body) }),
    recipes: (signal?: AbortSignal) => data<Recipe[]>(API_PATHS.recipes, { auth: false, signal }),

    askMo: (body: AskMoRequest, signal?: AbortSignal) =>
      json<ChatCompletion>(API_PATHS.askMo, { method: 'POST', body: JSON.stringify(body), signal }).then(readAskMoReply),
    secondOpinion: (body: AskMoRequest, signal?: AbortSignal) =>
      json<ChatCompletion>(API_PATHS.secondOpinion, { method: 'POST', body: JSON.stringify(body), signal }).then(readAskMoReply),

    importCharacter: (body: CharacterImportRequest) =>
      json<CharacterImportResponse>(API_PATHS.characters, { method: 'POST', body: JSON.stringify(body) }),

    freeChallenge: (token: string, signal?: AbortSignal) => json<FreeChallenge>(API_PATHS.freeChallenge, {
      auth: false, headers: { [FREE_TOKEN_HEADER]: token }, cache: 'no-store', signal,
    }),

    /**
     * `/v1/chat/completions`. Streams (SSE) for every model except anonymo-council, which answers as one JSON body.
     * `onDelta` receives text as it arrives; the result carries the Anonymo receipt and its id.
     */
    async chat(
      body: ChatRequest | PhotoChatRequest,
      opts: {
        headers?: ChatHeaders;
        signal?: AbortSignal;
        onDelta?: (text: string) => void;
        free?: { token: string; proof: string; onRemaining: (left: number) => void };
      } = {},
    ): Promise<ChatResult> {
      const headers: Record<string, string> = {};
      if (opts.headers?.refusalCatch) headers['x-anonymo-refusal-catch'] = opts.headers.refusalCatch;
      if (opts.headers?.sealed || body.model === 'anonymo-sealed') headers['x-anonymo-sealed'] = 'required';
      if (opts.free) {
        headers[FREE_TOKEN_HEADER] = opts.free.token;
        headers[FREE_PROOF_HEADER] = opts.free.proof;
      }
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
        ...(opts.free ? {
          auth: false,
          onResponse: (response: Response) => {
            const remaining = response.headers.get(FREE_REMAINING_HEADER);
            if (remaining !== null && /^\d+$/.test(remaining)) opts.free?.onRemaining(Number(remaining));
          },
        } : {}),
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
        autoClass: response.headers.get('x-anonymo-auto'), // update "auto"
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
        const cited = citationsOf(choice?.message?.annotations);
        if (cited.length) result.citations = cited;
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
        // Update "auto": every chunk names the model that answered, not anonymo-auto.
        if (body.model === 'anonymo-auto' && typeof chunk.model === 'string' && chunk.model) result.model = chunk.model;
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content;
        if (text) {
          result.content += text;
          opts.onDelta?.(text);
        }
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
        if (choice?.delta?.annotations) result.citations = citationsOf(choice.delta.annotations, result.citations); // update "search"
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

/** The signed receipt inside a media reply's `x-anonymo-receipt` header (base64url of `{payload, key_id, sig}`), or null. */
export function mediaReceiptFromHeader(header: string | null): SpeechReceipt | null {
  if (!header) return null;
  try {
    const bin = atob(header.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(header.length / 4) * 4, '='));
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Partial<SpeechReceipt> | null;
    return parsed && typeof parsed.payload?.request_id === 'string' ? { payload: parsed.payload, key_id: parsed.key_id ?? null, sig: parsed.sig ?? null } : null;
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
