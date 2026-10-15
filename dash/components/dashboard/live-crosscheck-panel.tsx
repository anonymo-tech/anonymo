'use client';

import { useT } from '@/lib/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Info, AlertTriangle } from 'lucide-react';
import { MotionIcon } from './motion-icon';
import { useContentGuard } from './use-content-guard';
import {
  createWorkspaceClient,
  formatUsd6,
  type ServiceProject,
} from '../../lib/client/workspace';
import {
  createCrossCheckClient,
  crossCheckErrorMessage,
  CrossCheckClientError,
  guardCrossCheckText,
  makeCrossCheckApproval,
  type CrossCheckApproval,
  type CrossCheckCapability,
  type CrossCheckQuote,
  type CrossCheckView,
  type ReviewerRoster,
  type RunSummary,
  type SourceSummary,
} from '../../lib/client/crosscheck';

type PendingApproval = {
  quote: CrossCheckQuote;
  approval: CrossCheckApproval;
  phase: 'quoted' | 'uncertain';
};
const verdictLabel = {
  HOLDS: 'Holds against these sources',
  DOES_NOT_HOLD: 'Does not hold against these sources',
  NO_CONSENSUS: 'No consensus',
  PARTLY: 'Partly supported',
};
const blankSource = { title: '', uri: '', text: '' };
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export function LiveCrossCheckPanel({
  accountId,
}: {
  accountId: string | null;
}) {
  const t = useT();
  const labelId = useId(),
    checkContent = useContentGuard();
  const [projects, setProjects] = useState<ServiceProject[]>([]),
    [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [capability, setCapability] = useState<CrossCheckCapability | null>(
      null,
    ),
    [rosters, setRosters] = useState<ReviewerRoster[]>([]),
    [rosterId, setRosterId] = useState('');
  const [sources, setSources] = useState<SourceSummary[]>([]),
    [sourceCursor, setSourceCursor] = useState<string | null>(null),
    [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourceDraft, setSourceDraft] = useState(blankSource),
    [claims, setClaims] = useState([{ id: 'claim-1', text: '' }]);
  const [runs, setRuns] = useState<RunSummary[]>([]),
    [runCursor, setRunCursor] = useState<string | null>(null);
  const [run, setRun] = useState<CrossCheckView | null>(null),
    [pending, setPending] = useState<PendingApproval | null>(null);
  const [cacheHit, setCacheHit] = useState(false),
    [warnings, setWarnings] = useState<string[]>([]),
    [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!!accountId),
    [now, setNow] = useState(Date.now);
  const epoch = useRef(0),
    viewRevision = useRef(0),
    mounted = useRef(false),
    blocked = useRef(false),
    busyRef = useRef(false),
    lifetime = useRef<AbortController | null>(null);
  const currentOwner = useRef(accountId),
    pollRead = useRef<AbortController | null>(null);

  const roster = rosters.find((item) => item.id === rosterId);
  const maximumClaims = Math.min(
    24,
    Math.floor(
      (capability?.limits.calls ?? 24) / (roster?.reviewers.length ?? 3),
    ),
  );
  const chosenBytes = sources
    .filter((source) => selectedSources.includes(source.id))
    .reduce((total, source) => total + source.sourceBytes, 0);
  const uncertain = pending?.phase === 'uncertain',
    expired = pending ? Date.parse(pending.quote.expiresAt) <= now : false;
  const locked = busy || !!pending;

  function fail(failure: unknown, generation: number) {
    if (
      !mounted.current ||
      generation !== epoch.current ||
      (failure instanceof Error && failure.name === 'AbortError')
    )
      return;
    setError(crossCheckErrorMessage(failure));
    if (
      (failure instanceof CrossCheckClientError ||
        (failure instanceof Error && 'status' in failure)) &&
      failure.status === 401
    )
      window.dispatchEvent(
        new CustomEvent('conclave:session-change', {
          detail: { reason: 'signed-out' },
        }),
      );
  }
  async function action(
    work: (
      client: ReturnType<typeof createCrossCheckClient>,
      current: () => boolean,
    ) => Promise<void>,
  ) {
    if (!accountId || blocked.current || busyRef.current || !lifetime.current)
      return;
    const generation = epoch.current,
      owner = accountId,
      signal = lifetime.current.signal;
    const current = () =>
      mounted.current &&
      generation === epoch.current &&
      owner === currentOwner.current &&
      !signal.aborted &&
      !blocked.current;
    viewRevision.current++;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work(createCrossCheckClient(owner, { signal }), current);
    } catch (failure) {
      fail(failure, generation);
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function installPage(
    sourcePage: { sources: SourceSummary[]; nextCursor: string | null },
    runPage: { runs: RunSummary[]; nextCursor: string | null },
  ) {
    setSources(sourcePage.sources);
    setSourceCursor(sourcePage.nextCursor);
    setRuns(runPage.runs);
    setRunCursor(runPage.nextCursor);
  }
  useEffect(() => {
    mounted.current = true;
    currentOwner.current = accountId;
    blocked.current = false;
    const controller = new AbortController(),
      generation = ++epoch.current;
    lifetime.current = controller;
    const current = () =>
      mounted.current &&
      generation === epoch.current &&
      !controller.signal.aborted;
    const reset = () => {
      controller.abort();
      epoch.current++;
      blocked.current = true;
      busyRef.current = false;
      setProjects([]);
      setProjectId('');
      setSources([]);
      setSelectedSources([]);
      setRuns([]);
      setRun(null);
      setPending(null);
      setSourceDraft(blankSource);
      setClaims([{ id: 'claim-1', text: '' }]);
      setWarnings([]);
      setError(null);
      setCapability(null);
      setRosters([]);
      setBusy(false);
      setLoading(false);
    };
    window.addEventListener('conclave:session-change', reset);
    if (accountId)
      void (async () => {
        try {
          const client = createCrossCheckClient(accountId, {
            signal: controller.signal,
          });
          const [capability, rosters, page] = await Promise.all([
            client.capability(),
            client.rosters(),
            createWorkspaceClient({
              accountId,
              signal: controller.signal,
            }).projects(),
          ]);
          if (!current()) return;
          setCapability(capability);
          setRosters(rosters);
          setRosterId(rosters[0]?.id ?? '');
          setProjects(page.items);
          setProjectCursor(page.nextCursor);
          const first = page.items[0]?.id;
          if (first) {
            setProjectId(first);
            const [sourcePage, runPage] = await Promise.all([
              client.sources(first),
              client.runs(first),
            ]);
            if (current()) installPage(sourcePage, runPage);
          }
        } catch (failure) {
          fail(failure, generation);
        } finally {
          if (current()) setLoading(false);
        }
      })();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const shutdown = () => {
      mounted.current = false;
      epoch.current++;
      controller.abort();
    };
    return () => {
      shutdown();
      window.clearInterval(timer);
      window.removeEventListener('conclave:session-change', reset);
    };
  }, [accountId]);

  async function chooseProject(id: string) {
    if (locked || loading || run) return;
    await action(async (client, current) => {
      const [sourcePage, runPage] = await Promise.all([
        client.sources(id),
        client.runs(id),
      ]);
      if (!current()) return;
      setProjectId(id);
      installPage(sourcePage, runPage);
      setSelectedSources([]);
      setSourceDraft(blankSource);
      setClaims([{ id: 'claim-1', text: '' }]);
      setWarnings([]);
    });
  }
  async function saveSource() {
    const snapshot = { ...sourceDraft },
      project = projectId;
    if (
      !snapshot.title.trim() ||
      !snapshot.text.trim() ||
      bytes(snapshot.text) > 65536
    ) {
      setError('Give the source a title and provide up to 64 KiB of text.');
      return;
    }
    await action(async (client, current) => {
      const warnings = await guardCrossCheckText(checkContent, [
        snapshot.title,
        snapshot.uri,
        snapshot.text,
      ]);
      if (!current()) return;
      const saved = await client.saveSource({
        projectId: project,
        title: snapshot.title.trim(),
        text: snapshot.text,
        uri: snapshot.uri.trim() || null,
      });
      if (!current()) return;
      const summary: SourceSummary = {
        id: saved.id,
        title: saved.title,
        uri: saved.uri,
        acquisition: saved.acquisition,
        capturedAtMs: saved.capturedAtMs,
        contentHash: saved.contentHash,
        snapshotHash: saved.snapshotHash,
        sourceBytes: bytes(saved.text),
      };
      setSources((current) => [summary, ...current]);
      setSelectedSources((current) =>
        current.length < 8 ? [...current, saved.id] : current,
      );
      setSourceDraft(blankSource);
      setWarnings(warnings);
    });
  }
  async function prepare() {
    const selected = [...selectedSources],
      claimSnapshot = claims.map((claim) => ({
        id: claim.id,
        text: claim.text.trim(),
      })),
      project = projectId,
      chosenRoster = rosterId;
    if (
      !project ||
      !chosenRoster ||
      !selected.length ||
      selected.length > 8 ||
      chosenBytes > 131072 ||
      claimSnapshot.some((claim) => !claim.text) ||
      claimSnapshot.length > maximumClaims
    ) {
      setError(
        'Choose a project, reviewed roster, one to eight sources, and explicit claims within this roster’s limit.',
      );
      return;
    }
    await action(async (client, current) => {
      const snapshots = await Promise.all(
        selected.map((id) => client.source(id, project)),
      );
      if (!current()) return;
      const warnings = await guardCrossCheckText(checkContent, [
        ...claimSnapshot.map((claim) => claim.text),
        ...snapshots.flatMap((source) => [
          source.title,
          source.uri ?? '',
          source.text,
        ]),
      ]);
      if (!current()) return;
      setWarnings(warnings);
      const prepared = await client.prepare({
        projectId: project,
        rosterId: chosenRoster,
        sourceIds: selected,
        claims: claimSnapshot,
      });
      if (!current()) return;
      const saved = await client.read(prepared.run.id, project);
      if (!current()) return;
      setRun(saved);
      setCacheHit(prepared.cacheHit);
      setPending(null);
      if (
        !saved.result &&
        saved.execution?.state === 'not_started' &&
        capability?.configured
      ) {
        const quote = await client.quote(saved);
        if (!current()) return;
        setPending({
          quote,
          approval: makeCrossCheckApproval(quote, crypto.randomUUID()),
          phase: 'quoted',
        });
      }
    });
  }
  async function readRun(id: string) {
    if (pending) return;
    await action(async (client, current) => {
      const saved = await client.read(id, projectId);
      if (current()) {
        setRun(saved);
        setCacheHit(false);
        setWarnings([]);
      }
    });
  }
  async function refreshRun() {
    if (!run) return;
    const savedRun = run;
    await action(async (client, current) => {
      const saved = await client.read(savedRun.id, savedRun.projectId);
      if (current()) {
        setRun(saved);
        if (saved.execution?.state !== 'not_started' || saved.result)
          setPending(null);
      }
    });
  }
  async function requestQuote() {
    if (!run || pending || !capability?.configured) return;
    const savedRun = run;
    await action(async (client, current) => {
      const saved = await client.read(savedRun.id, savedRun.projectId);
      if (!current()) return;
      setRun(saved);
      if (saved.result || saved.execution?.state !== 'not_started') return;
      const warnings = await guardCrossCheckText(checkContent, [
        ...saved.plan.claims.map((claim) => claim.text),
        ...saved.plan.sources.flatMap((source) => [
          source.title,
          source.uri ?? '',
          source.text,
        ]),
      ]);
      if (!current()) return;
      setWarnings(warnings);
      const quote = await client.quote(saved);
      if (current())
        setPending({
          quote,
          approval: makeCrossCheckApproval(quote, crypto.randomUUID()),
          phase: 'quoted',
        });
    });
  }
  async function approve() {
    if (!run || !pending || (!uncertain && expired)) return;
    const savedRun = run,
      frozen = pending;
    await action(async (client, current) => {
      setPending({ ...frozen, phase: 'uncertain' });
      let accepted;
      try {
        accepted = await client.approve(savedRun.id, frozen.approval);
        if (!current()) return;
      } catch (failure) {
        if (current()) {
          if (
            failure instanceof CrossCheckClientError &&
            failure.code === 'CROSSCHECK_ALREADY_STARTED'
          ) {
            const read = await client.read(savedRun.id, savedRun.projectId);
            if (current()) {
              setRun(read);
              if (read.execution?.state !== 'not_started') setPending(null);
            }
          } else if (
            failure instanceof CrossCheckClientError &&
            failure.status >= 400 &&
            failure.status < 500 &&
            ![408, 429].includes(failure.status)
          )
            setPending({ ...frozen, phase: 'quoted' });
        }
        throw failure;
      }
      setRun({ ...savedRun, execution: accepted.execution });
      setPending(null);
      setCacheHit(false);
      const read = await client.read(savedRun.id, savedRun.projectId);
      if (current()) setRun(read);
    });
  }
  const runId = run?.id,
    runProject = run?.projectId;
  const shouldPoll =
    !!run &&
    !run.result &&
    ((!!pending && pending.phase === 'uncertain') ||
      ['queued', 'running', 'awaiting_evaluation'].includes(
        run.execution?.state ?? '',
      ) ||
      run.execution?.calls.some((call) =>
        ['queued', 'running'].includes(call.state),
      ));
  useEffect(() => {
    if (!accountId || !runId || !runProject || !shouldPoll || blocked.current)
      return;
    const controller = new AbortController(),
      generation = epoch.current,
      parent = lifetime.current?.signal;
    pollRead.current = controller;
    const stop = () => controller.abort();
    parent?.addEventListener('abort', stop, { once: true });
    const current = () =>
      mounted.current &&
      generation === epoch.current &&
      !controller.signal.aborted;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const revision = viewRevision.current;
      try {
        if (!busyRef.current && document.visibilityState !== 'hidden') {
          const saved = await createCrossCheckClient(accountId, {
            signal: controller.signal,
          }).read(runId, runProject);
          if (!current()) return;
          if (busyRef.current || revision !== viewRevision.current) {
            timer = setTimeout(() => {
              void poll();
            }, 5000);
            return;
          }
          setRun(saved);
          if (saved.execution?.state !== 'not_started' || saved.result)
            setPending(null);
        }
      } catch (failure) {
        fail(failure, generation);
      }
      if (current())
        timer = setTimeout(() => {
          void poll();
        }, 5000);
    };
    timer = setTimeout(() => {
      void poll();
    }, 5000);
    return () => {
      controller.abort();
      clearTimeout(timer);
      parent?.removeEventListener('abort', stop);
    };
  }, [accountId, runId, runProject, shouldPoll]);

  return (
    <>
      <p className="ct-intro">
        {t(
          'Check explicit claims against text you provide. Independent reviewers see the same source snapshots without one another’s answers. Exact quote checks verify text presence; agreement is not proof that a claim is true.',
        )}
      </p>
      {!accountId && (
        <p className="ct-note">
          {t('Sign in through Account to prepare or read a Cross-Check.')}
        </p>
      )}
      {loading && (
        <output className="ct-note">
          {t('Loading reviewed rosters and your projects…')}
        </output>
      )}
      {capability && !capability.configured && (
        <div className="ct-claim">
          <strong>{t('Live reviews unavailable')}</strong>
          <p>
            {capability.reason === 'REVIEWED_ROSTER_REQUIRED'
              ? t(
                  'The operator must configure a current reviewed roster before model reviews can run.',
                )
              : t(
                  'The operator has not enabled and configured Cross-Check execution. Saving a source or preparing a plan does not run models.',
                )}
          </p>
        </div>
      )}
      {error && (
        <output className="ct-note">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{t(error)}</span>
        </output>
      )}
      {warnings.map((warning, index) => (
        <p className="ct-note" key={`${warning}:${index}`}>
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            {t(
              '{warning} This text is treated as source data, not an instruction to the reviewer.',
              { warning: t(warning) },
            )}
          </span>
        </p>
      ))}
      {accountId && !loading && !run && (
        <>
          {!projects.length ? (
            <p className="ct-note">
              {t(
                'Create an account project in Projects, then reopen Cross-Check.',
              )}
            </p>
          ) : (
            <form
              className="cw-simple-form"
              onSubmit={(event) => {
                event.preventDefault();
                void prepare();
              }}
            >
              <label htmlFor={`${labelId}-project`}>{t('Project')}</label>
              <select
                id={`${labelId}-project`}
                className="ct-button"
                value={projectId}
                disabled={locked}
                onChange={(event) => {
                  void chooseProject(event.target.value);
                }}
              >
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
              {projectCursor && (
                <button
                  className="ct-button"
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    void action(async (_client, current) => {
                      const page = await createWorkspaceClient({
                        accountId,
                        signal: lifetime.current?.signal,
                      }).projects(projectCursor);
                      if (current()) {
                        setProjects((existing) => [
                          ...new Map(
                            [...existing, ...page.items].map((item) => [
                              item.id,
                              item,
                            ]),
                          ).values(),
                        ]);
                        setProjectCursor(page.nextCursor);
                      }
                    })
                  }
                >
                  {t('Load more projects')}
                </button>
              )}
              <label htmlFor={`${labelId}-roster`}>
                {t('Independent reviewer roster')}
              </label>
              <select
                id={`${labelId}-roster`}
                className="ct-button"
                value={rosterId}
                disabled={locked || !rosters.length}
                onChange={(event) => setRosterId(event.target.value)}
              >
                {!rosters.length && (
                  <option value="">{t('No reviewed roster available')}</option>
                )}
                {rosters.map((roster) => (
                  <option key={roster.id} value={roster.id}>
                    {t('{roster} · {count} families', {
                      roster: t(roster.label),
                      count: roster.reviewers.length,
                    })}
                  </option>
                ))}
              </select>
              {roster && (
                <p className="ct-note">
                  {t('{reviewers}. Up to {count} claims for this roster.', {
                    reviewers: roster.reviewers
                      .map(
                        (reviewer) =>
                          `${reviewer.modelId} (${t(reviewer.distribution)})`,
                      )
                      .join(' · '),
                    count: maximumClaims,
                  })}
                </p>
              )}
              {claims.map((claim, index) => (
                <div className="cw-simple-form" key={claim.id}>
                  <label htmlFor={`${labelId}-${claim.id}`}>
                    {t('Claim {number}', { number: index + 1 })}
                  </label>
                  <textarea
                    className="ct-detail"
                    id={`${labelId}-${claim.id}`}
                    rows={2}
                    maxLength={2000}
                    value={claim.text}
                    disabled={locked}
                    onChange={(event) =>
                      setClaims((current) =>
                        current.map((item) =>
                          item.id === claim.id
                            ? { ...item, text: event.target.value }
                            : item,
                        ),
                      )
                    }
                    placeholder={t(
                      'One specific claim that these sources can support or contradict',
                    )}
                  />
                  {claims.length > 1 && (
                    <button
                      className="ct-button"
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        setClaims((current) =>
                          current.filter((item) => item.id !== claim.id),
                        )
                      }
                    >
                      {t('Remove claim {number}', { number: index + 1 })}
                    </button>
                  )}
                </div>
              ))}
              <button
                data-icon-trigger
                className="ct-button"
                type="button"
                disabled={locked || claims.length >= maximumClaims}
                onClick={() =>
                  setClaims((current) => [
                    ...current,
                    { id: `claim-${crypto.randomUUID()}`, text: '' },
                  ])
                }
              >
                <MotionIcon name="add" size={18} />
                {t('Add claim')}
              </button>
              <fieldset disabled={locked}>
                <legend>{t('Source snapshots · choose up to 8')}</legend>
                {sources.length ? (
                  sources.map((source) => (
                    <label className="ct-note" key={source.id}>
                      <input
                        type="checkbox"
                        checked={selectedSources.includes(source.id)}
                        disabled={
                          !selectedSources.includes(source.id) &&
                          selectedSources.length >= 8
                        }
                        onChange={() =>
                          setSelectedSources((current) =>
                            current.includes(source.id)
                              ? current.filter((id) => id !== source.id)
                              : [...current, source.id],
                          )
                        }
                      />
                      <span>
                        {t('{title} · {bytes} bytes · provided text', {
                          title: source.title,
                          bytes: source.sourceBytes.toLocaleString(),
                        })}
                      </span>
                    </label>
                  ))
                ) : (
                  <p className="ct-note">
                    {t(
                      'Save a source excerpt below to begin. URLs are references; this panel does not retrieve web pages.',
                    )}
                  </p>
                )}
              </fieldset>
              {sourceCursor && (
                <button
                  className="ct-button"
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    void action(async (client, current) => {
                      const page = await client.sources(
                        projectId,
                        sourceCursor,
                      );
                      if (current()) {
                        setSources((existing) => [
                          ...new Map(
                            [...existing, ...page.sources].map((source) => [
                              source.id,
                              source,
                            ]),
                          ).values(),
                        ]);
                        setSourceCursor(page.nextCursor);
                      }
                    })
                  }
                >
                  {t('Load more sources')}
                </button>
              )}
              <p className="ct-note">
                {t(
                  'Selected source text: {bytes} / 131,072 bytes. Individual reviewer routes may accept less. All selected text is included; oversized inputs are refused.',
                  { bytes: chosenBytes.toLocaleString() },
                )}
              </p>
              <button
                data-icon-trigger
                className="ct-button ct-button-primary"
                type="submit"
                disabled={
                  locked ||
                  !roster ||
                  !selectedSources.length ||
                  claims.some((claim) => !claim.text.trim()) ||
                  claims.length > maximumClaims ||
                  chosenBytes > 131072
                }
              >
                <MotionIcon name="search" size={18} />
                {busy
                  ? t('Preparing…')
                  : capability?.configured
                    ? t('Prepare and review cost')
                    : t('Save unreviewed plan')}
              </button>
            </form>
          )}
          {projects.length > 0 && (
            <details className="ct-detail ct-example">
              <summary>{t('Add a provided source snapshot')}</summary>
              <form
                className="cw-simple-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSource();
                }}
              >
                <p className="ct-note">
                  {t(
                    'This saves an immutable excerpt in your account project after a local content check. No web page is fetched and no model is called.',
                  )}
                </p>
                <label htmlFor={`${labelId}-source-title`}>
                  {t('Source title')}
                </label>
                <input
                  id={`${labelId}-source-title`}
                  value={sourceDraft.title}
                  maxLength={300}
                  disabled={locked}
                  onChange={(event) =>
                    setSourceDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                />
                <label htmlFor={`${labelId}-source-uri`}>
                  {t('Reference URL (optional)')}
                </label>
                <input
                  id={`${labelId}-source-uri`}
                  type="url"
                  value={sourceDraft.uri}
                  maxLength={2048}
                  disabled={locked}
                  onChange={(event) =>
                    setSourceDraft((current) => ({
                      ...current,
                      uri: event.target.value,
                    }))
                  }
                  placeholder="https://…"
                />
                <label htmlFor={`${labelId}-source-text`}>
                  {t('Exact source excerpt')}
                </label>
                <textarea
                  className="ct-detail"
                  id={`${labelId}-source-text`}
                  rows={6}
                  value={sourceDraft.text}
                  maxLength={65536}
                  disabled={locked}
                  onChange={(event) =>
                    setSourceDraft((current) => ({
                      ...current,
                      text: event.target.value,
                    }))
                  }
                />
                <p className="ct-note">
                  {t(
                    '{bytes} / 65,536 bytes. Remove secrets before saving. Pattern checks do not catch every secret.',
                    { bytes: bytes(sourceDraft.text).toLocaleString() },
                  )}
                </p>
                <button
                  className="ct-button"
                  type="submit"
                  disabled={
                    locked ||
                    !sourceDraft.title.trim() ||
                    !sourceDraft.text.trim() ||
                    bytes(sourceDraft.text) > 65536
                  }
                >
                  {t('Check and save source')}
                </button>
              </form>
            </details>
          )}
          {runs.length > 0 && (
            <section
              className="ct-detail ct-example"
              aria-label={t('Saved Cross-Checks')}
            >
              <h3>{t('Saved Cross-Checks')}</h3>
              {runs.map((saved) => (
                <button
                  className="ct-button"
                  key={saved.id}
                  type="button"
                  disabled={locked}
                  onClick={() => void readRun(saved.id)}
                >
                  {saved.status === 'reviewed' ? t('Reviewed') : t('Prepared')}{' '}
                  · {saved.preparedAt.slice(0, 16).replace('T', ' ')} UTC
                </button>
              ))}
              {runCursor && (
                <button
                  className="ct-button"
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    void action(async (client, current) => {
                      const page = await client.runs(projectId, runCursor);
                      if (current()) {
                        setRuns((existing) => [
                          ...new Map(
                            [...existing, ...page.runs].map((item) => [
                              item.id,
                              item,
                            ]),
                          ).values(),
                        ]);
                        setRunCursor(page.nextCursor);
                      }
                    })
                  }
                >
                  {t('Load earlier checks')}
                </button>
              )}
            </section>
          )}
        </>
      )}
      {run && (
        <>
          <section className="ct-detail ct-example">
            <span className="ct-eyebrow">
              {cacheHit
                ? t('Reused completed review · no new model calls started')
                : run.result
                  ? t('Completed review')
                  : run.execution?.state === 'not_started'
                    ? t('Prepared · not reviewed')
                    : t('Execution · {state}', {
                        state: t(
                          run.execution?.state.replaceAll('_', ' ') ??
                            'unavailable',
                        ),
                      })}
            </span>
            <h3>
              {run.result
                ? t(verdictLabel[run.result.verdict])
                : t('Review against provided sources')}
            </h3>
            {run.result && <p>{t(run.result.limitation)}</p>}
            {run.execution?.state === 'incomplete' && (
              <p className="ct-note">
                {t(
                  'Some reviews or settlement need attention. This is not a complete consensus result. Reading status will not retry or rebill model calls.',
                )}
              </p>
            )}
            <dl className="ct-facts">
              <div>
                <dt>{t('Claims')}</dt>
                <dd>{run.plan.claims.length}</dd>
              </div>
              <div>
                <dt>{t('Reviewer families')}</dt>
                <dd>{run.plan.reviewers.length}</dd>
              </div>
              <div>
                <dt>{t('Source snapshots')}</dt>
                <dd>
                  {t('{count} · provided text only', {
                    count: run.plan.sources.length,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('Cached result')}</dt>
                <dd>
                  {run.result
                    ? run.cacheUsable
                      ? t(
                          'Eligible for reuse in this project within its recorded window',
                        )
                      : t(
                          'Historical result · reuse window expired or unavailable',
                        )
                    : t('No completed result')}
                </dd>
              </div>
              {run.execution?.maximumUsd6 && (
                <div>
                  <dt>{t('Approved maximum')}</dt>
                  <dd>{formatUsd6(run.execution.maximumUsd6)}</dd>
                </div>
              )}
              {run.execution && (
                <div>
                  <dt>{t('Settled usage')}</dt>
                  <dd>
                    {run.execution.actualUsd6 === null
                      ? t('Not fully settled')
                      : formatUsd6(run.execution.actualUsd6)}
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <details className="ct-detail ct-example" open={!run.result}>
            <summary>
              {t('Claims, source snapshots and reviewer roster')}
            </summary>
            {run.plan.claims.map((claim, index) => (
              <p className="ct-note" key={claim.id}>
                <strong>{t('Claim {number}', { number: index + 1 })}</strong>
                <span>{claim.text}</span>
              </p>
            ))}
            {run.plan.reviewers.map((reviewer) => (
              <p className="ct-note" key={reviewer.id}>
                {reviewer.modelId} · {reviewer.family} ·{' '}
                {t(reviewer.distribution)}
              </p>
            ))}
            {run.plan.sources.map((source) => (
              <details className="ct-example" key={source.id}>
                <summary>
                  {t('{title} · provided text', { title: source.title })}
                </summary>
                <dl className="ct-facts">
                  <div>
                    <dt>{t('Captured')}</dt>
                    <dd>{new Date(source.capturedAtMs).toISOString()}</dd>
                  </div>
                  <div>
                    <dt>{t('Reference')}</dt>
                    <dd>{source.uri ?? t('No reference URL supplied')}</dd>
                  </div>
                  <div>
                    <dt>{t('Snapshot hash')}</dt>
                    <dd className="ct-code">{source.snapshotHash}</dd>
                  </div>
                </dl>
                <p className="ct-note">{source.text}</p>
              </details>
            ))}
          </details>
          {pending && (
            <section
              className="ct-detail ct-example"
              aria-label={t('Paid review approval')}
            >
              <h3>
                {uncertain
                  ? t('Recover the original request')
                  : t('Review the maximum reservation')}
              </h3>
              <p className="ct-note">
                {uncertain
                  ? t(
                      'The approval outcome is uncertain. Recovery uses the same request key and quoted amount; it does not request a new execution.',
                    )
                  : t(
                      '{count} independent reviewer calls. The inference gateway and each model host receive these claims and sources in plaintext.',
                      { count: pending.quote.reviewCount },
                    )}
              </p>
              <dl className="ct-facts">
                <div>
                  <dt>{t('Total maximum')}</dt>
                  <dd>{formatUsd6(pending.quote.maximumUsd6)}</dd>
                </div>
                <div>
                  <dt>{t('Quote')}</dt>
                  <dd>
                    {uncertain
                      ? t('Original approval retained')
                      : expired
                        ? t('Expired — dismiss and request another quote')
                        : t('Expires {time} UTC', {
                            time: pending.quote.expiresAt.slice(11, 19),
                          })}
                  </dd>
                </div>
              </dl>
              {pending.quote.terms.map((term) => (
                <details
                  className="ct-example"
                  key={`${term.claimId}:${term.reviewerId}`}
                >
                  <summary>
                    {t('{model} · claim {number} · maximum {amount}', {
                      model: term.modelId,
                      number:
                        run.plan.claims.findIndex(
                          (claim) => claim.id === term.claimId,
                        ) + 1,
                      amount: formatUsd6(term.maximumUsd6),
                    })}
                  </summary>
                  <p className="ct-note">
                    {t(term.card.level)} · {t(term.card.retentionDisclosure)}
                  </p>
                  <p className="ct-note">
                    {t('Markup {percent}% included. Evidence date: {date}.', {
                      percent: term.markupBps / 100,
                      date: term.card.evidenceDate,
                    })}
                  </p>
                </details>
              ))}
              <p className="ct-note">
                {t(
                  'Cancellation may still incur usage already dispatched. Uncertain settlement can remain held for review. No free recheck entitlement is implied.',
                )}
              </p>
              <button
                className="ct-button"
                type="button"
                disabled={busy || uncertain}
                onClick={() => {
                  setPending(null);
                  setError(null);
                }}
              >
                {t('Dismiss quote')}
              </button>
              <button
                className="ct-button ct-button-primary"
                type="button"
                disabled={busy || (!uncertain && expired)}
                onClick={() => void approve()}
              >
                {busy
                  ? t('Checking…')
                  : uncertain
                    ? t('Recover same request')
                    : t('Reserve up to {amount} and run reviews', {
                        amount: formatUsd6(pending.quote.maximumUsd6),
                      })}
              </button>
            </section>
          )}
          {run.result?.claims.map((claim, index) => (
            <section className="ct-detail ct-example" key={claim.claim.id}>
              <span className="ct-eyebrow">
                {t('Claim {number} · {valid} / {total} valid reviews', {
                  number: index + 1,
                  valid: claim.validFamilyCount,
                  total: run.plan.reviewers.length,
                })}
              </span>
              <h3>{t(verdictLabel[claim.verdict])}</h3>
              <p className="ct-note">{claim.claim.text}</p>
              {claim.dissent && (
                <p className="ct-note">
                  <AlertTriangle size={15} aria-hidden="true" />
                  {t('Valid reviewers disagree. Dissent is preserved below.')}
                </p>
              )}
              {claim.uncertainty.length > 0 && (
                <p className="ct-note">
                  {t('Uncertainty: {reasons}.', {
                    reasons: claim.uncertainty
                      .map((reason) => t(reason.replaceAll('_', ' ')))
                      .join(t.locale === 'zh' ? '；' : '; '),
                  })}
                </p>
              )}
              {claim.reviews.map((review) => (
                <details
                  className="ct-example"
                  key={review.reviewerId}
                  open={!review.valid || claim.dissent}
                >
                  <summary>
                    {review.modelId} ·{' '}
                    {review.valid
                      ? review.verdict && t(review.verdict.replaceAll('_', ' '))
                      : t('Review discarded')}
                  </summary>
                  <p className="ct-note">
                    {review.valid
                      ? review.rationale
                      : t('Not counted: {reason}.', {
                          reason: review.invalidReason
                            ? t(review.invalidReason.replaceAll('_', ' '))
                            : 'undefined',
                        })}
                  </p>
                  {review.quotes.map((quote, index) => (
                    <div
                      className="ct-evidence"
                      key={`${quote.sourceId}:${index}`}
                    >
                      <span className="ct-eyebrow">
                        {t('{title} · exact normalized match', {
                          title:
                            run.plan.sources.find(
                              (source) => source.id === quote.sourceId,
                            )?.title ?? '',
                        })}
                      </span>
                      <blockquote>{quote.quote}</blockquote>
                      <p className="ct-code">
                        {t('Source snapshot {hash}', {
                          hash: quote.sourceHash,
                        })}
                      </p>
                    </div>
                  ))}
                </details>
              ))}
            </section>
          ))}
          {!!run.execution?.calls.length && (
            <details className="ct-detail ct-example">
              <summary>{t('Reviewer delivery and settlement')}</summary>
              {run.execution.calls.map((call) => (
                <p className="ct-note" key={call.id}>
                  {t('{model} · claim {number}: {state} · {billing}', {
                    model:
                      run.plan.reviewers.find(
                        (reviewer) => reviewer.id === call.reviewerId,
                      )?.modelId ?? '',
                    number:
                      run.plan.claims.findIndex(
                        (claim) => claim.id === call.claimId,
                      ) + 1,
                    state: t(call.state.replaceAll('_', ' ')),
                    billing: t(call.billingState.replaceAll('_', ' ')),
                  })}
                  {call.actualUsd6 !== null
                    ? ` · ${formatUsd6(call.actualUsd6)}`
                    : ''}
                  {call.errorCode ? ` · ${call.errorCode}` : ''}
                </p>
              ))}
            </details>
          )}
          <div className="ct-note">
            <Info size={15} aria-hidden="true" />
            <span>
              {t(
                'Sources are supplied snapshots, not independently retrieved or verified publications. Consensus can be wrong.',
              )}
            </span>
          </div>
          <button
            className="ct-button"
            type="button"
            disabled={busy}
            onClick={() => void refreshRun()}
          >
            {t('Read saved status')}
          </button>
          {!pending &&
            !run.result &&
            run.execution?.state === 'not_started' && (
              <button
                className="ct-button"
                type="button"
                disabled={busy || !capability?.configured}
                onClick={() => void requestQuote()}
              >
                {t('Request current quote')}
              </button>
            )}
          {run.execution?.calls.some((call) =>
            ['queued', 'running'].includes(call.state),
          ) && (
            <button
              className="ct-button"
              type="button"
              disabled={busy}
              onClick={() =>
                void action(async (client, current) => {
                  await client.cancel(run.id);
                  if (!current()) return;
                  const saved = await client.read(run.id, run.projectId);
                  if (current()) {
                    setRun(saved);
                    setError(
                      'Cancellation requested. Already-dispatched usage may still be charged.',
                    );
                  }
                })
              }
            >
              {t('Request cancellation')}
            </button>
          )}
          <button
            className="ct-button"
            type="button"
            disabled={busy || !!pending}
            onClick={() => {
              pollRead.current?.abort();
              setRun(null);
              setCacheHit(false);
              setWarnings([]);
              setError(null);
              void action(async (client, current) => {
                const page = await client.runs(projectId);
                if (current()) {
                  setRuns(page.runs);
                  setRunCursor(page.nextCursor);
                }
              });
            }}
          >
            {t('Back to draft and saved checks')}
          </button>
        </>
      )}
    </>
  );
}
