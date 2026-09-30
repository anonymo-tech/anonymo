// SPDX-License-Identifier: Apache-2.0
// Anonymo for LangChain.js. Anonymo speaks the OpenAI chat and embeddings API, so these are LangChain's own
// OpenAI classes with Anonymo's defaults: the router URL, the key from ANONYMO_API_KEY, the lane and disclosure
// ceiling as options, and the signed receipt of every chat call surfaced as `response_metadata.anonymo`.
//
// How the receipt gets there: a small `fetch` wrapper (installed as the OpenAI client's fetch) records the
// receipt headers and the `receipt` field of each response into a per-call store. `_generate` and
// `_streamResponseChunks` open that store with AsyncLocalStorage, so concurrent calls never see each other's
// receipt, and copy it onto the returned message.
import { AsyncLocalStorage } from "node:async_hooks";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import {
  ChatOpenAI,
  type ChatOpenAICallOptions,
  type ChatOpenAIFields,
  type ClientOptions,
  OpenAIEmbeddings,
  type OpenAIEmbeddingsParams,
} from "@langchain/openai";

/** The public Anonymo router. Point `baseURL` (or ANONYMO_BASE_URL) elsewhere to use a self-hosted router. */
export const ANONYMO_BASE_URL = "https://api-production-70da.up.railway.app/api/v1";

/**
 * Where a call may run. "public": any provider. "attested": only providers whose enclave the router has
 * verified; the router refuses (sending nothing, charging nothing) when none can answer. "unlinkable": served only
 * through an independent relay or the onion service and paid with a blind token, never with a key, so a call made
 * with an API key on this lane is refused.
 */
export type AnonymoLane = "public" | "attested" | "unlinkable";

/** The most the provider may learn about who sent a call: "any", "policy" (a published policy) or "none". */
export type AnonymoDisclosure = "any" | "policy" | "none";

/** Routing preferences sent as the `provider` object of the request body. */
export interface AnonymoProviderPreferences {
  lane?: AnonymoLane;
  disclosure?: AnonymoDisclosure;
  /** Only use these providers. */
  only?: string[];
  /** Try providers in this order. */
  order?: string[];
  /** Allow falling back to other providers when the preferred ones fail. */
  allow_fallbacks?: boolean;
  [key: string]: unknown;
}

/** What `response_metadata.anonymo` carries on every chat response. */
export interface AnonymoesponseMetadata {
  /** Id of the signed receipt. Fetch it with GET /api/v1/receipts/{id}. */
  receipt_id: string | null;
  /** The lane the router actually used (x-anonymo-lane). */
  lane: string | null;
  /** How much the provider could learn: attested, policy or vendor-forwarded (x-anonymo-disclosure). */
  disclosure: string | null;
  /** The full signed receipt from the response body, or null when the response carried none. */
  receipt: Record<string, unknown> | null;
}

/** Options shared by the chat model and the embeddings. */
export interface AnonymoOptions {
  /** Anonymo API key (sk-ar-v1-...). Defaults to the ANONYMO_API_KEY environment variable. */
  apiKey?: string;
  /** Router base URL including /api/v1. Defaults to ANONYMO_BASE_URL, then the public router. */
  baseURL?: string;
  /** Where calls may run. Sent as the X-Anonymo-Lane header (and as provider.lane in chat bodies). */
  lane?: AnonymoLane;
  /** Disclosure ceiling. Sent as the X-Anonymo-Disclosure-Max header (and as provider.disclosure in chat bodies). */
  disclosure?: AnonymoDisclosure;
  /** Extra routing preferences, merged into the `provider` object of chat bodies. */
  provider?: AnonymoProviderPreferences;
}

export type ChatAnonymoFields = Omit<ChatOpenAIFields, "apiKey"> & AnonymoOptions;
export type AnonymoEmbeddingsFields = Omit<Partial<OpenAIEmbeddingsParams>, "apiKey"> &
  AnonymoOptions & { configuration?: ClientOptions };

/** The fetch signature the OpenAI client accepts. */
export type FetchLike = NonNullable<ClientOptions["fetch"]>;

type Capture = { receiptId?: string; lane?: string; disclosure?: string; receipt?: Record<string, unknown> };

const captures = new AsyncLocalStorage<Capture>();

const LANE_RANK: Record<string, number> = { public: 0, attested: 1, unlinkable: 2 };
const DISCLOSURE_RANK: Record<string, number> = { any: 0, policy: 1, none: 2 };

/** The stricter of two values by rank, so merging preferences never loosens what the caller asked for. */
function stricter<T extends string>(rank: Record<string, number>, a: T | undefined, b: T | undefined): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (rank[b] ?? -1) > (rank[a] ?? -1) ? b : a;
}

function resolveBaseURL(baseURL?: string): string {
  const url = baseURL ?? getEnvironmentVariable("ANONYMO_BASE_URL") ?? ANONYMO_BASE_URL;
  return url.replace(/\/+$/, "");
}

function resolveApiKey(apiKey?: string): string {
  const key = apiKey ?? getEnvironmentVariable("ANONYMO_API_KEY");
  if (!key) throw new Error("Anonymo API key missing: pass `apiKey` or set the ANONYMO_API_KEY environment variable.");
  return key;
}

function laneHeaders(lane?: AnonymoLane, disclosure?: AnonymoDisclosure): Record<string, string> {
  return {
    ...(lane ? { "X-Anonymo-Lane": lane } : {}),
    ...(disclosure ? { "X-Anonymo-Disclosure-Max": disclosure } : {}),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Scans an SSE stream as it passes through, keeping the `{"receipt": ...}` event the router sends before [DONE]. */
function tapReceipt(store: Capture): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  const scan = (line: string) => {
    if (!line.startsWith("data:") || !line.includes('"receipt"')) return;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (isObject(event) && isObject(event.receipt)) store.receipt = event.receipt;
    } catch {
      // Not JSON, or not the receipt event: ignore.
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) scan(line);
    },
    flush() {
      scan(buffer + decoder.decode());
    },
  });
}

/** Wraps a fetch so each response's receipt headers and body receipt land in the current call's store. */
export function capturingFetch(send?: FetchLike): FetchLike {
  return async (input, init) => {
    // globalThis.fetch is looked up per call, so a fetch patched after construction is still used.
    const res = await (send ?? globalThis.fetch)(input, init);
    const store = captures.getStore();
    if (!store) return res;
    store.receiptId = res.headers.get("x-receipt-id") ?? store.receiptId;
    store.lane = res.headers.get("x-anonymo-lane") ?? store.lane;
    store.disclosure = res.headers.get("x-anonymo-disclosure") ?? store.disclosure;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      try {
        const body: unknown = await res.clone().json();
        if (isObject(body) && isObject(body.receipt)) store.receipt = body.receipt;
      } catch {
        // Leave the body to the OpenAI client, which reports its own parse errors.
      }
      return res;
    }
    if (type.includes("text/event-stream") && res.body) {
      return new Response(res.body.pipeThrough(tapReceipt(store)), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }
    return res;
  };
}

function metadataOf(store: Capture): AnonymoesponseMetadata | undefined {
  const receiptId = store.receiptId ?? (typeof store.receipt?.id === "string" ? store.receipt.id : undefined);
  if (!receiptId && !store.lane && !store.disclosure && !store.receipt) return undefined;
  return {
    receipt_id: receiptId ?? null,
    lane: store.lane ?? null,
    disclosure: store.disclosure ?? null,
    receipt: store.receipt ?? null,
  };
}

/**
 * An Anonymo chat model. Any id from GET /api/v1/models works as `model`.
 *
 * ```ts
 * const llm = new ChatAnonymo({ model: "meta-llama/llama-3.3-70b-instruct", lane: "attested" });
 * const msg = await llm.invoke("Say hello in five words.");
 * msg.response_metadata.anonymo; // { receipt_id, lane, disclosure, receipt }
 * ```
 */
export class ChatAnonymo extends ChatOpenAI {
  static lc_name() {
    return "ChatAnonymo";
  }

  lane?: AnonymoLane;

  disclosure?: AnonymoDisclosure;

  constructor(modelOrFields?: string | ChatAnonymoFields, maybeFields?: ChatAnonymoFields) {
    const given: ChatAnonymoFields =
      typeof modelOrFields === "string" ? { ...maybeFields, model: modelOrFields } : { ...modelOrFields };
    const { apiKey, baseURL, lane, disclosure, provider, configuration, modelKwargs, ...rest } = given;
    const fromKwargs = isObject(modelKwargs?.provider) ? (modelKwargs.provider as AnonymoProviderPreferences) : {};
    const prefs: AnonymoProviderPreferences = { ...fromKwargs, ...provider };
    prefs.lane = stricter(LANE_RANK, stricter(LANE_RANK, fromKwargs.lane, provider?.lane), lane);
    prefs.disclosure = stricter(DISCLOSURE_RANK, stricter(DISCLOSURE_RANK, fromKwargs.disclosure, provider?.disclosure), disclosure);
    const body = Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== undefined));
    super({
      ...rest,
      apiKey: resolveApiKey(apiKey),
      modelKwargs: { ...modelKwargs, ...(Object.keys(body).length ? { provider: body } : {}) },
      configuration: {
        ...configuration,
        baseURL: resolveBaseURL(baseURL ?? configuration?.baseURL ?? undefined),
        defaultHeaders: { ...configuration?.defaultHeaders, ...laneHeaders(prefs.lane, prefs.disclosure) },
        fetch: capturingFetch(configuration?.fetch),
      },
    });
    this.lane = prefs.lane;
    this.disclosure = prefs.disclosure;
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const store: Capture = {};
    const result = await captures.run(store, () => super._generate(messages, options, runManager));
    const anonymo = metadataOf(store);
    if (anonymo) {
      for (const generation of result.generations) {
        generation.message.response_metadata = { ...generation.message.response_metadata, anonymo };
      }
      result.llmOutput = { ...result.llmOutput, anonymo };
    }
    return result;
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const store: Capture = {};
    const chunks = super._streamResponseChunks(messages, options, runManager)[Symbol.asyncIterator]();
    // Each step runs inside the store so the fetch made by the first step, and the stream reads after it, see it.
    for (;;) {
      const step = await captures.run(store, () => chunks.next());
      if (step.done) break;
      yield step.value;
    }
    const anonymo = metadataOf(store);
    if (anonymo) {
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({ content: "", response_metadata: { anonymo } }),
      });
    }
  }
}

/**
 * Anonymo embeddings. Any embedding model id from GET /api/v1/models works as `model`.
 * Vectors are requested as plain floats.
 */
export class AnonymoEmbeddings extends OpenAIEmbeddings {
  constructor(fields: AnonymoEmbeddingsFields = {}) {
    const { apiKey, baseURL, lane, disclosure, provider, configuration, ...rest } = fields;
    const effectiveLane = stricter(LANE_RANK, provider?.lane, lane);
    const effectiveDisclosure = stricter(DISCLOSURE_RANK, provider?.disclosure, disclosure);
    super({
      encodingFormat: "float",
      ...rest,
      apiKey: resolveApiKey(apiKey),
      configuration: {
        ...configuration,
        baseURL: resolveBaseURL(baseURL ?? configuration?.baseURL ?? undefined),
        defaultHeaders: { ...configuration?.defaultHeaders, ...laneHeaders(effectiveLane, effectiveDisclosure) },
      },
    });
  }
}

/** Reads `response_metadata.anonymo` from a chat response, or undefined when it has none. */
export function receiptOf(message: BaseMessage): AnonymoesponseMetadata | undefined {
  const value = (message.response_metadata as Record<string, unknown> | undefined)?.anonymo;
  return isObject(value) ? (value as unknown as AnonymoesponseMetadata) : undefined;
}

export type { ChatOpenAICallOptions as ChatAnonymoCallOptions };
