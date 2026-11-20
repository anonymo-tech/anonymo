import { AnonymoApiError } from './client.ts';
import { formatUsd, musdToUsdString, usdToMusd } from './money.ts';
import type { ImageGeneration, ImageRequest, MediaImageModel } from './types.ts';

export const MIN_COMPARE_MODELS = 2;
export const MAX_COMPARE_MODELS = 4;

type CompareImage = { model: MediaImageModel; size: string; price: number };

export type CompareFailure = {
  status: 'blocked' | 'failed' | 'unconfirmed';
  message: string;
};

type CompareOutcome = CompareFailure | {
  status: 'ready';
  png: Uint8Array<ArrayBuffer>;
  requestId: string;
  price: number;
  receipt: unknown;
};

export function toggleCompareModel(ids: readonly string[], id: string): readonly string[] {
  if (ids.includes(id)) return ids.filter((selected) => selected !== id);
  return ids.length < MAX_COMPARE_MODELS ? [...ids, id] : ids;
}

export function compareSizes(models: readonly MediaImageModel[]) {
  const counts = new Map<string, number>();
  for (const model of models) {
    for (const size of new Set(model.sizes)) counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
}

export function planComparison(models: readonly MediaImageModel[], size: string): CompareImage[] {
  return models.map((model) => ({
    model,
    size: model.sizes.includes(size) ? size : model.sizes[0],
    price: usdToMusd(model.pricing.usd_per_image),
  }));
}

export function comparisonTotal(plan: readonly CompareImage[]): number {
  return plan.reduce((sum, image) => sum + image.price, 0);
}

export function formatComparePrice(musd: number): string {
  // The workspace's usual dollar formatter drops fractions of a cent above one cent.
  return Number.isSafeInteger(musd) && musd % 10_000 !== 0 ? `$${musdToUsdString(musd)}` : formatUsd(musd);
}

function compareFailure(error: unknown): CompareFailure {
  if (error instanceof AnonymoApiError) {
    if (error.status === 451) {
      return { status: 'blocked', message: 'A safety check stopped this image.' };
    }
    if (error.status === 402) {
      return {
        status: 'failed',
        message: error.code === 'key_cap_reached' ? 'This key reached its spending limit.' : 'Not enough credit for this image.',
      };
    }
    return { status: 'failed', message: 'Image generation failed.' };
  }
  return { status: 'unconfirmed', message: 'Check your balance to confirm any charge.' };
}

export async function runComparison(
  plan: readonly CompareImage[],
  prompt: string,
  generate: (request: ImageRequest) => Promise<ImageGeneration>,
  onResult: (modelId: string, result: CompareOutcome) => void,
): Promise<void> {
  const text = prompt.trim();
  const total = comparisonTotal(plan);
  if (!text || !Number.isSafeInteger(total) || plan.length < MIN_COMPARE_MODELS || plan.length > MAX_COMPARE_MODELS
    || new Set(plan.map(({ model }) => model.id)).size !== plan.length) return;

  await Promise.all(plan.map(async ({ model, size }) => {
    let result: CompareOutcome;
    try {
      const { data, anonymo } = await generate({ model: model.id, prompt: text, n: 1, size });
      if (!data[0]?.b64_json || !anonymo.request_id) throw new Error('Incomplete image response');
      result = {
        status: 'ready',
        png: Uint8Array.from(atob(data[0].b64_json), (c) => c.charCodeAt(0)),
        requestId: anonymo.request_id,
        price: usdToMusd(anonymo.cost_usd),
        receipt: 'receipt' in anonymo ? anonymo.receipt : null,
      };
    } catch (error) {
      result = compareFailure(error);
    }
    onResult(model.id, result);
  }));
}
