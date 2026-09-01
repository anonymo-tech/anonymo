import {
  makeMediaApproval,
  MediaClientError,
  mediaErrorMessage,
  parseMediaInput,
  type MediaApproval,
  type MediaClient,
  type MediaJob,
  type MediaOptions,
  type MediaQuote,
  type MediaRoute,
} from './media.ts';

export type StudioDraftPreference = {
  prompt: string;
  modelIds: string[];
  ratio: string;
  duration: string;
  strict: boolean;
  reference: unknown;
};
export type StudioReviewEntry = {
  family: 'runway' | 'veo' | 'kling';
  name: string;
  route: MediaRoute;
  options: MediaOptions;
  quote: MediaQuote | null;
  approval: MediaApproval | null;
  phase:
    | 'unquoted'
    | 'quoted'
    | 'submitting'
    | 'uncertain'
    | 'accepted'
    | 'rejected';
  job: MediaJob | null;
  error: string | null;
};
export type StudioReview = {
  projectId: string;
  prompt: string;
  requestedRatio: string;
  requestedDuration: string;
  entries: StudioReviewEntry[];
};
const names = { runway: 'Runway', veo: 'Veo', kling: 'Kling' } as const;
function fail(message: string): never {
  throw new MediaClientError('STUDIO_REVIEW_REQUIRED', message);
}
export const studioVariantKey = (options: MediaOptions) =>
  JSON.stringify(options);
export function studioVariantLabel(options: MediaOptions) {
  return options.kind === 'video'
    ? `${options.duration}s · ${options.aspectRatio} · ${options.quality}`
    : `${options.resolution} · ${options.aspectRatio}`;
}
export function studioRoutes(routes: MediaRoute[], now = Date.now()) {
  return routes.filter(
    (route) =>
      route.modality === 'video' &&
      Object.hasOwn(names, route.family) &&
      Date.parse(route.expiresAt) > now,
  );
}
export function prepareStudioReview(
  draft: StudioDraftPreference,
  routes: MediaRoute[],
  projectId: string,
  now = Date.now(),
): StudioReview {
  if (draft.strict)
    fail(
      'Sealed media generation is unavailable. Turn off the sealed route explicitly to review a standard request.',
    );
  if (draft.reference != null)
    fail(
      'Reference uploads are not supported for live media. Remove the reference explicitly before requesting a quote.',
    );
  if (
    !Array.isArray(draft.modelIds) ||
    draft.modelIds.length < 1 ||
    draft.modelIds.length > 3 ||
    new Set(draft.modelIds).size !== draft.modelIds.length
  )
    fail('Choose between one and three different connected video models.');
  if (
    !['16:9', '9:16', '1:1'].includes(draft.ratio) ||
    !/^\d{1,3}$/.test(draft.duration) ||
    Number(draft.duration) < 1 ||
    Number(draft.duration) > 120
  )
    fail('Choose a supported frame and a positive duration preference.');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      projectId,
    )
  )
    fail('Choose a saved service project before requesting media.');
  const available = studioRoutes(routes, now);
  const entries = draft.modelIds.map((family): StudioReviewEntry => {
    if (!Object.hasOwn(names, family))
      fail(
        `${family === 'sora' ? 'Sora' : 'A selected model'} has no supported live media route. Change the selection before continuing.`,
      );
    const selected = family as keyof typeof names;
    const matching = available
      .filter((route) => route.family === selected)
      .sort(
        (a, b) =>
          Date.parse(b.expiresAt) - Date.parse(a.expiresAt) ||
          b.version - a.version ||
          a.versionId.localeCompare(b.versionId),
      );
    const route = matching[0];
    if (!route)
      fail(
        `${names[selected]} has no currently reviewed video route. Refresh the routes or change the model selection.`,
      );
    const variants = route.pricing.variants
      .filter(
        (v) =>
          v.options.kind === 'video' && v.options.aspectRatio === draft.ratio,
      )
      .sort((a, b) => {
        if (a.options.kind !== 'video' || b.options.kind !== 'video') return 0;
        return (
          Math.abs(a.options.duration - Number(draft.duration)) -
            Math.abs(b.options.duration - Number(draft.duration)) ||
          (BigInt(a.providerUsd6) < BigInt(b.providerUsd6)
            ? -1
            : BigInt(a.providerUsd6) > BigInt(b.providerUsd6)
              ? 1
              : studioVariantKey(a.options).localeCompare(
                  studioVariantKey(b.options),
                ))
        );
      });
    if (!variants.length)
      fail(
        `${names[selected]} has no reviewed ${draft.ratio} option. Change the frame explicitly before continuing.`,
      );
    const input = parseMediaInput(
      {
        prompt: draft.prompt,
        privacy: 'standard',
        options: variants[0].options,
      },
      route.modelId,
    );
    if (
      new TextEncoder().encode(input.prompt).byteLength >
      route.pricing.maxInputBytes
    )
      fail(`${names[selected]} requires a shorter description.`);
    return {
      family: selected,
      name: names[selected],
      route: structuredClone(route),
      options: input.options,
      quote: null,
      approval: null,
      phase: 'unquoted',
      job: null,
      error: null,
    };
  });
  return {
    projectId: projectId.toLowerCase(),
    prompt: draft.prompt,
    requestedRatio: draft.ratio,
    requestedDuration: draft.duration,
    entries,
  };
}
export function hasUncertainStudioApproval(review: StudioReview) {
  return review.entries.some(
    (entry) => entry.phase === 'uncertain' || entry.phase === 'submitting',
  );
}
export function studioPendingMaximum(review: StudioReview): string | null {
  const entries = review.entries.filter((entry) => entry.phase !== 'accepted');
  if (!entries.length) return '0';
  if (
    entries.some(
      (entry) =>
        !entry.quote ||
        !entry.approval ||
        !['quoted', 'uncertain', 'submitting'].includes(entry.phase),
    )
  )
    return null;
  return entries
    .reduce(
      (total, entry) => total + BigInt(entry.approval!.approvedMaximumUsd6),
      0n,
    )
    .toString();
}
export function changeStudioVariant(
  review: StudioReview,
  family: string,
  key: string,
): StudioReview {
  if (
    review.entries.some((entry) =>
      ['accepted', 'uncertain', 'submitting', 'rejected'].includes(entry.phase),
    )
  )
    fail('Keep the accepted terms while resolving this request.');
  const entry = review.entries.find((entry) => entry.family === family);
  const variant = entry?.route.pricing.variants.find(
    (v) => studioVariantKey(v.options) === key,
  );
  if (!entry || !variant || variant.options.kind !== 'video')
    fail('Choose a currently reviewed variant.');
  return {
    ...review,
    entries: review.entries.map((item) => ({
      ...item,
      options:
        item.family === family
          ? structuredClone(variant.options)
          : item.options,
      quote: null,
      approval: null,
      phase: 'unquoted',
      error: null,
    })),
  };
}
export function interruptedStudioReview(review: StudioReview): StudioReview {
  return {
    ...review,
    entries: review.entries.map((entry) =>
      entry.phase === 'submitting'
        ? {
            ...entry,
            phase: 'uncertain',
            error:
              'Submission was interrupted. Recover the original request before starting another.',
          }
        : entry,
    ),
  };
}
export async function quoteStudioReview(
  review: StudioReview,
  client: Pick<MediaClient, 'quote'>,
  key: () => string = () => crypto.randomUUID(),
): Promise<StudioReview> {
  if (hasUncertainStudioApproval(review))
    fail('Recover the original approvals before requesting new quotes.');
  const entries = await Promise.all(
    review.entries.map(async (entry): Promise<StudioReviewEntry> => {
      if (entry.phase === 'accepted') return entry;
      try {
        const quote = await client.quote({
          projectId: review.projectId,
          routeVersionId: entry.route.versionId,
          input: {
            prompt: review.prompt,
            privacy: 'standard',
            options: entry.options,
          },
        });
        if (quote.modelId !== entry.route.modelId)
          fail('The quote model changed. Refresh the reviewed routes.');
        const variant = entry.route.pricing.variants.find(
          (v) =>
            studioVariantKey(v.options) === studioVariantKey(entry.options),
        );
        const maximum = variant
          ? (BigInt(variant.providerUsd6) *
              BigInt(10000 + entry.route.pricing.markupBps) +
              9999n) /
            10000n
          : null;
        if (
          !variant ||
          quote.providerMaximumUsd6 !== variant.providerUsd6 ||
          quote.maximumUsd6 !== maximum?.toString()
        )
          fail(
            'The quote price changed. Refresh the reviewed routes before approving.',
          );
        return {
          ...entry,
          quote,
          approval: makeMediaApproval(quote, key()),
          phase: 'quoted',
          error: null,
        };
      } catch (failure) {
        return {
          ...entry,
          quote: null,
          approval: null,
          phase: 'unquoted',
          error: mediaErrorMessage(failure),
        };
      }
    }),
  );
  return { ...review, entries };
}
/** Sequential by intent: stop after the first failed/ambiguous paid submission. Recovery only touches unknown rows. */
export async function submitStudioReview(
  original: StudioReview,
  client: Pick<MediaClient, 'create'>,
  control: { current: () => boolean; update: (review: StudioReview) => void },
): Promise<StudioReview> {
  let review = original;
  const recovery = hasUncertainStudioApproval(review);
  const targets = review.entries.filter((entry) =>
    recovery ? entry.phase === 'uncertain' : entry.phase === 'quoted',
  );
  if (!targets.length || (!recovery && studioPendingMaximum(review) === null))
    fail('Review every remaining model quote before approving.');
  for (const target of targets) {
    if (!control.current()) return review;
    if (!target.approval || !target.quote)
      fail(
        'The original approval is missing. Read the saved jobs before continuing.',
      );
    if (!recovery && Date.parse(target.quote.expiresAt) <= Date.now())
      fail('A quote expired. Refresh the remaining quotes before approving.');
    const setEntry = (change: Partial<StudioReviewEntry>) => {
      review = {
        ...review,
        entries: review.entries.map((entry) =>
          entry.family === target.family ? { ...entry, ...change } : entry,
        ),
      };
      control.update(review);
    };
    setEntry({ phase: 'submitting', error: null });
    try {
      const result = await client.create(target.approval);
      if (!control.current()) return review;
      if (
        result.job.projectId !== review.projectId ||
        result.job.routeVersionId !== target.route.versionId ||
        result.job.modelId !== target.route.modelId ||
        result.job.input.prompt !== review.prompt ||
        studioVariantKey(result.job.input.options) !==
          studioVariantKey(target.options)
      )
        throw new MediaClientError(
          'INVALID_RESPONSE',
          'The accepted result could not be matched to this approval.',
          0,
          true,
        );
      setEntry({ phase: 'accepted', job: result.job, error: null });
    } catch (failure) {
      if (!control.current()) return review;
      setEntry({
        phase:
          failure instanceof MediaClientError &&
          !failure.outcomeUnknown &&
          failure.status >= 400 &&
          failure.status < 500
            ? 'rejected'
            : 'uncertain',
        error: mediaErrorMessage(failure),
      });
      break;
    }
  }
  return review;
}
export function isPendingStudioJob(job: MediaJob) {
  return (
    ['queued', 'dispatching', 'polling'].includes(job.state) ||
    (job.state === 'reconciliation_pending' && job.canRecover) ||
    (job.state === 'completed' &&
      ['queued', 'processing', 'retry'].includes(job.processingState ?? ''))
  );
}
