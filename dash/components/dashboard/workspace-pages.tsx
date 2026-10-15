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
  Star,
} from 'lucide-react';
import type { CanvasBrief, Room, WorkspaceState } from './canvas-state';
import { MotionIcon } from './motion-icon';
import { LivePurse, type PurseAccount } from './live-purse';
import { LiveBriefEditor } from './live-brief-editor';
import { LiveBriefReader } from './live-brief-reader';
import { LiveBriefSynthesis } from './live-brief-synthesis';
import { featureOn } from './feature-switches';
import { renderBriefPrintHtml } from '../../lib/brief-document';
import { useT, type Translator } from '@/lib/i18n';
import '@/app/dashboard/workspace-pages.css';
import { LiveWorkspaceServices } from './live-workspace-services';
import { isStringList, useDeviceSetting } from './use-device-setting';
import '@/app/dashboard/library-tools.css';
import { DecisionWorkspace } from './decision-workspace';

import { ArchivedProjects } from './archived-projects';
import { PROJECT_VIEW_DEFAULT, isProjectView, sortProjects, EMPTY_PROJECT_LABELS, PROJECT_LABELS, isProjectLabels, setProjectLabel } from '../../lib/project-organizer';
import '@/app/dashboard/project-organizer.css';
const validProjectFilter = (value: unknown): value is string => typeof value === 'string' && value.length <= 160;

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
  onRestoreProject?: (id: string, revision: number) => Promise<boolean>;
  onCompareDecision?: (prompt: string) => boolean;
  onDeleteBrief: (id: string) => void;
  onEditBrief?: (brief: CanvasBrief) => Promise<boolean>;
  onRefreshBrief?: (id: string) => Promise<boolean>;
  onToast: (message: string) => void;
};

function dateLabel(value: number, locale: Translator['locale']) {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

function roomLabel(room: Room, t: Translator) {
  const samples: Record<string, string> = {
    'room-launch': 'Launch plan',
    'room-solana': 'Solana research',
    'room-website': 'Website refresh',
  };
  return !room.live && samples[room.id] === room.name
    ? t(room.name)
    : room.name;
}

const SAMPLE_BRIEF_NOTICE =
  'Local sample comparison. No live models were called.';

function isInitialSampleTurn(turn: Room['turns'][number]) {
  return (
    !turn.live &&
    [
      'turn-launch-sample',
      'turn-solana-sample',
      'turn-website-sample',
    ].includes(turn.id)
  );
}

function briefTitleLabel(
  brief: CanvasBrief,
  room: Room | undefined,
  t: Translator,
) {
  return !brief.live && room && brief.title === room.name
    ? roomLabel(room, t)
    : brief.title;
}

function briefBodyLabel(
  brief: CanvasBrief,
  room: Room | undefined,
  t: Translator,
) {
  if (brief.live || !brief.body.startsWith(`${SAMPLE_BRIEF_NOTICE}\n\n`))
    return brief.body;
  let body = `${t(SAMPLE_BRIEF_NOTICE)}${brief.body.slice(SAMPLE_BRIEF_NOTICE.length)}`;
  for (const turn of room?.turns ?? []) {
    if (isInitialSampleTurn(turn)) {
      body = body.replace(`## ${turn.prompt}\n\n`, `## ${t(turn.prompt)}\n\n`);
    }
    for (const answer of turn.answers) {
      if (answer.live) continue;
      body = body.replace(
        ` — ${answer.heading}\n\n${answer.paragraphs.join('\n\n')}`,
        ` — ${t(answer.heading)}\n\n${answer.paragraphs.map((paragraph) => t(paragraph)).join('\n\n')}`,
      );
    }
  }
  return body;
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
  const t = useT();
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
            <p>{isInitialSampleTurn(turn) ? t(turn.prompt) : turn.prompt}</p>
          </div>
          <div className="cp-preview-connection">
            <span />
            <ArrowRight size={13} />
          </div>
          <div className="cp-preview-answer">
            <MotionIcon name="brief" size={20} />
            <p>
              {turn.answers[0]?.heading
                ? turn.answers[0].live
                  ? turn.answers[0].heading
                  : t(turn.answers[0].heading)
                : t('A question worth exploring.')}
            </p>
            <small>
              {turn.answers.length === 1
                ? t('{count} perspective', { count: turn.answers.length })
                : t('{count} perspectives', { count: turn.answers.length })}
            </small>
          </div>
        </>
      ) : (
        <>
          <span className="cp-room-outline">
            <MotionIcon name="add" size={24} />
          </span>
          <p>{t('A place for your next idea.')}</p>
        </>
      )}
    </div>
  );
}

function RoomsPage({
  account,
  state,
  query,
  onOpenRoom,
  onCreateRoom,
  onTogglePin,
  onDeleteRoom,
  onRestoreProject,
  onToast,
}: WorkspacePagesProps) {
  const t = useT();
  const [filter, setFilter] = useState<'recent' | 'pinned'>('recent');
  const projectView = useDeviceSetting(`conclave:project-view:v1:${account?.accountId ?? 'guest'}`, PROJECT_VIEW_DEFAULT, isProjectView, featureOn('projectView'));
  const viewOptions = featureOn('projectView') ? projectView.value : PROJECT_VIEW_DEFAULT;
  const projectLabels = useDeviceSetting(`conclave:project-labels:v1:${account?.accountId ?? 'guest'}`, EMPTY_PROJECT_LABELS, isProjectLabels, featureOn('projectLabels'));
  const [labelFilter, setLabelFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) input.current?.focus();
  }, [creating]);
  const search = query.trim().toLowerCase();
  const rooms = sortProjects(state.rooms
    .filter(
      (room) =>
        (filter === 'recent' || room.pinned) &&
        (!featureOn('projectLabels') || !labelFilter || projectLabels.value[room.id] === labelFilter) &&
        `${room.name} ${room.turns.map((turn) => turn.prompt).join(' ')}`
          .toLowerCase()
          .includes(search),
    ), viewOptions.sort);
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
        title={t('Projects')}
        description={t(
          'A place for every question. Pick up a thought, or start something new.',
        )}
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
          {t('New project')}
        </button>
      </PageHeading>
      {featureOn('archiveRecovery') && account?.accountId && onRestoreProject && <ArchivedProjects key={account.accountId} accountId={account.accountId} onRestore={onRestoreProject} onOpen={onOpenRoom} />}
      {creating && (
        <form className="cp-create-strip" id="cp-new-room" onSubmit={create}>
          <label htmlFor="cp-room-name">{t('What are you working on?')}</label>
          <div>
            <input
              ref={input}
              id="cp-room-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder={t('Give your project a name')}
              required
            />
            <button
              data-icon-trigger
              className="cp-button cp-button--ink"
              type="submit"
              disabled={!name.trim()}
            >
              {t('Create project')}
              <MotionIcon name="forward" size={20} />
            </button>
            <button
              data-icon-trigger
              className="cp-icon-button"
              type="button"
              onClick={() => setCreating(false)}
              aria-label={t('Cancel new project')}
            >
              <MotionIcon name="close" size={20} />
            </button>
          </div>
        </form>
      )}
      <div className="cp-filter-row">
        <div className="cp-tabs" aria-label={t('Project filter')}>
          <button
            data-icon-trigger
            type="button"
            aria-pressed={filter === 'recent'}
            onClick={() => setFilter('recent')}
          >
            {t('Recent')}
          </button>
          <button
            data-icon-trigger
            type="button"
            aria-pressed={filter === 'pinned'}
            onClick={() => setFilter('pinned')}
          >
            {t('Pinned')}
          </button>
        </div>
        <span className="cp-count">
          {rooms.length === 1
            ? t('{count} project', { count: rooms.length })
            : t('{count} projects', { count: rooms.length })}
        </span>
      </div>
      {featureOn('projectView') && <div className="po-controls">
        <div className="cp-tabs" aria-label="Project layout">
          <button type="button" aria-pressed={viewOptions.layout === 'cards'} onClick={() => projectView.save({...viewOptions, layout:'cards'})}>Cards</button>
          <button type="button" aria-pressed={viewOptions.layout === 'list'} onClick={() => projectView.save({...viewOptions, layout:'list'})}>List</button>
        </div>
        <label>Sort <select value={viewOptions.sort} onChange={event => projectView.save({...viewOptions, sort:event.target.value as typeof viewOptions.sort})}>
          <option value="recent">Recently updated</option><option value="name">Name A–Z</option><option value="oldest">Oldest update first</option>
        </select></label>
        {projectView.error && <output>{projectView.error}</output>}
      </div>}
      {featureOn('projectLabels') && <div className="po-controls">
        <label>Label <select value={labelFilter} onChange={event => setLabelFilter(event.target.value)}><option value="">All labels</option>{PROJECT_LABELS.map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
        <small>Labels are saved on this device.</small>
        {projectLabels.error && <output>{projectLabels.error}</output>}
      </div>}
      {rooms.length ? (
        <div className={`cp-room-grid${viewOptions.layout === 'list' ? ' po-project-list' : ''}`}>
          {rooms.map((room) => (
            <article className="cp-room-card" key={room.id}>
              <div className="cp-card-actions">
                <button
                  data-icon-trigger
                  className={`cp-icon-button${room.pinned ? ' is-pinned' : ''}`}
                  type="button"
                  onClick={() => onTogglePin(room.id)}
                  aria-label={
                    room.pinned
                      ? t('Unpin {name}', { name: roomLabel(room, t) })
                      : t('Pin {name}', { name: roomLabel(room, t) })
                  }
                  aria-pressed={room.pinned}
                >
                  <MotionIcon name="pin" size={20} active={room.pinned} />
                </button>
                <button
                  data-icon-trigger
                  className="cp-icon-button"
                  type="button"
                  onClick={() => onDeleteRoom(room.id)}
                  aria-label={t('Delete {name}', { name: roomLabel(room, t) })}
                >
                  <MotionIcon name="remove" size={20} />
                </button>
              </div>
              {featureOn('projectLabels') && <label className="po-label-control" style={{borderColor: PROJECT_LABELS.find(label => label.id === projectLabels.value[room.id])?.color}}>
                <span className="po-sr-only">Label for {roomLabel(room, t)}</span>
                <select aria-label={`Label for ${roomLabel(room,t)}`} value={projectLabels.value[room.id] ?? ''} onChange={event => {
                  try { projectLabels.save(setProjectLabel(projectLabels.value, room.id, event.target.value)); } catch { onToast('This project label could not be saved.'); }
                }}><option value="">No label</option>{PROJECT_LABELS.map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</select>
              </label>}
              <button
                data-icon-trigger
                className="cp-room-open"
                type="button"
                onClick={() => onOpenRoom(room.id)}
                aria-label={t('Open {name}', { name: roomLabel(room, t) })}
              >
                <RoomPreview room={room} />
                <div className="cp-room-caption">
                  <h2>{roomLabel(room, t)}</h2>
                  <div>
                    <span>
                      {room.turns.length
                        ? room.turns.length === 1
                          ? t('{count} conversation', {
                              count: room.turns.length,
                            })
                          : t('{count} conversations', {
                              count: room.turns.length,
                            })
                        : t('A fresh start')}
                    </span>
                    <span>{dateLabel(room.updatedAt, t.locale)}</span>
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
              ? t('No projects found')
              : filter === 'pinned'
                ? t('Keep a thought close')
                : t('Start a project')
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
                {t('New project')}
              </button>
            ) : undefined
          }
        >
          {search
            ? t('Try a project name or a few words from a question.')
            : filter === 'pinned'
              ? t('Pin a project to give your ongoing work a place here.')
              : t(
                  'Start with a question, a project, or an idea you want to understand.',
                )}
        </EmptyState>
      )}
    </section>
  );
}

function BriefPreview({
  brief,
  room,
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
  room?: Room;
  roomName: string;
  onOpenRoom: () => void;
  onDelete: () => void;
  onClose: () => void;
  onEdit?: (brief: CanvasBrief) => Promise<boolean>;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [printError, setPrintError] = useState('');
  return (
    <aside
      className="cp-brief-preview"
      aria-label={t('Preview: {title}', {
        title: briefTitleLabel(brief, room, t),
      })}
    >
      <div className="cp-preview-toolbar">
        <span>
          <MotionIcon name="brief" size={20} />
          {t('Saved Brief')}
        </span>
        <button
          data-icon-trigger
          className="cp-icon-button"
          type="button"
          aria-label={t('Close Brief preview')}
          onClick={onClose}
        >
          <MotionIcon name="close" size={20} />
        </button>
      </div>
      <div className="cp-brief-content">
        <p className="cp-eyebrow">
          {roomName} · {dateLabel(brief.createdAt, t.locale)}
        </p>
        <h2>{briefTitleLabel(brief, room, t)}</h2>
        {editing && onEdit && brief.live?.document ? (
          <LiveBriefEditor
            brief={brief}
            onSave={onEdit}
            onClose={() => setEditing(false)}
          />
        ) : brief.live?.document ? (
          <LiveBriefReader document={brief.live.document} />
        ) : (
          <pre>{briefBodyLabel(brief, room, t)}</pre>
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
            {t('Print / PDF')}
          </button>
        )}
        {onEdit && brief.live?.document && (
          <button
            type="button"
            className="cp-button"
            disabled={editing}
            onClick={() => setEditing(true)}
          >
            {t('Edit assessment')}
          </button>
        )}
        <button
          data-icon-trigger
          type="button"
          className="cp-button cp-button--ink"
          onClick={() =>
            downloadText(
              `${filename(brief.title)}.md`,
              briefBodyLabel(brief, room, t),
            )
          }
        >
          <MotionIcon name="download" size={20} />
          {t('Download')}
        </button>
        <button
          data-icon-trigger
          type="button"
          className="cp-button"
          onClick={onOpenRoom}
        >
          {t('Open project')}
          <MotionIcon name="open" size={20} />
        </button>
        <button
          data-icon-trigger
          type="button"
          className="cp-icon-button"
          aria-label={t('Delete saved Brief')}
          onClick={() => setConfirming(!confirming)}
        >
          <MotionIcon name="remove" size={20} />
        </button>
      </div>
      {printError && <output>{t(printError)}</output>}
      {confirming && (
        <div className="cp-delete-confirm">
          <p>{t('Remove this saved Brief from your library?')}</p>
          <div>
            <button
              data-icon-trigger
              className="cp-text-button"
              type="button"
              onClick={() => setConfirming(false)}
            >
              {t('Keep Brief')}
            </button>
            <button
              data-icon-trigger
              className="cp-text-button cp-text-button--red"
              type="button"
              onClick={onDelete}
            >
              {t('Delete Brief')}
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
  const t = useT();
  const [filter, setFilter] = useState('All');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stars = useDeviceSetting<string[]>(`conclave.brief-stars.v1:${account?.accountId ?? 'sample'}`, [], isStringList, featureOn('briefStars'));
  const [onlyStars, setOnlyStars] = useState(false);
  const projectSetting = useDeviceSetting(`conclave.library-project.v1:${account?.accountId ?? 'sample'}`, '', validProjectFilter, featureOn('libraryFilter'));
  const projects = [...new Set(state.briefs.map(brief => brief.roomId))].map(id => ({id, name: state.rooms.find(room => room.id === id)?.name ?? 'Archived project'})).sort((a,b) => a.name.localeCompare(b.name));
  const project = featureOn('libraryFilter') && projects.some(item => item.id === projectSetting.value) ? projectSetting.value : '';
  const search = query.trim().toLowerCase();
  const briefs = state.briefs
    .filter(
      (brief) =>
        (filter === 'All' || filter === 'Briefs') &&
        (!project || brief.roomId === project) &&
        (!featureOn('briefStars') || !onlyStars || stars.value.includes(brief.id)) &&
        `${brief.title} ${brief.body}`.toLowerCase().includes(search),
    )
    .toSorted((a, b) => b.createdAt - a.createdAt);
  // Filtering cards must not unmount an open assessment with unsaved changes.
  const selected = state.briefs.find((brief) => brief.id === selectedId);
  return (
    <section className="cp-page cp-library">
      <PageHeading
        title={t('Library')}
        description={t(
          'The useful things you chose to keep. Your saved Briefs, together in one place.',
        )}
      />
      <div className="cp-filter-row">
        <div className="cp-pills" aria-label={t('Library filter')}>
          {['All', 'Files', 'Media', 'Briefs'].map((item) => (
            <button
              data-icon-trigger
              type="button"
              key={item}
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              {t(item)}
            </button>
          ))}
        </div>
        <span className="cp-count">
          {briefs.length === 1
            ? t('{count} item', { count: briefs.length })
            : t('{count} items', { count: briefs.length })}
        </span>
      </div>
      {featureOn('libraryFilter') && <div className="cl-library-tools">
        <label>Project
          <select aria-label="Filter Library by project" value={project} onChange={event => projectSetting.save(event.target.value)}>
            <option value="">All projects</option>
            {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {project && <button type="button" onClick={() => projectSetting.save('')}>Clear project filter</button>}
        {projectSetting.error && <span role="status">{projectSetting.error}</span>}
      </div>}
      {featureOn('briefStars') && <div className="cl-library-tools">
        <button className="cl-library-favorites" type="button" aria-pressed={onlyStars} onClick={() => setOnlyStars(!onlyStars)}><Star size={15} fill={onlyStars ? 'currentColor' : 'none'} /> Favorites{onlyStars ? ' only' : ''}</button>
        <span>{stars.error || 'Favorites are saved on this device.'}</span>
      </div>}
      <div className={`cp-library-layout${selected ? ' has-preview' : ''}`}>
        <div>
          {briefs.length ? (
            <div className="cp-library-grid">
              {briefs.map((brief) => (
                <div key={brief.id} className="cl-library-item">
                <button
                  data-icon-trigger
                  type="button"
                  className={`cp-library-card${selected?.id === brief.id ? ' is-selected' : ''}`}
                  aria-pressed={selected?.id === brief.id}
                  onClick={() => setSelectedId(brief.id)}
                >
                  <div className="cp-document-preview">
                    <MotionIcon name="brief" size={24} />
                    <strong>
                      {briefTitleLabel(
                        brief,
                        state.rooms.find((room) => room.id === brief.roomId),
                        t,
                      )}
                    </strong>
                    <p>
                      {(brief.live?.document
                        ? brief.live.document.analysis.decision ||
                          brief.live.document.evidence[0].answer
                        : briefBodyLabel(
                            brief,
                            state.rooms.find(
                              (room) => room.id === brief.roomId,
                            ),
                            t,
                          ).replace(/^#+\s*/gm, '')
                      ).slice(0, 165)}
                    </p>
                  </div>
                  <div className="cp-library-caption">
                    <h2>
                      {briefTitleLabel(
                        brief,
                        state.rooms.find((room) => room.id === brief.roomId),
                        t,
                      )}
                    </h2>
                    <span>
                      {t('Brief')}
                      <span>·</span>
                      {dateLabel(brief.createdAt, t.locale)}
                    </span>
                  </div>
                </button>
                {featureOn('briefStars') && <button type="button" className="cl-brief-star" aria-label={`${stars.value.includes(brief.id) ? 'Unfavorite' : 'Favorite'} ${brief.title}`} aria-pressed={stars.value.includes(brief.id)} onClick={() => stars.save(stars.value.includes(brief.id) ? stars.value.filter(id => id !== brief.id) : [...stars.value.filter(id => state.briefs.some(item => item.id === id)).slice(-255), brief.id])}><Star size={17} fill={stars.value.includes(brief.id) ? 'currentColor' : 'none'} /></button>}
                </div>
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
                featureOn('briefStars') && onlyStars ? 'No favorites match' : project ? 'No Briefs match this project' : search
                  ? t('Nothing matches just yet')
                  : filter === 'Files' || filter === 'Media'
                    ? filter === 'Files'
                      ? t('No saved files yet')
                      : t('No saved media yet')
                    : t('Keep the parts that matter')
              }
            >
              {search
                ? t('Try a different title or a few words from your Brief.')
                : filter === 'Files' || filter === 'Media'
                  ? t(
                      'This library currently holds saved Briefs. Uploaded Studio references stay in the Studio draft.',
                    )
                  : t(
                      'Select useful answers in a project and save a Brief. It will be waiting here.',
                    )}
            </EmptyState>
          )}
        </div>
        {selected && (
          <BriefPreview
            key={selected.id}
            brief={selected}
            room={state.rooms.find((room) => room.id === selected.roomId)}
            onEdit={onEditBrief}
            accountId={account?.accountId}
            visible={view === 'library'}
            onRefreshBrief={onRefreshBrief}
            roomName={(() => {
              const room = state.rooms.find(
                (room) => room.id === selected.roomId,
              );
              return room ? roomLabel(room, t) : t('Saved project');
            })()}
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
  const t = useT();
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
    onToast(t('Agent plan created. No task is running.'));
  };
  const choose = (draft: AgentDraft) => {
    setSelectedId(draft.id);
    setNotes(draft.notes);
  };
  const exportPlan = (draft: AgentDraft) =>
    downloadText(
      `${filename(draft.name)}-agent-plan.md`,
      `# ${draft.name}\n\n${t('Status: local draft; no runtime connected')}\n${t(
        'Scope: {project}',
        {
          project: (() => {
            const room = state.rooms.find((room) => room.id === draft.scope);
            return room ? roomLabel(room, t) : t('Unassigned project');
          })(),
        },
      )}\n\n## ${t('Goal')}\n\n${draft.goal}\n\n## ${t('Instructions')}\n\n${draft.notes || t('No additional instructions.')}\n\n${t('No apps, computer, memory service, schedule or spending authority has been granted.')}\n`,
    );
  return (
    <section className="cp-page cp-agents">
      <PageHeading
        title={t('Agents')}
        description={t(
          'Give ongoing work a clear purpose. Start with a goal and the boundaries that matter.',
        )}
      >
        <span className="cp-status">
          <span />
          {t('Runtime not connected')}
        </span>
      </PageHeading>
      <div className="cp-agent-tabs">
        <div className="cp-tabs" aria-label={t('Agent drafts')}>
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
            {t('New agent')}
          </button>
        </div>
        <span className="cp-fineprint">
          {t('Local plans · download to keep')}
        </span>
      </div>
      {!selected ? (
        <div className="cp-plan-layout">
          <div className="cp-plan-intro">
            <span className="cp-feature-icon">
              <MotionIcon name="agents" size={24} />
            </span>
            <h2>
              {t.rich('Good work starts{break}with a good brief.', {
                break: <br />,
              })}
            </h2>
            <p>
              {t(
                'What should this agent help you do? Give it a name, a specific goal, and a project to work within.',
              )}
            </p>
            <div className="cp-boundary-note">
              <LockKeyhole size={17} />
              <span>
                {t(
                  'This creates a plan. Apps, memory and background execution are not connected.',
                )}
              </span>
            </div>
          </div>
          <form className="cp-form-paper" onSubmit={create}>
            <label>
              {t('Name')}
              <input
                value={name}
                onChange={(event) => {
                  setScope(workingRoom);
                  setName(event.target.value);
                }}
                maxLength={50}
                placeholder={t('For example, Scout')}
                required
              />
            </label>
            <label>
              {t('Goal')}
              <textarea
                value={goal}
                onChange={(event) => {
                  setScope(workingRoom);
                  setGoal(event.target.value);
                }}
                placeholder={t(
                  'Describe what a useful result would look like…',
                )}
                maxLength={3000}
                required
              />
            </label>
            <label>
              {t('Working project')}
              <select
                value={workingRoom}
                onChange={(event) => setScope(event.target.value)}
              >
                {!workingRoomExists && (
                  <option value={workingRoom} disabled>
                    {t('Choose an available project')}
                  </option>
                )}
                {state.rooms.length ? (
                  state.rooms.map((room) => (
                    <option value={room.id} key={room.id}>
                      {roomLabel(room, t)}
                    </option>
                  ))
                ) : (
                  <option value="">{t('Unassigned')}</option>
                )}
              </select>
            </label>
            <button
              data-icon-trigger
              type="submit"
              className="cp-button cp-button--red"
              disabled={!name.trim() || !goal.trim() || !workingRoomExists}
            >
              {t('Create agent plan')}
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
                <span>{t('Goal')}</span>
              </div>
              <h2>{selected.goal}</h2>
              <p>
                {(() => {
                  const room = state.rooms.find(
                    (room) => room.id === selected.scope,
                  );
                  return room ? roomLabel(room, t) : t('Unassigned project');
                })()}
              </p>
            </article>
            <div className="cp-agent-next">
              <span className="cp-red-dot" />
              <div>
                <h3>{t('A plan, ready for its next step.')}</h3>
                <p>
                  {t(
                    '{name} has not started a task. Connect a runtime before granting tools, schedules or permission to act.',
                    { name: selected.name },
                  )}
                </p>
                <button
                  data-icon-trigger
                  className="cp-button"
                  type="button"
                  onClick={() => exportPlan(selected)}
                >
                  <MotionIcon name="download" size={20} />
                  {t('Download plan')}
                </button>
              </div>
            </div>
          </div>
          <aside className="cp-agent-inspector">
            <div className="cp-tabs" aria-label={t('Agent details')}>
              {['Instructions', 'Activity', 'Apps'].map((item) => (
                <button
                  data-icon-trigger
                  key={item}
                  type="button"
                  aria-pressed={tab === item}
                  onClick={() => setTab(item)}
                >
                  {t(item)}
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
                  onToast(t('Instructions saved to this draft.'));
                }}
              >
                <label htmlFor="cp-agent-notes">
                  {t('Things this agent should know')}
                </label>
                <textarea
                  id="cp-agent-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  maxLength={5000}
                  placeholder={t(
                    'Scope, sources to use, and actions that would need your review…',
                  )}
                />
                <p className="cp-fineprint">
                  {t(
                    'Your notes are part of this draft. They have not been sent to an agent or memory service.',
                  )}
                </p>
                <button
                  data-icon-trigger
                  className="cp-button cp-button--ink"
                  type="submit"
                >
                  {t('Save instructions')}
                  <MotionIcon name="select" size={20} />
                </button>
              </form>
            ) : tab === 'Activity' ? (
              <div className="cp-agent-activity">
                <span className="cp-red-dot" />
                <div>
                  <h3>{t('Plan created')}</h3>
                  <p>
                    {t('{date} · in this session', {
                      date: dateLabel(selected.createdAt, t.locale),
                    })}
                  </p>
                  <small>{t('No background work has run.')}</small>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={<MotionIcon name="connections" size={24} />}
                title={t('No access granted')}
              >
                {t(
                  'Connected apps and computer access will be listed here when a runtime is available.',
                )}
              </EmptyState>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function DecisionsPage({ account, onToast, onCompareDecision }: WorkspacePagesProps) {
  return <DecisionWorkspace key={account?.accountId ?? 'guest'} accountId={account?.accountId ?? 'guest'} onToast={onToast} onCompare={onCompareDecision} />;
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
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="cp-page cp-utility">
      <PageHeading
        title={t('Connections')}
        description={t(
          'Only the access you choose. See what is connected and where your information can go.',
        )}
      />
      <div className="cp-local-connection">
        <span className="cp-connection-icon">
          <MotionIcon name="rooms" size={20} />
        </span>
        <div>
          <h2>{t('This browser')}</h2>
          <p>
            {state.rooms.length === 1
              ? t('{count} project', { count: state.rooms.length })
              : t('{count} projects', { count: state.rooms.length })}{' '}
            ·{' '}
            {state.briefs.length === 1
              ? t('{count} saved Brief', { count: state.briefs.length })
              : t('{count} saved Briefs', { count: state.briefs.length })}
          </p>
        </div>
        <span className="cp-local-label">
          {t('Local workspace')}
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
                  <strong>{t(item.name)}</strong>
                  <span>{t(item.description)}</span>
                </span>
                <span className="cp-connection-state">
                  {t('Not connected')}
                </span>
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
                  <p>{t(item.detail)}</p>
                  <span>
                    <LockKeyhole size={14} />
                    {t('No permissions granted')}
                  </span>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <p className="cp-footer-note">
        {t(
          'No account connections are required to explore your local workspace.',
        )}
      </p>
    </section>
  );
}

function PursePage({ onToast }: WorkspacePagesProps) {
  const t = useT();
  const [budget, setBudget] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const amount = Number(budget);
  return (
    <section className="cp-page cp-purse">
      <PageHeading
        title={t('Purse')}
        description={t(
          'Know what a request will cost. Keep a clear record of what you choose to spend.',
        )}
      />
      <div className="cp-purse-layout">
        <div className="cp-balance-area">
          <span className="cp-eyebrow">{t('Available balance')}</span>
          <p className="cp-balance">
            — <span>USDC</span>
          </p>
          <span className="cp-status">
            <span />
            {t('Wallet and payments not connected')}
          </span>
          <p>
            {t(
              'Your balance will appear when a wallet and the payment service are connected.',
            )}
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
            onToast(
              t('Spending plan saved in this view. No live limit was set.'),
            );
          }}
        >
          <h2>{t('A plan for your spending')}</h2>
          <p>{t('Set an intended monthly amount for your draft.')}</p>
          <label htmlFor="cp-budget">{t('Monthly target')}</label>
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
            {t('Save spending plan')}
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
              {t('Download {amount} USDC plan', { amount: saved })}
            </button>
          )}
          <p className="cp-fineprint">
            {t(
              'A planning amount only. It does not move funds or enforce a spending limit.',
            )}
          </p>
        </form>
      </div>
      <div className="cp-ledger">
        <div className="cp-ledger-heading">
          <h2>{t('Receipts')}</h2>
          <span>{t('No settled activity')}</span>
        </div>
        <div className="cp-ledger-columns" aria-hidden="true">
          <span>{t('Activity')}</span>
          <span>{t('Reference')}</span>
          <span>{t('Amount')}</span>
        </div>
        <EmptyState
          icon={<MotionIcon name="brief" size={24} />}
          title={t('Every real request, accounted for')}
        >
          {t(
            'Receipts will appear after connected requests settle. The local preview does not charge you.',
          )}
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
  const t = useT();
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
    onToast(t('Chapter plan saved in this view. No access was shared.'));
  };
  const exportPlan = (draft: ChapterDraft) =>
    downloadText(
      `${filename(draft.name)}-chapter-plan.md`,
      `# ${draft.name}\n\n${draft.purpose}\n\n## ${t('Proposed projects')}\n\n${
        draft.rooms
          .map((id) => {
            const room = state.rooms.find((room) => room.id === id);
            return `- ${room ? roomLabel(room, t) : t('Removed project')}`;
          })
          .join('\n') || t('No projects selected.')
      }\n\n## ${t('Sharing preference')}\n\n${t(draft.access)}\n\n${t('Local draft only. No invitations sent, permissions granted, shared budget created or Squads account connected.')}\n`,
    );
  return (
    <section className="cp-page cp-chapters">
      <PageHeading
        title={t('Chapters')}
        description={t(
          'A shared direction for a few good minds. Plan the projects and boundaries for your team.',
        )}
      >
        <span className="cp-status">
          <span />
          {t('Team services not connected')}
        </span>
      </PageHeading>
      <div className="cp-plan-layout">
        <div className="cp-plan-intro">
          <span className="cp-feature-icon">
            <MotionIcon name="chapters" size={24} />
          </span>
          <h2>
            {t.rich('Work together.{break}Choose what is shared.', {
              break: <br />,
            })}
          </h2>
          <p>
            {t(
              'A Chapter will bring people, projects and a shared allowance together. Start by deciding what belongs in yours.',
            )}
          </p>
          {drafts.length > 0 && (
            <div className="cp-chapter-drafts" aria-label={t('Chapter drafts')}>
              {drafts.map((draft) => (
                <article key={draft.id}>
                  <span>
                    <MotionIcon name="chapters" size={20} />
                  </span>
                  <div>
                    <h3>{draft.name}</h3>
                    <p>
                      {draft.rooms.length === 1
                        ? t('{count} proposed project · local draft', {
                            count: draft.rooms.length,
                          })
                        : t('{count} proposed projects · local draft', {
                            count: draft.rooms.length,
                          })}
                    </p>
                  </div>
                  <button
                    data-icon-trigger
                    className="cp-icon-button"
                    type="button"
                    aria-label={t('Download {name} plan', { name: draft.name })}
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
              {t(
                'Project access stays personal. Save or download a plan before connecting team services.',
              )}
            </span>
          </div>
        </div>
        <form className="cp-form-paper" onSubmit={create}>
          <label>
            {t('Chapter name')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder={t('What brings your team together?')}
              required
            />
          </label>
          <label>
            {t('Purpose')}
            <textarea
              className="cp-short-input"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              maxLength={2000}
              placeholder={t(
                'A short note about the work you want to do together.',
              )}
            />
          </label>
          <fieldset className="cp-room-checklist">
            <legend>{t('Projects to include in the plan')}</legend>
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
                <span>{roomLabel(room, t)}</span>
              </label>
            ))}
            {!state.rooms.length && (
              <p>{t('No projects yet. You can add them to a later plan.')}</p>
            )}
          </fieldset>
          <label>
            {t('Sharing preference')}
            <select
              value={access}
              onChange={(event) => setAccess(event.target.value)}
            >
              <option value="Review before sharing">
                {t('Review before sharing')}
              </option>
              <option value="Members can contribute">
                {t('Members can contribute')}
              </option>
              <option value="Members can view only">
                {t('Members can view only')}
              </option>
            </select>
          </label>
          <button
            data-icon-trigger
            className="cp-button cp-button--red"
            type="submit"
            disabled={!name.trim()}
          >
            {t('Save Chapter plan')}
            <MotionIcon name="forward" size={20} />
          </button>
          <p className="cp-fineprint">
            {t(
              'A local draft. No invitation, shared access or team budget is created.',
            )}
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
        {props.view === 'agents' && <LiveWorkspaceServices view="agents" accountId={props.account?.accountId ?? null} />}
      </div>
      <div className="cp-view" hidden={props.view !== 'library'}>
        <LibraryPage {...props} />
      </div>
      <div className="cp-view" hidden={props.view !== 'decisions'}>
        <DecisionsPage {...props} />
      </div>
      <div className="cp-view" hidden={props.view !== 'connections'}>
        {props.view === 'connections' && <LiveWorkspaceServices view="connections" accountId={props.account?.accountId ?? null} />}
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
        {props.view === 'chapters' && <LiveWorkspaceServices view="chapters" accountId={props.account?.accountId ?? null} />}
      </div>
    </>
  );
}
