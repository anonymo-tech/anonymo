'use client';
import { modelReleased, releasedModelSelection } from '../../lib/model-release.ts';
import { appendChatDraft, quotedReplyDraft } from '../../lib/chat-drafts';
import type { ReuseQuestion } from './ask-again';
import { SendYourWay, useSendYourWay } from './send-your-way';
import { shouldSubmitChatKey } from '../../lib/chat-send-key';
import { CHAT_LIMITS } from '../../lib/chat-limits';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Image from 'next/image';
import { Check, ChevronDown, Shield, X } from 'lucide-react';
import { MotionIcon } from './motion-icon';
import { Wordmark } from '../conclave/wordmark';
import { LanguageToggle } from '../language-toggle';
import { translate, useT, type Translator } from '@/lib/i18n';
import Link from '../site-link';
import { MODELS, downloadFile, scanPrompt } from './data';
import {
  canvasLimits,
  createBrief,
  createRoom,
  createSampleTurn,
  initialWorkspace,
  parseWorkspace,
  workspaceKey,
  type Answer,
  type Room,
  type WorkspaceState,
} from './canvas-state';
import { ProviderIcon, type AnswerActions } from './answer-card';
import { appendDecisionDraft } from '../../lib/decision-worksheet';
import { CHAT_LIMITS } from '../../lib/chat-limits';
import { takeawayDocument } from '../../lib/takeaway';
import { PaperTrail } from './paper-trail';
import {paperPrompt,type PaperSource} from '../../lib/paper-trail';
import { PictureThis } from './picture-this';
import type { ChatImage } from '../../lib/picture-this';
import { SayIt } from './say-it';
import { Recall } from './recall';
import { QuickPhrases } from './quick-phrases';
import { ModelPanels } from './model-panels';
import { ModelPickerOptions } from './model-picker-options';
import { ChatThread, type ChatTurnPreference } from './chat-thread';
import { WorkspacePages } from './workspace-pages';
import { featureOn, type FeatureName } from './feature-switches';
import { StudioPage, STUDIO_MODELS } from './studio-page';
import {
  useStudioSession,
  StudioDraftOptions,
  StudioDraftReview,
} from './studio-session';
import { ToolsContent } from './workspace-tools';
import { useContentGuard } from './use-content-guard';
import { useLiveWorkspace } from './use-live-workspace';
import { LiveRequestReview } from './live-request-review';
import {
  LiveRoutingOptions,
  DEFAULT_ROUTING_PREFERENCES,
} from './live-routing-options';
import {
  formatFriendlyUsd6,
  type WorkspaceRoutingPreferences,
} from '../../lib/client/workspace';
import { formatAccountUsd6 } from '../../lib/client/account-records';
import { useLiveStudio } from './use-live-studio';
import { LiveStudioReview } from './live-studio-review';
import { LiveStudioPage } from './live-studio-page';
import '@/app/dashboard/conversation-bar.css';
import type {
  ComposerControl,
  ComposerState,
} from '../second-look/second-look-workspace';
const SecondLookWorkspace = lazy(() =>
  import('../second-look/second-look-workspace').then((module) => ({
    default: module.SecondLookWorkspace,
  })),
);

const CanvasBoard = lazy(() => import('./canvas-board'));
const views = [
  'second-look',
  'canvas',
  'chat',
  'rooms',
  'studio',
  'agents',
  'library',
  'decisions',
  'connections',
  'purse',
  'chapters',
] as const;
type View = (typeof views)[number];
const tools = [
  'routes',
  'explainer',
  'crosscheck',
  'settings',
  'identity',
  'help',
] as const;
type Tool = (typeof tools)[number];

/**
 * MVP surface gate. Chat, account sign-in (`identity`) and `settings` are always
 * visible because Chat depends on them. Every other view and tool dialog belongs
 * to a feature and appears only when that feature's switch is on (see
 * `feature-switches.ts`). Hidden surfaces keep their code and lose their entry
 * points: dock and menu buttons, deep links and in-chat actions.
 */
const FEATURE_SURFACES: Record<FeatureName, readonly (View | Tool)[]> = {
  cleanRead: [],
  codeClip: [],
  projectView: [],
  canvasMemory: [],
  libraryFilter: [],
  quoteReply: [],
  askAgain: [],
  projectLabels: [],
  tidyCanvas: [],
  briefStars: [],
  threadMap: [],
  runTotal: [],
  archiveRecovery: [],
  decisionDrafts: [],
  studioReuse: [],
  readingRoom: [],
  sendYourWay: [],
  decisionImport: [],
  decisionCompare: [],
  studioSearch: [],

  frontRow: [],
  modelPanels: [],
  modelFinder: [],
  quickPhrases: [],
  recall: [],
  takeaway: [],
  sayIt: [],
  readToMe: [],
  pictureThis: [],
  paperTrail: [],
  flywheel: [],
  moreModels: [],
  secondLook: ['second-look'],
  projects: ['rooms'],
  canvas: ['canvas'],
  library: ['library'],
  decisions: ['decisions'],
  help: ['help'],
  routes: ['routes'],
  purse: ['purse'],
  receipts: [],
  crosscheck: ['crosscheck'],
  synthesis: [],
  explainer: ['explainer'],
  studio: ['studio'],
  chapters: ['chapters'],
  agents: ['agents'],
  connections: ['connections'],
};
const MVP_VISIBLE_VIEWS: readonly (View | Tool)[] = [
  'chat',
  'identity',
  'settings',
  ...(Object.keys(FEATURE_SURFACES) as FeatureName[])
    .filter(featureOn)
    .flatMap((name) => FEATURE_SURFACES[name]),
];
const DEFAULT_VIEW: View = 'chat';
const isVisible = (id: View | Tool) => MVP_VISIBLE_VIEWS.includes(id);
const pageViews: readonly View[] = [
  'rooms',
  'agents',
  'library',
  'decisions',
  'connections',
  'purse',
  'chapters',
];
/** Briefs are saved to the Library, so Brief creation follows its visibility. */
const briefsVisible = isVisible('library');
type DialogName =
  | Tool
  | 'brief'
  | 'rename'
  | 'delete'
  | 'reset'
  | 'studio-review'
  | null;
type Popup = 'rooms' | 'models' | 'more' | 'account' | null;

const navigation = (
  [
    { id: 'rooms', label: 'Projects' },
    { id: 'chat', label: 'Chat' },
    { id: 'canvas', label: 'Canvas' },
    { id: 'second-look', label: 'FOMO' },
    { id: 'studio', label: 'Studio' },
    { id: 'agents', label: 'Agents' },
  ] as const
).filter((item) => isVisible(item.id));
const secondary = (
  [
    { id: 'library', label: 'Library' },
    { id: 'decisions', label: 'Decisions' },
    { id: 'connections', label: 'Connections' },
    { id: 'purse', label: 'Purse' },
    { id: 'chapters', label: 'Chapters' },
  ] as const
).filter((item) => isVisible(item.id));
const moreToolsVisible = (['explainer', 'crosscheck', 'routes'] as const).some(
  isVisible,
);
const dialogTitles: Record<Exclude<DialogName, null>, string> = {
  routes: 'Model routes',
  explainer: 'Solana Explainer',
  crosscheck: 'Cross-Check',
  settings: 'Workspace settings',
  identity: 'Your account',
  help: 'Explore your workspace',
  brief: 'Create a Brief',
  rename: 'Rename project',
  delete: 'Delete this project?',
  reset: 'Reset this local workspace?',
  'studio-review': 'Your Studio draft',
};
const maxStoredCharacters = 2_000_000;

/** Selected models in the picker's order, so quotes and answers list them the same way. */
function pickerOrder(ids: string[], models: readonly { id: string }[]) {
  const rank = (id: string) => {
    const index = models.findIndex((model) => model.id === id);
    return index < 0 ? models.length : index;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

function containsSecret(text: string) {
  const guard = scanPrompt(text);
  return guard?.type === 'key' || guard?.type === 'secret';
}

/** Drafts may stay in memory, but every saved record must pass validation and privacy checks. */
function storageSnapshot(value: WorkspaceState): WorkspaceState | null {
  const checked = parseWorkspace(value);
  if (!checked) return null;
  for (const room of checked.rooms) {
    if (containsSecret(room.name)) return null;
    if (scanPrompt(room.draft)) room.draft = '';
    for (const turn of room.turns) {
      if (containsSecret(turn.prompt)) return null;
      for (const answer of turn.answers) {
        if (
          containsSecret(answer.heading) ||
          answer.paragraphs.some(containsSecret)
        )
          return null;
      }
    }
  }
  if (
    checked.briefs.some(
      (brief) => containsSecret(brief.title) || containsSecret(brief.body),
    )
  )
    return null;
  return JSON.stringify(checked).length <= maxStoredCharacters ? checked : null;
}

/** Localize generated notices without changing the English messages stored in state. */
function localizeNotice(message: string, t: Translator) {
  const templates = [
    [
      /^Give the project a name of 1–(\d+) characters\.$/,
      'Give the project a name of 1–{count} characters.',
    ],
    [
      /^This local preview holds up to (\d+) projects\. Remove a project to make space\.$/,
      'This local preview holds up to {count} projects. Remove a project to make space.',
    ],
    [
      /^Compare up to (\d+) models at a time\.$/,
      'Compare up to {count} models at a time.',
    ],
    [
      /^Keep your question within (\d+) characters\.$/,
      'Keep your question within {count} characters.',
    ],
  ] as const;
  for (const [pattern, template] of templates) {
    const match = message.match(pattern);
    if (match) return t(template, { count: match[1] });
  }
  return t(message);
}

function modelLabel(
  label: string,
  t: (text: string, vars?: { label: string }) => string,
) {
  const match = label.match(/^Model ([A-D])$/);
  return match ? t('Model {label}', { label: match[1] }) : label;
}

function projectName(room: Room, t: Translator) {
  const defaults: Record<string, string> = {
    'room-launch': 'Launch plan',
    'room-solana': 'Solana research',
    'room-website': 'Website refresh',
    'service-empty': 'New project',
  };
  return defaults[room.id] === room.name
    ? t(room.name)
    : room.name;
}

function Dialog({
  title,
  children,
  onClose,
  variant,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  variant?: 'account';
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    el?.showModal();
    return () => {
      el?.close();
      if (variant === 'account') {
        const target = previousFocus?.isConnected && previousFocus !== document.body
          ? previousFocus
          : document.querySelector<HTMLButtonElement>('.cw-account-anchor > .cw-avatar');
        target?.focus({ preventScroll: true });
      }
    };
  }, [variant]);
  return (
    <dialog
      ref={ref}
      className={`cw-dialog${variant === 'account' ? ' ca-dialog' : ''}`}
      aria-labelledby="cw-dialog-title"
      onCancel={onClose}
    >
      <header>
        <h2 id="cw-dialog-title">{title}</h2>
        <button
          data-icon-trigger
          className="cw-icon-button"
          onClick={onClose}
          aria-label={t('Close dialog')}
        >
          {variant === 'account' ? <X size={19} /> : <MotionIcon name="close" size={21} />}
        </button>
      </header>
      <div className="cw-dialog-content">{children}</div>
    </dialog>
  );
}

export default function CanvasWorkspace() {
  const live = useLiveWorkspace({ loadBriefs: briefsVisible });
  const sessionKey = live.active
    ? `account:${live.account?.accountId ?? 'signed-out'}`
    : 'local-preview';
  return <CanvasWorkspaceShell key={sessionKey} live={live} />;
}

function CanvasWorkspaceShell({
  live,
}: {
  live: ReturnType<typeof useLiveWorkspace>;
}) {
  const t = useT();
  const sendSetting = useSendYourWay(live.active ? live.account?.accountId ?? 'signed-out' : 'preview', featureOn('sendYourWay'));
  const [localState, setState] = useState<WorkspaceState>(initialWorkspace);
  const checkContent = useContentGuard();
  const [fomoResult, setFomoResult] = useState<{subjectId:string;projectId:string;title:string}|null>(null);
  const checkingContent = useRef(false);
  const shellActive = useRef(true);
  useEffect(() => { shellActive.current = true; return () => { shellActive.current = false; }; }, []);

  const state = live.active ? live.state : localState;
  const localStateRef = useRef(localState);
  useLayoutEffect(() => {
    localStateRef.current = localState;
  }, [localState]);
  const [ready, setReady] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [storageConflict, setStorageConflict] = useState(false);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [popup, setPopup] = useState<Popup>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const briefSubmission = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );
  const [recallOpen,setRecallOpen] = useState(false);
  const [recalledTurn,setRecalledTurn] = useState<string|null>(null);
  const [query, setQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [strict, setStrict] = useState(false);
  const [blindComparison, setBlindComparison] = useState(false);
  const [routingByProject, setRoutingByProject] = useState<
    Record<string, WorkspaceRoutingPreferences>
  >({});
  const [routeModel, setRouteModel] = useState('claude');
  const [toast, setToast] = useState('');
  const [guardMessage, setGuardMessage] = useState('');
  const [redacted, setRedacted] = useState<string | null>(null);
  const [paperByRoom,setPaperByRoom] = useState<Record<string,PaperSource|null>>({});
  const [pictureByRoom,setPictureByRoom] = useState<Record<string,ChatImage[]>>({});
  const [attached, setAttached] = useState<string[]>([]);
  const [rename, setRename] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [chatPreferences, setChatPreferences] = useState<
    Record<string, Record<string, ChatTurnPreference>>
  >({});
  const composer = useRef<HTMLTextAreaElement>(null);
  const dockArea = useRef<HTMLDivElement>(null);
  const attachment = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLElement>(null);
  const chatScrollPositions = useRef(new Map<string, number>());
  const shownLastTurn = useRef<{ roomId: string; turnId: string | null }>({
    roomId: '',
    turnId: null,
  });
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const lastStored = useRef<string | null | undefined>(undefined);
  const writesBlocked = useRef(false);
  const flushStorage = useRef<(reportFailure?: boolean) => void>(() => {});
  const room =
    state.rooms.find((item) => item.id === state.activeRoomId) ||
    state.rooms[0];
  const routing = isVisible('routes')
    ? routingByProject[room.id] ?? DEFAULT_ROUTING_PREFERENCES
    : DEFAULT_ROUTING_PREFERENCES;
  const updateRouting = (value: WorkspaceRoutingPreferences) =>
    setRoutingByProject((current) => ({ ...current, [room.id]: value }));
  const isConversation = view === 'canvas' || view === 'chat';
  const isStudio = view === 'studio';
  const isSecondLook = featureOn('secondLook') && view === 'second-look';
  const [secondLookDraftStore, setSecondLookDraftStore] = useState<{
    accountId: string | null;
    value: string;
  }>({ accountId: null, value: '' });
  const secondLookDraft =
    secondLookDraftStore.accountId === (live.account?.accountId ?? null)
      ? secondLookDraftStore.value
      : '';
  const setSecondLookDraft = useCallback(
    (value: string) =>
      setSecondLookDraftStore({
        accountId: live.account?.accountId ?? null,
        value,
      }),
    [live.account?.accountId],
  );
  const [secondLookComposer, setSecondLookComposer] = useState<ComposerState>({
    placeholder: 'Paste a FOMO callout or profile link…',
    label: 'Research FOMO',
    busy: false,
  });
  const secondLookControl = useRef<ComposerControl | null>(null);

  const isComposerView = isConversation || isStudio || isSecondLook;
  const studio = useStudioSession(room.id);
  // Hidden Studio reads nothing: without an account scope the hook makes no media requests.
  const liveStudio = useLiveStudio({
    accountId:
      live.active && isVisible('studio')
        ? (live.account?.accountId ?? null)
        : null,
    projectId: live.active && room.live && isVisible('studio') ? room.id : null,
    active: live.active && isStudio,
  });
  const composerDraft = isSecondLook
    ? secondLookDraft
    : isStudio
      ? studio.draft.prompt
      : room.draft;
  const composerModelIds = isStudio
    ? studio.draft.modelIds
    : releasedModelSelection(room.selectedModels, live.active ? [] : ['claude', 'gemini']);
  const composerModels = isStudio ? STUDIO_MODELS : MODELS.filter((model) => modelReleased(model.id));
  const composerAttachments = isSecondLook
    ? []
    : isStudio
      ? studio.draft.reference
        ? [studio.draft.reference.name]
        : []
      : attached;
  const composerStrict = isStudio ? studio.draft.strict : strict;
  const submissionVersion = JSON.stringify({
    account: live.account?.accountId,
    project: room.id,
    view,
    models: composerModelIds,
    draft: composerDraft,
    strict: composerStrict,
    blind: blindComparison,
    routing,
    attachments: composerAttachments,
    pictures: pictureByRoom[room.id]??[],
    paper:paperByRoom[room.id]??null,
  });
  const latestSubmission = useRef(submissionVersion);
  useLayoutEffect(() => {
    latestSubmission.current = submissionVersion;
  }, [submissionVersion]);

  const notify = useCallback((message: string) => setToast(message), []);
  const blockConflictingSave = useCallback(
    (reportFailure = true) => {
      writesBlocked.current = true;
      if (reportFailure) {
        setStorageBlocked(true);
        setStorageConflict(true);
        notify(
          'Another tab changed the saved workspace. Your work stays in this tab. Open Settings to download it before reloading the saved version.',
        );
      }
    },
    [notify],
  );

  const lastTurnId = room.turns.at(-1)?.id ?? null;
  const revealChatTurn = useCallback((turnId: string, smooth: boolean) => {
    const turn = main.current?.querySelector<HTMLElement>(
      `[data-chat-turn-id="${CSS.escape(turnId)}"]`,
    );
    turn?.scrollIntoView({
      block: 'start',
      behavior:
        smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'smooth'
          : 'instant',
    });
  }, []);

  useEffect(() => { if (!recalledTurn || view !== 'chat') return; const frame = requestAnimationFrame(() => { revealChatTurn(recalledTurn, false); setRecalledTurn(null); }); return () => cancelAnimationFrame(frame); }, [recalledTurn, view, room.turns, revealChatTurn]);

  // A room opens at its latest turn, unless this tab saved a position for it.
  // Only opening a room or view repositions here; new turns are handled below.
  useLayoutEffect(() => {
    if (!main.current) return;
    const saved =
      view === 'chat' ? chatScrollPositions.current.get(room.id) : undefined;
    const latest = stateRef.current.rooms
      .find((item) => item.id === room.id)
      ?.turns.at(-1)?.id;
    if (saved !== undefined) main.current.scrollTop = saved;
    else if (view === 'chat' && latest) revealChatTurn(latest, false);
    else main.current.scrollTop = 0;
  }, [view, room.id, ready, revealChatTurn]);

  // A newly sent turn, or history arriving for an opened room, is brought into view.
  useLayoutEffect(() => {
    const previous = shownLastTurn.current;
    shownLastTurn.current = { roomId: room.id, turnId: lastTurnId };
    if (view !== 'chat' || !lastTurnId || previous.turnId === lastTurnId)
      return;
    const opened = previous.roomId !== room.id || previous.turnId === null;
    if (opened && chatScrollPositions.current.has(room.id)) return;
    revealChatTurn(lastTurnId, !opened);
  }, [lastTurnId, room.id, view, revealChatTurn]);

  const updateChatPreference = useCallback(
    (turnId: string, preference: ChatTurnPreference) => {
      setChatPreferences((current) => ({
        ...current,
        [room.id]: { ...current[room.id], [turnId]: preference },
      }));
    },
    [room.id],
  );

  useLayoutEffect(() => {
    const input = composer.current;
    if (!input) return;
    const resize = () => {
      input.style.height = '44px';
      if (input.value)
        input.style.height = `${Math.min(input.scrollHeight, 124)}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [composerDraft, composerModelIds.length, view]);

  useLayoutEffect(() => {
    const dock = dockArea.current;
    const shell = dock?.parentElement;
    if (!dock || !shell || !isComposerView) return;
    const measure = () => {
      const clearance = shell.clientHeight - dock.offsetTop + 14;
      shell.style.setProperty('--cw-compose-clearance', `${clearance}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    measure();
    return () => {
      observer.disconnect();
      shell.style.removeProperty('--cw-compose-clearance');
    };
  }, [isComposerView]);

  const updateWorkspace = useCallback(
    (change: (current: WorkspaceState) => WorkspaceState) => {
      if (live.active) {
        notify(
          'This action is not available for an account project yet. Your saved project is unchanged.',
        );
        return false;
      }
      if (!ready) {
        notify('Your saved workspace is still loading. Try again in a moment.');
        return false;
      }
      const checked = parseWorkspace(change(stateRef.current));
      if (!checked) {
        notify(
          'This change exceeds the local workspace limits. Existing projects, drafts, and saved data are unchanged.',
        );
        return false;
      }
      if (!storageSnapshot(checked)) {
        notify(
          'This change cannot be saved. Remove secret-like text or reduce the saved content; previous data is unchanged.',
        );
        return false;
      }
      stateRef.current = checked;
      localStateRef.current = checked;
      setState(checked);
      return true;
    },
    [ready, notify, live.active],
  );

  useEffect(() => {
    function readLocation() {
      const requested =
        location.hash.slice(1) ||
        new URLSearchParams(location.search).get('view');
      const hash = requested || DEFAULT_VIEW;
      const aliases: Record<string, View> = {
        fomo: 'second-look',
        projects: 'rooms',
        room: 'chat',
        compare: 'canvas',
        briefs: 'library',
        balance: 'purse',
        receipts: 'purse',
        developers: 'connections',
        sanctum: 'connections',
      };
      const candidate = aliases[hash] || hash;
      const isView = (views as readonly string[]).includes(candidate);
      const isTool = (tools as readonly string[]).includes(candidate);
      // Unrelated anchors, such as the skip link, leave the view unchanged.
      if (!isView && !isTool) return;
      if (isTool && isVisible(candidate as Tool)) {
        setDialog(candidate as Tool);
        return;
      }
      // Deep links to hidden views or tools open the default view instead.
      const next =
        isView && isVisible(candidate as View)
          ? (candidate as View)
          : DEFAULT_VIEW;
      setView(next);
      setSecondLookDraftStore({ accountId: null, value: '' });
      setGuardMessage('');
      setRedacted(null);
      setModelQuery('');
      setPopup(null);
      if (next === 'rooms' && location.hash !== '#projects')
        history.replaceState(null, '', '#projects');
      else if (requested && next !== candidate) {
        const url = new URL(location.href);
        url.searchParams.delete('view');
        url.hash = next;
        history.replaceState(null, '', url);
      }
    }
    const frame = requestAnimationFrame(() => {
      try {
        const raw = localStorage.getItem(workspaceKey);
        lastStored.current = raw;
        if (raw !== null) {
          let parsed: WorkspaceState | null = null;
          try {
            parsed =
              raw.length <= maxStoredCharacters
                ? parseWorkspace(JSON.parse(raw))
                : null;
          } catch {
            /* Invalid stored JSON must not be replaced with sample data. */
          }
          if (parsed && storageSnapshot(parsed)) {
            localStateRef.current = parsed;
            setState(parsed);
          } else {
            writesBlocked.current = true;
            setStorageBlocked(true);
            setToast(
              'Saved data could not be loaded safely. It has been kept untouched; use Settings to reset it.',
            );
          }
        }
      } catch {
        writesBlocked.current = true;
        setStorageBlocked(true);
        setToast(
          'Browser storage is unavailable. This session will not be saved.',
        );
      }
      readLocation();
      setReady(true);
    });
    window.addEventListener('hashchange', readLocation);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', readLocation);
    };
  }, []);

  useEffect(() => {
    const save = (reportFailure = true) => {
      if (
        !ready ||
        storageBlocked ||
        writesBlocked.current ||
        lastStored.current === undefined
      )
        return;
      try {
        const safe = storageSnapshot(localStateRef.current);
        if (!safe) {
          if (reportFailure)
            notify(
              'The workspace could not be saved safely. Your previous saved data has been kept untouched.',
            );
          return;
        }
        const raw = JSON.stringify(safe);
        if (localStorage.getItem(workspaceKey) !== lastStored.current) {
          blockConflictingSave(reportFailure);
          return;
        }
        if (raw !== lastStored.current) {
          localStorage.setItem(workspaceKey, raw);
          lastStored.current = raw;
        }
      } catch {
        writesBlocked.current = true;
        if (reportFailure) {
          setStorageBlocked(true);
          notify(
            'Storage is full or unavailable. New changes remain in this session.',
          );
        }
      }
    };
    flushStorage.current = save;
    if (!ready || storageBlocked) return;
    const timer = setTimeout(save, 250);
    return () => clearTimeout(timer);
  }, [localState, ready, storageBlocked, notify, blockConflictingSave]);

  useEffect(() => {
    const checkStorage = (event: StorageEvent) => {
      if (lastStored.current === undefined || writesBlocked.current) return;
      if (event.key !== null && event.key !== workspaceKey) return;
      try {
        if (event.storageArea !== localStorage) return;
        if (localStorage.getItem(workspaceKey) !== lastStored.current)
          blockConflictingSave();
      } catch {
        writesBlocked.current = true;
        setStorageBlocked(true);
        notify('Browser storage is unavailable. Your work stays in this tab.');
      }
    };
    window.addEventListener('storage', checkStorage);
    return () => window.removeEventListener('storage', checkStorage);
  }, [notify, blockConflictingSave]);

  useEffect(() => {
    const flush = () => flushStorage.current();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flushStorage.current(false);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPopup(null);
        document
          .querySelectorAll<HTMLDetailsElement>('.cw-answer-menu[open]')
          .forEach((el) => {
            el.open = false;
          });
      }
    }
    function outside(event: PointerEvent) {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[data-cw-popover]')
      )
        setPopup(null);
    }
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', outside);
    };
  }, []);

  function navigate(requested: View) {
    const next = isVisible(requested) ? requested : DEFAULT_VIEW;
    setView(next);
    setSecondLookDraftStore({ accountId: null, value: '' });
    setGuardMessage('');
    setRedacted(null);
    setModelQuery('');
    setPopup(null);
    setQuery('');
    history.replaceState(null, '', `#${next === 'rooms' ? 'projects' : next}`);
  }
  function updateRoom(update: Partial<Room>) {
    if (live.active) {
      if (update.name !== undefined) {
        void live.renameProject(room.id, update.name);
        return true;
      }
      if (update.draft !== undefined) live.setDraft(update.draft);
      if (update.selectedModels !== undefined)
        live.setModels(update.selectedModels);
      return update.draft !== undefined || update.selectedModels !== undefined;
    }
    return updateWorkspace((current) => ({
      ...current,
      rooms: current.rooms.map((item) =>
        item.id === current.activeRoomId
          ? { ...item, ...update, updatedAt: Date.now() }
          : item,
      ),
    }));
  }
  function appendSuggestion(suggestion: string) {
    const currentRoom = stateRef.current.rooms.find(
      (item) => item.id === stateRef.current.activeRoomId,
    );
    if (!currentRoom) return;
    const draft = currentRoom.draft
      ? `${currentRoom.draft}\n\n${suggestion}`
      : suggestion;
    if (!live.active && draft.length > canvasLimits.draft) {
      notify(
        'Your current draft is too long to add this question. Your text has been kept unchanged.',
      );
      return;
    }
    if (!updateRoom({ draft })) return;
    setGuardMessage('');
    setRedacted(null);
    composer.current?.focus();
  }
  function compareDecision(prompt: string): boolean {
    if (!featureOn('decisionCompare')) return false;
    const currentRoom = stateRef.current.rooms.find(item => item.id === stateRef.current.activeRoomId);
    if (!currentRoom || (live.active && !live.signedIn)) { notify('Sign in before adding this worksheet to chat.'); return false; }
    try {
      const draft = appendDecisionDraft(currentRoom.draft,prompt,CHAT_LIMITS.inputBytes,live.active ? Number.MAX_SAFE_INTEGER : canvasLimits.draft);
      if (!updateRoom({draft})) return false;
      navigate('chat');
      notify('Worksheet added to your draft. Choose your models and review before sending.');
      requestAnimationFrame(() => composer.current?.focus());
      return true;
    } catch (error) { notify(error instanceof Error ? error.message : 'The worksheet could not be added to chat.'); return false; }
  }
  function openRoom(id: string) {
    chatScrollPositions.current.delete(id);
    if (live.active) {
      void live.openProject(id).then((opened) => {
        if (opened) {
          setSelection([]);
          setAttached([]);
          navigate('canvas');
        }
      });
      return;
    }
    if (!updateWorkspace((current) => ({ ...current, activeRoomId: id })))
      return;
    setSelection([]);
    setAttached([]);
    setGuardMessage('');
    setRedacted(null);
    navigate('canvas');
  }
  function newRoom(name: string): boolean {
    if (live.active) {
      void live.createProject(name).then((created) => {
        if (created) {
          setSelection([]);
          setAttached([]);
          navigate('canvas');
        }
      });
      return true;
    }
    if (!name.trim() || name.length > canvasLimits.roomName) {
      notify(
        `Give the project a name of 1–${canvasLimits.roomName} characters.`,
      );
      return false;
    }
    if (stateRef.current.rooms.length >= canvasLimits.rooms) {
      notify(
        `This local preview holds up to ${canvasLimits.rooms} projects. Remove a project to make space.`,
      );
      return false;
    }
    const next = createRoom(name);
    if (
      !updateWorkspace((current) => ({
        ...current,
        activeRoomId: next.id,
        rooms: [next, ...current.rooms],
      }))
    )
      return false;
    setSelection([]);
    setAttached([]);
    setGuardMessage('');
    setRedacted(null);
    navigate('canvas');
    return true;
  }
  function openTool(tool: Tool) {
    if (isVisible(tool)) setDialog(tool);
    setPopup(null);
  }
  function toggleModel(id: string) {
    if (!isStudio && !modelReleased(id)) return;
    if (live.active && !isStudio && routing.mode === 'auto') {
      updateRouting({ ...routing, mode: 'manual' });
      if (composerModelIds.includes(id)) return;
    }
    const current = composerModelIds;
    if (current.includes(id) && current.length === 1) {
      notify('Keep at least one model selected.');
      return;
    }
    if (!current.includes(id) && current.length >= canvasLimits.modelsPerTurn) {
      notify(`Compare up to ${canvasLimits.modelsPerTurn} models at a time.`);
      return;
    }
    const next = pickerOrder(
      current.includes(id)
        ? current.filter((model) => model !== id)
        : [...current, id],
      composerModels,
    );
    if (isStudio) studio.update({ modelIds: next });
    else updateRoom({ selectedModels: next });
  }
  function setComposerDraft(draft: string) {
    if (isSecondLook) {
      setSecondLookDraft(draft);
      return true;
    }
    return isStudio ? studio.update({ prompt: draft }) : updateRoom({ draft });
  }
  async function submit() {
    if (isSecondLook) {
      if (!secondLookDraft.trim() || secondLookComposer.busy) return;
      if (containsSecret(secondLookDraft)) {
        setGuardMessage(
          'Remove private keys or recovery phrases before continuing.',
        );
        return;
      }
      setGuardMessage('');
      await secondLookControl.current?.submit(secondLookDraft);
      return;
    }
    if (live.status === 'loading') {
      notify('Checking workspace availability. Try again in a moment.');
      return;
    }
    if(!live.active && (pictureByRoom[room.id]?.length || paperByRoom[room.id])){notify('Connect your account to ask models about attachments.');return;}
    const prompt = composerDraft.trim();
    if (!prompt) {
      setGuardMessage('');
      setRedacted(null);
      composer.current?.focus();
      return;
    }
    if (live.active && isStudio) {
      if (live.status !== 'ready') {
        openTool('identity');
        return;
      }
      setGuardMessage('');
      setRedacted(null);
      setPopup(null);
      await liveStudio.requestReview({ ...studio.draft, prompt });
      return;
    }
    if (live.active && !isStudio) {
      if (live.status !== 'ready') {
        openTool('identity');
        return;
      }
      if (strict) {
        setGuardMessage(
          'No verified private route is available. This request has not been sent.',
        );
        return;
      }
      if (attached.length) {
        setGuardMessage(
          'Attachments are not supported by the connected text routes yet. Remove them before sending.',
        );
        return;
      }
      if (live.busy) {
        // A brief account action (such as a Stop request) is finishing; streams never block sending.
        notify('Finishing the previous action. Send again in a moment.');
        return;
      }
      if (checkingContent.current) return;
      checkingContent.current = true;
      const checkedVersion = submissionVersion;
      try {
        const requestPrompt=featureOn('paperTrail') && paperByRoom[room.id] ? paperPrompt(composerDraft,paperByRoom[room.id]!) : composerDraft;
        const checked = await checkContent(requestPrompt);
        if (latestSubmission.current !== checkedVersion) {
          notify(
            'Your draft or project changed during the content check. Review it and send again.',
          );
          return;
        }
        const finding = checked.findings.find(
          (item) => item.severity === 'block',
        );
        if (finding) {
          setGuardMessage(finding.message);
          setRedacted(checked.redacted || null);
          return;
        }
        await live.quotePrompt({
          images:featureOn('pictureThis') ? pictureByRoom[room.id] : undefined,
          prompt: requestPrompt,
          composerDraft,
          modelIds: pickerOrder(composerModelIds, composerModels),
          blind: blindComparison && routing.mode !== 'auto',
          routing,
          onProjectCreated: (projectId) => {
            setPictureByRoom(current => { const next = {...current, [projectId]: current['service-empty'] ?? []}; delete next['service-empty']; return next; });
            setPaperByRoom(current => { const next = {...current, [projectId]: current['service-empty'] ?? null}; delete next['service-empty']; return next; });
            setRoutingByProject((current) => {
              const next = { ...current };
              delete next['service-empty'];
              next[projectId] ??= { ...routing };
              return next;
            });
          },
        });
      } finally {
        checkingContent.current = false;
      }
      return;
    }
    const guard = scanPrompt(prompt);
    if (guard) {
      setGuardMessage(guard.message);
      setRedacted(guard.redacted || null);
      return;
    }
    if (composerStrict) {
      setRedacted(null);
      setGuardMessage(
        isStudio
          ? 'Video models are not connected. Turn off the verified-route requirement to review a local draft.'
          : 'No connected, verified route meets this policy. Turn off the verified-route requirement to explore sample answers.',
      );
      return;
    }
    if (prompt.length > canvasLimits.prompt) {
      setRedacted(null);
      setGuardMessage(
        `Keep your question within ${canvasLimits.prompt} characters.`,
      );
      return;
    }
    if (isStudio) {
      setGuardMessage('');
      setRedacted(null);
      setPopup(null);
      setDialog('studio-review');
      return;
    }
    if (room.turns.length >= canvasLimits.turnsPerRoom) {
      setGuardMessage('');
      setRedacted(null);
      notify(
        'This project has reached the local preview limit. Start a new project to continue.',
      );
      return;
    }
    const nextTurn = createSampleTurn(prompt, composerModelIds);
    if (
      !updateRoom({
        turns: [...room.turns, nextTurn],
        draft: '',
      })
    )
      return;
    setSelection([]);
    setAttached([]);
    setGuardMessage('');
    setRedacted(null);
    notify('Sample answers added. No prompt was sent to a model.');
  }
  const selectAnswer = useCallback(
    (id: string) =>
      setSelection((current) =>
        current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id],
      ),
    [],
  );
  const copyAnswer = useCallback(
    async (answer: Answer) => {
      if (answer.live?.outputTruncated) {
        notify('Load the full answer before copying it.');
        return;
      }
      try {
        await navigator.clipboard.writeText(
          [answer.heading, ...answer.paragraphs].join('\n\n'),
        );
        notify('Answer copied.');
      } catch {
        notify(
          'Clipboard access is unavailable. Select the answer text to copy it.',
        );
      }
    },
    [notify],
  );
  const branchAnswer = useCallback(
    (answer: Answer) => {
      if (answer.live?.outputTruncated) {
        notify('Load the full answer before creating a follow-up.');
        return;
      }
      const currentRoom = stateRef.current.rooms.find(
        (item) => item.id === stateRef.current.activeRoomId,
      );
      if (!currentRoom) return;
      if (live.active) {
        live.setDraft(
          `${currentRoom.draft ? `${currentRoom.draft}\n\n` : ''}Follow up on this answer:\n${answer.live?.output ?? [answer.heading, ...answer.paragraphs].filter(Boolean).join('\n\n')}\n\n`,
        );
        if (answer.modelId !== 'blind') live.setModels([answer.modelId]);
        composer.current?.focus();
        return;
      }
      const followUp = `Follow up on “${answer.heading}”\n`;
      const draft = currentRoom.draft
        ? `${currentRoom.draft}\n\n${followUp}`
        : followUp;
      if (!live.active && draft.length > canvasLimits.draft) {
        notify(
          'Your current draft is too long to add this follow-up. Your text has been kept unchanged.',
        );
        return;
      }
      if (
        !updateWorkspace((current) => ({
          ...current,
          rooms: current.rooms.map((item) =>
            item.id === current.activeRoomId
              ? {
                  ...item,
                  draft,
                  selectedModels: [answer.modelId],
                  updatedAt: Date.now(),
                }
              : item,
          ),
        }))
      )
        return;
      setGuardMessage('');
      setRedacted(null);
      notify('Follow-up draft ready for this model.');
      composer.current?.focus();
    },
    [notify, updateWorkspace, live],
  );
  const inspectRoute = useCallback((id: string) => {
    if (!isVisible('routes')) return;
    setRouteModel(id);
    setDialog('routes');
  }, []);
  const quoteAnswer = useCallback((answer: Answer, text: string) => {
    if (!featureOn('quoteReply') || !text.trim()) return;
    const currentRoom = stateRef.current.rooms.find(item => item.id === stateRef.current.activeRoomId);
    if (!currentRoom) return;
    const name = answer.live?.modelName || answer.live?.label || MODELS.find(model => model.id === answer.modelId)?.name || 'this model';
    const draft = quotedReplyDraft(currentRoom.draft, name, text);
    if (live.active && (!live.account || new TextEncoder().encode(draft).byteLength > CHAT_LIMITS.inputBytes)) {
      notify('This quote cannot fit in the current account draft. Your existing draft is unchanged.');
      return;
    }
    if (!live.active && draft.length > canvasLimits.draft) {
      notify('This quote would exceed the local draft limit. Your draft is unchanged.');
      return;
    }
    if (live.active) live.setDraft(draft);
    else if (!updateWorkspace(current => ({ ...current, rooms: current.rooms.map(item => item.id === currentRoom.id ? { ...item, draft, updatedAt: Date.now() } : item) }))) return;
    setGuardMessage('');
    setRedacted(null);
    composer.current?.focus();
    notify('Selected passage added to your draft. Add your question before sending.');
  }, [live, notify, updateWorkspace]);
  const reuseQuestion: ReuseQuestion = (turn, question, source) => {
    if (!featureOn('askAgain')) return 'Ask Again is unavailable.';
    if (!question.trim()) return 'Add a question first.';
    const current = stateRef.current.rooms.find(item => item.id === stateRef.current.activeRoomId);
    if (!current) return 'Open a project first.';
    const draft = appendChatDraft(current.draft, question);
    if (live.active && (!live.account || new TextEncoder().encode(draft).byteLength > CHAT_LIMITS.inputBytes)) return 'This question cannot fit in the current account draft. Your existing draft is unchanged.';
    if (!live.active && draft.length > canvasLimits.draft) return 'This would exceed the local draft limit. Your existing draft is unchanged.';
    const existingPaper = paperByRoom[current.id];
    if (source && existingPaper && JSON.stringify(existingPaper) !== JSON.stringify(source)) return 'Your draft already has a different document. Remove it before reusing this question.';
    const pictures = [...new Map([...(pictureByRoom[current.id] ?? []), ...(turn.images ?? [])].map(image => [image.dataUrl, image])).values()];
    if (pictures.length > 4) return 'This would attach more than four pictures. Remove a picture from your draft first.';
    if (source && !featureOn('paperTrail')) return 'The original document cannot be reused while Paper Trail is unavailable.';
    if (turn.images?.length && !featureOn('pictureThis')) return 'The original pictures cannot be reused while Picture This is unavailable.';
    if (live.active) live.setDraft(draft);
    else if (!updateWorkspace(state => ({ ...state, rooms: state.rooms.map(item => item.id === current.id ? { ...item, draft, updatedAt: Date.now() } : item) }))) return 'The draft could not be saved. Your existing work is unchanged.';
    if (source) setPaperByRoom(value => ({ ...value, [current.id]: source }));
    if (pictures.length) setPictureByRoom(value => ({ ...value, [current.id]: pictures }));
    setGuardMessage('');
    setRedacted(null);
    requestAnimationFrame(() => composer.current?.focus());
    notify('Question added to your draft. Edit it or change models before sending.');
    return null;
  };
  const actions: AnswerActions = useMemo(
    () => ({
      selected: selection,
      onSelect: briefsVisible ? selectAnswer : undefined,
      onCopy: copyAnswer,
      onBranch: branchAnswer,
      onQuote: featureOn('quoteReply') ? quoteAnswer : undefined,
      onRoute: isVisible('routes') ? inspectRoute : undefined,
      onLoadFull: (answer) => {
        const turn = room.turns.find((item) =>
          item.answers.some((entry) => entry.id === answer.id),
        );
        if (turn) void live.loadComparison(turn.id);
      },
      onCancel: (answer) => {
        const turn = room.turns.find((item) =>
          item.answers.some((entry) => entry.id === answer.id),
        );
        if (turn) void live.cancelTurn(turn.id);
      },
      onVote: (answer) => {
        const turn = room.turns.find((item) =>
          item.answers.some((entry) => entry.id === answer.id),
        );
        if (turn) void live.voteTurn(turn.id, answer.id);
      },
      onReveal: (answer) => {
        const turn = room.turns.find((item) =>
          item.answers.some((entry) => entry.id === answer.id),
        );
        if (turn) void live.revealTurn(turn.id);
      },
    }),
    [
      selection,
      selectAnswer,
      copyAnswer,
      branchAnswer,
      quoteAnswer,
      inspectRoute,
      room.turns,
      live,
    ],
  );

  function saveBrief() {
    if (live.active) {
      const chosen = room.turns
        .flatMap((turn) => turn.answers.map((answer) => ({ turn, answer })))
        .filter(({ answer }) => selection.includes(answer.id));
      if (
        chosen.some(
          ({ answer }) =>
            answer.live?.outputTruncated || answer.live?.state !== 'succeeded',
        )
      ) {
        notify('Load the full, completed answers before saving this Brief.');
        return;
      }
      if (!chosen.length || chosen.length > 4) {
        notify('Choose between one and four completed answers for a Brief.');
        return;
      }
      if (
        chosen.reduce(
          (total, { turn, answer }) =>
            total + turn.prompt.length + (answer.live?.output ?? '').length,
          0,
        ) > 24000
      ) {
        notify(
          'These questions and responses exceed the 24,000-character Brief limit. Select fewer or shorter responses.',
        );
        return;
      }
      if (
        chosen.some(({ turn }) => turn.live?.blind && !turn.live.revealedAt)
      ) {
        notify('Reveal the model names before saving their provenance.');
        return;
      }
      const input = {
        projectId: room.id,
        title: room.name,
        callIds: chosen.map(({ answer }) => answer.id),
      };
      const fingerprint = JSON.stringify(input);
      if (briefSubmission.current?.fingerprint !== fingerprint)
        briefSubmission.current = { fingerprint, key: crypto.randomUUID() };
      void live
        .createBriefFromCalls({
          ...input,
          idempotencyKey: briefSubmission.current.key,
        })
        .then((saved) => {
          if (saved) {
            briefSubmission.current = null;
            setDialog(null);
            setSelection([]);
            navigate('library');
          }
        });
      return;
    }
    const brief = createBrief(room, selection);
    if (!brief) {
      notify('Select fewer answers from this project to fit them in a Brief.');
      return;
    }
    if (stateRef.current.briefs.length >= canvasLimits.briefs) {
      notify('Remove a saved Brief before adding another.');
      return;
    }
    if (
      !updateWorkspace((current) => ({
        ...current,
        briefs: [brief, ...current.briefs],
      }))
    )
      return;
    setDialog(null);
    setSelection([]);
    notify(
      storageBlocked
        ? 'Brief added to this session’s Library. Changes are not being saved in this tab.'
        : 'Brief saved to your Library.',
    );
    navigate('library');
  }
  async function printTakeaway(){
    const target=window.open('about:blank','_blank');
    if(!target){notify('Allow a new tab to prepare your PDF.');return;}
    target.opener=null;
    target.document.body.textContent='Preparing your complete conversation…';
    try {const complete=live.active?await live.prepareTakeaway(room.id):room;if(!complete)throw new Error('Unable to load complete conversation.');if(target.closed)return;const parsed = new DOMParser().parseFromString(takeawayDocument(complete,id=>MODELS.find(m=>m.id===id)?.name??id), 'text/html'); target.document.replaceChild(target.document.importNode(parsed.documentElement, true), target.document.documentElement);target.document.getElementById('print')?.addEventListener('click',()=>target.print());target.focus();}
    catch {if(!target.closed)target.document.body.textContent='The complete conversation could not be loaded. Close this tab and try again.';}
    setPopup(null);
  }
  function exportRoom() {
    if (
      room.turns.some((turn) =>
        turn.answers.some((answer) => answer.live?.outputTruncated),
      )
    ) {
      notify('Load the full answers before exporting this conversation.');
      return;
    }
    const text =
      `# ${room.name}\n\n${live.active ? (room.live?.historyCursor ? translate('Conclave account project · Loaded history only; earlier conversations are not included') : translate('Conclave account project')) : translate('Local preview · Sample responses')}\n\n` +
      room.turns
        .map(
          (turn) =>
            `## ${turn.prompt}\n\n` +
            turn.answers
              .map(
                (answer) =>
                  `### ${answer.live?.modelName || (answer.live?.label && modelLabel(answer.live.label, translate)) || MODELS.find((model) => model.id === answer.modelId)?.name || translate('Model')}\n\n${answer.heading}\n\n${answer.paragraphs.join('\n\n')}`,
              )
              .join('\n\n'),
        )
        .join('\n\n---\n\n');
    downloadFile('conclave-project.md', text, 'text/markdown');
    setPopup(null);
  }
  function exportWorkspace() {
    if (live.active) {
      downloadFile(
        'conclave-account-projects.json',
        JSON.stringify(
          { exportedAt: new Date().toISOString(), ...live.state },
          null,
          2,
        ),
        'application/json',
      );
      notify(
        'Loaded account records downloaded. Answer excerpts remain marked as partial; older unloaded history is not included.',
      );
      return;
    }
    const safe = storageSnapshot(stateRef.current);
    if (!safe) {
      notify(
        'The workspace cannot be downloaded safely. Your current work is unchanged.',
      );
      return;
    }
    downloadFile(
      'conclave-workspace.json',
      JSON.stringify(safe, null, 2),
      'application/json',
    );
    notify(
      'Projects, safe drafts, and Briefs downloaded. Secret-like drafts were excluded.',
    );
  }

  const navigationDock = (
    <nav className="cw-navigation" aria-label={t('Workspace navigation')}>
      {navigation.map((item) => (
        <button
          data-icon-trigger
          key={item.id}
          className={`cw-nav-button${view === item.id ? ' is-active' : ''}`}
          onClick={() => navigate(item.id)}
          aria-label={t(item.label)}
          aria-current={view === item.id ? 'page' : undefined}
        >
          <MotionIcon
            name={item.id === 'second-look' ? 'search' : item.id}
            size={44}
            active={view === item.id}
          />
          <span className="cw-tooltip">{t(item.label)}</span>
        </button>
      ))}
      {(secondary.length > 0 || moreToolsVisible) && (
        <div className="cw-more-anchor" data-cw-popover>
          <button
            data-icon-trigger
            className={`cw-nav-button${secondary.some((item) => item.id === view) ? ' is-active' : ''}`}
            aria-label={t('More tools')}
            aria-expanded={popup === 'more'}
            onClick={() => setPopup(popup === 'more' ? null : 'more')}
          >
            <MotionIcon
              name="more"
              size={44}
              active={
                popup === 'more' || secondary.some((item) => item.id === view)
              }
            />
            <span className="cw-tooltip">{t('More')}</span>
          </button>
          {popup === 'more' && (
            <div className="cw-menu cw-more-menu">
              {secondary.length > 0 && (
                <p className="cw-menu-label">{t('YOUR WORKSPACE')}</p>
              )}
              {secondary.map((item) => (
                <button
                  data-icon-trigger
                  key={item.id}
                  onClick={() => navigate(item.id)}
                >
                  <MotionIcon
                    name={item.id}
                    size={32}
                    active={view === item.id}
                  />
                  {t(item.label)}
                </button>
              ))}
              {secondary.length > 0 && moreToolsVisible && <hr />}
              {isVisible('explainer') && (
                <button data-icon-trigger onClick={() => openTool('explainer')}>
                  <Image
                    src="/brand/providers/solana.svg"
                    width={18}
                    height={18}
                    alt=""
                  />
                  {t('Solana Explainer')}
                </button>
              )}
              {isVisible('crosscheck') && (
                <button
                  data-icon-trigger
                  onClick={() => openTool('crosscheck')}
                >
                  <MotionIcon name="decisions" size={20} />
                  {t('Cross-Check')}
                </button>
              )}
              {isVisible('routes') && (
                <button data-icon-trigger onClick={() => openTool('routes')}>
                  <MotionIcon name="route" size={18} />
                  {t('Model routes')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </nav>
  );

  const compose = (
    <div className="cw-composer">
      {guardMessage && (
        <div className="cw-guard" role="alert">
          <Shield size={18} />
          <div>
            <p>{localizeNotice(guardMessage, t)}</p>
            {redacted && (
              <button
                data-icon-trigger
                onClick={() => {
                  if (setComposerDraft(redacted)) {
                    setGuardMessage('');
                    setRedacted(null);
                  }
                }}
              >
                {t('Use redacted text')}
              </button>
            )}
          </div>
          <button
            data-icon-trigger
            onClick={() => {
              setGuardMessage('');
              setRedacted(null);
            }}
            aria-label={t('Dismiss guard message')}
          >
            <MotionIcon name="close" size={15} />
          </button>
        </div>
      )}
      {recallOpen && featureOn('recall') && <Recall accountId={live.active ? live.account?.accountId ?? null : null} rooms={state.rooms} onClose={()=>setRecallOpen(false)} onOpen={async hit=>{if(live.active){if(!await live.openRecalledExchange(hit.projectId,hit.comparisonId))throw new Error('Unavailable');}else updateWorkspace(current=>({...current,activeRoomId:hit.projectId}));navigate('chat');setRecalledTurn(hit.comparisonId);}}/>}
      {composerAttachments.length > 0 && (
        <div className="cw-attachments">
          {composerAttachments.map((name, i) => (
            <button
              data-icon-trigger
              key={`${name}-${i}`}
              onClick={() =>
                isStudio
                  ? studio.clearReference()
                  : setAttached((current) =>
                      current.filter((_, index) => i !== index),
                    )
              }
            >
              <MotionIcon name="attach" size={12} />
              {name}
              <MotionIcon name="close" size={12} />
            </button>
          ))}
          <span>{t('Local only · not read by sample models')}</span>
        </div>
      )}
      {isConversation && ['quickPhrases','sayIt','pictureThis','paperTrail'].some(name=>featureOn(name as FeatureName)) && <div className="eu-composer-tools" aria-label="Message tools">
        {isConversation && featureOn('paperTrail') && <div className="eu-controls"><PaperTrail key={room.id} value={paperByRoom[room.id]??null} onChange={source=>setPaperByRoom(current=>({...current,[room.id]:source}))}/></div>}
        {isConversation && featureOn('pictureThis') && <div className="eu-controls"><PictureThis key={room.id} value={pictureByRoom[room.id]??[]} onChange={images=>setPictureByRoom(current=>({...current,[room.id]:images}))}/></div>}
        {isConversation && featureOn('sayIt') && <div className="eu-controls"><SayIt onInsert={text=>appendSuggestion(text)}/></div>}
        {isConversation && featureOn('quickPhrases') && <div className="eu-controls"><QuickPhrases scope={live.active ? live.account?.accountId ?? 'signed-out' : 'preview'} draft={room.draft} onChange={draft=>updateRoom({draft})}/></div>}
      </div>}
      <div className="cw-compose-line">
        <button
          data-icon-trigger
          className="cw-attach"
          onClick={() => attachment.current?.click()}
          aria-label={
            isSecondLook
              ? t('Read a text request from a file')
              : t('Add files to this project')
          }
          title={
            isSecondLook ? t('Read a text request locally') : t('Add files locally')
          }
        >
          <MotionIcon name="attach" size={22} />
        </button>
        <textarea
          ref={composer}
          rows={1}
          maxLength={isSecondLook ? 50000 : live.active ? undefined : canvasLimits.draft}
          value={composerDraft}
          onChange={(event) => {
            if (setComposerDraft(event.target.value)) {
              setGuardMessage('');
              setRedacted(null);
            }
          }}
          aria-label={
            isSecondLook
              ? t(secondLookComposer.label)
              : t('Message to selected models')
          }
          placeholder={
            isSecondLook
              ? t(secondLookComposer.placeholder)
              : isStudio
                ? t('Describe your next scene…')
                : room.turns.length
                  ? t('Ask a follow-up…')
                  : t('Ask anything…')
          }
          onKeyDown={(event) => {
            // oxlint-disable-next-line typescript/no-deprecated -- Safari may clear isComposing on the final IME Enter; 229 preserves text entry.
            const composing = event.nativeEvent.isComposing || event.keyCode === 229;
            if (
              shouldSubmitChatKey({ key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, isComposing: composing }, isConversation && featureOn('sendYourWay') ? sendSetting.value : 'enter')
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />

        {isSecondLook ? (
          <span className="sl-composer-mode">
            <Shield size={14} />
            {secondLookComposer.busy ? t('Checking…') : t(secondLookComposer.label)}
          </span>
        ) : (
          <div data-cw-popover className="cw-model-anchor">
            <button
              data-icon-trigger
              className="cw-selected-models"
              aria-label={t('Choose models')}
              aria-expanded={popup === 'models'}
              title={composerModelIds
                .map(
                  (id) => composerModels.find((model) => model.id === id)?.name,
                )
                .join(', ')}
              onClick={() => setPopup(popup === 'models' ? null : 'models')}
            >
              <span
                className={`cw-model-stack${composerModelIds.length >= 3 ? ' is-grid' : ''}${composerModelIds.length === 3 ? ' is-pyramid' : ''}`}
                aria-hidden="true"
              >
                {composerModelIds.map((id) => (
                  <ProviderIcon key={id} id={id} size={20} />
                ))}
              </span>
              <ChevronDown size={13} />
            </button>
            {popup === 'models' && (
              <div className="cw-model-menu cw-menu">
                <div className="cw-model-menu-head">
                  <h2>
                    {isStudio
                      ? t('One direction. Different takes.')
                      : t('Models')}
                  </h2>
                  <p>
                    {isStudio
                      ? live.active
                        ? t('Choose reviewed video routes. Formats and costs appear before approval.')
                        : t('Choose up to four video models for your draft.')
                      : live.active
                        ? t('Choose up to {count} connected models.', {
                            count: canvasLimits.modelsPerTurn,
                          })
                        : t('Choose up to {count} sample models.', {
                            count: canvasLimits.modelsPerTurn,
                          })}
                  </p>
                </div>
                {live.active && !isStudio && isVisible('routes') && (
                  <LiveRoutingOptions
                    value={routing}
                    onChange={updateRouting}
                    availableUsd6={live.balance?.availableUsd6 ?? null}
                  />
                )}
                <label className="cw-search" data-icon-field>
                  <MotionIcon name="search" size={17} />
                  <input
                    aria-label={t('Find a model')}
                    placeholder={t('Find a model…')}
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                </label>
                {!isStudio && featureOn('modelPanels') && <ModelPanels scope={live.active ? live.account?.accountId ?? 'signed-out' : 'preview'} selected={composerModelIds} available={live.active ? live.availableModels : composerModels.map(model=>model.id)} onApply={models=>{ updateRoom({selectedModels:models}); updateRouting({...routing,mode:'manual'}); }} />}
                <ModelPickerOptions
                  routes={live.routes}
                  accountScope={live.active ? live.account?.accountId ?? "signed-out" : "preview"}
                  models={composerModels}
                  selected={composerModelIds}
                  available={live.active ? (isStudio ? liveStudio.availableModels : live.availableModels) : null}
                  query={modelQuery}
                  studio={isStudio}
                  onToggle={toggleModel}
                />
                {isStudio && (
                  <StudioDraftOptions
                    draft={studio.draft}
                    onChange={studio.update}
                    connected={live.active}
                  />
                )}
                {live.active && !isStudio && (
                  <label className="cw-strict">
                    <input
                      type="checkbox"
                      checked={
                        blindComparison &&
                        composerModelIds.length > 1 &&
                        routing.mode !== 'auto'
                      }
                      disabled={
                        composerModelIds.length < 2 || routing.mode === 'auto'
                      }
                      onChange={(event) =>
                        setBlindComparison(event.target.checked)
                      }
                    />
                    <span>
                      {t('Blind comparison')}
                      <small>{t('Hide reply labels until you vote or reveal.')}</small>
                    </span>
                  </label>
                )}
                <label className="cw-strict">
                  <input
                    type="checkbox"
                    checked={composerStrict}
                    onChange={(event) =>
                      isStudio
                        ? studio.update({ strict: event.target.checked })
                        : setStrict(event.target.checked)
                    }
                  />
                  <span>
                    {live.active && !isStudio
                      ? t('Require sealed execution')
                      : t('Require a verified route')}
                    <small>
                      {live.active && !isStudio
                        ? t('Only attested routes. No fallback.')
                        : t('Unverified routes will be blocked.')}
                    </small>
                  </span>
                </label>
                {!isStudio && isVisible('routes') && (
                  <button
                    data-icon-trigger
                    className="cw-route-link"
                    onClick={() => openTool('routes')}
                  >
                    <MotionIcon name="route" size={18} />
                    {t('Inspect model routes')}
                    <MotionIcon name="forward" size={14} />
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <button
          data-icon-trigger
          className="cw-send"
          aria-label={
            isSecondLook
              ? t(secondLookComposer.label)
              : isStudio
                ? live.active
                  ? t('Review video generation')
                  : t('Review Studio draft')
                : live.active
                  ? t('Review model request')
                  : t('Send sample prompt')
          }
          title={
            isStudio
              ? live.active
                ? t('Review generation · Enter')
                : t('Review draft · Enter')
              : isConversation && featureOn('sendYourWay') && sendSetting.value === 'modifier' ? 'Send · ⌘ / Ctrl + Enter' : t('Send · Enter')
          }
          onClick={submit}
          disabled={
            !composerDraft.trim() ||
            (isSecondLook && secondLookComposer.busy) ||
            (live.active && isStudio && liveStudio.busy)
          }
        >
          <MotionIcon name="send" size={21} />
        </button>
      </div>
      {isConversation && featureOn('sendYourWay') && <SendYourWay setting={sendSetting} />}
    </div>
  );

  return (
    <div className={`cw-shell cw-view-${view}`}>
      <a className="cw-skip" href="#cw-main">
        {t('Skip to workspace')}
      </a>
      <header className="cw-header">
        <Link className="cw-brand" href="/" aria-label={t('Conclave home')}>
          <Wordmark />
        </Link>
        <div className="cw-room-anchor" data-cw-popover>
          <button
            data-icon-trigger
            className="cw-room-trigger"
            onClick={() => setPopup(popup === 'rooms' ? null : 'rooms')}
            aria-expanded={popup === 'rooms'}
          >
            <MotionIcon name="copy" size={16} />
            <span>
              {isConversation || view === 'studio' || view === 'agents'
                ? projectName(room, t)
                : t('Personal')}
            </span>
            <ChevronDown size={16} />
          </button>
          {popup === 'rooms' && (
            <div className="cw-menu cw-room-menu">
              <p className="cw-menu-label">{t('YOUR PROJECTS')}</p>
              {/* Without the Projects page, this scrolling menu lists every loaded project. */}
              {state.rooms
                .slice(0, isVisible('rooms') ? 8 : undefined)
                .map((item) => (
                  <button
                    data-icon-trigger
                    key={item.id}
                    onClick={() => openRoom(item.id)}
                  >
                    <MotionIcon name="rooms" size={16} />
                    <span>{projectName(item, t)}</span>
                    {item.id === room.id && <Check size={15} />}
                  </button>
                ))}
              <button
                data-icon-trigger
                onClick={() => newRoom('Untitled project')}
              >
                <MotionIcon name="add" size={16} />
                {t('New project')}
              </button>
              <hr />
              <button
                data-icon-trigger
                onClick={() => {
                  setRename(room.name);
                  setDialog('rename');
                  setPopup(null);
                }}
              >
                <MotionIcon name="settings" size={16} />
                {t('Rename project')}
              </button>
              {featureOn('recall') && <button onClick={()=>{setRecallOpen(true);setPopup(null);}}>Recall</button>}
              {featureOn('takeaway') && <button disabled={live.busy||!room.turns.length} onClick={()=>void printTakeaway()}>Takeaway · Save PDF</button>}
              <button data-icon-trigger onClick={exportRoom}>
                <MotionIcon name="download" size={16} />
                {t('Export conversation')}
              </button>
              {briefsVisible && (
                <button
                  data-icon-trigger
                  disabled={!room.turns.length}
                  onClick={() => {
                    setDialog('brief');
                    setPopup(null);
                  }}
                >
                  <MotionIcon name="brief" size={16} />
                  {t('Create Brief…')}
                </button>
              )}
              {isVisible('rooms') && (
                <button data-icon-trigger onClick={() => navigate('rooms')}>
                  <MotionIcon name="rooms" size={16} />
                  {t('All projects')}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="cw-account-anchor" data-cw-popover>
          <LanguageToggle className="cw-language" />
          <button
            data-icon-trigger
            className="cw-avatar"
            aria-label={t('Account menu')}
            aria-expanded={popup === 'account'}
            onClick={() => setPopup(popup === 'account' ? null : 'account')}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle
                cx="8"
                cy="5.5"
                r="3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M2.5 14c.8-3 2.9-4.5 5.5-4.5s4.7 1.5 5.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          {popup === 'account' && (
            <div className="cw-menu cw-account-menu">
              {!isVisible('purse') && (
                <>
                  <p className="cw-menu-label">{t('AVAILABLE BALANCE')}</p>
                  {live.active && live.status === 'ready' ? (
                    <button
                      data-icon-trigger
                      disabled={live.busy}
                      title={
                        live.balance
                          ? t(
                              '{available} USD available · {reserved} USD reserved for open requests. Select to refresh.',
                              {
                                available: formatAccountUsd6(
                                  live.balance.availableUsd6,
                                ),
                                reserved: formatAccountUsd6(
                                  live.balance.reservedUsd6,
                                ),
                              },
                            )
                          : t('Refresh balance')
                      }
                      onClick={() => {
                        setPopup(null);
                        void live.refresh();
                      }}
                    >
                      <MotionIcon name="purse" size={17} />
                      {live.balance ? (
                        <span className="cw-balance">
                          <strong>
                            {formatFriendlyUsd6(live.balance.availableUsd6)}
                          </strong>
                          <small>
                            {t('{amount} reserved for open requests', {
                              amount: formatFriendlyUsd6(
                                live.balance.reservedUsd6,
                              ),
                            })}
                          </small>
                          {live.balance.internalTestCreditUsd6 !==
                            undefined && (
                            <small>
                              {t('Internal test credit · not USDC')}
                            </small>
                          )}
                          {live.balance.welcomeCreditUsd6 !== undefined && (
                            <small>{t('Welcome usage credit · not USDC')}</small>
                          )}
                        </span>
                      ) : (
                        t('Unavailable · Refresh')
                      )}
                    </button>
                  ) : (
                    <button
                      data-icon-trigger
                      disabled={live.status === 'loading'}
                      onClick={() => openTool('identity')}
                    >
                      <MotionIcon name="purse" size={17} />
                      {live.status === 'loading'
                        ? t('Checking…')
                        : live.active
                          ? t('Sign in to view')
                          : t('Not connected')}
                    </button>
                  )}
                  <hr />
                </>
              )}
              <p className="cw-menu-label">
                {live.active ? t('ACCOUNT WORKSPACE') : t('LOCAL WORKSPACE')}
              </p>
              {isVisible('identity') && (
                <button data-icon-trigger onClick={() => openTool('identity')}>
                  <MotionIcon name="chapters" size={17} />
                  {t('Account & wallet')}
                </button>
              )}
              {isVisible('settings') && (
                <button data-icon-trigger onClick={() => openTool('settings')}>
                  <MotionIcon name="settings" size={17} />
                  {t('Settings')}
                </button>
              )}
              {isVisible('help') && (
                <button data-icon-trigger onClick={() => openTool('help')}>
                  <MotionIcon name="help" size={17} />
                  {t('Help & shortcuts')}
                </button>
              )}
              <Link data-icon-trigger href="/docs">
                <MotionIcon name="library" size={17} />
                {t('Field guide')}
              </Link>
              {/* Narrow screens have no room for the switch in the header. */}
              <div className="cw-menu-language">
                <hr />
                <p className="cw-menu-label">{t('LANGUAGE')}</p>
                <LanguageToggle />
              </div>
            </div>
          )}
        </div>
      </header>

      <main
        ref={main}
        id="cw-main"
        className="cw-content"
        tabIndex={-1}
        onScroll={(event) => {
          if (view === 'chat')
            chatScrollPositions.current.set(
              room.id,
              event.currentTarget.scrollTop,
            );
        }}
      >
        {!isSecondLook && live.active && live.status !== 'ready' && (
          <div className="cw-loading">
            <p>
              {live.status === 'loading'
                ? t('Loading your account workspace…')
                : live.status === 'error'
                  ? t('Your account workspace is unavailable.')
                  : t('Sign in to continue with your account projects.')}
            </p>
            <button
              className="ct-button"
              type="button"
              onClick={() => openTool('identity')}
            >
              {t('Open account')}
            </button>
          </div>
        )}
        {live.active &&
          live.status === 'ready' &&
          (view === 'rooms' || view === 'library' || isConversation) && (
            <div className="ct-note">
              {isConversation && room.live?.historyCursor && (
                <button
                  className="ct-button"
                  type="button"
                  disabled={live.busy}
                  onClick={() => void live.loadMoreHistory()}
                >
                  {t('Load earlier conversations')}
                </button>
              )}
              {view === 'library' && live.briefsCursor && (
                <button
                  className="ct-button"
                  type="button"
                  disabled={live.busy}
                  onClick={() => void live.loadMoreBriefs()}
                >
                  {t('Load more Briefs')}
                </button>
              )}
              {view === 'rooms' && live.projectsCursor && (
                <button
                  className="ct-button"
                  type="button"
                  disabled={live.busy}
                  onClick={() => void live.loadMoreProjects()}
                >
                  {t('Load more projects')}
                </button>
              )}
            </div>
          )}
        {isConversation ? (
          <>
            {briefsVisible && selection.length > 0 && (
              <div className="cw-selection-bar">
                <span>
                  {t('{count} selected', { count: selection.length })}
                </span>
                <button data-icon-trigger onClick={() => setDialog('brief')}>
                  <MotionIcon name="brief" size={15} />
                  {t('Create Brief')}
                </button>
                <button
                  data-icon-trigger
                  aria-label={t('Clear selection')}
                  onClick={() => setSelection([])}
                >
                  <MotionIcon name="close" size={15} />
                </button>
              </div>
            )}
            {room.turns.length === 0 ? (
              <div className="cw-empty-room">
                <span className="cw-empty-kicker">{t('A NEW PROJECT')}</span>
                <h1>{t('What are we thinking about?')}</h1>
                <p>{t('One question. A few different perspectives.')}</p>
                <div>
                  <button
                    data-icon-trigger
                    onClick={() =>
                      appendSuggestion(
                        'How should I launch my notes app in two weeks?',
                      )
                    }
                  >
                    {t('Plan a launch')}
                    <MotionIcon name="forward" size={16} />
                  </button>
                  <button
                    data-icon-trigger
                    onClick={() =>
                      appendSuggestion(
                        'What should I check before approving a Solana transaction?',
                      )
                    }
                  >
                    {t('Explore Solana')}
                    <MotionIcon name="forward" size={16} />
                  </button>
                </div>
                <small>
                  {live.active
                    ? live.status === 'ready'
                      ? t(
                          'Choose your models and review the cost before sending.',
                        )
                      : t('Sign in to open your account projects.')
                    : t('Local preview · Sample answers, no connected models.')}
                </small>
              </div>
            ) : view === 'canvas' ? (
              ready && (
                <Suspense
                  fallback={
                    <div className="cw-loading">
                      {t('Opening your canvas…')}
                    </div>
                  }
                >
                  <CanvasBoard
                    key={`${live.account?.accountId ?? 'local'}:${room.id}`}
                    accountScope={live.account?.accountId ?? 'local-preview'}
                    projectId={room.id}
                    turns={room.turns}
                    actions={actions}
                  />
                </Suspense>
              )
            ) : (
              <ChatThread
                turns={room.turns}
                actions={actions}
                preferences={chatPreferences[room.id] ?? {}}
                onPreferenceChange={updateChatPreference}
                onReuseQuestion={reuseQuestion}
                hasEarlier={!!room.live?.historyCursor}
                loadingHistory={live.busy}
                onLoadEarlier={() => void live.loadMoreHistory()}
                accountScope={live.active ? live.account?.accountId ?? 'signed-out' : 'preview'}
              />
            )}
          </>
        ) : null}
        {isStudio &&
          (live.active ? (
            <LiveStudioPage
              key={room.id}
              studio={liveStudio}
              active={isStudio}
              onToast={notify}
              onReuse={(draft) => {
                studio.clearReference();
                studio.update(draft);
                requestAnimationFrame(() => composer.current?.focus());
              }}
            />
          ) : (
            <StudioPage
              key={room.id}
              active={isStudio}
              modelIds={studio.draft.modelIds}
              onToast={notify}
            />
          ))}
        {isSecondLook && (
          <Suspense
            fallback={<div className="cw-loading">{t('Opening FOMO…')}</div>}
          >
            <SecondLookWorkspace
              accountId={live.account?.accountId ?? null}
              controlRef={secondLookControl}
              onComposer={setSecondLookComposer}
              onDraft={setSecondLookDraft}
              onSignIn={() => openTool('identity')}
              onToast={notify}
              analysis={{
                models: MODELS.filter(model=>live.availableModels.includes(model.id)),
                defaultModelIds: composerModelIds,
                available: live.callsAvailable && !live.busy,
                analyze: async ({title,prompt,modelIds,subjectId}) => {
                  if (!live.signedIn) { openTool('identity'); return false; }
                  const version = latestSubmission.current;
                  const checked=await checkContent(prompt);
                  if (!shellActive.current || latestSubmission.current !== version) return false;
                  const blocked=checked.findings.find(finding=>finding.severity==='block');
                  if (blocked) {notify(blocked.message); return false;}
                  return live.quotePrompt({prompt,modelIds,researchTitle:title,onProjectCreated:projectId=>setFomoResult({subjectId,projectId,title})});
                },
                resultSubjectId: fomoResult?.subjectId,
                turns: fomoResult ? state.rooms.find(item=>item.id===fomoResult.projectId)?.turns ?? [] : [],
                results: fomoResult ? <ChatThread
                  turns={state.rooms.find(item=>item.id===fomoResult.projectId)?.turns ?? []}
                  actions={actions}
                  preferences={chatPreferences[fomoResult.projectId] ?? {}}
                  onPreferenceChange={updateChatPreference}
                /> : null,
              }}
            />
          </Suspense>
        )}
        {pageViews.some(isVisible) && (
          <WorkspacePages
            account={
              live.active
                ? {
                    accountId: live.account?.accountId ?? null,
                    balance: live.balance,
                    refresh: live.refresh,
                  }
                : undefined
            }
            view={isConversation || view === 'second-look' ? undefined : view}
            state={state}
            query={query}
            onOpenRoom={openRoom}
            onCreateRoom={newRoom}
            onTogglePin={(id) =>
              updateWorkspace((current) => ({
                ...current,
                rooms: current.rooms.map((item) =>
                  item.id === id ? { ...item, pinned: !item.pinned } : item,
                ),
              }))
            }
            onCompareDecision={compareDecision}
            onRestoreProject={live.active ? live.restoreProject : undefined}
            onDeleteRoom={(id) => {
              setDeleteId(id);
              setDialog('delete');
            }}
            onDeleteBrief={(id) =>
              live.active
                ? void live.deleteBrief(id)
                : updateWorkspace((current) => ({
                    ...current,
                    briefs: current.briefs.filter((item) => item.id !== id),
                  }))
            }
            onEditBrief={live.active ? live.updateBriefDocument : undefined}
            onRefreshBrief={live.active ? live.refreshBrief : undefined}
            onToast={notify}
          />
        )}
      </main>

      <div
        ref={dockArea}
        className={`cw-dock-area${isComposerView ? ' cw-conversation-dock' : ''}`}
      >
        <div className={`cw-dock${!isComposerView ? ' cw-dock-browse' : ''}`}>
          {navigationDock}
          {isComposerView ? (
            compose
          ) : view === 'rooms' || view === 'library' ? (
            <div className="cw-dock-search" data-icon-field>
              <MotionIcon name="search" size={18} />
              <input
                aria-label={
                  view === 'rooms' ? t('Search projects') : t('Search library')
                }
                placeholder={
                  view === 'rooms'
                    ? t('Find a project…')
                    : view === 'library'
                      ? t('Find something you saved…')
                      : t('Search this workspace…')
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  data-icon-trigger
                  onClick={() => setQuery('')}
                  aria-label={t('Clear search')}
                >
                  <MotionIcon name="close" size={16} />
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <button
        data-icon-trigger
        className="cw-demo-label"
        onClick={() =>
          openTool(
            isVisible('help') ? 'help' : live.active ? 'identity' : 'settings',
          )
        }
      >
        {live.active
          ? t.rich('Account workspace{status}', {
              status: (
                <span>
                  {t(' · {status}', {
                    status:
                      live.status === 'ready'
                        ? t('Private session')
                        : t('Sign in'),
                  })}
                </span>
              ),
            })
          : t.rich('Local preview{sample}', {
              sample: <span>{t(' · Sample data')}</span>,
            })}
      </button>
      <input
        ref={attachment}
        hidden
        type="file"
        multiple={!isStudio && !isSecondLook}
        accept={
          isSecondLook
            ? '.txt,.json'
            : isStudio
              ? 'image/jpeg,image/png,image/webp,image/gif'
              : '.txt,.md,.csv,.json,image/*'
        }
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          if (isSecondLook) {
            const file = files[0];
            event.target.value = '';
            if (!file) return;
            if (file.size > 50000) {
              notify('Choose a text request smaller than 50 KB.');
              return;
            }
            const version = latestSubmission.current;
            void file.text().then(
              (text) => {
                if (latestSubmission.current !== version) return;
                if (containsSecret(text)) {
                  notify(
                    'This file appears to contain a secret and was not loaded.',
                  );
                  return;
                }
                setSecondLookDraft(text);
                notify(
                  'Request loaded in this tab. Review it before inspecting.',
                );
              },
              () => notify('This file could not be read.'),
            );
            return;
          }
          if (isStudio) {
            const message = studio.attach(files[0]);
            if (message) notify(message);
            event.target.value = '';
            return;
          }
          setAttached(files.slice(0, 3).map((file) => file.name));
          notify(
            'Files are attached locally. Sample models do not read or upload them.',
          );
          event.target.value = '';
        }}
      />
      {toast && (
        <output className="cw-toast">
          <Check size={16} />
          <span>{localizeNotice(toast, t)}</span>
          <button
            data-icon-trigger
            onClick={() => setToast('')}
            aria-label={t('Dismiss notification')}
          >
            <MotionIcon name="close" size={14} />
          </button>
        </output>
      )}

      {live.active && live.error && (
        <output className="cw-toast">{localizeNotice(live.error, t)}</output>
      )}
      {live.requestReview && (
        <Dialog title={t('Review model request')} onClose={live.dismissRequest}>
          <LiveRequestReview
            review={live.requestReview}
            availableUsd6={live.balance?.availableUsd6 ?? null}
            busy={live.busy}
            error={live.error}
            onApprove={() => {
              const projectId = live.requestReview!.projectId;
              const sentPicture = pictureByRoom[projectId], sentPaper = paperByRoom[projectId];
              void live.approveRequest().then(accepted => {
                if (!accepted) return;
                setPictureByRoom(current => current[projectId] === sentPicture ? {...current, [projectId]: []} : current);
                setPaperByRoom(current => current[projectId] === sentPaper ? {...current, [projectId]: null} : current);
              });
            }}
            onDismiss={live.dismissRequest}
          />
        </Dialog>
      )}
      {liveStudio.review && (
        <Dialog
          title={t('Review video generation')}
          onClose={() => {
            liveStudio.dismissReview();
          }}
        >
          <LiveStudioReview
            review={liveStudio.review}
            busy={liveStudio.busy}
            error={liveStudio.error}
            onVariantChange={(family, key) => {
              liveStudio.selectVariant(family, key);
            }}
            onRefreshQuotes={() => {
              void liveStudio.refreshQuotes();
            }}
            onApprove={() => {
              void liveStudio.approve().then((accepted) => {
                if (accepted) void live.refresh();
              });
            }}
            onDismiss={() => {
              liveStudio.dismissReview();
            }}
          />
        </Dialog>
      )}
      {dialog && (
        <Dialog
          title={t(dialog === 'identity' && !live.signedIn ? 'Connect to Conclave' : dialogTitles[dialog])}
          variant={dialog === 'identity' ? 'account' : undefined}
          onClose={() => setDialog(null)}
        >
          {dialog === 'studio-review' ? (
            <StudioDraftReview
              draft={studio.draft}
              projectName={room.name}
              modelNames={STUDIO_MODELS.filter((model) =>
                studio.draft.modelIds.includes(model.id),
              ).map((model) => model.name)}
              onClose={() => setDialog(null)}
              onToast={notify}
            />
          ) : dialog === 'brief' ? (
            <div className="cw-brief-picker">
              <p>
                {live.active
                  ? t(
                      'Choose up to four completed responses. Your Brief preserves their original text, provenance, and usage at save.',
                    )
                  : t(
                      'Choose the perspectives worth keeping. Your Brief saves their sample answers together.',
                    )}
              </p>
              {room.turns.map((turn) => (
                <fieldset key={turn.id}>
                  <legend>{turn.prompt}</legend>
                  {turn.answers.map((answer) => (
                    <label key={answer.id}>
                      <input
                        type="checkbox"
                        checked={selection.includes(answer.id)}
                        onChange={() => selectAnswer(answer.id)}
                      />
                      <ProviderIcon id={answer.modelId} size={22} />
                      <span>
                        <strong>
                          {answer.live?.modelName ??
                            (answer.live?.label
                              ? modelLabel(answer.live.label, t)
                              : undefined) ??
                            MODELS.find((model) => model.id === answer.modelId)
                              ?.name}
                        </strong>
                        {answer.live && !answer.live.output
                          ? t(answer.heading)
                          : answer.heading}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
              <button
                data-icon-trigger
                className="cw-primary"
                disabled={selection.length === 0}
                onClick={saveBrief}
              >
                {t('Save Brief to Library')}
                <MotionIcon name="forward" size={17} />
              </button>
            </div>
          ) : dialog === 'rename' ? (
            <form
              className="cw-simple-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (live.active) {
                  void live
                    .renameProject(room.id, rename.trim())
                    .then((saved) => {
                      if (saved) setDialog(null);
                    });
                  return;
                }
                if (rename.trim() && updateRoom({ name: rename.trim() }))
                  setDialog(null);
              }}
            >
              <label htmlFor="cw-room-name">{t('Project name')}</label>
              <input
                id="cw-room-name"
                value={rename}
                maxLength={canvasLimits.roomName}
                onChange={(event) => setRename(event.target.value)}
              />
              <button
                data-icon-trigger
                className="cw-primary"
                disabled={!rename.trim()}
              >
                {t('Save name')}
                <MotionIcon name="select" size={18} />
              </button>
            </form>
          ) : dialog === 'delete' ? (
            <div className="cw-simple-form">
              <p>
                {live.active
                  ? t(
                      'This project will be archived. Existing requests and accounting records are retained.',
                    )
                  : t(
                      'The project and its saved Briefs will be removed from this browser.',
                    )}
              </p>
              <button
                data-icon-trigger
                className="cw-primary"
                onClick={() => {
                  if (live.active) {
                    if (deleteId)
                      void live.archiveProject(deleteId).then((archived) => {
                        if (archived) {
                          setDialog(null);
                          setSelection([]);
                        }
                      });
                    return;
                  }
                  if (
                    !updateWorkspace((current) => {
                      const rooms = current.rooms.filter(
                        (item) => item.id !== deleteId,
                      );
                      if (!rooms.length)
                        rooms.push(createRoom('Untitled project'));
                      return {
                        ...current,
                        rooms,
                        activeRoomId:
                          current.activeRoomId === deleteId
                            ? rooms[0].id
                            : current.activeRoomId,
                        briefs: current.briefs.filter(
                          (item) => item.roomId !== deleteId,
                        ),
                      };
                    })
                  )
                    return;
                  setDialog(null);
                  setSelection([]);
                  setGuardMessage('');
                  setRedacted(null);
                  if (deleteId) studio.removeProject(deleteId);
                  notify('Project removed.');
                }}
              >
                {live.active ? t('Archive project') : t('Delete project')}
              </button>
            </div>
          ) : dialog === 'reset' ? (
            <div className="cw-simple-form">
              <p>
                {t(
                  'This removes this preview’s projects and Briefs from this browser. Export anything you want to keep first.',
                )}
              </p>
              <button
                data-icon-trigger
                className="cw-primary"
                onClick={() => {
                  let canSave = true;
                  try {
                    localStorage.removeItem(workspaceKey);
                  } catch {
                    canSave = false;
                  }
                  studio.reset();
                  const fresh = initialWorkspace();
                  localStateRef.current = fresh;
                  if (!live.active) stateRef.current = fresh;
                  lastStored.current = canSave ? null : undefined;
                  writesBlocked.current = !canSave;
                  setState(fresh);
                  setStorageBlocked(!canSave);
                  setStorageConflict(false);
                  setSelection([]);
                  setAttached([]);
                  setGuardMessage('');
                  setRedacted(null);
                  setDialog(null);
                  navigate('canvas');
                  notify(
                    canSave
                      ? 'Local workspace reset.'
                      : 'Session reset. Browser storage is unavailable, so saved data could not be removed.',
                  );
                }}
              >
                {t('Reset local workspace')}
              </button>
            </div>
          ) : (
            <>
              <ToolsContent
                service={
                  live.active
                    ? {
                        accountId: live.account?.accountId ?? null,
                        routes: live.routes,
                        signedIn: live.signedIn,
                        liveInference: live.callsAvailable,
                        internalTestCredit:
                          live.balance?.internalTestCreditUsd6 !== undefined,
                      }
                    : undefined
                }
                view={dialog}
                modelId={routeModel}
                onClose={() => setDialog(null)}
                onToast={notify}
              />
              {dialog === 'settings' && !live.active && (
                <div className="cw-reset-row">
                  <button data-icon-trigger onClick={() => setDialog('reset')}>
                    {t('Reset local workspace')}
                  </button>
                  {storageBlocked && (
                    <>
                      <p>
                        {storageConflict
                          ? t(
                              'Another tab changed the saved workspace. This tab has stopped saving. Download your projects and Briefs before reloading the saved version.',
                            )
                          : t(
                              'Storage is unavailable or contains data this version cannot read. Download your current projects and Briefs to keep them.',
                            )}
                      </p>
                      <button data-icon-trigger onClick={exportWorkspace}>
                        {t('Download projects & Briefs')}
                      </button>
                      {storageConflict && (
                        <button
                          data-icon-trigger
                          onClick={() => location.reload()}
                        >
                          {t('Reload saved workspace')}
                        </button>
                      )}
                      <p>
                        {t(
                          'Secret-like drafts are excluded from the download. Download Studio, Agent, and Chapter plans from their pages.',
                        )}
                      </p>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}
