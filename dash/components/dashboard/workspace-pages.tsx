'use client';

import {
  useEffect,
  useRef,
  useState,
  type SubmitEvent,
  type ReactNode,
} from 'react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import type { CanvasBrief, Room, WorkspaceState } from './canvas-state';
import { MotionIcon } from './motion-icon';
import { LivePurse, type PurseAccount } from './live-purse';
import { LiveBriefEditor } from './live-brief-editor';
import { LiveBriefReader } from './live-brief-reader';
import { LiveBriefSynthesis } from './live-brief-synthesis';
import { featureOn } from './feature-switches';
import { renderBriefPrintHtml } from '../../lib/brief-document';
import '@/app/dashboard/workspace-pages.css';

export type PageView =
  | 'rooms'
  | 'studio'
  | 'agents'
  | 'library'
  | 'decisions'
  | 'connections'
  | 'purse'
  | 'chapters';

type WorkspacePagesProps = {
  account?: PurseAccount;
  view?: PageView;
  state: WorkspaceState;
  query: string;
  onOpenRoom: (id: string) => void;
  onCreateRoom: (name: string) => boolean;
  onTogglePin: (id: string) => void;
  onDeleteRoom: (id: string) => void;
  onDeleteBrief: (id: string) => void;
  onEditBrief?: (brief: CanvasBrief) => Promise<boolean>;
  onRefreshBrief?: (id: string) => Promise<boolean>;
  onToast: (message: string) => void;
};

function dateLabel(value: number) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

function filename(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 70) || 'conclave-draft'
  );
}

function downloadText(
  name: string,
  text: string,
  type = 'text/markdown;charset=utf-8',
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PageHeading({
  title,
  description,
  children,
  eyebrow,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="cp-heading">
      <div>
        {eyebrow && <p className="cp-eyebrow">{eyebrow}</p>}
        <h1 className="cp-title">{title}</h1>
        <p className="cp-description">{description}</p>
      </div>
      {children && <div className="cp-heading-actions">{children}</div>}
    </header>
  );
}

function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="cp-empty">
      <span className="cp-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

function RoomPreview({ room }: { room: Room }) {
  const turn = room.turns.at(-1);
  return (
    <div
      className={`cp-room-preview${turn ? '' : ' cp-room-preview--empty'}`}
      aria-hidden="true"
    >
      {turn ? (
        <>
          <div className="cp-preview-question">
            <span className="cp-red-dot" />
            <p>{turn.prompt}</p>
          </div>
          <div className="cp-preview-connection">
            <span />
            <ArrowRight size={13} />
          </div>
          <div className="cp-preview-answer">
            <MotionIcon name="brief" size={20} />
            <p>{turn.answers[0]?.heading || 'A question worth exploring.'}</p>
            <small>
              {turn.answers.length}{' '}
              {turn.answers.length === 1 ? 'perspective' : 'perspectives'}
            </small>
          </div>
        </>
      ) : (
        <>
          <span className="cp-room-outline">
            <MotionIcon name="add" size={24} />
          </span>
          <p>A place for your next idea.</p>
        </>
      )}
    </div>
  );
}

function RoomsPage({
  state,
  query,
  onOpenRoom,
  onCreateRoom,
  onTogglePin,
  onDeleteRoom,
}: WorkspacePagesProps) {
  const [filter, setFilter] = useState<'recent' | 'pinned'>('recent');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) input.current?.focus();
  }, [creating]);
  const search = query.trim().toLowerCase();
  const rooms = state.rooms
    .filter(
      (room) =>
        (filter === 'recent' || room.pinned) &&
        `${room.name} ${room.turns.map((turn) => turn.prompt).join(' ')}`
          .toLowerCase()
          .includes(search),
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  const create = (event: SubmitEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (!onCreateRoom(name.trim())) return;
    setName('');
    setCreating(false);
  };
  return (
    <section className="cp-page cp-rooms">
      <PageHeading
        title="Projects"
        description="A place for every question. Pick up a thought, or start something new."
      >
        <button
          data-icon-trigger
          className="cp-button cp-button--red"
          type="button"
          aria-expanded={creating}
          aria-controls="cp-new-room"
          onClick={() => setCreating(!creating)}
        >
          <MotionIcon name="add" size={20} />
          New project
        </button>
      </PageHeading>
      {creating && (
        <form className="cp-create-strip" id="cp-new-room" onSubmit={create}>
          <label htmlFor="cp-room-name">What are you working on?</label>
          <div>
            <input
              ref={input}
              id="cp-room-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="Give your project a name"
              required
            />
            <button
              data-icon-trigger
              className="cp-button cp-button--ink"
              type="submit"
              disabled={!name.trim()}
            >
              Create project
              <MotionIcon name="forward" size={20} />
            </button>
            <button
              data-icon-trigger
              className="cp-icon-button"
              type="button"
              onClick={() => setCreating(false)}
              aria-label="Cancel new project"
            >
              <MotionIcon name="close" size={20} />
            </button>
          </div>
        </form>
      )}
      <div className="cp-filter-row">
        <div className="cp-tabs" aria-label="Project filter">
          <button
            data-icon-trigger
            type="button"
            aria-pressed={filter === 'recent'}
            onClick={() => setFilter('recent')}
          >
            Recent
          </button>
          <button
            data-icon-trigger
            type="button"
            aria-pressed={filter === 'pinned'}
            onClick={() => setFilter('pinned')}
          >
            Pinned
          </button>
        </div>
        <span className="cp-count">
          {rooms.length} {rooms.length === 1 ? 'project' : 'projects'}
        </span>
      </div>
      {rooms.length ? (
        <div className="cp-room-grid">
          {rooms.map((room) => (
            <article className="cp-room-card" key={room.id}>
              <div className="cp-card-actions">
                <button
                  data-icon-trigger
                  className={`cp-icon-button${room.pinned ? ' is-pinned' : ''}`}
                  type="button"
                  onClick={() => onTogglePin(room.id)}
                  aria-label={`${room.pinned ? 'Unpin' : 'Pin'} ${room.name}`}
                  aria-pressed={room.pinned}
                >
                  <MotionIcon name="pin" size={20} active={room.pinned} />
                </button>
                <button
                  data-icon-trigger
                  className="cp-icon-button"
                  type="button"
                  onClick={() => onDeleteRoom(room.id)}
                  aria-label={`Delete ${room.name}`}
                >
                  <MotionIcon name="remove" size={20} />
                </button>
              </div>
              <button
                data-icon-trigger
                className="cp-room-open"
                type="button"
                onClick={() => onOpenRoom(room.id)}
                aria-label={`Open ${room.name}`}
              >
                <RoomPreview room={room} />
                <div className="cp-room-caption">
                  <h2>{room.name}</h2>
                  <div>
                    <span>
                      {room.turns.length
                        ? `${room.turns.length} ${room.turns.length === 1 ? 'conversation' : 'conversations'}`
                        : 'A fresh start'}
                    </span>
                    <span>{dateLabel(room.updatedAt)}</span>
                  </div>
                </div>
              </button>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={
            search ? (
              <MotionIcon name="search" size={24} />
            ) : (
              <MotionIcon name="rooms" size={24} />
            )
          }
          title={
            search
              ? 'No projects found'
              : filter === 'pinned'
                ? 'Keep a thought close'
                : 'Start a project'
          }
          action={
            !search && filter === 'recent' ? (
              <button
                data-icon-trigger
                type="button"
                className="cp-button cp-button--red"
                onClick={() => setCreating(true)}
              >
                <MotionIcon name="add" size={20} />
                New project
              </button>
            ) : undefined
          }
        >
          {search
            ? 'Try a project name or a few words from a question.'
            : filter === 'pinned'
              ? 'Pin a project to give your ongoing work a place here.'
              : 'Start with a question, a project, or an idea you want to understand.'}
        </EmptyState>
      )}
    </section>
  );
}

function BriefPreview({
  brief,
  roomName,
  onOpenRoom,
  onDelete,
  onClose,
  onEdit,
  accountId,
  visible,
  onRefreshBrief,
}: {
  accountId?: string | null;
  visible: boolean;
  onRefreshBrief?: (id: string) => Promise<boolean>;
  brief: CanvasBrief;
  roomName: string;
  onOpenRoom: () => void;
  onDelete: () => void;
  onClose: () => void;
  onEdit?: (brief: CanvasBrief) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [printError, setPrintError] = useState('');
  return (
    <aside className="cp-brief-preview" aria-label={`Preview: ${brief.title}`}>
      <div className="cp-preview-toolbar">
        <span>
          <MotionIcon name="brief" size={20} />
          Saved Brief
        </span>
        <button
          data-icon-trigger
          className="cp-icon-button"
          type="button"
          aria-label="Close Brief preview"
          onClick={onClose}
        >
          <MotionIcon name="close" size={20} />
        </button>
      </div>
      <div className="cp-brief-content">
        <p className="cp-eyebrow">
          {roomName} · {dateLabel(brief.createdAt)}
        </p>
        <h2>{brief.title}</h2>
        {editing && onEdit && brief.live?.document ? (
          <LiveBriefEditor
            brief={brief}
            onSave={onEdit}
            onClose={() => setEditing(false)}
          />
        ) : brief.live?.document ? (
          <LiveBriefReader document={brief.live.document} />
        ) : (
          <pre>{brief.body}</pre>
        )}
        {featureOn('synthesis') &&
          accountId &&
          onRefreshBrief &&
          brief.live?.document && (
            <LiveBriefSynthesis
              brief={brief}
              accountId={accountId}
              visible={visible}
              onRefreshBrief={onRefreshBrief}
            />
          )}
      </div>
      <div className="cp-preview-footer">
        {brief.live?.document && (
          <button
            type="button"
            className="cp-button"
            onClick={() => {
              const printable = window.open('', '_blank');
              if (!printable) {
                setPrintError(
                  'Allow a new window to print this Brief or save it as PDF.',
                );
                return;
              }
              printable.opener = null;
              printable.document.open();
              // The print window is a same-origin blank document we own; writing
              // the rendered HTML into it is the intended way to print a Brief.
              // oxlint-disable-next-line typescript/no-deprecated
              printable.document.write(
                renderBriefPrintHtml(brief.title, brief.live!.document!),
              );
              printable.document.close();
              printable.focus();
              printable.print();
              setPrintError('');
            }}
          >
            Print / PDF
          </button>
        )}
        {onEdit && brief.live?.document && (
          <button
            type="button"
            className="cp-button"
            disabled={editing}
            onClick={() => setEditing(true)}
          >
            Edit assessment
          </button>
        )}
        <button
          data-icon-trigger
          type="button"
          className="cp-button cp-button--ink"
          onClick={() =>
            downloadText(`${filename(brief.title)}.md`, brief.body)
          }
        >
          <MotionIcon name="download" size={20} />
          Download
        </button>
        <button
          data-icon-trigger
          type="button"
          className="cp-button"
          onClick={onOpenRoom}
        >
          Open project
          <MotionIcon name="open" size={20} />
        </button>
        <button
          data-icon-trigger
          type="button"
          className="cp-icon-button"
          aria-label="Delete saved Brief"
          onClick={() => setConfirming(!confirming)}
        >
          <MotionIcon name="remove" size={20} />
        </button>
      </div>
      {printError && <output>{printError}</output>}
      {confirming && (
        <div className="cp-delete-confirm">
          <p>Remove this saved Brief from your library?</p>
          <div>
            <button
              data-icon-trigger
              className="cp-text-button"
              type="button"
              onClick={() => setConfirming(false)}
            >
              Keep Brief
            </button>
            <button
              data-icon-trigger
              className="cp-text-button cp-text-button--red"
              type="button"
              onClick={onDelete}
            >
              Delete Brief
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function LibraryPage({
  state,
  query,
  onOpenRoom,
  onDeleteBrief,
  onEditBrief,
  onRefreshBrief,
  account,
  view,
}: WorkspacePagesProps) {
  const [filter, setFilter] = useState('All');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const search = query.trim().toLowerCase();
  const briefs = state.briefs
    .filter(
      (brief) =>
        (filter === 'All' || filter === 'Briefs') &&
        `${brief.title} ${brief.body}`.toLowerCase().includes(search),
    )
    .toSorted((a, b) => b.createdAt - a.createdAt);
  // Filtering cards must not unmount an open assessment with unsaved changes.
  const selected = state.briefs.find((brief) => brief.id === selectedId);
  return (
    <section className="cp-page cp-library">
      <PageHeading
        title="Library"
        description="The useful things you chose to keep. Your saved Briefs, together in one place."
      />
      <div className="cp-filter-row">
        <div className="cp-pills" aria-label="Library filter">
          {['All', 'Files', 'Media', 'Briefs'].map((item) => (
            <button
              data-icon-trigger
              type="button"
              key={item}
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <span className="cp-count">
          {briefs.length} {briefs.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      <div className={`cp-library-layout${selected ? ' has-preview' : ''}`}>
        <div>
          {briefs.length ? (
            <div className="cp-library-grid">
              {briefs.map((brief) => (
                <button
                  data-icon-trigger
                  key={brief.id}
                  type="button"
                  className={`cp-library-card${selected?.id === brief.id ? ' is-selected' : ''}`}
                  aria-pressed={selected?.id === brief.id}
                  onClick={() => setSelectedId(brief.id)}
                >
                  <div className="cp-document-preview">
                    <MotionIcon name="brief" size={24} />
                    <strong>{brief.title}</strong>
                    <p>
                      {(brief.live?.document
                        ? brief.live.document.analysis.decision ||
                          brief.live.document.evidence[0].answer
                        : brief.body.replace(/^#+\s*/gm, '')
                      ).slice(0, 165)}
                    </p>
                  </div>
                  <div className="cp-library-caption">
                    <h2>{brief.title}</h2>
                    <span>
                      Brief<span>·</span>
                      {dateLabel(brief.createdAt)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={
                filter === 'Media' ? (
                  <MotionIcon name="studio" size={24} />
                ) : (
                  <MotionIcon name="library" size={24} />
                )
              }
              title={
                search
                  ? 'Nothing matches just yet'
                  : filter === 'Files' || filter === 'Media'
                    ? `No saved ${filter.toLowerCase()} yet`
                    : 'Keep the parts that matter'
              }
            >
              {search
                ? 'Try a different title or a few words from your Brief.'
                : filter === 'Files' || filter === 'Media'
                  ? 'This library currently holds saved Briefs. Uploaded Studio references stay in the Studio draft.'
                  : 'Select useful answers in a project and save a Brief. It will be waiting here.'}
            </EmptyState>
          )}
        </div>
        {selected && (
          <BriefPreview
            key={selected.id}
            brief={selected}
            onEdit={onEditBrief}
            accountId={account?.accountId}
            visible={view === 'library'}
            onRefreshBrief={onRefreshBrief}
            roomName={
              state.rooms.find((room) => room.id === selected.roomId)?.name ||
              'Saved project'
            }
            onClose={() => setSelectedId(null)}
            onOpenRoom={() => onOpenRoom(selected.roomId)}
            onDelete={() => {
              onDeleteBrief(selected.id);
              setSelectedId(null);
            }}
          />
        )}
      </div>
    </section>
  );
}

type AgentDraft = {
  id: string;
  name: string;
  goal: string;
  scope: string;
  notes: string;
  createdAt: number;
};

function AgentsPage({ state, onToast }: WorkspacePagesProps) {
  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('');
  const workingRoom = scope || state.activeRoomId;
  const workingRoomExists = state.rooms.some((room) => room.id === workingRoom);
  const [tab, setTab] = useState('Instructions');
  const [notes, setNotes] = useState('');
  const selected = drafts.find((draft) => draft.id === selectedId);
  const create = (event: SubmitEvent) => {
    event.preventDefault();
    if (!name.trim() || !goal.trim() || !workingRoomExists) return;
    const draft: AgentDraft = {
      id: crypto.randomUUID(),
      name: name.trim(),
      goal: goal.trim(),
      scope: workingRoom,
      notes: '',
      createdAt: Date.now(),
    };
    setDrafts([...drafts, draft]);
    setSelectedId(draft.id);
    setName('');
    setGoal('');
    setScope('');
    setNotes('');
    onToast('Agent plan created. No task is running.');
  };
  const choose = (draft: AgentDraft) => {
    setSelectedId(draft.id);
    setNotes(draft.notes);
  };
  const exportPlan = (draft: AgentDraft) =>
    downloadText(
      `${filename(draft.name)}-agent-plan.md`,
      `# ${draft.name}\n\nStatus: local draft; no runtime connected\nScope: ${state.rooms.find((room) => room.id === draft.scope)?.name || 'Unassigned project'}\n\n## Goal\n\n${draft.goal}\n\n## Instructions\n\n${draft.notes || 'No additional instructions.'}\n\nNo apps, computer, memory service, schedule or spending authority has been granted.\n`,
    );
  return (
    <section className="cp-page cp-agents">
      <PageHeading
        title="Agents"
        description="Give ongoing work a clear purpose. Start with a goal and the boundaries that matter."
      >
        <span className="cp-status">
          <span />
          Runtime not connected
        </span>
      </PageHeading>
      <div className="cp-agent-tabs">
        <div className="cp-tabs" aria-label="Agent drafts">
          {drafts.map((draft) => (
            <button
              data-icon-trigger
              type="button"
              key={draft.id}
              aria-pressed={draft.id === selectedId}
              onClick={() => choose(draft)}
            >
              {draft.name}
            </button>
          ))}
          <button
            data-icon-trigger
            type="button"
            aria-pressed={!selected}
            onClick={() => setSelectedId(null)}
          >
            <MotionIcon name="add" size={20} />
            New agent
          </button>
        </div>
        <span className="cp-fineprint">Local plans · download to keep</span>
      </div>
      {!selected ? (
        <div className="cp-plan-layout">
          <div className="cp-plan-intro">
            <span className="cp-feature-icon">
              <MotionIcon name="agents" size={24} />
            </span>
            <h2>
              Good work starts
              <br />
              with a good brief.
            </h2>
            <p>
              What should this agent help you do? Give it a name, a specific
              goal, and a project to work within.
            </p>
            <div className="cp-boundary-note">
              <LockKeyhole size={17} />
              <span>
                This creates a plan. Apps, memory and background execution are
                not connected.
              </span>
            </div>
          </div>
          <form className="cp-form-paper" onSubmit={create}>
            <label>
              Name
              <input
                value={name}
                onChange={(event) => {
                  setScope(workingRoom);
                  setName(event.target.value);
                }}
                maxLength={50}
                placeholder="For example, Scout"
                required
              />
            </label>
            <label>
              Goal
              <textarea
                value={goal}
                onChange={(event) => {
                  setScope(workingRoom);
                  setGoal(event.target.value);
                }}
                placeholder="Describe what a useful result would look like…"
                maxLength={3000}
                required
              />
            </label>
            <label>
              Working project
              <select
                value={workingRoom}
                onChange={(event) => setScope(event.target.value)}
              >
                {!workingRoomExists && (
                  <option value={workingRoom} disabled>
                    Choose an available project
                  </option>
                )}
                {state.rooms.length ? (
                  state.rooms.map((room) => (
                    <option value={room.id} key={room.id}>
                      {room.name}
                    </option>
                  ))
                ) : (
                  <option value="">Unassigned</option>
                )}
              </select>
            </label>
            <button
              data-icon-trigger
              type="submit"
              className="cp-button cp-button--red"
              disabled={!name.trim() || !goal.trim() || !workingRoomExists}
            >
              Create agent plan
              <MotionIcon name="forward" size={20} />
            </button>
          </form>
        </div>
      ) : (
        <div className="cp-agent-layout">
          <div className="cp-agent-board">
            <article className="cp-goal-paper">
              <div>
                <MotionIcon name="decisions" size={24} />
                <span>Goal</span>
              </div>
              <h2>{selected.goal}</h2>
              <p>
                {state.rooms.find((room) => room.id === selected.scope)?.name ||
                  'Unassigned project'}
              </p>
            </article>
            <div className="cp-agent-next">
              <span className="cp-red-dot" />
              <div>
                <h3>A plan, ready for its next step.</h3>
                <p>
                  {selected.name} has not started a task. Connect a runtime
                  before granting tools, schedules or permission to act.
                </p>
                <button
                  data-icon-trigger
                  className="cp-button"
                  type="button"
                  onClick={() => exportPlan(selected)}
                >
                  <MotionIcon name="download" size={20} />
                  Download plan
                </button>
              </div>
            </div>
          </div>
          <aside className="cp-agent-inspector">
            <div className="cp-tabs" aria-label="Agent details">
              {['Instructions', 'Activity', 'Apps'].map((item) => (
                <button
                  data-icon-trigger
                  key={item}
                  type="button"
                  aria-pressed={tab === item}
                  onClick={() => setTab(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            {tab === 'Instructions' ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setDrafts(
                    drafts.map((draft) =>
                      draft.id === selected.id ? { ...draft, notes } : draft,
                    ),
                  );
                  onToast('Instructions saved to this draft.');
                }}
              >
                <label htmlFor="cp-agent-notes">
                  Things this agent should know
                </label>
                <textarea
                  id="cp-agent-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={5000}
                  placeholder="Scope, sources to use, and actions that would need your review…"
                />
                <p className="cp-fineprint">
                  Your notes are part of this draft. They have not been sent to
                  an agent or memory service.
                </p>
                <button
                  data-icon-trigger
                  className="cp-button cp-button--ink"
                  type="submit"
                >
                  Save instructions
                  <MotionIcon name="select" size={20} />
                </button>
              </form>
            ) : tab === 'Activity' ? (
              <div className="cp-agent-activity">
                <span className="cp-red-dot" />
                <div>
                  <h3>Plan created</h3>
                  <p>{dateLabel(selected.createdAt)} · in this session</p>
                  <small>No background work has run.</small>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={<MotionIcon name="connections" size={24} />}
                title="No access granted"
              >
                Connected apps and computer access will be listed here when a
                runtime is available.
              </EmptyState>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function DecisionsPage({ onToast }: WorkspacePagesProps) {
  const [type, setType] = useState('choice');
  const [question, setQuestion] = useState('');
  const [evidence, setEvidence] = useState('');
  const [options, setOptions] = useState(
    'Billing\nAccount\nTechnical\nOther / review',
  );
  const [criteria, setCriteria] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const choices = options
    .split('\n')
    .map((option) => option.trim())
    .filter(Boolean);
  const ready = Boolean(
    question.trim() &&
    evidence.trim() &&
    criteria.trim() &&
    (type !== 'choice' || choices.length >= 2),
  );
  const edit = (setter: (value: string) => void, value: string) => {
    setter(value);
    setReviewed(false);
  };
  const exportDraft = () => {
    downloadText(
      'conclave-decision-draft.json',
      JSON.stringify(
        {
          kind: type,
          question: question.trim(),
          input: evidence.trim(),
          criteria: criteria.trim(),
          ...(type === 'choice' ? { options: choices } : {}),
          result: null,
          requiresReview: true,
          status: 'not_evaluated',
        },
        null,
        2,
      ),
      'application/json;charset=utf-8',
    );
    onToast('Decision draft downloaded.');
  };
  return (
    <section className="cp-page cp-decisions">
      <PageHeading
        title="Decisions"
        description="A clear question. The right context. An explicit place for human judgment."
      >
        <span className="cp-status">
          <span />
          Decision service not connected
        </span>
      </PageHeading>
      <div className="cp-decision-layout">
        <form
          className="cp-form-paper"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) setReviewed(true);
          }}
        >
          <div className="cp-pills" aria-label="Decision type">
            {[
              { id: 'choice', name: 'Choice' },
              { id: 'score', name: 'Score' },
              { id: 'noul', name: 'Proposition' },
            ].map((item) => (
              <button
                data-icon-trigger
                type="button"
                key={item.id}
                aria-pressed={type === item.id}
                onClick={() => edit(setType, item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <label>
            {type === 'noul' ? 'Proposition to evaluate' : 'The question'}
            <input
              value={question}
              onChange={(event) => edit(setQuestion, event.target.value)}
              maxLength={400}
              placeholder={
                type === 'choice'
                  ? 'Which team should review this request?'
                  : type === 'score'
                    ? 'How well does this meet our rubric?'
                    : 'The evidence supports this claim…'
              }
              required
            />
          </label>
          <label>
            Input and evidence
            <textarea
              value={evidence}
              onChange={(event) => edit(setEvidence, event.target.value)}
              maxLength={6000}
              placeholder="Add the actual state or source material the decision should consider."
              required
            />
          </label>
          {type === 'choice' && (
            <label>
              Options
              <span className="cp-label-note">
                One per line; keep an Other / review path.
              </span>
              <textarea
                className="cp-options-input"
                value={options}
                onChange={(event) => edit(setOptions, event.target.value)}
                maxLength={1000}
                required
              />
            </label>
          )}
          <label>
            {type === 'score'
              ? 'Scoring rubric and range'
              : 'Criteria and review conditions'}
            <textarea
              className="cp-short-input"
              value={criteria}
              onChange={(event) => edit(setCriteria, event.target.value)}
              maxLength={2000}
              placeholder={
                type === 'score'
                  ? 'Define the scale and what each score means.'
                  : 'What matters? When should a person take a closer look?'
              }
              required
            />
          </label>
          <button
            data-icon-trigger
            type="submit"
            className="cp-button cp-button--red"
            disabled={!ready}
          >
            Review decision draft
            <MotionIcon name="forward" size={20} />
          </button>
        </form>
        <aside className="cp-decision-output">
          <div className="cp-paper-heading">
            <ShieldCheck size={20} />
            <h2>Review</h2>
          </div>
          {reviewed ? (
            <div className="cp-decision-result">
              <span className="cp-review-badge">Needs evaluation</span>
              <h3>{question}</h3>
              <dl>
                <div>
                  <dt>Type</dt>
                  <dd>
                    {type === 'noul'
                      ? 'Proposition / Noul'
                      : type === 'score'
                        ? 'Score'
                        : 'Choice'}
                  </dd>
                </div>
                <div>
                  <dt>Result</dt>
                  <dd>Not evaluated</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>Not available</dd>
                </div>
              </dl>
              {type === 'choice' && (
                <div className="cp-option-list">
                  {choices.map((option, index) => (
                    <span key={`${option}-${index}`}>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      {option}
                    </span>
                  ))}
                </div>
              )}
              <p>
                The draft is complete. It has not been sent to a decision model,
                and no rule has been deployed.
              </p>
              <button
                data-icon-trigger
                className="cp-button cp-button--ink"
                type="button"
                onClick={exportDraft}
              >
                <MotionIcon name="download" size={20} />
                Download draft
              </button>
            </div>
          ) : (
            <EmptyState
              icon={<ShieldCheck size={30} />}
              title="A question before a conclusion"
            >
              Complete the worksheet to review its structure. Probabilities and
              scores need a connected, evaluated decision service.
            </EmptyState>
          )}
        </aside>
      </div>
    </section>
  );
}

const CONNECTIONS = [
  {
    id: 'models',
    name: 'Model providers',
    icon: 'agents',
    description: 'Independent perspectives, with a route for each request.',
    detail:
      'Model calls are not connected. Before a real request, the selected route must identify the provider, data handling, supported capabilities and estimated cost.',
  },
  {
    id: 'wallet',
    name: 'Solana wallet',
    icon: 'purse',
    description: 'Your identity and usage balance, when you choose to connect.',
    detail:
      'Wallet sign-in and payments are not connected. No wallet address is requested here, and Conclave does not sign or execute transactions in this preview.',
  },
  {
    id: 'apps',
    name: 'Apps & sources',
    icon: 'connections',
    description: 'Bring in the context you want your work to use.',
    detail:
      'No external apps have access. A future connection must show the account, requested scopes and what information leaves this workspace before access is granted.',
  },
  {
    id: 'runtime',
    name: 'Agent runtime',
    icon: 'agents',
    description: 'Tools, memory and ongoing work with clear boundaries.',
    detail:
      'Agent plans are local drafts. No computer, scheduler, memory service or background task runner is connected.',
  },
] as const;

function ConnectionsPage({ state }: WorkspacePagesProps) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="cp-page cp-utility">
      <PageHeading
        title="Connections"
        description="Only the access you choose. See what is connected and where your information can go."
      />
      <div className="cp-local-connection">
        <span className="cp-connection-icon">
          <MotionIcon name="rooms" size={20} />
        </span>
        <div>
          <h2>This browser</h2>
          <p>
            {state.rooms.length}{' '}
            {state.rooms.length === 1 ? 'project' : 'projects'} ·{' '}
            {state.briefs.length} saved{' '}
            {state.briefs.length === 1 ? 'Brief' : 'Briefs'}
          </p>
        </div>
        <span className="cp-local-label">
          Local workspace
          <Check size={14} />
        </span>
      </div>
      <div className="cp-connection-list">
        {CONNECTIONS.map((item) => {
          return (
            <article className="cp-connection" key={item.id}>
              <button
                data-icon-trigger
                type="button"
                aria-expanded={selected === item.id}
                aria-controls={`cp-connection-${item.id}`}
                onClick={() =>
                  setSelected(selected === item.id ? null : item.id)
                }
              >
                <span className="cp-connection-icon">
                  <MotionIcon
                    name={item.icon}
                    size={24}
                    active={selected === item.id}
                  />
                </span>
                <span className="cp-connection-copy">
                  <strong>{item.name}</strong>
                  <span>{item.description}</span>
                </span>
                <span className="cp-connection-state">Not connected</span>
                <ChevronRight
                  size={17}
                  className={selected === item.id ? 'is-open' : ''}
                />
              </button>
              {selected === item.id && (
                <div
                  id={`cp-connection-${item.id}`}
                  className="cp-connection-detail"
                >
                  <p>{item.detail}</p>
                  <span>
                    <LockKeyhole size={14} />
                    No permissions granted
                  </span>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <p className="cp-footer-note">
        No account connections are required to explore your local workspace.
      </p>
    </section>
  );
}

function PursePage({ onToast }: WorkspacePagesProps) {
  const [budget, setBudget] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const amount = Number(budget);
  return (
    <section className="cp-page cp-purse">
      <PageHeading
        title="Purse"
        description="Know what a request will cost. Keep a clear record of what you choose to spend."
      />
      <div className="cp-purse-layout">
        <div className="cp-balance-area">
          <span className="cp-eyebrow">Available balance</span>
          <p className="cp-balance">
            — <span>USDC</span>
          </p>
          <span className="cp-status">
            <span />
            Wallet and payments not connected
          </span>
          <p>
            Your balance will appear when a wallet and the payment service are
            connected.
          </p>
        </div>
        <form
          className="cp-budget-paper"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !budget.trim() ||
              !Number.isFinite(amount) ||
              amount < 0 ||
              amount > 100000
            )
              return;
            setSaved(amount.toFixed(2));
            onToast('Spending plan saved in this view. No live limit was set.');
          }}
        >
          <h2>A plan for your spending</h2>
          <p>Set an intended monthly amount for your draft.</p>
          <label htmlFor="cp-budget">Monthly target</label>
          <div className="cp-money-input">
            <input
              id="cp-budget"
              type="number"
              min="0"
              max="100000"
              step="0.01"
              value={budget}
              onChange={(event) => {
                setBudget(event.target.value);
                setSaved(null);
              }}
              placeholder="0.00"
              required
            />
            <span>USDC</span>
          </div>
          <button
            data-icon-trigger
            type="submit"
            className="cp-button cp-button--ink"
            disabled={!budget.trim()}
          >
            Save spending plan
            <MotionIcon name="select" size={20} />
          </button>
          {saved !== null && (
            <button
              data-icon-trigger
              className="cp-text-button"
              type="button"
              onClick={() =>
                downloadText(
                  'conclave-spending-plan.json',
                  JSON.stringify(
                    {
                      monthlyTargetUSDC: saved,
                      status: 'draft',
                      enforced: false,
                    },
                    null,
                    2,
                  ),
                  'application/json;charset=utf-8',
                )
              }
            >
              <MotionIcon name="download" size={20} />
              Download {saved} USDC plan
            </button>
          )}
          <p className="cp-fineprint">
            A planning amount only. It does not move funds or enforce a spending
            limit.
          </p>
        </form>
      </div>
      <div className="cp-ledger">
        <div className="cp-ledger-heading">
          <h2>Receipts</h2>
          <span>No settled activity</span>
        </div>
        <div className="cp-ledger-columns" aria-hidden="true">
          <span>Activity</span>
          <span>Reference</span>
          <span>Amount</span>
        </div>
        <EmptyState
          icon={<MotionIcon name="brief" size={24} />}
          title="Every real request, accounted for"
        >
          Receipts will appear after connected requests settle. The local
          preview does not charge you.
        </EmptyState>
      </div>
    </section>
  );
}

type ChapterDraft = {
  id: string;
  name: string;
  purpose: string;
  rooms: string[];
  access: string;
};

function ChaptersPage({ state, onToast }: WorkspacePagesProps) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [rooms, setRooms] = useState<string[]>([]);
  const [access, setAccess] = useState('Review before sharing');
  const [drafts, setDrafts] = useState<ChapterDraft[]>([]);
  const create = (event: SubmitEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setDrafts([
      ...drafts,
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        purpose: purpose.trim(),
        rooms: rooms.filter((id) => state.rooms.some((room) => room.id === id)),
        access,
      },
    ]);
    setName('');
    setPurpose('');
    setRooms([]);
    onToast('Chapter plan saved in this view. No access was shared.');
  };
  const exportPlan = (draft: ChapterDraft) =>
    downloadText(
      `${filename(draft.name)}-chapter-plan.md`,
      `# ${draft.name}\n\n${draft.purpose}\n\n## Proposed projects\n\n${draft.rooms.map((id) => `- ${state.rooms.find((room) => room.id === id)?.name || 'Removed project'}`).join('\n') || 'No projects selected.'}\n\n## Sharing preference\n\n${draft.access}\n\nLocal draft only. No invitations sent, permissions granted, shared budget created or Squads account connected.\n`,
    );
  return (
    <section className="cp-page cp-chapters">
      <PageHeading
        title="Chapters"
        description="A shared direction for a few good minds. Plan the projects and boundaries for your team."
      >
        <span className="cp-status">
          <span />
          Team services not connected
        </span>
      </PageHeading>
      <div className="cp-plan-layout">
        <div className="cp-plan-intro">
          <span className="cp-feature-icon">
            <MotionIcon name="chapters" size={24} />
          </span>
          <h2>
            Work together.
            <br />
            Choose what is shared.
          </h2>
          <p>
            A Chapter will bring people, projects and a shared allowance
            together. Start by deciding what belongs in yours.
          </p>
          {drafts.length > 0 && (
            <div className="cp-chapter-drafts" aria-label="Chapter drafts">
              {drafts.map((draft) => (
                <article key={draft.id}>
                  <span>
                    <MotionIcon name="chapters" size={20} />
                  </span>
                  <div>
                    <h3>{draft.name}</h3>
                    <p>
                      {draft.rooms.length} proposed{' '}
                      {draft.rooms.length === 1 ? 'project' : 'projects'} ·
                      local draft
                    </p>
                  </div>
                  <button
                    data-icon-trigger
                    className="cp-icon-button"
                    type="button"
                    aria-label={`Download ${draft.name} plan`}
                    onClick={() => exportPlan(draft)}
                  >
                    <MotionIcon name="download" size={20} />
                  </button>
                </article>
              ))}
            </div>
          )}
          <div className="cp-boundary-note">
            <LockKeyhole size={17} />
            <span>
              Project access stays personal. Save or download a plan before
              connecting team services.
            </span>
          </div>
        </div>
        <form className="cp-form-paper" onSubmit={create}>
          <label>
            Chapter name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="What brings your team together?"
              required
            />
          </label>
          <label>
            Purpose
            <textarea
              className="cp-short-input"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              maxLength={2000}
              placeholder="A short note about the work you want to do together."
            />
          </label>
          <fieldset className="cp-room-checklist">
            <legend>Projects to include in the plan</legend>
            {state.rooms.map((room) => (
              <label key={room.id}>
                <input
                  type="checkbox"
                  checked={rooms.includes(room.id)}
                  onChange={(event) =>
                    setRooms(
                      event.target.checked
                        ? [...rooms, room.id]
                        : rooms.filter((id) => id !== room.id),
                    )
                  }
                />
                <MotionIcon name="rooms" size={20} />
                <span>{room.name}</span>
              </label>
            ))}
            {!state.rooms.length && (
              <p>No projects yet. You can add them to a later plan.</p>
            )}
          </fieldset>
          <label>
            Sharing preference
            <select
              value={access}
              onChange={(event) => setAccess(event.target.value)}
            >
              <option>Review before sharing</option>
              <option>Members can contribute</option>
              <option>Members can view only</option>
            </select>
          </label>
          <button
            data-icon-trigger
            className="cp-button cp-button--red"
            type="submit"
            disabled={!name.trim()}
          >
            Save Chapter plan
            <MotionIcon name="forward" size={20} />
          </button>
          <p className="cp-fineprint">
            A local draft. No invitation, shared access or team budget is
            created.
          </p>
        </form>
      </div>
    </section>
  );
}

export function WorkspacePages(props: WorkspacePagesProps) {
  return (
    <>
      <div className="cp-view" hidden={props.view !== 'rooms'}>
        <RoomsPage {...props} />
      </div>
      <div className="cp-view" hidden={props.view !== 'agents'}>
        <AgentsPage {...props} />
      </div>
      <div className="cp-view" hidden={props.view !== 'library'}>
        <LibraryPage {...props} />
      </div>
      <div className="cp-view" hidden={props.view !== 'decisions'}>
        <DecisionsPage {...props} />
      </div>
      <div className="cp-view" hidden={props.view !== 'connections'}>
        <ConnectionsPage {...props} />
      </div>
      <div className="cp-view" hidden={props.view !== 'purse'}>
        {props.account ? (
          props.view === 'purse' ? (
            <LivePurse
              key={props.account.accountId ?? 'anonymous'}
              account={props.account}
              visible
            />
          ) : null
        ) : (
          <PursePage {...props} />
        )}
      </div>
      <div className="cp-view" hidden={props.view !== 'chapters'}>
        <ChaptersPage {...props} />
      </div>
    </>
  );
}
