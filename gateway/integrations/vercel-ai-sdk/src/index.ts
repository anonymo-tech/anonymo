// SPDX-License-Identifier: Apache-2.0
// Anonymo provider for the Vercel AI SDK. Anonymo speaks the OpenAI chat, completion and embeddings API, so this
// is the SDK's own OpenAI-compatible provider with Anonymo's defaults: the router URL, the key read from
// ANONYMO_API_KEY when a request is made (not at import), the attested lane as an option, and the signed
// receipt of every call surfaced as provider metadata.
import { createOpenAICompatible, type MetadataExtractor, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import { type FetchFunction, loadApiKey, loadOptionalSetting, withoutTrailingSlash } from "@ai-sdk/provider-utils";

/** The public Anonymo router. Point `baseURL` elsewhere to use a self-hosted router. */
export const ANONYMO_BASE_URL = "https://anonymo.invalid/api/v1";

/** Any id from GET /api/v1/models, e.g. "meta-llama/llama-3.3-70b-instruct" or "z-ai/glm-5.3". */
export type AnonymoModelId = string & {};

export interface AnonymoProviderSettings {
  /** Anonymo API key (anm_live_...). Defaults to the ANONYMO_API_KEY environment variable, read per request. */
  apiKey?: string;
  /** Router base URL including /api/v1. Defaults to ANONYMO_BASE_URL, then the public router. */
  baseURL?: string;
  /**
   * "attested" sends every call only to providers whose enclave the router has verified, and makes the router
   * refuse (sending nothing, charging nothing) when none can answer. Sent as the X-Anonymo-Lane header.
   */
  lane?: "public" | "attested";
  /** Extra headers for every request. */
  headers?: Record<string, string>;
  /** Custom fetch, for tests or middleware. */
  fetch?: FetchFunction;
}

/** What `providerMetadata.anonymo` carries on a response: the receipt id to verify later, and the billed cost. */
export type AnonymoMetadata = { receiptId?: string; receiptKeyId?: string; costUsd?: number };

const pick = (body: unknown): AnonymoMetadata => {
  const b = (body ?? {}) as { receipt?: { id?: unknown; key_id?: unknown }; usage?: { cost?: unknown } };
  const out: AnonymoMetadata = {};
  if (typeof b.receipt?.id === "string") out.receiptId = b.receipt.id;
  if (typeof b.receipt?.key_id === "string") out.receiptKeyId = b.receipt.key_id;
  if (typeof b.usage?.cost === "number") out.costUsd = b.usage.cost;
  return out;
};

const asMetadata = (m: AnonymoMetadata) => (Object.keys(m).length ? { anonymo: { ...m } } : undefined);

/** Lifts `receipt` and `usage.cost` from Anonymo responses (and from the stream chunks that carry them). */
export const anonymoMetadata: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => asMetadata(pick(parsedBody)),
  createStreamExtractor: () => {
    let seen: AnonymoMetadata = {};
    return {
      processChunk: (chunk) => {
        seen = { ...seen, ...pick(chunk) };
      },
      buildMetadata: () => asMetadata(seen),
    };
  },
};

export type AnonymoProvider = OpenAICompatibleProvider<AnonymoModelId, AnonymoModelId, AnonymoModelId, AnonymoModelId>;

/** Create an Anonymo provider. `anonymo("<model id>")` returns a chat model. */
export function createAnonymo(options: AnonymoProviderSettings = {}): AnonymoProvider {
  const baseURL = withoutTrailingSlash(loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: "ANONYMO_BASE_URL" })) ?? ANONYMO_BASE_URL;
  const send = options.fetch ?? globalThis.fetch;
  // The key is resolved when a request is sent, so the default `anonymo` export works however late the
  // environment is loaded, and a missing key fails the call with a clear message instead of the import.
  const withKey: FetchFunction = (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      const key = loadApiKey({ apiKey: options.apiKey, environmentVariableName: "ANONYMO_API_KEY", description: "Anonymo" });
      headers.set("authorization", `Bearer ${key}`);
    }
    return send(input, { ...init, headers });
  };
  return createOpenAICompatible<AnonymoModelId, AnonymoModelId, AnonymoModelId, AnonymoModelId>({
    name: "anonymo",
    baseURL,
    headers: { ...(options.lane && options.lane !== "public" ? { "X-Anonymo-Lane": options.lane } : {}), ...options.headers },
    fetch: withKey,
    includeUsage: true,
    supportsStructuredOutputs: true,
    metadataExtractor: anonymoMetadata,
  });
}

/** The default provider: the public router, key from ANONYMO_API_KEY. */
export const anonymo = createAnonymo();
