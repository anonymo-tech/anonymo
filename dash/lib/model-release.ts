import { CHINESE_CHAT_MODELS } from './chinese-models.ts';
import { featureOn } from '../components/dashboard/feature-switches.ts';

export const BASE_CHAT_MODELS = ['claude', 'gpt', 'gemini', 'grok'] as const;
export const MORE_CHAT_MODELS = ['deepseek', 'qwen', 'llama', ...CHINESE_CHAT_MODELS.filter(model => !['deepseek', 'qwen'].includes(model.key)).map(model => model.key)] as const;

/** Release policy applies to the picker, new requests and server route checks. */
export function modelReleased(modelId: string): boolean {
  return (
    (BASE_CHAT_MODELS as readonly string[]).includes(modelId) ||
    (featureOn('moreModels') &&
      (MORE_CHAT_MODELS as readonly string[]).includes(modelId))
  );
}

/** Keep saved history intact while removing held models from new selections. */
export function releasedModelSelection(
  modelIds: readonly string[],
  fallback: readonly string[] = ['claude', 'gemini'],
): string[] {
  const released = modelIds.filter(modelReleased);
  return released.length ? released : fallback.filter(modelReleased);
}

/** Shared picker, registry and worker policy; never includes media or held tools. */
export function releasedChatFamilies(): string[] {
  return [...BASE_CHAT_MODELS, ...MORE_CHAT_MODELS].filter(modelReleased);
}
