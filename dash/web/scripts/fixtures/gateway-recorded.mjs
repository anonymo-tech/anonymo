// Recorded GATEWAY /v1/chat/completions stream shapes for every reviewed chat
// family (direct probes, 2026-10-10, two runs of the same one-sentence prompt,
// 2048-token cap).
// Each `usage` object is the provider's final usage member verbatim, with its
// number lexemes intact. Completion IDs, timestamps, upstream provider names,
// routing receipts and answer text are placeholders; no real identifier,
// prompt or credential appears here.

/** Reviewed GATEWAY catalog prices (integer USD6 per million tokens) for each route. */
export const reviewedPricing = Object.freeze({
  claude: { inputPerMillionUsd6: '4220000', outputPerMillionUsd6: '21100000' },
  gpt: { inputPerMillionUsd6: '2110000', outputPerMillionUsd6: '10550000' },
  gemini: { inputPerMillionUsd6: '1000000', outputPerMillionUsd6: '6000000' },
  grok: { inputPerMillionUsd6: '2110000', outputPerMillionUsd6: '6330000' },
  deepseek: { inputPerMillionUsd6: '696300', outputPerMillionUsd6: '2088900' },
  qwen: { inputPerMillionUsd6: '2110000', outputPerMillionUsd6: '6330000' },
  llama: { inputPerMillionUsd6: '105500', outputPerMillionUsd6: '316500' },
});

const receipt =
  ': gateway-routing-receipt {"v":2,"request_id":"fixture-request","route":"fixture"}\n\n' +
  ': gateway-routing-receipt-sig {"alg":"ECDSA-SHA256","sig":"fixture"}\n\n';
const frame = (value) => `data: ${value}\n\n`;
const done = 'data: [DONE]\n\n';
const words = ['Photosynthesis', ' turns light', ' into chemical energy.'];

/** OpenRouter-style chunks: id/object/created/model/provider/choices/service_tier. */
function openRouter({
  model,
  id,
  usage,
  reasoning = false,
  processing = false,
}) {
  const head = (choices, extra = '') =>
    frame(
      `{"id":"${id}","object":"chat.completion.chunk","created":1700000000,"model":"${model}","provider":"fixture-upstream","choices":${choices},"service_tier":null${extra}}`,
    );
  return (
    (processing ? ': GATEWAY PROCESSING\n\n' : '') +
    receipt +
    head(
      '[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]',
    ) +
    (reasoning
      ? head(
          '[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"Fixture reasoning.","reasoning_details":[{"type":"reasoning.text","text":"Fixture reasoning.","format":"unknown","index":0}]},"finish_reason":null}]',
        )
      : '') +
    words
      .map((text) =>
        head(
          `[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(text)}},"finish_reason":null}]`,
        ),
      )
      .join('') +
    head(
      '[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop","native_finish_reason":"stop"}]',
    ) +
    head(
      '[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop","native_finish_reason":"stop"}]',
      `,"usage":${usage}`,
    ) +
    done
  );
}

/** Google-compatible chunks: reasoning is reported beside the completion count. */
function google({ model, id, usage }) {
  const chunk = (choices, extra = '') =>
    frame(
      `{"choices":${choices},"created":1700000000,"id":"${id}","model":"${model}","object":"chat.completion.chunk","system_fingerprint":""${extra}}`,
    );
  return (
    receipt +
    chunk(
      `[{"delta":{"content":${JSON.stringify(words[0])},"role":"assistant","extra_content":{"google":{"thought_signature":"fixture"}}},"index":0}]`,
    ) +
    chunk(
      `[{"delta":{"content":${JSON.stringify(words.slice(1).join(''))},"role":"assistant"},"finish_reason":"stop","index":0}]`,
    ) +
    chunk('[]', `,"usage":${usage}`) +
    done
  );
}

/** Anthropic-style usage through GATEWAY: input/output tokens and cache counts, no cost. */
function anthropic({ model, id, usage }) {
  const chunk = (choices, extra = '') =>
    frame(
      `{"id":"${id}","object":"chat.completion.chunk","created":1700000000,"model":"${model}","choices":${choices}${extra}}`,
    );
  return (
    receipt +
    chunk(
      '[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]',
    ) +
    words
      .map((text) =>
        chunk(
          `[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":null}]`,
        ),
      )
      .join('') +
    chunk('[{"index":0,"delta":{},"finish_reason":"stop"}]') +
    chunk('[]', `,"usage":${usage}`) +
    done
  );
}

/**
 * Every reviewed chat family with its recorded final usage and the exact USD6
 * it must settle at: the positive provider cost (`cost`, else the BYOK
 * upstream cost), else usage × reviewed price with reasoning billed as
 * output, each rounded up to the micro-dollar.
 */
export const recordedStreams = Object.freeze([
  {
    family: 'llama',
    modelId: 'meta-llama/llama-4-scout',
    providerId: 'gen-1700000000-fixturellama',
    // Provider cost has 7 decimal places.
    usage:
      '{"prompt_tokens":19,"completion_tokens":35,"total_tokens":54,"cost":0.0000124,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.0000124,"upstream_inference_prompt_cost":0.0000019,"upstream_inference_completions_cost":0.0000105},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0,"audio_tokens":0}}',
    shape: 'openRouter',
    // Provider 12.4 µ$ → 13 (usage 19 × 0.1055 + 35 × 0.3165 = 13.082 → 14).
    expected: {
      costUsd6: 13,
      costSource: 'provider',
      usageCostUsd6: 14,
      providerCostUsd6: 13,
    },
    tokens: { inputTokens: 19, outputTokens: 35, totalTokens: 54 },
  },
  {
    family: 'deepseek',
    modelId: 'deepseek/deepseek-v4-pro-0813',
    providerId: 'gen-1700000000-fixturedeepseek',
    reasoning: true,
    // 8 decimal places; 108 of 134 completion tokens are reasoning (inside).
    usage:
      '{"prompt_tokens":92,"completion_tokens":134,"total_tokens":226,"cost":0.00032604,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.00032604,"upstream_inference_prompt_cost":0.00006072,"upstream_inference_completions_cost":0.00026532},"completion_tokens_details":{"reasoning_tokens":108,"image_tokens":0,"audio_tokens":0}}',
    shape: 'openRouter',
    // Provider 326.04 µ$ → 327 (usage 92 × 0.6963 + 134 × 2.0889 = 343.9722 → 344).
    expected: {
      costUsd6: 327,
      costSource: 'provider',
      usageCostUsd6: 344,
      providerCostUsd6: 327,
    },
    tokens: { inputTokens: 92, outputTokens: 134, totalTokens: 226 },
  },
  {
    family: 'gemini',
    modelId: 'google/gemini-3.1-pro-preview',
    providerId: 'fixture-gemini-0000000001',
    // No cost; 423 reasoning tokens reported beside 21 completion tokens.
    usage:
      '{"completion_tokens":21,"completion_tokens_details":{"reasoning_tokens":423},"extra_properties":{"google":{"traffic_type":"ON_DEMAND"}},"prompt_tokens":9,"total_tokens":453}',
    shape: 'google',
    // 9 × 1.00 + (21 + 423) × 6.00 = 2673 µ$ exactly.
    expected: {
      costUsd6: 2673,
      costSource: 'usage',
      usageCostUsd6: 2673,
      providerCostUsd6: null,
    },
    tokens: { inputTokens: 9, outputTokens: 21, totalTokens: 453 },
  },
  {
    family: 'gpt',
    modelId: 'gpt-6.1-sol',
    providerId: 'gen-1700000000-fixturegpt',
    processing: true,
    // BYOK: cost 0, real charge only in cost_details.upstream_inference_cost.
    usage:
      '{"prompt_tokens":16,"completion_tokens":32,"total_tokens":48,"cost":0,"is_byok":true,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.0003872,"upstream_inference_prompt_cost":0.0000352,"upstream_inference_completions_cost":0.000352},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0,"audio_tokens":0}}',
    shape: 'openRouter',
    // Upstream 387.2 µ$ → 388 (usage 16 × 2.11 + 32 × 10.55 = 371.36 → 372).
    expected: {
      costUsd6: 388,
      costSource: 'provider',
      usageCostUsd6: 372,
      providerCostUsd6: 388,
    },
    tokens: { inputTokens: 16, outputTokens: 32, totalTokens: 48 },
  },
  {
    family: 'qwen',
    modelId: 'qwen/qwen3.8-2.4t-a95b',
    providerId: 'gen-1700000000-fixtureqwen',
    reasoning: true,
    usage:
      '{"prompt_tokens":71,"completion_tokens":51,"total_tokens":122,"cost":0.000448,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.000448,"upstream_inference_prompt_cost":0.000142,"upstream_inference_completions_cost":0.000306},"completion_tokens_details":{"reasoning_tokens":25,"image_tokens":0,"audio_tokens":0}}',
    shape: 'openRouter',
    // Provider 448 (usage 71 × 2.11 + 51 × 6.33 = 472.64 → 473).
    expected: {
      costUsd6: 448,
      costSource: 'provider',
      usageCostUsd6: 473,
      providerCostUsd6: 448,
    },
    tokens: { inputTokens: 71, outputTokens: 51, totalTokens: 122 },
  },
  {
    family: 'grok',
    modelId: 'x-ai/grok-4.7',
    providerId: 'gen-1700000000-fixturegrok',
    reasoning: true,
    // Second probe run: 1152 of 1251 prompt tokens are cached and 103 of 128
    // completion tokens are reasoning (inside). GATEWAY's cost reflects the
    // upstream cache discount; cached usage cannot be priced at reviewed rates.
    usage:
      '{"prompt_tokens":1251,"completion_tokens":128,"total_tokens":1379,"cost":0.001542,"is_byok":false,"prompt_tokens_details":{"cached_tokens":1152,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.001542,"upstream_inference_prompt_cost":0.000774,"upstream_inference_completions_cost":0.000768},"completion_tokens_details":{"reasoning_tokens":103,"image_tokens":0,"audio_tokens":0}}',
    shape: 'openRouter',
    // Provider 1542; usage is not derivable (cached prompt tokens).
    expected: {
      costUsd6: 1542,
      costSource: 'provider',
      usageCostUsd6: null,
      providerCostUsd6: 1542,
    },
    tokens: { inputTokens: 1251, outputTokens: 128, totalTokens: 1379 },
  },
  {
    family: 'claude',
    modelId: 'claude-opus-5.5',
    providerId: 'chatcmpl-fixture0000000001',
    usage:
      '{"input_tokens":20,"output_tokens":4,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}',
    shape: 'anthropic',
    // 20 × 4.22 + 4 × 21.10 = 168.8 µ$ → 169.
    expected: {
      costUsd6: 169,
      costSource: 'usage',
      usageCostUsd6: 169,
      providerCostUsd6: null,
    },
    tokens: { inputTokens: 20, outputTokens: 4, totalTokens: null },
  },
  // Second probe run (same prompt): different upstream routing and usage.
  {
    family: 'llama',
    modelId: 'meta-llama/llama-4-scout',
    providerId: 'gen-1700000001-fixturellama',
    // 8 decimals; this upstream charged more than the reviewed price.
    usage:
      '{"prompt_tokens":19,"completion_tokens":35,"total_tokens":54,"cost":0.00002407,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.00002407,"upstream_inference_prompt_cost":0.00000342,"upstream_inference_completions_cost":0.00002065},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0,"audio_tokens":0}}',
    shape: 'openRouter',
    // Provider 24.07 µ$ → 25 (usage 13.082 → 14).
    expected: {
      costUsd6: 25,
      costSource: 'provider',
      usageCostUsd6: 14,
      providerCostUsd6: 25,
    },
    tokens: { inputTokens: 19, outputTokens: 35, totalTokens: 54 },
  },
  {
    family: 'deepseek',
    modelId: 'deepseek/deepseek-v4-pro-0813',
    providerId: 'gen-1700000001-fixturedeepseek',
    usage:
      '{"prompt_tokens":13,"completion_tokens":32,"total_tokens":45,"cost":0.0001639,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.0001639,"upstream_inference_prompt_cost":0.0000039,"upstream_inference_completions_cost":0.00016},"completion_tokens_details":{"reasoning_tokens":0,"image_tokens":0,"audio_tokens":0}}',
    shape: 'openRouter',
    // Provider 163.9 µ$ → 164 (usage 13 × 0.6963 + 32 × 2.0889 = 75.8967 → 76).
    expected: {
      costUsd6: 164,
      costSource: 'provider',
      usageCostUsd6: 76,
      providerCostUsd6: 164,
    },
    tokens: { inputTokens: 13, outputTokens: 32, totalTokens: 45 },
  },
  {
    family: 'gemini',
    modelId: 'google/gemini-3.1-pro-preview',
    providerId: 'fixture-gemini-0000000002',
    usage:
      '{"completion_tokens":21,"completion_tokens_details":{"reasoning_tokens":481},"extra_properties":{"google":{"traffic_type":"ON_DEMAND"}},"prompt_tokens":9,"total_tokens":511}',
    shape: 'google',
    // 9 × 1.00 + (21 + 481) × 6.00 = 3021 µ$ exactly.
    expected: {
      costUsd6: 3021,
      costSource: 'usage',
      usageCostUsd6: 3021,
      providerCostUsd6: null,
    },
    tokens: { inputTokens: 9, outputTokens: 21, totalTokens: 511 },
  },
  {
    family: 'qwen',
    modelId: 'qwen/qwen3.8-2.4t-a95b',
    providerId: 'gen-1700000001-fixtureqwen',
    reasoning: true,
    usage:
      '{"prompt_tokens":62,"completion_tokens":55,"total_tokens":117,"cost":0.000454,"is_byok":false,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0,"audio_tokens":0,"video_tokens":0},"cost_details":{"upstream_inference_cost":0.000454,"upstream_inference_prompt_cost":0.000124,"upstream_inference_completions_cost":0.00033},"completion_tokens_details":{"reasoning_tokens":31,"image_tokens":0,"audio_tokens":0}}',
    shape: 'openRouter',
    // Provider 454 (usage 62 × 2.11 + 55 × 6.33 = 478.97 → 479).
    expected: {
      costUsd6: 454,
      costSource: 'provider',
      usageCostUsd6: 479,
      providerCostUsd6: 454,
    },
    tokens: { inputTokens: 62, outputTokens: 55, totalTokens: 117 },
  },
  {
    family: 'claude',
    modelId: 'claude-opus-5.5',
    providerId: 'chatcmpl-fixture0000000002',
    usage:
      '{"input_tokens":24,"output_tokens":53,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}',
    shape: 'anthropic',
    // 24 × 4.22 + 53 × 21.10 = 1219.58 µ$ → 1220.
    expected: {
      costUsd6: 1220,
      costSource: 'usage',
      usageCostUsd6: 1220,
      providerCostUsd6: null,
    },
    tokens: { inputTokens: 24, outputTokens: 53, totalTokens: null },
  },
]);

export const recordedText = words.join('');

/** The full SSE body for one recorded family. */
export function recordedStream(entry) {
  const shape = { openRouter, google, anthropic }[entry.shape];
  return shape({
    model:
      entry.shape === 'anthropic'
        ? `anthropic/${entry.modelId}`
        : entry.modelId,
    id: entry.providerId,
    usage: entry.usage,
    reasoning: entry.reasoning,
    processing: entry.processing,
  });
}

/** A fetch stub that serves a body as a chunked event stream. */
export function streamResponse(text, split = 7) {
  const encoded = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === encoded.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoded.slice(offset, offset + split));
        offset = Math.min(offset + split, encoded.length);
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
