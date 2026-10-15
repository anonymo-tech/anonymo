import { CHINESE_CHAT_MODELS } from './chinese-models.ts';
/** Native completion capacities reviewed against the model catalog, 2026-10-14.
 * These are model limits, not a shared Conclave response-length setting.
 * Reasoning is included in the completion budget except the separate Gemini count.
 */
export const CHAT_CAPACITY: Readonly<Record<string, { outputTokens: number; reasoningTokens: number }>> = Object.freeze({
  claude: { outputTokens: 128000, reasoningTokens: 0 },
  gpt: { outputTokens: 128000, reasoningTokens: 0 },
  gemini: { outputTokens: 65536, reasoningTokens: 65536 },
  grok: { outputTokens: 450000, reasoningTokens: 0 },
  deepseek: { outputTokens: 393216, reasoningTokens: 0 },
  qwen: { outputTokens: 131072, reasoningTokens: 0 },
  llama: { outputTokens: 117964, reasoningTokens: 0 },
  ...Object.fromEntries(CHINESE_CHAT_MODELS.filter(model => !['deepseek', 'qwen'].includes(model.key)).map(model => [model.key, { outputTokens: model.outputTokens, reasoningTokens: 0 }])),
});
const maximumOutputTokens = Math.max(...Object.values(CHAT_CAPACITY).map(c => c.outputTokens));
/** Transport abuse envelopes; token/context acceptance belongs to the selected model. */
export const CHAT_LIMITS = Object.freeze({
  outputTokens: maximumOutputTokens,
  inputBytes: 16 * 1024 * 1024,
  messages: Number.MAX_SAFE_INTEGER,
  // A stalled stream times out; a stream making progress has no wall-clock deadline.
  generationMs: 600000,
  requestBytes: 6 * 16 * 1024 * 1024 + 65536,
  // Safely accommodates the longest tokens in native completions, including JSON escaping.
  outputCharacters: maximumOutputTokens * 128,
  outputBytes: maximumOutputTokens * 128 * 4,
  responseBytes: 4 * maximumOutputTokens * 128 * 6 + 65536,
});
