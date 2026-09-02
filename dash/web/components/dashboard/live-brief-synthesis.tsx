'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { CanvasBrief } from './canvas-state';
import type { BriefDocument } from '../../lib/brief-document';
import type { ServiceRoute } from '../../lib/client/workspace';
import { formatAccountUsd6 } from '../../lib/client/account-records';
import {
  BriefSynthesisError,
  createBriefSynthesisClient,
  synthesisApproval,
  synthesisErrorMessage,
  synthesisPending,
  type SynthesisCapability,
  type SynthesisRun,
} from '../../lib/client/brief-synthesis';
import { BriefSynthesisResult } from './brief-synthesis-result';

type Props = {
  brief: CanvasBrief;
  accountId: string;
  visible: boolean;
  onRefreshBrief: (id: string) => Promise<boolean>;
};
const usd = (amount: string) => `$${formatAccountUsd6(amount)}`;
const utc = (value: string) =>
  new Date(value).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
const stateLabel: Record<SynthesisRun['state'], string> = {
  quoted: 'Awaiting approval',
  queued: 'Queued',
  running: 'Generating',
  reconciliation_pending: 'Checking billing outcome',
  awaiting_evaluation: 'Ready for output validation',
  valid: 'Analysis ready',
  invalid: 'Analysis could not be used',
  failed: 'Request failed',
  cancelled: 'Cancelled',
};
function mergeRuns(old: SynthesisRun[], incoming: SynthesisRun[]) {
  const map = new Map(old.map((run) => [run.id, run]));
  for (const run of incoming) map.set(run.id, run);
  return [...map.values()].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

export function LiveBriefSynthesis(props: Props) {
  if (!props.brief.live?.document) return null;
  return (
    <SynthesisPanel
      key={`${props.accountId}:${props.brief.id}:${props.brief.roomId}:${props.brief.live.document.evidenceHash}`}
      {...props}
      document={props.brief.live.document}
    />
  );
}

function SynthesisPanel({
  brief,
  accountId,
  visible,
  onRefreshBrief,
  document: sourceDocument,
}: Props & { document: BriefDocument }) {
  const [scope] = useState(() => ({
    briefId: brief.id,
    projectId: brief.roomId,
    document: sourceDocument,
  }));
  const [capability, setCapability] = useState<SynthesisCapability | null>(
    null,
  );
  const [routes, setRoutes] = useState<ServiceRoute[]>([]);
  const [runs, setRuns] = useState<SynthesisRun[]>([]);
  const [focused, setFocused] = useState<SynthesisRun | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [routeId, setRouteId] = useState('');
  const [maxTokens, setMaxTokens] = useState(2048);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState<SynthesisRun | null>(null);
  const [invalidSession, setInvalidSession] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const life = useRef<AbortController | null>(null);
  const busyRef = useRef(false),
    revision = useRef(0);
  const runsRef = useRef(runs),
    focusRef = useRef(focused);
  useLayoutEffect(() => {
    runsRef.current = runs;
    focusRef.current = focused;
  }, [runs, focused]);
  useLayoutEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    const reset = () => {
      controller.abort();
      revision.current++;
      setInvalidSession(true);
      setRuns([]);
      setFocused(null);
      setUncertain(null);
      setRoutes([]);
      setBusy(false);
    };
    window.addEventListener('conclave:session-change', reset);
    return () => {
      controller.abort();
      window.removeEventListener('conclave:session-change', reset);
    };
  }, []);
  const context = useCallback(() => {
    const controller = life.current;
    if (!controller || controller.signal.aborted) return null;
    return {
      client: createBriefSynthesisClient(
        { accountId, signal: controller.signal },
        scope,
      ),
      current: () => life.current === controller && !controller.signal.aborted,
    };
  }, [accountId, scope]);
  const install = useCallback((run: SynthesisRun) => {
    setRuns((old) => mergeRuns(old, [run]));
    setFocused(run);
  }, []);
  const act = useCallback(
    async (
      work: (ctx: NonNullable<ReturnType<typeof context>>) => Promise<void>,
    ) => {
      const ctx = context();
      if (!ctx || busyRef.current) return;
      busyRef.current = true;
      revision.current++;
      setBusy(true);
      setError('');
      try {
        await work(ctx);
      } catch (error) {
        if (ctx.current()) setError(synthesisErrorMessage(error));
      } finally {
        if (ctx.current()) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [context],
  );
  const refresh = useCallback(
    () =>
      act(async (ctx) => {
        const [page, cap, available] = await Promise.allSettled([
          ctx.client.list(),
          ctx.client.capability(),
          ctx.client.routes(),
        ]);
        if (!ctx.current()) return;
        setCapability(cap.status === 'fulfilled' ? cap.value : null);
        if (available.status === 'fulfilled') {
          setRoutes(available.value);
          setRouteId((old) =>
            available.value.some((route) => route.versionId === old)
              ? old
              : (available.value[0]?.versionId ?? ''),
          );
        } else {
          setRoutes([]);
          setRouteId('');
        }
        if (page.status === 'rejected') throw page.reason;
        setRuns(page.value.runs);
        setNextCursor(page.value.nextCursor);
        setLoaded(true);
        const previous = focusRef.current;
        const selected =
          page.value.runs.find((run) => run.id === previous?.id) ??
          page.value.runs[0];
        if (selected) {
          const full = await ctx.client.get(selected.id, selected);
          if (ctx.current()) {
            install(full);
            setUncertain(null);
          }
        } else {
          setFocused(null);
          setUncertain(null);
        }
        if (ctx.current()) await onRefreshBrief(scope.briefId);
      }),
    [act, install, onRefreshBrief, scope.briefId],
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void refresh();
    });
    return () => cancelAnimationFrame(frame);
  }, [refresh]);
  const hasPollableRuns = runs.some(
    (run) => synthesisPending(run.state) && run.state !== 'awaiting_evaluation',
  );
  useEffect(() => {
    if (!visible || invalidSession || !hasPollableRuns) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const ctx = context(),
        version = revision.current;
      if (ctx && !busyRef.current && document.visibilityState === 'visible') {
        const pending = runsRef.current
          .filter(
            (run) =>
              synthesisPending(run.state) &&
              run.state !== 'awaiting_evaluation',
          )
          .slice(0, 4);
        const updates = await Promise.allSettled(
          pending.map((run) => ctx.client.get(run.id, run)),
        );
        if (
          !cancelled &&
          ctx.current() &&
          document.visibilityState === 'visible' &&
          version === revision.current &&
          !busyRef.current
        ) {
          const values = updates.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
          );
          if (values.length) {
            setRuns((old) => mergeRuns(old, values));
            setFocused(
              (old) => values.find((run) => run.id === old?.id) ?? old,
            );
          }
        }
      }
      if (!cancelled)
        timer = setTimeout(() => {
          void poll();
        }, 4000);
    };
    timer = setTimeout(() => {
      void poll();
    }, 4000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [visible, invalidSession, hasPollableRuns, context]);
  const quote = () =>
    act(async (ctx) => {
      try {
        const run = await ctx.client.quote(routeId, maxTokens);
        if (ctx.current()) install(run);
      } catch (error) {
        if (ctx.current()) setLoaded(false);
        throw error;
      }
    });
  const approve = (run: SynthesisRun) =>
    act(async (ctx) => {
      try {
        const result = await ctx.client.approve(run, synthesisApproval(run));
        if (ctx.current()) {
          install(result.run);
          setUncertain(null);
        }
      } catch (error) {
        if (
          ctx.current() &&
          error instanceof BriefSynthesisError &&
          error.outcomeUnknown
        )
          setUncertain(run);
        throw error;
      }
    });
  const read = (run: SynthesisRun) =>
    act(async (ctx) => {
      const saved = await ctx.client.get(run.id, run);
      if (ctx.current()) {
        install(saved);
        setUncertain(null);
      }
    });
  const select = (runId: string | null) =>
    act(async (ctx) => {
      await ctx.client.select(brief.live!.revision, runId);
      if (ctx.current() && !(await onRefreshBrief(brief.id)))
        throw new Error('REFRESH_REQUIRED');
    });
  const selectedId = sourceDocument.synthesis?.runId ?? null;
  const pending = runs.some((run) => synthesisPending(run.state));
  const unexpired = runs.some(
    (run) => run.state === 'quoted' && Date.parse(run.quote.expiresAt) > now,
  );
  const chosenRoute = routes.find((route) => route.versionId === routeId);
  const tokenLimit = Math.min(
    capability?.limits.maxOutputTokens ?? 8192,
    chosenRoute?.pricing.maxOutputTokens ?? 8192,
  );
  useEffect(() => {
    if (!visible || invalidSession || !unexpired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible, invalidSession, unexpired]);
  if (invalidSession)
    return (
      <output className="cp-fineprint">
        Your session changed. Reopen this Brief after signing in.
      </output>
    );
  return (
    <section
      aria-label="Generate Brief analysis"
      style={{ display: 'grid', gap: 16, marginTop: 24 }}
    >
      <h3 style={{ fontSize: 14 }}>Generated analysis</h3>
      <p className="cp-fineprint">
        Summarize the {scope.document.evidence.length} saved responses and
        compare their positions. The saved questions, answers, and source labels
        are sent; your decision and notes stay separate.
      </p>
      <button
        type="button"
        className="cp-button"
        disabled={busy}
        onClick={() => void refresh()}
      >
        Read saved analysis requests
      </button>
      {error && (
        <p role="alert" className="cp-fineprint">
          {error}
        </p>
      )}
      {!loaded && (
        <output className="cp-fineprint">
          Read saved requests before creating an analysis.
        </output>
      )}
      {loaded && !capability?.configured && (
        <p className="cp-fineprint">
          Generation is unavailable. Previously saved requests and results
          remain readable.
        </p>
      )}
      {loaded && capability?.configured && (
        <form
          className="cw-simple-form"
          onSubmit={(event) => {
            event.preventDefault();
            void quote();
          }}
        >
          <label>
            Analysis model
            <select
              value={routeId}
              disabled={busy || !!uncertain}
              onChange={(event) => setRouteId(event.target.value)}
            >
              {routes.length === 0 && (
                <option value="">No reviewed routes available</option>
              )}
              {routes.map((route) => (
                <option key={route.versionId} value={route.versionId}>
                  {route.modelId} · route {route.versionId.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Maximum output tokens
            <input
              type="number"
              min={1}
              max={tokenLimit}
              value={maxTokens}
              disabled={busy || !!uncertain}
              onChange={(event) => setMaxTokens(Number(event.target.value))}
            />
          </label>
          {chosenRoute && (
            <p className="cp-fineprint">
              Standard processing: {chosenRoute.card.retentionDisclosure}
            </p>
          )}
          <button
            type="submit"
            className="cp-button"
            disabled={
              busy ||
              !!uncertain ||
              pending ||
              unexpired ||
              !chosenRoute ||
              !Number.isInteger(maxTokens) ||
              maxTokens < 1 ||
              maxTokens > tokenLimit
            }
          >
            Get an exact quote
          </button>
          {(pending || unexpired) && (
            <p className="cp-fineprint">
              Review the saved request below before creating another.
            </p>
          )}
        </form>
      )}
      {uncertain && (
        <div aria-live="polite">
          <p>
            Approval may have completed. Keep this saved request and its
            original approval key.
          </p>
          <button
            type="button"
            className="cp-button"
            disabled={busy}
            onClick={() => void read(uncertain)}
          >
            Read saved approval status
          </button>
          <button
            type="button"
            className="cp-button"
            disabled={busy}
            onClick={() => void approve(uncertain)}
          >
            Recover the same approval
          </button>
        </div>
      )}
      {focused && (
        <div style={{ display: 'grid', gap: 12 }}>
          <h4>
            {focused.quote.modelId} · {stateLabel[focused.state]}
          </h4>
          <dl className="ct-facts">
            <div>
              <dt>Analysis maximum</dt>
              <dd>{usd(focused.quote.maximumUsd6)}</dd>
            </div>
            <div>
              <dt>Analysis charge</dt>
              <dd>
                {focused.billing?.actualUsd6 == null
                  ? 'Not settled'
                  : usd(focused.billing.actualUsd6)}
              </dd>
            </div>
            <div>
              <dt>Route</dt>
              <dd>{focused.quote.routeVersionId}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{utc(focused.createdAt)}</dd>
            </div>
          </dl>
          <p className="cp-fineprint">
            This charge is separate from the original responses.{' '}
            {focused.quote.card.retentionDisclosure}
          </p>
          {focused.state === 'quoted' && (
            <>
              <p className="cp-fineprint">
                Quote expires {utc(focused.quote.expiresAt)}. Maximum{' '}
                {focused.quote.maxOutputTokens} output tokens. Your saved source
                evidence is fixed for this request.
              </p>
              <button
                type="button"
                className="cp-button cp-button--ink"
                disabled={
                  busy ||
                  !!uncertain ||
                  focused.briefId === null ||
                  Date.parse(focused.quote.expiresAt) <= now ||
                  !capability?.configured
                }
                onClick={() => void approve(focused)}
              >
                Approve up to {usd(focused.quote.maximumUsd6)}
              </button>
            </>
          )}
          {focused.state === 'awaiting_evaluation' && (
            <button
              type="button"
              className="cp-button"
              disabled={busy}
              onClick={() =>
                void act(async (ctx) => {
                  const run = await ctx.client.evaluate(focused);
                  if (ctx.current()) install(run);
                })
              }
            >
              Validate saved output · no new model request
            </button>
          )}
          {['queued', 'running', 'reconciliation_pending'].includes(
            focused.state,
          ) && (
            <button
              type="button"
              className="cp-button"
              disabled={busy || !!uncertain}
              onClick={() =>
                void act(async (ctx) => {
                  await ctx.client.cancel(focused.id);
                  const run = await ctx.client.get(focused.id, focused);
                  if (ctx.current()) install(run);
                })
              }
            >
              Request cancellation
            </button>
          )}
          {focused.state === 'invalid' && (
            <p className="cp-fineprint">
              The output could not be used as a sourced analysis. Any confirmed
              provider charge is retained; no automatic replacement is
              requested.
            </p>
          )}
          {focused.result?.analysis && (
            <>
              {focused.id !== selectedId && (
                <BriefSynthesisResult
                  analysis={focused.result.analysis}
                  evidence={scope.document.evidence}
                />
              )}
              <button
                type="button"
                className="cp-button"
                disabled={busy || focused.id === selectedId}
                onClick={() => void select(focused.id)}
              >
                {focused.id === selectedId
                  ? 'Included in this Brief'
                  : 'Use this analysis in the Brief'}
              </button>
            </>
          )}
        </div>
      )}
      {selectedId && (
        <button
          type="button"
          className="cp-button"
          disabled={busy}
          onClick={() => void select(null)}
        >
          Remove generated analysis from the Brief
        </button>
      )}
      {runs.length > 0 && (
        <details>
          <summary>Analysis request history ({runs.length})</summary>
          <ul>
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="cp-button"
                  disabled={busy}
                  onClick={() => void read(run)}
                >
                  {run.quote.modelId} · {stateLabel[run.state]} ·{' '}
                  {utc(run.createdAt)}
                </button>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <button
              type="button"
              className="cp-button"
              disabled={busy}
              onClick={() =>
                void act(async (ctx) => {
                  const page = await ctx.client.list(nextCursor);
                  if (ctx.current()) {
                    setRuns((old) => mergeRuns(old, page.runs));
                    setNextCursor(page.nextCursor);
                  }
                })
              }
            >
              Load older requests
            </button>
          )}
        </details>
      )}
    </section>
  );
}
