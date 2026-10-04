// SPDX-License-Identifier: Apache-2.0
// ElizaOS model provider for Anonymo. Registers TEXT_SMALL, TEXT_LARGE and TEXT_EMBEDDING against the router's
// OpenAI-compatible API, so an agent picks any of the catalogue's models by id. With ANONYMO_LANE=attested every
// call goes only to providers whose enclave the router has verified, and the router refuses (sending nothing,
// charging nothing) when none can answer: an agent never silently falls back to an unattested host.
// Every answer carries a signed receipt id, logged at debug level so an operator can verify a call later.
import { type GenerateTextParams, type IAgentRuntime, type Plugin, type TextEmbeddingParams, logger, ModelType } from "@elizaos/core";

export const ANONYMO_BASE_URL = "https://anonymo.tech/api/v1";
const DEFAULTS = {
  ANONYMO_SMALL_MODEL: "meta-llama/llama-3.3-70b-instruct",
  ANONYMO_LARGE_MODEL: "deepseek/deepseek-v3.2",
  ANONYMO_EMBEDDING_MODEL: "qwen/qwen3-embedding-8b",
  ANONYMO_EMBEDDING_DIMENSIONS: "4096",
} as const;

function setting(runtime: IAgentRuntime, key: string, fallback?: string): string | undefined {
  const v = runtime.getSetting(key) ?? process.env[key];
  return v === null || v === undefined || v === "" ? fallback : String(v);
}

function config(runtime: IAgentRuntime) {
  const apiKey = setting(runtime, "ANONYMO_API_KEY");
  if (!apiKey) throw new Error("ANONYMO_API_KEY is not set. Create a key at the Anonymo dashboard and add it to the agent's settings.");
  const baseURL = (setting(runtime, "ANONYMO_BASE_URL", ANONYMO_BASE_URL) as string).replace(/\/$/, "");
  const lane = setting(runtime, "ANONYMO_LANE", "public");
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  if (lane && lane !== "public") headers["x-anonymo-lane"] = lane;
  return { baseURL, headers };
}

async function post(runtime: IAgentRuntime, path: string, body: Record<string, unknown>): Promise<any> {
  const { baseURL, headers } = config(runtime);
  const res = await fetch(`${baseURL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anonymo ${path} answered ${res.status}: ${json?.error?.message ?? res.statusText}`);
  if (json?.receipt?.id) logger.debug(`[anonymo] ${body.model} receipt ${json.receipt.id} cost $${json?.usage?.cost ?? "?"}`);
  return json;
}

async function chat(runtime: IAgentRuntime, model: string, p: GenerateTextParams): Promise<string> {
  // `user` is deliberately not forwarded: the router needs no end-user identifier to route or bill a call.
  const json = await post(runtime, "/chat/completions", {
    model,
    messages: [{ role: "user", content: p.prompt }],
    ...(p.maxTokens !== undefined ? { max_tokens: p.maxTokens } : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.topP !== undefined ? { top_p: p.topP } : {}),
    ...(p.frequencyPenalty !== undefined ? { frequency_penalty: p.frequencyPenalty } : {}),
    ...(p.presencePenalty !== undefined ? { presence_penalty: p.presencePenalty } : {}),
    ...(p.stopSequences?.length ? { stop: p.stopSequences } : {}),
    ...(p.responseFormat && typeof p.responseFormat === "object" ? { response_format: p.responseFormat } : {}),
  });
  return json?.choices?.[0]?.message?.content ?? "";
}

export const anonymoPlugin: Plugin = {
  name: "anonymo",
  description: "Anonymo model provider: any catalogue model by id, a signed receipt per call, and an attested-only lane.",
  config: {
    ANONYMO_API_KEY: process.env.ANONYMO_API_KEY ?? null,
    ANONYMO_BASE_URL: process.env.ANONYMO_BASE_URL ?? null,
    ANONYMO_SMALL_MODEL: process.env.ANONYMO_SMALL_MODEL ?? null,
    ANONYMO_LARGE_MODEL: process.env.ANONYMO_LARGE_MODEL ?? null,
    ANONYMO_EMBEDDING_MODEL: process.env.ANONYMO_EMBEDDING_MODEL ?? null,
    ANONYMO_EMBEDDING_DIMENSIONS: process.env.ANONYMO_EMBEDDING_DIMENSIONS ?? null,
    ANONYMO_LANE: process.env.ANONYMO_LANE ?? null,
  },
  async init(_config, runtime) {
    if (!setting(runtime, "ANONYMO_API_KEY")) logger.warn("[anonymo] ANONYMO_API_KEY is not set; model calls will fail until it is.");
  },
  models: {
    [ModelType.TEXT_SMALL]: async (runtime, params) => chat(runtime, setting(runtime, "ANONYMO_SMALL_MODEL", DEFAULTS.ANONYMO_SMALL_MODEL) as string, params),
    [ModelType.TEXT_LARGE]: async (runtime, params) => chat(runtime, setting(runtime, "ANONYMO_LARGE_MODEL", DEFAULTS.ANONYMO_LARGE_MODEL) as string, params),
    [ModelType.TEXT_EMBEDDING]: async (runtime, params: TextEmbeddingParams | string | null) => {
      const dims = Number(setting(runtime, "ANONYMO_EMBEDDING_DIMENSIONS", DEFAULTS.ANONYMO_EMBEDDING_DIMENSIONS));
      // ElizaOS calls with null once at startup to learn the vector size; answer without a network call.
      if (params === null) return Array.from({ length: dims }, (_, i) => (i === 0 ? 0.1 : 0));
      const input = typeof params === "string" ? params : params.text;
      const json = await post(runtime, "/embeddings", { model: setting(runtime, "ANONYMO_EMBEDDING_MODEL", DEFAULTS.ANONYMO_EMBEDDING_MODEL), input });
      const v = json?.data?.[0]?.embedding;
      if (!Array.isArray(v)) throw new Error("Anonymo /embeddings returned no vector.");
      return v as number[];
    },
  },
};

export default anonymoPlugin;
