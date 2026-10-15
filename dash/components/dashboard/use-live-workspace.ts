'use client';
import { MAX_ROUTING_CANDIDATES } from '../../lib/model-routing.ts';
import { CHAT_LIMITS } from '../../lib/chat-limits.ts';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSession } from '../../lib/client/service.ts';
import {
  CANCEL_DRAIN_TIMEOUT,
  createWorkspaceClient,
  isPendingCall,
  quotedInput,
  workspaceErrorMessage,
  WorkspaceError,
  type CallSnapshot,
  type ComparisonInput,
  type ComparisonQuote,
  type QuotedComparisonInput,
  type ServiceBalance,
  type ServiceBrief,
  type ServiceComparison,
  type ServiceProject,
  type ServiceRoute,
  routingBudgetUsd6,
  assertRoutingBudget,
  DEFAULT_PROJECT_TITLE,
  projectTitleFromPrompt,
  type WorkspaceRoutingPreferences,
} from '../../lib/client/workspace.ts';
import type {
  CanvasBrief,
  Room,
  Turn,
  WorkspaceState,
} from './canvas-state.ts';
import { MODELS } from './data.ts';
import { modelReleased } from '../../lib/model-release.ts';
import {
  ModelRoutingError,
  resolveModelMentions,
  routingProfileFresh,
  type RouteRecommendation,
  type RoutingTask,
} from '../../lib/model-routing.ts';

export type LiveStatus =
  | 'loading'
  | 'preview'
  | 'signed-out'
  | 'ready'
  | 'error';
export type LiveRequestReview = {
  researchTitle?: string;
  projectId: string;
  prompt: string;
  blind: boolean;
  quotes: ComparisonQuote[];
  maximumUsd6: string;
  expiresAt: string;
  phase: 'quoted' | 'uncertain';
  routing?:
    | {
        mode: 'mentions';
        mentions: string[];
        overridesAuto: boolean;
        budgetUsd6: string | null;
      }
    | {
        mode: 'auto';
        task: RoutingTask;
        budgetUsd6: string;
        recommendation: RouteRecommendation;
        maxOutputTokens: number;
      };
  contexts: {
    family: string;
    includedExchanges: number;
    omittedExchanges: number;
    /** Why each omitted loaded turn was left out; the counts sum to omittedExchanges. */
    omittedReasons: Partial<Record<ContextOmission, number>>;
    olderHistoryNotLoaded: boolean;
  }[];
};
export type ContextOmission =
  | 'blind'
  | 'otherModel'
  | 'inProgress'
  | 'stopping'
  | 'unsettled'
  | 'unfinished'
  | 'notLoaded'
  | 'sizeLimit';
type PendingRequest = {
  review: LiveRequestReview;
  input: QuotedComparisonInput;
  draft: string;
  attempted: boolean;
};
type Client = ReturnType<typeof createWorkspaceClient>;
const emptyId = 'service-empty';
const emptyWorkspace = (): WorkspaceState => ({
  version: 1,
  activeRoomId: emptyId,
  rooms: [
    {
      id: emptyId,
      name: 'New project',
      pinned: false,
      updatedAt: 0,
      draft: '',
      selectedModels: [],
      turns: [],
    },
  ],
  briefs: [],
});
const aborted = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';
const defaults = (routes: ServiceRoute[]) =>
  MODELS.filter((model) => routes.some((route) => route.family === model.id))
    .slice(0, 2)
    .map((model) => model.id);
const available = (routes: ServiceRoute[], nowMs = Date.now()) =>
  routes.filter(
    (route) =>
      route.available &&
      modelReleased(route.family) &&
      route.modality === 'chat' &&
      route.card.reviewed &&
      Date.parse(route.expiresAt) > nowMs,
  );

/** Only verified, fully loaded service turns can enter a new model's context. */
export function conversationItems(
  room: Room,
  prompt: string,
  routes: ServiceRoute[],
) {
  const encoder = new TextEncoder();
  const history = room.live
    ? room.turns.filter((turn) => turn.live?.comparisonId === turn.id)
    : [];
  const contexts: LiveRequestReview['contexts'] = [];
  const items = routes.map((route) => {
    const budget = Math.min(CHAT_LIMITS.inputBytes, route.pricing.maxInputBytes);
    let bytes = encoder.encode(prompt).byteLength;
    if (bytes > budget)
      throw new WorkspaceError(
        'PROMPT_TOO_LARGE',
        'This question exceeds a selected route’s input limit.',
      );
    const messages: ComparisonInput['items'][number]['messages'] = [
      { role: 'user', content: prompt },
    ];
    let includedExchanges = 0;
    const omittedReasons: Partial<Record<ContextOmission, number>> = {};
    const omit = (reason: ContextOmission, count = 1) => {
      omittedReasons[reason] = (omittedReasons[reason] ?? 0) + count;
    };
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i];
      if (turn.live?.blind && !turn.live.revealedAt) {
        omit('blind');
        continue;
      }
      const reply = turn.answers.find(
        (answer) => answer.modelId === route.family,
      );
      const answer =
        reply?.live?.state === 'succeeded' && !reply.live.outputTruncated
          ? reply
          : undefined;
      const output = answer?.live?.output;
      if (!output?.trim()) {
        omit(
          !reply?.live
            ? 'otherModel'
            : isPendingCall(reply.live.state)
              ? reply.live.cancelRequested
                ? 'stopping'
                : 'inProgress'
              : reply.live.state === 'reconciliation_pending'
                ? 'unsettled'
                : reply.live.state === 'succeeded' && reply.live.outputTruncated
                  ? 'notLoaded'
                  : 'unfinished',
        );
        continue;
      }
      const pairBytes =
        encoder.encode(turn.prompt).byteLength +
        encoder.encode(output).byteLength;
      if (messages.length + 2 > CHAT_LIMITS.messages || bytes + pairBytes > budget) {
        throw new WorkspaceError('PROMPT_TOO_LARGE', 'This conversation exceeds the safe request size. Start a new chat to continue. Your saved history is unchanged.');
      }
      messages.unshift(
        { role: 'user', content: turn.prompt },
        { role: 'assistant', content: output },
      );
      includedExchanges++;
      bytes += pairBytes;
    }
    contexts.push({
      family: route.family,
      includedExchanges,
      omittedExchanges: history.length - includedExchanges,
      omittedReasons,
      olderHistoryNotLoaded: !!room.live?.historyCursor,
    });
    return {
      routeVersionId: route.versionId,
      messages,
      maxOutputTokens: route.pricing.maxOutputTokens,
      privacy: 'standard' as const,
    };
  });
  return { items, contexts };
}

/** Pure request preparation; the caller must guard the original draft first. No quote or inference is performed here. */
export function prepareWorkspaceRouting(
  room: Room,
  draft: string,
  models: string[],
  routes: ServiceRoute[],
  preferences?: WorkspaceRoutingPreferences,
  nowMs = Date.now(),
) {
  const catalog = available(routes, nowMs);
  let mentioned: ReturnType<typeof resolveModelMentions>;
  try {
    mentioned = resolveModelMentions(
      draft,
      routes.map((route) => ({
        ...route,
        available: catalog.some((item) => item.versionId === route.versionId),
      })),
      nowMs,
    );
  } catch (error) {
    if (error instanceof ModelRoutingError)
      throw new WorkspaceError(error.code, error.message);
    throw error;
  }
  const { prompt, mentions, routeVersionIds } = mentioned;
  const auto = preferences?.mode === 'auto' && routeVersionIds.length === 0;
  let selected: ServiceRoute[];
  if (auto) {
    selected = catalog.filter(
      (route) =>
        route.pricing.maxOutputTokens >= 1 &&
        route.card.routing?.tasks.includes(preferences.task) &&
        routingProfileFresh(route.card.routing, nowMs, route.expiresAt) &&
        new TextEncoder().encode(prompt).byteLength <=
          route.pricing.maxInputBytes,
    );
    if (selected.length > MAX_ROUTING_CANDIDATES)
      throw new WorkspaceError(
        'AUTO_ROUTE_LIMIT',
        'More than 256 reviewed routes match this task. Choose models manually rather than omitting candidates.',
      );
    if (!selected.length)
      throw new WorkspaceError(
        'AUTO_ROUTE_UNAVAILABLE',
        'No reviewed route supports this task and input with the current output limit. Choose Manual or refresh the model list.',
      );
  } else if (routeVersionIds.length) {
    selected = routeVersionIds.map((routeId) =>
      catalog.find((route) => route.versionId === routeId)!,
    );
  } else {
    if (
      !models.length ||
      models.length > 4 ||
      new Set(models).size !== models.length
    )
      throw new WorkspaceError(
        'INVALID_MODELS',
        'Choose one to four available models.',
      );
    const choices = models.map((model) =>
      catalog.find((route) => route.family === model),
    );
    if (choices.some((route) => !route))
      throw new WorkspaceError(
        'ROUTE_UNAVAILABLE',
        'A selected model route is unavailable. Refresh the model list.',
      );
    selected = choices as ServiceRoute[];
  }
  const conversation = conversationItems(room, prompt, selected);
  const budgetUsd6 =
    preferences?.mode === 'auto'
      ? routingBudgetUsd6(preferences.budgetUsd)
      : null;
  return {
    prompt,
    mentions,
    routes: selected,
    conversation,
    auto: auto
      ? {
          task: preferences.task,
          budgetUsd6: budgetUsd6!,
        }
      : null,
    overridesAuto: !!mentions.length && preferences?.mode === 'auto',
    budgetUsd6,
  };
}

/** Research uses exactly four explicit picks with no unrelated conversation history. */
export function prepareFomoComparison(
  room: Room,
  prompt: string,
  models: string[],
  routes: ServiceRoute[],
  nowMs = Date.now(),
): ReturnType<typeof prepareWorkspaceRouting> {
  if (models.length !== 4 || new Set(models).size !== 4)
    throw new WorkspaceError(
      'INVALID_MODELS',
      'Choose four different models for this analysis.',
    );
  const catalog = available(routes, nowMs);
  const selected = models.map((id) => catalog.find((route) => route.family === id));
  if (selected.some((route) => !route))
    throw new WorkspaceError(
      'ROUTE_UNAVAILABLE',
      'One of the chosen models is unavailable. Choose a replacement.',
    );
  const resolved = selected as ServiceRoute[];
  return {
    prompt,
    mentions: [],
    routes: resolved,
    conversation: conversationItems({ ...room, turns: [], live: undefined }, prompt, resolved),
    auto: null,
    overridesAuto: false,
    budgetUsd6: null,
  };
}

/**
 * The calls to stream for a room, as `turnId:callId` keys, at most four.
 * Stopping calls keep draining for exact billing, possibly for minutes; when
 * the cap binds they yield to calls still generating, so a newer turn is never
 * left without live updates. Nothing here blocks sending a new turn.
 */
export function streamedCalls(room: Room, limit = 4) {
  const pending = room.turns.flatMap((turn) =>
    turn.answers
      .filter((answer) => answer.live && isPendingCall(answer.live.state))
      .map((answer) => ({
        key: `${turn.id}:${answer.id}`,
        stopping: answer.live?.cancelRequested === true,
      })),
  );
  const ordered =
    pending.length > limit
      ? [
          ...pending.filter((call) => call.stopping),
          ...pending.filter((call) => !call.stopping),
        ]
      : pending;
  return ordered
    .slice(-limit)
    .map((call) => call.key)
    .join(',');
}

/** The placeholder heading for a call that has not returned text. */
export function callHeading(call: {
  state: string;
  output: string;
  errorCode?: string | null;
  cancelRequested?: boolean;
}) {
  if (call.output) return '';
  if (call.cancelRequested && isPendingCall(call.state))
    return 'Stopping response';
  if (
    call.state === 'reconciliation_pending' &&
    call.errorCode === CANCEL_DRAIN_TIMEOUT
  )
    return 'Stopped · settlement under review';
  return call.state === 'queued'
    ? 'Waiting to begin'
    : call.state === 'running'
      ? 'Generating response'
      : call.state === 'cancelled'
        ? 'Request cancelled'
        : call.state === 'reconciliation_pending'
          ? 'Settlement under review'
          : call.state === 'failed'
            ? 'Request did not complete'
            : 'No text returned';
}

export function comparisonTurn(comparison: ServiceComparison): Turn {
  return {
    id: comparison.id,
    prompt: comparison.prompt,
    live: {
      comparisonId: comparison.id,
      blind: comparison.blind,
      revealedAt: comparison.revealedAt,
      votedCallId: comparison.votedCallId,
      createdAt: comparison.createdAt,
    },
    answers: comparison.calls.map((call) => ({
      id: call.id,
      modelId: call.family ?? 'blind',
      heading: callHeading(call),
      paragraphs: call.output ? [call.output] : [],
      live: {
        callId: call.id,
        state: call.state,
        errorCode: call.errorCode,
        cancelRequested: call.cancelRequested,
        billing: call.billing,
        modelName: call.modelId ?? call.label,
        label: call.label,
        routeVersionId: call.routeVersionId,
        output: call.output,
        outputTruncated: call.outputTruncated,
        outputLength: call.outputLength,
      },
    })),
  };
}
function projectRoom(
  project: ServiceProject,
  models: string[],
  previous?: Room,
): Room {
  return {
    id: project.id,
    name: project.title,
    pinned: previous?.pinned ?? false,
    updatedAt: project.updatedAt
      ? Date.parse(project.updatedAt)
      : (previous?.updatedAt ?? Date.now()),
    draft: previous?.draft ?? '',
    selectedModels: previous?.selectedModels ?? models,
    turns: previous?.turns ?? [],
    live: {
      revision: project.revision,
      historyCursor: previous?.live?.historyCursor,
    },
  };
}
function canvasBrief(brief: ServiceBrief, previous?: CanvasBrief): CanvasBrief {
  if (brief.body === undefined)
    throw new WorkspaceError(
      'BRIEF_NOT_LOADED',
      'This Brief could not be loaded.',
    );
  return {
    id: brief.id,
    title: brief.title,
    body: brief.body,
    roomId: brief.projectId,
    createdAt: brief.createdAt
      ? Date.parse(brief.createdAt)
      : (previous?.createdAt ?? Date.now()),
    live: { revision: brief.revision, document: brief.document },
  };
}
async function fullBriefs(client: Client, briefs: ServiceBrief[]) {
  const result: ServiceBrief[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, briefs.length) }, async () => {
      while (next < briefs.length) {
        const index = next++,
          metadata = briefs[index];
        const body = await client.brief(metadata.id);
        if (body.projectId !== metadata.projectId)
          throw new WorkspaceError(
            'INVALID_RESPONSE',
            'The Brief response did not match the saved project.',
          );
        result[index] = { ...metadata, ...body };
      }
    }),
  );
  return result;
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Private service content is held in component memory only, separately from preview storage.
 * `loadBriefs: false` skips Brief reads while the Library and Brief creation are hidden.
 */
export function useLiveWorkspace({
  loadBriefs = true,
}: { loadBriefs?: boolean } = {}) {
  const [state, setState] = useState<WorkspaceState>(emptyWorkspace);
  const stateRef = useRef(state);
  const [status, setStatus] = useState<LiveStatus>('loading');
  const [active, setActive] = useState(false);
  const [account, setAccount] = useState<AccountSession | null>(null);
  const accountRef = useRef<AccountSession | null>(null);
  const [routes, setRoutes] = useState<ServiceRoute[]>([]);
  const routesRef = useRef<ServiceRoute[]>([]);
  const [chatConfigured, setChatConfigured] = useState(false);
  const configuredRef = useRef(false);
  const [balance, setBalance] = useState<ServiceBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [requestReview, setRequestReview] = useState<LiveRequestReview | null>(
    null,
  );
  const pendingRef = useRef<PendingRequest | null>(null);
  const [projectsCursor, setProjectsCursor] = useState<string | null>(null);
  const projectsCursorRef = useRef<string | null>(null);
  const [briefsCursor, setBriefsCursor] = useState<string | null>(null);
  const briefsCursorRef = useRef<string | null>(null);
  const epoch = useRef(0);
  const sessionAbort = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const suspended = useRef(false);
  const opening = useRef(0);

  const commit = useCallback(
    (update: (current: WorkspaceState) => WorkspaceState) => {
      if (!mounted.current) return;
      const next = update(stateRef.current);
      stateRef.current = next;
      setState(next);
    },
    [],
  );
  const clear = useCallback(() => {
    epoch.current++;
    sessionAbort.current?.abort();
    sessionAbort.current = new AbortController();
    accountRef.current = null;
    setAccount(null);
    routesRef.current = [];
    setRoutes([]);
    configuredRef.current = false;
    setChatConfigured(false);
    setBalance(null);
    pendingRef.current = null;
    setRequestReview(null);
    busyRef.current = false;
    setBusy(false);
    projectsCursorRef.current = null;
    setProjectsCursor(null);
    briefsCursorRef.current = null;
    setBriefsCursor(null);
    commit(emptyWorkspace);
  }, [commit]);
  const fail = useCallback(
    (failure: unknown, generation: number) => {
      if (!mounted.current || generation !== epoch.current || aborted(failure))
        return;
      if (failure instanceof WorkspaceError && failure.status === 401) {
        clear();
        setStatus('signed-out');
      }
      setError(workspaceErrorMessage(failure));
    },
    [clear],
  );
  const context = useCallback(() => {
    if (
      !accountRef.current ||
      suspended.current ||
      !sessionAbort.current ||
      sessionAbort.current.signal.aborted
    )
      throw new WorkspaceError(
        'SESSION_REQUIRED',
        'Sign in to access your private workspace.',
        401,
      );
    const generation = epoch.current,
      owner = accountRef.current.accountId;
    return {
      client: createWorkspaceClient({
        signal: sessionAbort.current.signal,
        accountId: owner,
      }),
      generation,
      current: () =>
        mounted.current &&
        generation === epoch.current &&
        owner === accountRef.current?.accountId &&
        !suspended.current,
    };
  }, []);
  const applyComparison = useCallback(
    (comparison: ServiceComparison) => {
      commit((current) => ({
        ...current,
        rooms: current.rooms.map((room) => {
          if (room.id !== comparison.projectId) return room;
          const turn = comparisonTurn(comparison),
            exists = room.turns.some((item) => item.id === turn.id);
          return {
            ...room,
            updatedAt: Math.max(
              room.updatedAt,
              Date.parse(comparison.createdAt),
            ),
            turns: exists
              ? room.turns.map((item) => (item.id === turn.id ? turn : item))
              : [...room.turns, turn],
          };
        }),
      }));
    },
    [commit],
  );

  const refresh = useCallback(async (): Promise<boolean> => {
    if (suspended.current) {
      setStatus('signed-out');
      setError(
        'Your wallet account changed. Confirm sign-in again in Account before accessing private data.',
      );
      return false;
    }
    sessionAbort.current?.abort();
    sessionAbort.current = new AbortController();
    const signal = sessionAbort.current.signal,
      generation = ++epoch.current;
    let client = createWorkspaceClient({ signal });
    const current = () =>
      mounted.current && generation === epoch.current && !signal.aborted;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setStatus('loading');
    try {
      const capabilities = await client.capabilities();
      if (!current()) return false;
      setActive(capabilities.mode === 'service');
      if (capabilities.mode === 'preview') {
        clear();
        setStatus('preview');
        return true;
      }
      const session = await client.session();
      if (!current()) return false;
      if (!session) {
        clear();
        setStatus('signed-out');
        return true;
      }
      if (accountRef.current?.accountId !== session.accountId) {
        commit(emptyWorkspace);
        pendingRef.current = null;
        setRequestReview(null);
        setBalance(null);
        setRoutes([]);
        routesRef.current = [];
      }
      accountRef.current = session;
      setAccount(session);
      client = createWorkspaceClient({ signal, accountId: session.accountId });
      configuredRef.current = capabilities.chat.configured;
      setChatConfigured(capabilities.chat.configured);
      const optionalRead = async <T>(
        read: Promise<T>,
        fallback: T,
        notice: string,
      ): Promise<T> => {
        try {
          return await read;
        } catch (failure) {
          if (
            aborted(failure) ||
            (failure instanceof WorkspaceError && failure.status === 401)
          )
            throw failure;
          if (current()) setError(notice);
          return fallback;
        }
      };
      const [catalog, projects, funds, briefPage] = await Promise.all([
        optionalRead(
          client.routes(),
          [] as ServiceRoute[],
          'Model routes could not be loaded. Your projects remain available.',
        ),
        client.projects(),
        optionalRead<ServiceBalance | null>(
          client.balance(),
          null,
          'The current balance could not be loaded. Refresh it before approving a paid request.',
        ),
        loadBriefs
          ? client.briefs()
          : Promise.resolve({ items: [] as ServiceBrief[], nextCursor: null }),
      ]);
      if (!current()) return false;
      routesRef.current = catalog;
      setRoutes(catalog);
      setBalance(funds);
      projectsCursorRef.current = projects.nextCursor;
      setProjectsCursor(projects.nextCursor);
      briefsCursorRef.current = briefPage.nextCursor;
      setBriefsCursor(briefPage.nextCursor);
      const initialModels = defaults(available(catalog));
      const old = stateRef.current;
      // Preserve in-memory drafts for loaded projects beyond the first page, too.
      const loaded = new Map(
        old.rooms
          .filter(
            (room) =>
              room.live &&
              (projects.nextCursor !== null ||
                projects.items.some((project) => project.id === room.id)),
          )
          .map((room) => [room.id, room]),
      );
      for (const project of projects.items)
        loaded.set(
          project.id,
          projectRoom(project, initialModels, loaded.get(project.id)),
        );
      const rooms = [...loaded.values()];
      const activeRoomId = rooms.some((room) => room.id === old.activeRoomId)
        ? old.activeRoomId
        : (rooms[0]?.id ?? emptyId);
      commit((currentState) => ({
        ...currentState,
        activeRoomId,
        rooms: rooms.length
          ? rooms
          : [
              {
                ...emptyWorkspace().rooms[0],
                draft:
                  currentState.rooms.find((room) => room.id === emptyId)
                    ?.draft ?? '',
                selectedModels: initialModels,
              },
            ],
      }));
      const [history, loadedBriefs] = await Promise.all([
        activeRoomId === emptyId
          ? Promise.resolve(null)
          : optionalRead(
              client.comparisons(activeRoomId),
              null,
              'Saved conversation history could not be loaded. No saved data was changed.',
            ),
        optionalRead(
          fullBriefs(client, briefPage.items),
          [] as ServiceBrief[],
          'Saved Brief contents could not be loaded. No saved data was changed.',
        ),
      ]);
      if (!current()) return false;
      commit((currentState) => {
        const briefs = new Map(
          currentState.briefs
            .filter(
              (brief) =>
                briefPage.nextCursor !== null ||
                briefPage.items.some((item) => item.id === brief.id),
            )
            .map((brief) => [brief.id, brief]),
        );
        for (const brief of loadedBriefs)
          briefs.set(brief.id, canvasBrief(brief, briefs.get(brief.id)));
        return {
          ...currentState,
          briefs: [...briefs.values()],
          rooms: currentState.rooms.map((room) =>
            room.id === activeRoomId && history
              ? {
                  ...room,
                  turns: mergeHistory(room.turns, history.items),
                  live: {
                    revision: room.live!.revision,
                    historyCursor: history.nextCursor,
                  },
                }
              : room,
          ),
        };
      });
      setStatus('ready');
      return true;
    } catch (failure) {
      if (current()) {
        setStatus('error');
        fail(failure, generation);
      }
      return false;
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [clear, commit, fail, loadBriefs]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // One channel owner; messages carry only a reason, never identity or content.
    const channel =
      typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel('conclave-session');
    const sessionChanged = (event: Event) => {
      const detail = (
        event as CustomEvent<{ reason?: string; external?: boolean }>
      ).detail;
      const reason = detail?.reason;
      if (!['signed-in', 'signed-out', 'wallet-changed'].includes(reason ?? ''))
        return;
      if (!detail?.external) channel?.postMessage({ reason });
      clear();
      setError(null);
      if (reason === 'wallet-changed') {
        suspended.current = true;
        setStatus('signed-out');
        setError(
          'Your wallet account changed. Confirm sign-in again in Account before accessing private data.',
        );
        return;
      }
      suspended.current = false;
      if (reason === 'signed-out') {
        setStatus('signed-out');
        return;
      }
      void refresh();
    };
    if (channel)
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data;
        if (
          !value ||
          typeof value !== 'object' ||
          !('reason' in value) ||
          typeof value.reason !== 'string' ||
          !['signed-in', 'signed-out', 'wallet-changed'].includes(value.reason)
        )
          return;
        window.dispatchEvent(
          new CustomEvent('conclave:session-change', {
            detail: { reason: value.reason, external: true },
          }),
        );
      };
    window.addEventListener('conclave:session-change', sessionChanged);
    let checking = false;
    const checkSession = async () => {
      if (
        checking ||
        suspended.current ||
        !accountRef.current ||
        document.visibilityState === 'hidden'
      )
        return;
      checking = true;
      const generation = epoch.current,
        owner = accountRef.current.accountId;
      try {
        const session = await createWorkspaceClient({
          signal: sessionAbort.current?.signal,
          accountId: owner,
        }).session();
        if (
          mounted.current &&
          generation === epoch.current &&
          (!session || session.accountId !== owner)
        ) {
          clear();
          setStatus('signed-out');
          setError(
            'Your session changed. Sign in again to access this workspace.',
          );
        }
      } catch (failure) {
        fail(failure, generation);
      } finally {
        checking = false;
      }
    };
    const focus = () => {
      void checkSession();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    const shutdown = () => {
      mounted.current = false;
      epoch.current++;
      sessionAbort.current?.abort();
    };
    return () => {
      shutdown();
      window.removeEventListener('conclave:session-change', sessionChanged);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
      channel?.close();
    };
  }, [refresh, clear, fail]);

  const run = useCallback(
    async (
      action: (ctx: ReturnType<typeof context>) => Promise<boolean>,
    ): Promise<boolean> => {
      if (busyRef.current) return false;
      let ctx: ReturnType<typeof context>;
      try {
        ctx = context();
      } catch (failure) {
        fail(failure, epoch.current);
        return false;
      }
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        return await action(ctx);
      } catch (failure) {
        fail(failure, ctx.generation);
        return false;
      } finally {
        if (ctx.current()) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [context, fail],
  );

  const createProject = useCallback(
    (name: string) =>
      run(async (ctx) => {
        if (!name.trim() || name.length > 80)
          throw new WorkspaceError(
            'INVALID_TITLE',
            'Give the project a name of 1–80 characters.',
          );
        const project = await ctx.client.createProject(name.trim());
        if (!ctx.current()) return false;
        const room = projectRoom(
          project,
          defaults(available(routesRef.current)),
        );
        commit((current) => ({
          ...current,
          activeRoomId: room.id,
          rooms: [room, ...current.rooms.filter((item) => item.id !== emptyId)],
        }));
        return true;
      }),
    [run, commit],
  );
  const openProject = useCallback(
    (projectId: string) =>
      run(async (ctx) => {
        if (
          !stateRef.current.rooms.some(
            (room) => room.id === projectId && room.live,
          )
        )
          return false;
        const serial = ++opening.current;
        const history = await ctx.client.comparisons(projectId);
        if (!ctx.current() || serial !== opening.current) return false;
        commit((current) => ({
          ...current,
          activeRoomId: projectId,
          rooms: current.rooms.map((room) =>
            room.id === projectId
              ? {
                  ...room,
                  turns: mergeHistory(room.turns, history.items),
                  live: {
                    revision: room.live!.revision,
                    historyCursor: history.nextCursor,
                  },
                }
              : room,
          ),
        }));
        return true;
      }),
    [run, commit],
  );
  const renameProject = useCallback(
    (projectId: string, name: string) =>
      run(async (ctx) => {
        const room = stateRef.current.rooms.find(
          (room) => room.id === projectId,
        );
        if (!room?.live) return false;
        if (!name.trim() || name.length > 80)
          throw new WorkspaceError(
            'INVALID_TITLE',
            'Give the project a name of 1–80 characters.',
          );
        const project = await ctx.client.renameProject(
          projectId,
          name.trim(),
          room.live.revision,
        );
        if (!ctx.current()) return false;
        commit((current) => ({
          ...current,
          rooms: current.rooms.map((item) =>
            item.id === projectId ? projectRoom(project, [], item) : item,
          ),
        }));
        return true;
      }),
    [run, commit],
  );
  const archiveProject = useCallback(
    (projectId: string) =>
      run(async (ctx) => {
        const room = stateRef.current.rooms.find(
          (room) => room.id === projectId,
        );
        if (!room?.live) return false;
        if (pendingRef.current?.review.projectId === projectId)
          throw new WorkspaceError(
            'REQUEST_PENDING',
            'Resolve or dismiss this project’s request review before archiving.',
          );
        await ctx.client.archiveProject(projectId, room.live.revision);
        if (!ctx.current()) return false;
        commit((current) => {
          const remaining = current.rooms.filter(
            (item) => item.id !== projectId,
          );
          const rooms = remaining.length
            ? remaining
            : [
                {
                  ...emptyWorkspace().rooms[0],
                  selectedModels: defaults(available(routesRef.current)),
                },
              ];
          return {
            ...current,
            rooms,
            activeRoomId:
              current.activeRoomId === projectId
                ? rooms[0].id
                : current.activeRoomId,
          };
        });
        return true;
      }),
    [run, commit],
  );
  const loadMoreProjects = useCallback(
    () =>
      run(async (ctx) => {
        if (!projectsCursorRef.current) return false;
        const page = await ctx.client.projects(projectsCursorRef.current);
        if (!ctx.current()) return false;
        projectsCursorRef.current = page.nextCursor;
        setProjectsCursor(page.nextCursor);
        commit((current) => {
          const rooms = new Map(
            current.rooms
              .filter((room) => room.live)
              .map((room) => [room.id, room]),
          );
          for (const project of page.items)
            rooms.set(
              project.id,
              projectRoom(
                project,
                defaults(available(routesRef.current)),
                rooms.get(project.id),
              ),
            );
          return { ...current, rooms: [...rooms.values()] };
        });
        return true;
      }),
    [run, commit],
  );
  const loadMoreHistory = useCallback(
    () =>
      run(async (ctx) => {
        const room = stateRef.current.rooms.find(
          (room) => room.id === stateRef.current.activeRoomId,
        );
        if (!room?.live?.historyCursor) return false;
        const page = await ctx.client.comparisons(
          room.id,
          room.live.historyCursor,
        );
        if (!ctx.current()) return false;
        commit((current) => ({
          ...current,
          rooms: current.rooms.map((item) =>
            item.id === room.id
              ? {
                  ...item,
                  turns: mergeHistory(item.turns, page.items),
                  live: {
                    revision: item.live!.revision,
                    historyCursor: page.nextCursor,
                  },
                }
              : item,
          ),
        }));
        return true;
      }),
    [run, commit],
  );
  const setDraft = useCallback(
    (draft: string) => {
      if (
        !accountRef.current ||
        typeof draft !== 'string' ||
        new TextEncoder().encode(draft).byteLength > CHAT_LIMITS.inputBytes
      )
        return;
      commit((current) => ({
        ...current,
        rooms: current.rooms.map((room) =>
          room.id === current.activeRoomId ? { ...room, draft } : room,
        ),
      }));
    },
    [commit],
  );
  const setModels = useCallback(
    (models: string[]) => {
      const supported = available(routesRef.current);
      if (
        !accountRef.current ||
        models.length < 1 ||
        models.length > 4 ||
        new Set(models).size !== models.length ||
        models.some(
          (model) => !supported.some((route) => route.family === model),
        )
      )
        return;
      commit((current) => ({
        ...current,
        rooms: current.rooms.map((room) =>
          room.id === current.activeRoomId
            ? { ...room, selectedModels: [...models] }
            : room,
        ),
      }));
    },
    [commit],
  );

  const quotePrompt = useCallback(
    (
      options: {
        prompt?: string;
        modelIds?: string[];
        blind?: boolean;
        routing?: WorkspaceRoutingPreferences;
        researchTitle?: string;
        onProjectCreated?: (projectId: string) => void;
      } = {},
    ) =>
      run(async (ctx) => {
        if (pendingRef.current)
          throw new WorkspaceError(
            'REQUEST_PENDING',
            'Finish the current request review before preparing another.',
          );
        if (!configuredRef.current)
          throw new WorkspaceError('PROVIDER_UNAVAILABLE', messagesUnavailable);
        let room = stateRef.current.rooms.find(
          (room) => room.id === stateRef.current.activeRoomId,
        )!;
        const draft = options.prompt ?? room.draft,
          models = options.modelIds ?? room.selectedModels;
        if (!options.researchTitle) {
          // History pages contain previews. Load every eligible exchange before quoting,
          // so scrolling the UI cannot change the context sent to a model.
          const cursors = new Set<string>();
          while (room.live?.historyCursor) {
            const cursor = room.live.historyCursor;
            if (cursors.has(cursor)) throw new WorkspaceError('INVALID_RESPONSE', 'Conversation history could not be loaded. Please retry.');
            cursors.add(cursor);
            const page = await ctx.client.comparisons(room.id, cursor);
            if (!ctx.current()) return false;
            room = { ...room, turns: mergeHistory(room.turns, page.items),
              live: { ...room.live, historyCursor: page.nextCursor } };
          }
          for (const turn of room.turns) {
            if (turn.live?.blind && !turn.live.revealedAt) continue;
            if (turn.answers.some((a) => a.live?.state === 'succeeded' && a.live.outputTruncated)) {
              const full = await ctx.client.comparison(turn.id);
              if (!ctx.current()) return false;
              room = { ...room, turns: mergeHistory(room.turns, [full]) };
            }
          }
          const loadedRoom = room;
          commit((current) => ({ ...current, rooms: current.rooms.map((item) =>
            item.id === loadedRoom.id ? { ...item, turns: loadedRoom.turns, live: loadedRoom.live } : item) }));
        }
        const planned = options.researchTitle ? prepareFomoComparison(room, draft, models, routesRef.current) : prepareWorkspaceRouting(
          room,
          draft,
          models,
          routesRef.current,
          options.routing,
        );
        const { prompt } = planned;
        // A project is created only as part of this explicit send action or createProject.
        if (room.id === emptyId || options.researchTitle) {
          const project = await ctx.client.createProject(options.researchTitle?.slice(0, 80) ?? DEFAULT_PROJECT_TITLE);
          if (!ctx.current()) return false;
          const created = {
            ...projectRoom(project, models),
            draft: options.researchTitle ? '' :
              stateRef.current.rooms.find((item) => item.id === emptyId)
                ?.draft ?? room.draft,
          };
          commit((current) => ({
            ...current,
            activeRoomId: created.id,
            rooms: [
              created,
              ...current.rooms.filter((item) => item.id !== emptyId),
            ],
          }));
          room = created;
          options.onProjectCreated?.(created.id);
        }
        let selected = planned.routes;
        let conversation = planned.conversation;
        let input: ComparisonInput = {
          projectId: room.id,
          blind: options.blind === true && selected.length > 1 && !planned.auto,
          items: conversation.items,
        };
        let routing: LiveRequestReview['routing'];
        let quotes;
        if (planned.auto) {
          const result = await ctx.client.autoQuote({
            projectId: room.id,
            task: planned.auto.task,
            privacy: 'standard',
            budgetUsd6: planned.auto.budgetUsd6,
            candidates: input.items,
          });
          if (!ctx.current()) return false;
          const index = selected.findIndex(
            (route) => route.versionId === result.recommendation.routeVersionId,
          );
          if (index < 0)
            throw new WorkspaceError(
              'INVALID_RESPONSE',
              'The recommended route did not match the reviewed candidates.',
            );
          selected = [selected[index]];
          conversation = {
            items: [conversation.items[index]],
            contexts: [conversation.contexts[index]],
          };
          input = { ...input, items: conversation.items };
          quotes = result;
          routing = {
            mode: 'auto',
            task: planned.auto.task,
            budgetUsd6: planned.auto.budgetUsd6,
            recommendation: result.recommendation,
            maxOutputTokens: conversation.items[0].maxOutputTokens,
          };
        } else {
          quotes = await ctx.client.quote(input);
          if (planned.mentions.length)
            routing = {
              mode: 'mentions',
              mentions: planned.mentions,
              overridesAuto: planned.overridesAuto,
              budgetUsd6: planned.budgetUsd6,
            };
        }
        if (!ctx.current()) return false;
        if (
          quotes.quotes.some(
            (quote, index) =>
              quote.family !== selected[index]!.family ||
              quote.modelId !== selected[index]!.modelId,
          )
        )
          throw new WorkspaceError(
            'INVALID_RESPONSE',
            'A quoted route did not match the selected model.',
          );
        assertRoutingBudget(quotes.maximumUsd6, planned.budgetUsd6);
        const expiresAt = quotes.quotes.reduce(
          (earliest, quote) =>
            Date.parse(quote.expiresAt) < Date.parse(earliest)
              ? quote.expiresAt
              : earliest,
          quotes.quotes[0].expiresAt,
        );
        const review: LiveRequestReview = {
          ...(options.researchTitle ? { researchTitle: options.researchTitle } : {}),
          projectId: room.id,
          prompt,
          blind: input.blind,
          quotes: quotes.quotes,
          maximumUsd6: quotes.maximumUsd6,
          expiresAt,
          phase: 'quoted',
          contexts: conversation.contexts,
          ...(routing ? { routing } : {}),
        };
        pendingRef.current = {
          review,
          input: quotedInput(input, quotes, crypto.randomUUID()),
          draft,
          attempted: false,
        };
        setRequestReview(review);
        return true;
      }),
    [run, commit],
  );

  const approveRequest = useCallback(
    () =>
      run(async (ctx) => {
        const pending = pendingRef.current;
        if (!pending) return false;
        if (
          !pending.attempted &&
          Date.parse(pending.review.expiresAt) <= Date.now()
        )
          throw new WorkspaceError(
            'QUOTE_EXPIRED',
            'This quote has expired. Dismiss it and request a new quote.',
          );
        pending.attempted = true;
        // The server may accept this request before any response reaches us.
        // Set recovery state before dispatch so refresh/abort cannot leave an
        // expired quote that is neither recoverable nor dismissible.
        pending.review = { ...pending.review, phase: 'uncertain' };
        setRequestReview(pending.review);
        try {
          const result = await ctx.client.submit(pending.input);
          if (!ctx.current()) return false;
          applyComparison(result.comparison);
          commit((current) => ({
            ...current,
            rooms: current.rooms.map((room) =>
              room.id === pending.review.projectId &&
              room.draft === pending.draft
                ? { ...room, draft: '' }
                : room,
            ),
          }));
          pendingRef.current = null;
          setRequestReview(null);
          try {
            const funds = await ctx.client.balance();
            if (ctx.current()) setBalance(funds);
          } catch (failure) {
            fail(failure, ctx.generation);
          }
          // A default-titled project takes its first sent question as a title.
          const titled = stateRef.current.rooms.find(
            (room) => room.id === pending.review.projectId,
          );
          const title = projectTitleFromPrompt(pending.review.prompt);
          if (
            ctx.current() &&
            titled?.live &&
            !titled.live.historyCursor &&
            titled.name === DEFAULT_PROJECT_TITLE &&
            titled.turns.length === 1 &&
            title
          ) {
            try {
              const project = await ctx.client.renameProject(
                titled.id,
                title,
                titled.live.revision,
              );
              if (ctx.current())
                commit((current) => ({
                  ...current,
                  rooms: current.rooms.map((item) =>
                    item.id === project.id
                      ? projectRoom(project, [], item)
                      : item,
                  ),
                }));
            } catch {
              // The default title remains; Rename project is still available.
            }
          }
          return true;
        } catch (failure) {
          if (ctx.current() && pendingRef.current === pending) {
            // A response/body/network failure can occur after commit. Keep exactly the same key and payload.
            const definitive =
              failure instanceof WorkspaceError &&
              failure.status >= 400 &&
              failure.status < 500 &&
              ![408, 429].includes(failure.status);
            if (definitive) pending.attempted = false;
            pending.review = {
              ...pending.review,
              phase: definitive ? 'quoted' : 'uncertain',
            };
            setRequestReview(pending.review);
          }
          throw failure;
        }
      }),
    [run, applyComparison, commit, fail],
  );
  const dismissRequest = useCallback(() => {
    if (busyRef.current) return false;
    if (pendingRef.current?.attempted) {
      setError(
        'The submission outcome is uncertain. Retry this same request to recover its saved status before dismissing.',
      );
      return false;
    }
    pendingRef.current = null;
    setRequestReview(null);
    setError(null);
    return true;
  }, []);
  const actionTurn = useCallback(
    (turnId: string, action: 'cancel' | 'reveal' | 'vote', callId?: string) =>
      run(async (ctx) => {
        const turn = stateRef.current.rooms
          .flatMap((room) => room.turns)
          .find((turn) => turn.id === turnId);
        if (
          !turn?.live ||
          (callId && !turn.answers.some((answer) => answer.id === callId))
        )
          return false;
        const result = await ctx.client.comparisonAction(
          turn.live.comparisonId,
          action,
          callId,
        );
        if (!ctx.current()) return false;
        applyComparison(result);
        return true;
      }),
    [run, applyComparison],
  );
  const cancelTurn = useCallback(
    (id: string) => actionTurn(id, 'cancel'),
    [actionTurn],
  );
  const revealTurn = useCallback(
    (id: string) => actionTurn(id, 'reveal'),
    [actionTurn],
  );
  const voteTurn = useCallback(
    (id: string, callId: string) => actionTurn(id, 'vote', callId),
    [actionTurn],
  );
  const loadComparison = useCallback(
    (comparisonId: string) =>
      run(async (ctx) => {
        if (
          !stateRef.current.rooms.some((room) =>
            room.turns.some((turn) => turn.live?.comparisonId === comparisonId),
          )
        )
          return false;
        const comparison = await ctx.client.comparison(comparisonId);
        if (!ctx.current()) return false;
        applyComparison(comparison);
        return true;
      }),
    [run, applyComparison],
  );

  const saveBrief = useCallback(
    (brief: CanvasBrief) =>
      run(async (ctx) => {
        if (
          !brief.title.trim() ||
          brief.title.length > 160 ||
          !brief.body.trim() ||
          brief.body.length > 24000
        )
          throw new WorkspaceError(
            'INVALID_BRIEF',
            'Use a title of up to 160 characters and a body of up to 24,000 characters.',
          );
        const existing = stateRef.current.briefs.find(
          (item) => item.id === brief.id && item.live,
        );
        const result = await ctx.client.saveBrief({
          ...(existing
            ? { id: existing.id, revision: existing.live!.revision }
            : {}),
          projectId: brief.roomId,
          title: brief.title,
          body: brief.body,
        });
        if (!ctx.current()) return false;
        const saved = canvasBrief(result, existing);
        commit((current) => ({
          ...current,
          briefs: [
            saved,
            ...current.briefs.filter((item) => item.id !== saved.id),
          ],
        }));
        return true;
      }),
    [run, commit],
  );
  const createBriefFromCalls = useCallback(
    (input: {
      projectId: string;
      title: string;
      callIds: string[];
      idempotencyKey: string;
    }) =>
      run(async (ctx) => {
        const result = await ctx.client.briefFromCalls(input);
        if (!ctx.current()) return false;
        const saved = canvasBrief(result);
        commit((current) => ({
          ...current,
          briefs: [
            saved,
            ...current.briefs.filter((item) => item.id !== saved.id),
          ],
        }));
        return true;
      }),
    [run, commit],
  );
  const updateBriefDocument = useCallback(
    (brief: CanvasBrief) =>
      run(async (ctx) => {
        if (!brief.live?.document) return false;
        const result = await ctx.client.updateBriefDocument(
          brief.id,
          brief.title,
          brief.live.revision,
          brief.live.document.analysis,
        );
        if (!ctx.current()) return false;
        const saved = canvasBrief(result, brief);
        commit((current) => ({
          ...current,
          briefs: current.briefs.map((item) =>
            item.id === saved.id ? saved : item,
          ),
        }));
        return true;
      }),
    [run, commit],
  );
  const refreshBrief = useCallback(
    (briefId: string) =>
      run(async (ctx) => {
        const previous = stateRef.current.briefs.find(
          (item) => item.id === briefId,
        );
        if (!previous?.live) return false;
        const result = await ctx.client.brief(briefId);
        if (!ctx.current() || result.projectId !== previous.roomId)
          return false;
        commit((current) => ({
          ...current,
          briefs: current.briefs.map((item) =>
            item.id === briefId &&
            item.live &&
            item.roomId === result.projectId &&
            item.live.revision <= result.revision
              ? canvasBrief(result, item)
              : item,
          ),
        }));
        return true;
      }),
    [run, commit],
  );
  const deleteBrief = useCallback(
    (briefId: string) =>
      run(async (ctx) => {
        const brief = stateRef.current.briefs.find(
          (item) => item.id === briefId,
        );
        if (!brief?.live) return false;
        await ctx.client.deleteBrief(briefId, brief.live.revision);
        if (!ctx.current()) return false;
        commit((current) => ({
          ...current,
          briefs: current.briefs.filter((item) => item.id !== briefId),
        }));
        return true;
      }),
    [run, commit],
  );
  const loadMoreBriefs = useCallback(
    () =>
      run(async (ctx) => {
        if (!briefsCursorRef.current) return false;
        const page = await ctx.client.briefs(
            undefined,
            briefsCursorRef.current,
          ),
          loaded = await fullBriefs(ctx.client, page.items);
        if (!ctx.current()) return false;
        briefsCursorRef.current = page.nextCursor;
        setBriefsCursor(page.nextCursor);
        commit((current) => {
          const briefs = new Map(current.briefs.map((item) => [item.id, item]));
          for (const brief of loaded)
            briefs.set(brief.id, canvasBrief(brief, briefs.get(brief.id)));
          return { ...current, briefs: [...briefs.values()] };
        });
        return true;
      }),
    [run, commit],
  );

  const activeRoom =
    state.rooms.find((room) => room.id === state.activeRoomId) ??
    state.rooms[0];
  const pendingCalls = streamedCalls(activeRoom);
  useEffect(() => {
    if (status !== 'ready' || !account || !pendingCalls) return;
    const controller = new AbortController(),
      generation = epoch.current;
    const parentSignal = sessionAbort.current?.signal;
    const stop = () => controller.abort();
    parentSignal?.addEventListener('abort', stop, { once: true });
    if (parentSignal?.aborted) controller.abort();
    const signal = controller.signal,
      client = createWorkspaceClient({ signal, accountId: account.accountId });
    const current = () =>
      mounted.current &&
      !signal.aborted &&
      generation === epoch.current &&
      account.accountId === accountRef.current?.accountId;
    const updateSnapshot = (snapshot: CallSnapshot) => {
      if (!current()) return;
      const hidden = stateRef.current.rooms
        .flatMap((room) => room.turns)
        .find((turn) =>
          turn.answers.some((answer) => answer.live?.callId === snapshot.id),
        )?.live;
      if (
        hidden?.blind &&
        !hidden.revealedAt &&
        (snapshot.billing.maximumUsd6 !== null ||
          snapshot.billing.actualUsd6 !== null)
      )
        throw new WorkspaceError(
          'INVALID_RESPONSE',
          'The blind response included information that should remain hidden until reveal.',
        );
      commit((workspace) => ({
        ...workspace,
        rooms: workspace.rooms.map((room) => ({
          ...room,
          turns: room.turns.map((turn) => ({
            ...turn,
            answers: turn.answers.map((answer) =>
              answer.live?.callId === snapshot.id
                ? {
                    ...answer,
                    heading: callHeading(snapshot),
                    paragraphs: snapshot.output ? [snapshot.output] : [],
                    live: {
                      ...answer.live,
                      state: snapshot.state,
                      errorCode: snapshot.errorCode,
                      cancelRequested: snapshot.cancelRequested,
                      billing: snapshot.billing,
                      output: snapshot.output,
                      outputTruncated: false,
                      outputLength: snapshot.output.length,
                    },
                  }
                : answer,
            ),
          })),
        })),
      }));
      if (!isPendingCall(snapshot.state)) {
        // The terminal snapshot removes its stream effect; this refresh follows the account epoch.
        void createWorkspaceClient({
          signal: parentSignal,
          accountId: account.accountId,
        })
          .balance()
          .then((funds) => {
            if (
              mounted.current &&
              generation === epoch.current &&
              account.accountId === accountRef.current?.accountId
            )
              setBalance(funds);
          })
          .catch((failure) => fail(failure, generation));
      }
    };
    for (const entry of pendingCalls.split(',')) {
      const [comparisonId, callId] = entry.split(':');
      void (async () => {
        let failures = 0;
        while (current()) {
          try {
            await client.streamCall(callId, updateSnapshot);
            if (!current()) return;
            const comparison = await client.comparison(comparisonId);
            if (!current()) return;
            applyComparison(comparison);
            if (
              !comparison.calls.some(
                (call) => call.id === callId && isPendingCall(call.state),
              )
            ) {
              const funds = await client.balance();
              if (current()) setBalance(funds);
              return;
            }
            failures = 0;
          } catch (failure) {
            if (!current() || aborted(failure)) return;
            if (failure instanceof WorkspaceError && failure.status === 401) {
              fail(failure, generation);
              return;
            }
            // An SSE unavailable event can represent an expired session. Check it before reconnecting.
            try {
              const session = await client.session();
              if (!current()) return;
              if (!session || session.accountId !== account.accountId) {
                clear();
                setStatus('signed-out');
                setError(
                  'Your session changed. Sign in again to access this workspace.',
                );
                return;
              }
              const comparison = await client.comparison(comparisonId);
              if (!current()) return;
              applyComparison(comparison);
              if (
                !comparison.calls.some(
                  (call) => call.id === callId && isPendingCall(call.state),
                )
              )
                return;
            } catch (recoveryError) {
              if (
                recoveryError instanceof WorkspaceError &&
                recoveryError.status === 401
              ) {
                fail(recoveryError, generation);
                return;
              }
            }
            failures++;
            if (current())
              setError(
                'The live connection was interrupted. Reconnecting to this saved request; no new request will be sent.',
              );
          }
          try {
            await wait(Math.min(30000, 5000 * 2 ** failures), signal);
          } catch {
            return;
          }
        }
      })();
    }
    return () => {
      controller.abort();
      parentSignal?.removeEventListener('abort', stop);
    };
  }, [status, account, pendingCalls, commit, applyComparison, fail, clear]);

  const availableModels = MODELS.filter((model) =>
    available(routes).some((route) => route.family === model.id),
  ).map((model) => model.id);
  return {
    status,
    active,
    state,
    account,
    signedIn: !!account && status === 'ready',
    loading: status === 'loading',
    routes,
    availableModels,
    callsAvailable:
      status === 'ready' && chatConfigured && available(routes).length > 0,
    balance,
    error,
    busy,
    requestReview,
    projectsCursor,
    briefsCursor,
    activeRoom,
    refresh,
    createProject,
    openProject,
    renameProject,
    archiveProject,
    loadMoreProjects,
    loadMoreHistory,
    setDraft,
    setModels,
    quotePrompt,
    approveRequest,
    dismissRequest,
    cancelTurn,
    revealTurn,
    voteTurn,
    loadComparison,
    saveBrief,
    createBriefFromCalls,
    updateBriefDocument,
    refreshBrief,
    deleteBrief,
    loadMoreBriefs,
  };
}
const messagesUnavailable =
  'Live model requests are not configured. Your signed-in projects remain available.';
export function mergeHistory(
  existing: Turn[],
  comparisons: ServiceComparison[],
): Turn[] {
  const merged = new Map(existing.map((turn) => [turn.id, turn]));
  for (const comparison of comparisons) {
    const incoming = comparisonTurn(comparison),
      previous = merged.get(incoming.id);
    // A small history preview must never replace a full result already opened in memory.
    incoming.answers = incoming.answers.map((answer) => {
      const old = previous?.answers.find((item) => item.id === answer.id);
      return answer.live?.outputTruncated &&
        old?.live &&
        !old.live.outputTruncated &&
        old.live.outputLength === answer.live.outputLength
        ? {
            ...answer,
            heading: old.heading,
            paragraphs: old.paragraphs,
            live: {
              ...answer.live,
              output: old.live.output,
              outputTruncated: false,
            },
          }
        : answer;
    });
    merged.set(incoming.id, incoming);
  }
  return [...merged.values()].sort(
    (a, b) =>
      Date.parse(a.live?.createdAt ?? '') -
        Date.parse(b.live?.createdAt ?? '') || a.id.localeCompare(b.id),
  );
}
