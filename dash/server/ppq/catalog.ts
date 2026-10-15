import { CHINESE_CHAT_MODELS } from '../../lib/chinese-models.ts';
import { cost, integer, record, type Usd6 } from './codec.ts';
import { PpqError } from './errors.ts';

// Exact, pinned catalog IDs (never "~...-latest" aliases). deepseek/qwen/llama must
// stay open-weight models: the cross-check registry labels those families so.
export const PPQ_MODEL_ALLOWLIST = Object.freeze({
  claude: { id: 'claude-opus-5.5', modality: 'chat' },
  gemini: { id: 'google/gemini-3.1-pro-preview', modality: 'chat' },
  gpt: { id: 'gpt-6.1-sol', modality: 'chat' },
  grok: { id: 'x-ai/grok-4.7', modality: 'chat' },
  deepseek: { id: 'deepseek/deepseek-v4-pro-0813', modality: 'chat' },
  qwen: { id: 'qwen/qwen3.8-2.4t-a95b', modality: 'chat' },
  llama: { id: 'meta-llama/llama-4-scout', modality: 'chat' },
  ...Object.fromEntries(CHINESE_CHAT_MODELS.filter(model => !['deepseek', 'qwen'].includes(model.key)).map(model => [model.key, { id: model.modelId, modality: 'chat' as const }])),
  runway: { id: 'runway-gen4', modality: 'video' },
  veo: { id: 'veo3-fast', modality: 'video' },
  kling: { id: 'kling-2.5-turbo', modality: 'video' },
  image: { id: 'nano-banana-2', modality: 'image' },
} as const);

export type PpqFamily = keyof typeof PPQ_MODEL_ALLOWLIST;
export type PpqModality = 'chat' | 'image' | 'video';
export type PpqPrivacy = 'standard' | 'strict';

export function modelForFamily(family: string): string | null {
  return Object.hasOwn(PPQ_MODEL_ALLOWLIST, family)
    ? PPQ_MODEL_ALLOWLIST[family as PpqFamily].id
    : null;
}

export function validateModel(
  id: string,
  modality: PpqModality,
  privacy?: PpqPrivacy,
) {
  if (privacy === 'strict') throw new PpqError('privacy_unavailable');
  if (privacy !== undefined && privacy !== 'standard')
    throw new PpqError('invalid_request');
  if (
    !Object.values(PPQ_MODEL_ALLOWLIST).some(
      (model) => model.id === id && model.modality === modality,
    )
  )
    throw new PpqError('invalid_request');
}

export type PpqCatalogModel = {
  id: string;
  family: PpqFamily;
  name: string;
  modality: PpqModality;
  contextLength: number | null;
  privacyLevel: 'anon' | 'zdr' | 'e2e' | null;
  strictPrivacyAvailable: false;
  supportedParameters: string[];
  pricing: {
    inputPerMillionUsd6: Usd6 | null;
    outputPerMillionUsd6: Usd6 | null;
    cacheReadPerMillionUsd6?: Usd6 | null;
    baseUsd6: Usd6 | null;
    variants: { quality: string; size: string; usd6: Usd6 }[];
  };
};

export function normalizeCatalog(value: unknown): PpqCatalogModel[] {
  const entries = record(value)?.data;
  if (!Array.isArray(entries) || entries.length > 5_000)
    throw new PpqError('invalid_response');
  const models: PpqCatalogModel[] = [];
  for (const [family, allowed] of Object.entries(PPQ_MODEL_ALLOWLIST)) {
    const matches = entries.filter((entry) => record(entry)?.id === allowed.id);
    if (matches.length > 1) throw new PpqError('invalid_response');
    const entry = record(matches[0]);
    if (!entry) continue;
    // Endpoints come from our allowlist, never PPQ's inconsistent media type alone.
    if (entry.type !== allowed.modality) continue;
    const pricing = record(entry.pricing);
    if (!pricing || pricing.currency !== 'USD') continue;
    const variants: PpqCatalogModel['pricing']['variants'] = [];
    if (Array.isArray(pricing.variants)) {
      if (pricing.variants.length > 64) throw new PpqError('invalid_response');
      for (const raw of pricing.variants) {
        const variant = record(raw);
        if (
          typeof variant?.quality !== 'string' ||
          variant.quality.length > 40 ||
          !Array.isArray(variant.options)
        )
          throw new PpqError('invalid_response');
        if (variant.options.length > 128)
          throw new PpqError('invalid_response');
        for (const option of variant.options) {
          const item = record(option);
          if (typeof item?.size !== 'string' || item.size.length > 80)
            throw new PpqError('invalid_response');
          const amount = cost(item.price, false, true);
          if (amount !== null)
            variants.push({
              quality: variant.quality,
              size: item.size,
              usd6: amount,
            });
        }
      }
    }
    const name =
      typeof entry.name === 'string' && entry.name.length <= 100
        ? entry.name
        : allowed.id;
    models.push({
      id: allowed.id,
      family: family as PpqFamily,
      name,
      modality: allowed.modality,
      contextLength: integer(entry.context_length),
      privacyLevel:
        entry.privacyLevel === 'anon' ||
        entry.privacyLevel === 'zdr' ||
        entry.privacyLevel === 'e2e'
          ? entry.privacyLevel
          : null,
      strictPrivacyAvailable: false,
      supportedParameters: Array.isArray(entry.supported_parameters)
        ? entry.supported_parameters
            .filter(
              (item): item is string =>
                typeof item === 'string' && /^[a-z_]{1,50}$/.test(item),
            )
            .slice(0, 64)
        : [],
      pricing: {
        // Some published token rates have sub-micro-dollar precision. Round
        // reservations up to our money unit; provider-reported actual cost
        // still takes precedence at settlement. Never use floating-point math.
        inputPerMillionUsd6: cost(pricing.input_per_1M_tokens, false),
        outputPerMillionUsd6: cost(pricing.output_per_1M_tokens, false),
        cacheReadPerMillionUsd6: cost(pricing.cache_read_per_1M_tokens, false),
        baseUsd6: cost(pricing.base_price, false, true),
        variants,
      },
    });
  }
  return models;
}
