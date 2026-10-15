import type { MediaJob, MediaRoute } from './client/media.ts';
import { prepareStudioReview, studioRoutes, studioVariantKey, studioVariantLabel } from './client/studio-review.ts';
export type StudioReuseDraft = {
  prompt: string;
  modelIds: string[];
  ratio: string;
  duration: string;
  strict: false;
  reference: null;
};
/** A remix is only a draft. It never reuses a quote, approval, job key or charge. */
export function studioReuseDraft(job: MediaJob, routes: MediaRoute[], now = Date.now()) {
  if (job.modality !== 'video' || job.input.options.kind !== 'video') return null;
  const route = studioRoutes(routes, now).find(route => route.modelId === job.modelId);
  if (!route) return null;
  const source = job.input.options;
  const variants = route.pricing.variants.filter(variant => variant.options.kind === 'video');
  const option = variants.find(variant => studioVariantKey(variant.options) === studioVariantKey(source)) ??
    variants.find(variant => variant.options.aspectRatio === source.aspectRatio) ?? variants[0];
  if (!option || option.options.kind !== 'video') return null;
  const draft: StudioReuseDraft = {
    prompt: job.input.prompt,
    modelIds: [route.family],
    ratio: option.options.aspectRatio,
    duration: String(option.options.duration),
    strict: false,
    reference: null,
  };
  try {
    // Resolve through the same current reviewed catalogue used by the next quote.
    const review = prepareStudioReview(draft, routes, job.projectId, now);
    if (review.entries[0].route.modelId !== job.modelId) return null;
    const selected = review.entries[0].options;
    return {
      draft,
      format: studioVariantLabel(selected),
      formatChanged: studioVariantKey(selected) !== studioVariantKey(source),
    };
  } catch { return null; }
}
