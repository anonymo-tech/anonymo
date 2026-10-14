'use client';

import { useT, type Translator } from '@/lib/i18n';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createMediaClient,
  mediaAssetUrl,
  mediaErrorMessage,
  MediaClientError,
  type MediaCapability,
  type MediaJob,
  type MediaRoute,
  type MediaClient,
} from '../../lib/client/media';
import {
  changeStudioVariant,
  hasUncertainStudioApproval,
  interruptedStudioReview,
  isPendingStudioJob,
  prepareStudioReview,
  quoteStudioReview,
  studioRoutes,
  submitStudioReview,
  type StudioDraftPreference,
  type StudioReview,
} from '../../lib/client/studio-review';
import { useContentGuard } from './use-content-guard';

/** Translate display messages while retaining the original request and error data. */
export function studioMessage(message: string, t: Translator): string {
  let match =
    /^(Sora|A selected model) has no supported live media route\. Change the selection before continuing\.$/.exec(
      message,
    );
  if (match)
    return t(
      '{model} has no supported live media route. Change the selection before continuing.',
      {
        model:
          match[1] === 'A selected model' ? t('A selected model') : match[1],
      },
    );
  match =
    /^(Runway|Veo|Kling) has no currently reviewed video route\. Refresh the routes or change the model selection\.$/.exec(
      message,
    );
  if (match)
    return t(
      '{model} has no currently reviewed video route. Refresh the routes or change the model selection.',
      { model: match[1] },
    );
  match =
    /^(Runway|Veo|Kling) has no reviewed (16:9|9:16|1:1) option\. Change the frame explicitly before continuing\.$/.exec(
      message,
    );
  if (match)
    return t(
      '{model} has no reviewed {ratio} option. Change the frame explicitly before continuing.',
      { model: match[1], ratio: match[2] },
    );
  match = /^(Runway|Veo|Kling) requires a shorter description\.$/.exec(message);
  if (match)
    return t('{model} requires a shorter description.', { model: match[1] });
  return t(message);
}

export type { StudioDraftPreference, StudioReview };
type StudioState = {
  scope: string;
  status: 'loading' | 'ready' | 'error';
  capability: MediaCapability | null;
  routes: MediaRoute[];
  jobs: MediaJob[];
  review: StudioReview | null;
  nextCursor: string | null;
  busy: boolean;
  error: string | null;
};
type Runtime = {
  scope: string;
  accountId: string;
  projectId: string;
  controller: AbortController;
  busy: boolean;
  revision: number;
};
const empty = (scope = ''): StudioState => ({
  scope,
  status: 'loading',
  capability: null,
  routes: [],
  jobs: [],
  review: null,
  nextCursor: null,
  busy: false,
  error: null,
});
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function mergeJobs(current: MediaJob[], incoming: MediaJob[]) {
  const map = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = map.get(job.id);
    if (
      !previous ||
      Date.parse(job.updatedAt) >= Date.parse(previous.updatedAt)
    )
      map.set(job.id, job);
  }
  return [...map.values()].sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      b.id.localeCompare(a.id),
  );
}

/** Private media and approvals remain in memory; the active account and project fence every request. */
export function useLiveStudio({
  accountId,
  projectId,
  active,
}: {
  accountId: string | null;
  projectId: string | null;
  active: boolean;
}) {
  const t = useT();
  const scope =
    accountId && projectId && uuid.test(accountId) && uuid.test(projectId)
      ? `${accountId.toLowerCase()}:${projectId.toLowerCase()}`
      : '';
  const [state, setState] = useState<StudioState>(empty);
  const stateRef = useRef(state),
    runtime = useRef<Runtime | null>(null);
  const reviews = useRef(new Map<string, StudioReview>()),
    cacheOwner = useRef<string | null>(null);
  const checkContent = useContentGuard();
  const current = useCallback(
    (run: Runtime) => runtime.current === run && !run.controller.signal.aborted,
    [],
  );
  const install = useCallback(
    (run: Runtime, change: Partial<StudioState>) => {
      if (!current(run)) return;
      const previous =
        stateRef.current.scope === run.scope
          ? stateRef.current
          : empty(run.scope);
      const next = { ...previous, ...change, scope: run.scope };
      stateRef.current = next;
      if (next.review) reviews.current.set(run.scope, next.review);
      else reviews.current.delete(run.scope);
      setState(next);
    },
    [current],
  );
  const report = useCallback(
    (run: Runtime, failure: unknown) => {
      if (
        !current(run) ||
        (failure instanceof Error && failure.name === 'AbortError')
      )
        return;
      install(run, { error: mediaErrorMessage(failure) });
      if (failure instanceof MediaClientError && failure.status === 401)
        window.dispatchEvent(
          new CustomEvent('conclave:session-change', {
            detail: { reason: 'signed-out' },
          }),
        );
    },
    [current, install],
  );

  useEffect(() => {
    const reviewCache = reviews.current;
    if (cacheOwner.current !== accountId) {
      reviews.current.clear();
      cacheOwner.current = accountId;
    }
    if (!scope || !accountId || !projectId) {
      runtime.current = null;
      const frame = requestAnimationFrame(() => {
        stateRef.current = empty();
        setState(empty());
      });
      return () => cancelAnimationFrame(frame);
    }
    const run: Runtime = {
      scope,
      accountId: accountId.toLowerCase(),
      projectId: projectId.toLowerCase(),
      controller: new AbortController(),
      busy: true,
      revision: 0,
    };
    runtime.current = run;
    const reset = () => {
      run.controller.abort();
      reviews.current.clear();
      runtime.current = null;
      stateRef.current = empty();
      setState(empty());
    };
    window.addEventListener('conclave:session-change', reset);
    const frame = requestAnimationFrame(() => {
      if (!current(run)) return;
      const cached = reviews.current.get(scope);
      install(run, {
        ...empty(scope),
        busy: true,
        review: cached ? interruptedStudioReview(cached) : null,
      });
      const client = createMediaClient(run.accountId, {
        signal: run.controller.signal,
      });
      void Promise.allSettled([
        client.capabilities(),
        client.routes(),
        client.list(run.projectId),
      ]).then(([capability, routes, page]) => {
        if (!current(run)) return;
        install(run, {
          capability:
            capability.status === 'fulfilled' ? capability.value : null,
          routes:
            routes.status === 'fulfilled' ? studioRoutes(routes.value) : [],
          jobs: page.status === 'fulfilled' ? page.value.jobs : [],
          nextCursor:
            page.status === 'fulfilled' ? page.value.nextCursor : null,
          status: page.status === 'fulfilled' ? 'ready' : 'error',
          busy: false,
        });
        run.busy = false;
        for (const result of [capability, routes, page])
          if (result.status === 'rejected') report(run, result.reason);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      run.controller.abort();
      const pending = reviewCache.get(scope);
      if (pending) reviewCache.set(scope, interruptedStudioReview(pending));
      window.removeEventListener('conclave:session-change', reset);
      if (runtime.current === run) runtime.current = null;
    };
  }, [accountId, projectId, scope, current, install, report]);

  // Render a fresh empty view immediately when props change, before effect cleanup.
  const visible = state.scope === scope && scope ? state : empty(scope);
  const pollingNeeded = visible.jobs.some(isPendingStudioJob);
  useEffect(() => {
    if (!active || !scope || !pollingNeeded) return;
    const run = runtime.current;
    if (!run || run.scope !== scope) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    run.controller.signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout>,
      offset = 0;
    const poll = async () => {
      if (!current(run) || controller.signal.aborted) return;
      let delay = 6000;
      if (!run.busy && document.visibilityState !== 'hidden') {
        const pending = stateRef.current.jobs.filter(isPendingStudioJob),
          revision = run.revision;
        if (!pending.length) return;
        const selected = Array.from(
          { length: Math.min(4, pending.length) },
          (_, i) => pending[(offset + i) % pending.length],
        );
        offset = (offset + selected.length) % pending.length;
        const client = createMediaClient(run.accountId, {
          signal: controller.signal,
        });
        const results = await Promise.allSettled(
          selected.map((job) => client.get(job.id)),
        );
        if (!current(run) || controller.signal.aborted) return;
        if (!run.busy && revision === run.revision) {
          const jobs: MediaJob[] = [];
          for (const result of results) {
            if (result.status === 'fulfilled') jobs.push(result.value);
            else {
              report(run, result.reason);
              delay = 15000;
            }
          }
          install(run, { jobs: mergeJobs(stateRef.current.jobs, jobs) });
        }
      }
      if (current(run) && !controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, delay);
    };
    timer = setTimeout(() => {
      void poll();
    }, 6000);
    return () => {
      clearTimeout(timer);
      controller.abort();
      run.controller.signal.removeEventListener('abort', abort);
    };
  }, [active, scope, pollingNeeded, current, install, report]);

  async function action(
    work: (client: MediaClient, run: Runtime) => Promise<void>,
  ) {
    const run = runtime.current;
    if (!run || run.scope !== scope || !current(run) || run.busy) return false;
    run.busy = true;
    run.revision++;
    install(run, { busy: true, error: null });
    try {
      await work(
        createMediaClient(run.accountId, { signal: run.controller.signal }),
        run,
      );
      return current(run);
    } catch (failure) {
      report(run, failure);
      return false;
    } finally {
      if (current(run)) {
        run.busy = false;
        install(run, { busy: false });
      }
    }
  }
  const saveReview = (run: Runtime, review: StudioReview) => {
    if (!current(run)) return;
    install(run, {
      review,
      jobs: mergeJobs(
        stateRef.current.jobs,
        review.entries.flatMap((entry) => (entry.job ? [entry.job] : [])),
      ),
    });
  };
  async function requestReview(draft: StudioDraftPreference) {
    const snapshot = structuredClone(draft);
    return action(async (client, run) => {
      const previous = stateRef.current.review;
      if (
        previous &&
        (hasUncertainStudioApproval(previous) ||
          previous.entries.some((entry) => entry.phase === 'accepted'))
      )
        throw new MediaClientError(
          'STUDIO_REVIEW_REQUIRED',
          'Resolve or close the existing review before preparing another request. Accepted jobs will not be resubmitted.',
        );
      if (!stateRef.current.capability?.configured)
        throw new MediaClientError(
          'MEDIA_CONFIGURATION_REQUIRED',
          'Live media generation is unavailable. Saved jobs remain readable; no model was called.',
        );
      const prepared = prepareStudioReview(
        snapshot,
        stateRef.current.routes,
        run.projectId,
      );
      const checked = await checkContent(prepared.prompt);
      if (!current(run)) return;
      if (checked.findings.some((finding) => finding.severity === 'block'))
        throw new MediaClientError(
          'SENSITIVE_CONTENT',
          'The content check blocked this description. Remove detected secrets, or try again if the check is unavailable. Nothing was sent.',
        );
      saveReview(run, prepared);
      const quoted = await quoteStudioReview(prepared, client);
      if (current(run)) saveReview(run, quoted);
    });
  }
  const selectVariant = (family: string, key: string) => {
    const run = runtime.current;
    if (
      !run ||
      run.scope !== scope ||
      !current(run) ||
      run.busy ||
      !stateRef.current.review
    )
      return false;
    try {
      run.revision++;
      saveReview(
        run,
        changeStudioVariant(stateRef.current.review, family, key),
      );
      install(run, { error: null });
      return true;
    } catch (failure) {
      report(run, failure);
      return false;
    }
  };
  const refreshQuotes = () =>
    action(async (client, run) => {
      const review = stateRef.current.review;
      if (!review) return;
      const quoted = await quoteStudioReview(review, client);
      if (current(run)) saveReview(run, quoted);
    });
  const approve = () =>
    action(async (client, run) => {
      const review = stateRef.current.review;
      if (!review) return;
      await submitStudioReview(review, client, {
        current: () => current(run),
        update: (next) => saveReview(run, next),
      });
    });
  const dismissReview = () => {
    const run = runtime.current,
      review = stateRef.current.review;
    if (
      !run ||
      run.scope !== scope ||
      !current(run) ||
      run.busy ||
      (review && hasUncertainStudioApproval(review))
    )
      return false;
    run.revision++;
    install(run, { review: null, error: null });
    return true;
  };
  const refresh = () =>
    action(async (client, run) => {
      const [capability, routes, page] = await Promise.all([
        client.capabilities(),
        client.routes(),
        client.list(run.projectId),
      ]);
      if (current(run))
        install(run, {
          capability,
          routes: studioRoutes(routes),
          jobs: mergeJobs(stateRef.current.jobs, page.jobs),
          nextCursor: page.nextCursor,
          status: 'ready',
        });
    });
  const loadMore = () =>
    action(async (client, run) => {
      const cursor = stateRef.current.nextCursor;
      if (!cursor) return;
      const page = await client.list(run.projectId, cursor);
      if (current(run))
        install(run, {
          jobs: mergeJobs(stateRef.current.jobs, page.jobs),
          nextCursor: page.nextCursor,
        });
    });
  const jobAction = (id: string, recover: boolean) =>
    action(async (client, run) => {
      if (!stateRef.current.jobs.some((job) => job.id === id))
        throw new MediaClientError(
          'MEDIA_NOT_FOUND',
          'Refresh this project before changing a saved job.',
        );
      const result = recover
        ? await client.recover(id)
        : await client.cancel(id);
      if (current(run))
        install(run, { jobs: mergeJobs(stateRef.current.jobs, [result.job]) });
    });
  const deleteClip = (id: string) =>
    action(async (client, run) => {
      const job = stateRef.current.jobs.find(
        (item) => item.id === id && item.projectId === run.projectId,
      );
      if (!job?.asset || job.mediaAssetState !== 'stored')
        throw new MediaClientError(
          'MEDIA_NOT_FOUND',
          'Choose a saved clip in this project before deleting it.',
        );
      await client.deleteAsset(job.asset.id);
      if (!current(run)) return;
      // The confirmed deletion invalidates playback immediately. Billing is retained,
      // including when the following read is interrupted; deletion is not a refund.
      install(run, {
        jobs: stateRef.current.jobs.map((item) =>
          item.id === id
            ? {
                ...item,
                asset: null,
                mediaAssetState: 'deleted',
                deliveryReady: false,
              }
            : item,
        ),
      });
      const saved = await client.get(id);
      if (current(run))
        install(run, { jobs: mergeJobs(stateRef.current.jobs, [saved]) });
    });
  return {
    status: !scope ? ('unavailable' as const) : visible.status,
    capability: visible.capability,
    routes: visible.routes,
    jobs: visible.jobs,
    availableModels: [
      ...new Set(studioRoutes(visible.routes).map((route) => route.family)),
    ],
    review: visible.review,
    busy: visible.busy,
    error: visible.error ? studioMessage(visible.error, t) : null,
    nextCursor: visible.nextCursor,
    requestReview,
    selectVariant,
    refreshQuotes,
    approve,
    dismissReview,
    refresh,
    loadMore,
    cancel: (id: string) => jobAction(id, false),
    recover: (id: string) => jobAction(id, true),
    deleteClip,
    assetUrl: (job: MediaJob, download = false) =>
      accountId &&
      scope &&
      job.projectId === projectId?.toLowerCase() &&
      visible.jobs.some(
        (item) => item.id === job.id && item.asset?.id === job.asset?.id,
      ) &&
      job.deliveryReady &&
      job.asset
        ? mediaAssetUrl(job.asset.id, accountId, { download })
        : null,
  };
}

export type LiveStudioController = ReturnType<typeof useLiveStudio>;
