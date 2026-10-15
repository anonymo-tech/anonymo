'use client';

import { useT } from '@/lib/i18n';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import Image from 'next/image';
import { Link2, Pause, Play } from 'lucide-react';
import { MotionIcon } from './motion-icon';
import { STUDIO_MODELS } from './studio-page';
import type { useLiveStudio } from './use-live-studio';
import type { MediaJob } from '../../lib/client/media';
import { formatAccountUsd6 } from '../../lib/client/account-records';
import { featureOn } from './feature-switches';
import { studioReuseDraft, type StudioReuseDraft } from '../../lib/studio-reuse';
import '../../app/dashboard/studio-page.css';
import '../../app/dashboard/studio-extras.css';
import { filterStudioJobs, STUDIO_JOB_GROUPS, type StudioJobGroup } from '../../lib/studio-search';

type Controller = ReturnType<typeof useLiveStudio>;
function modelFor(job: MediaJob) {
  const id = job.modelId.toLowerCase();
  return STUDIO_MODELS.find((model) => id.includes(model.id));
}
function label(job: MediaJob) {
  return modelFor(job)?.name ?? job.modelId;
}
function status(job: MediaJob) {
  if (job.mediaAssetState === 'stored') return 'Saved';
  if (job.mediaAssetState === 'deleted') return 'Clip deleted';
  if (job.mediaAssetState === 'unavailable' || job.processingState === 'failed')
    return 'Clip could not be prepared';
  if (job.state === 'reconciliation_pending')
    return 'Checking generation and charge';
  if (
    job.cancelRequested &&
    !['completed', 'failed', 'cancelled'].includes(job.state)
  )
    return 'Cancellation requested';
  if (job.state === 'completed') return 'Preparing clip';
  return (
    {
      queued: 'Waiting to start',
      dispatching: 'Starting generation',
      polling: 'Generating',
      failed: 'Generation failed',
      cancelled: 'Cancelled',
    }[job.state] ?? 'Checking status'
  );
}
const time = (value: number) => {
  const seconds = Math.max(0, Math.floor(value));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Saved results use the same Studio stage and transport as the preview. The
 * account session owns the media URLs; there is no public provider URL fallback. */
export function LiveStudioPage({
  studio,
  active,
  onToast,
  onReuse,
}: {
  onReuse: (draft: StudioReuseDraft) => void;
  studio: Controller;
  active: boolean;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const title = useId();
  const [selection, setSelection] = useState('recent');
  const [query, setQuery] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<StudioJobGroup>('all');
  const searchEnabled = featureOn('studioSearch');
  const loadedJobs = studio.jobs.filter((job) => job.modality === 'video');
  const jobs = searchEnabled ? filterStudioJobs(loadedJobs, query, modelFilter, stateFilter) : loadedJobs;
  const filtering = searchEnabled && (!!query.trim() || !!modelFilter || stateFilter !== 'all');
  const groupLabels: Record<StudioJobGroup, string> = { all: 'Any status', saved: 'Saved clips', progress: 'In progress', attention: 'Needs attention', cancelled: 'Cancelled', deleted: 'Deleted clips' };
  const chosen =
    selection === 'recent'
      ? jobs.slice(0, 4)
      : jobs.filter((job) => job.id === selection);
  const showing = chosen.length ? chosen : jobs.slice(0, 4);
  return (
    <section className="cs-page" hidden={!active} aria-labelledby={title}>
      <header className="cs-heading">
        <div className="cs-heading-copy">
          <h1 id={title}>{t('Studio')}</h1>
          <p>
            {studio.status === 'loading'
              ? t('Loading your clips…')
              : studio.capability?.configured
                ? t('Your video workspace')
                : t('Saved clips · Generation unavailable')}
          </p>
        </div>
        {jobs.length > 1 && (
          <select
            className="cs-view-toggle"
            aria-label={t('Studio results')}
            value={chosen.length ? selection : 'recent'}
            onChange={(event) => setSelection(event.target.value)}
          >
            <option value="recent">{t('Recent results')}</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {label(job)} · {job.input.prompt.slice(0, 42)} ·{' '}
                {new Date(job.createdAt).toISOString().slice(11, 16)} UTC
              </option>
            ))}
          </select>
        )}
      </header>
      {studio.error && (
        <output className="cp-boundary-note">{studio.error}</output>
      )}
      {searchEnabled && <div className="cs-search-tools">
        <div className="cs-search-fields">
          <label>
            <span>Find a clip</span>
            <input type="search" value={query} placeholder="Search prompts or models" maxLength={500}
              onChange={event => { setQuery(event.target.value); setSelection('recent'); }} />
          </label>
          <label>
            <span>Model</span>
            <select value={modelFilter} onChange={event => { setModelFilter(event.target.value); setSelection('recent'); }}>
              <option value="">All models</option>
              {[...new Set(loadedJobs.map(job => job.modelId))].map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <label>
            <span>Status</span>
            <select value={stateFilter} onChange={event => {
              const group = STUDIO_JOB_GROUPS.find(group => group === event.target.value);
              if (group) { setStateFilter(group); setSelection('recent'); }
            }}>
              {STUDIO_JOB_GROUPS.map(group => <option key={group} value={group}>{groupLabels[group]}</option>)}
            </select>
          </label>
          {filtering && <button type="button" onClick={() => { setQuery(''); setModelFilter(''); setStateFilter('all'); setSelection('recent'); }}>Clear filters</button>}
        </div>
        <output className="cs-search-count">
          {jobs.length} of {loadedJobs.length} loaded clips{studio.nextCursor ? '. Load earlier results to search older clips.' : '.'}
        </output>
      </div>}

      {showing.length ? (
        <StudioPlayback
          key={showing
            .map((job) => `${job.id}:${job.asset?.id ?? job.mediaAssetState}`)
            .join('|')}
          jobs={showing}
          studio={studio}
          active={active}
          onToast={onToast}
          onReuse={onReuse}
        />
      ) : (
        <div className="cs-stage is-focused">
          <div className="cs-media">
            <div className="cs-media-error">
              <span>
                {studio.status === 'loading'
                  ? t('Loading your saved results…')
                  : filtering ? 'No clips match these filters' : t('Your next idea starts here')}
              </span>
              <p>
                {filtering ? 'Try a different prompt, model or status, or load earlier results.' : studio.status === 'unavailable'
                  ? t('Sign in to save and generate clips.')
                  : t(
                      'Describe a video in the bar below. Review each model’s format and cost before generating.',
                    )}
              </p>
            </div>
          </div>
        </div>
      )}
      <div className="cs-heading">
        <button
          type="button"
          className="cp-text-button"
          disabled={studio.busy || studio.status === 'unavailable'}
          onClick={() => void studio.refresh()}
        >
          {t('Refresh results')}
        </button>
        {studio.nextCursor && (
          <button
            type="button"
            className="cp-text-button"
            disabled={studio.busy}
            onClick={() => void studio.loadMore()}
          >
            {t('Earlier results')}
          </button>
        )}
      </div>
    </section>
  );
}

function StudioPlayback({
  jobs,
  studio,
  active,
  onToast,
  onReuse,
}: {
  onReuse: (draft: StudioReuseDraft) => void;
  jobs: MediaJob[];
  studio: Controller;
  active: boolean;
  onToast: (message: string) => void;
}) {
  const t = useT();
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const menus = useRef(new Map<string, HTMLDetailsElement>());
  const request = useRef(0),
    isPlaying = useRef(false),
    positionRef = useRef(0);
  const [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const jobKey = jobs.map((job) => job.id).join('|');
  const videoRefs = useMemo(
    () =>
      Object.fromEntries(
        jobKey.split('|').map((id) => [
          id,
          (element: HTMLVideoElement | null) => {
            if (element) videos.current.set(id, element);
            else {
              videos.current.get(id)?.pause();
              videos.current.delete(id);
            }
          },
        ]),
      ),
    [jobKey, videos],
  );
  const visible = focused ? jobs.filter((job) => job.id === focused) : jobs;
  const ready = visible.filter(
    (job) =>
      job.deliveryReady &&
      job.asset?.contentType === 'video/mp4' &&
      !failed[job.id],
  );
  // The longest clip leads: a shorter clip ending must not truncate its peers.
  const leader = ready.reduce<MediaJob | undefined>(
    (best, job) =>
      !best || (durations[job.id] ?? 0) > (durations[best.id] ?? 0)
        ? job
        : best,
    undefined,
  );
  const duration = Math.max(0, ...ready.map((job) => durations[job.id] ?? 0));
  const playable =
    active && duration > 0 && ready.every((job) => durations[job.id] > 0);
  function closeMenus() {
    for (const menu of menus.current.values()) menu.open = false;
  }
  function pause() {
    request.current++;
    isPlaying.current = false;
    for (const video of videos.current.values()) video.pause();
    setPlaying(false);
  }
  function seek(value: number) {
    const next = Math.max(0, Math.min(value, duration));
    positionRef.current = next;
    setPosition(next);
    for (const job of ready) {
      const video = videos.current.get(job.id);
      if (video && video.readyState >= 1 && Number.isFinite(video.duration))
        video.currentTime = Math.min(next, video.duration);
    }
  }
  async function play() {
    if (isPlaying.current) {
      pause();
      return;
    }
    if (!playable || document.hidden) return;
    seek(positionRef.current >= duration - 0.05 ? 0 : positionRef.current);
    const current = ++request.current;
    isPlaying.current = true;
    setPlaying(true);
    const elements = ready
      .map((job) => videos.current.get(job.id))
      .filter(
        (video): video is HTMLVideoElement =>
          !!video && video.currentTime < video.duration,
      );
    const results = await Promise.allSettled(
      elements.map((video) => video.play()),
    );
    if (current !== request.current) return;
    if (results.some((result) => result.status === 'rejected')) {
      pause();
      onToast(
        t(
          'Playback could not start. Try Play again or refresh your saved results.',
        ),
      );
    }
  }
  useEffect(() => {
    const elements = videos.current,
      currentMenus = menus.current;
    const stop = () => {
      request.current++;
      isPlaying.current = false;
      for (const video of elements.values()) video.pause();
      setPlaying(false);
    };
    const visibility = () => {
      if (document.hidden) stop();
    };
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.cs-menu'))
        for (const menu of currentMenus.values()) menu.open = false;
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      for (const menu of currentMenus.values())
        if (menu.open) {
          menu.open = false;
          menu.querySelector<HTMLElement>('summary')?.focus();
        }
    };
    if (!active) stop();
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', keyboard);
    return () => {
      request.current += 1;
      isPlaying.current = false;
      for (const video of elements.values()) video.pause();
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', keyboard);
    };
  }, [active, request, isPlaying]);
  return (
    <div className={`cs-stage${visible.length === 1 ? ' is-focused' : ''}`}>
      <div className="cs-grid">
        {jobs.map((job) => {
          const model = modelFor(job),
            source = studio.assetUrl(job),
            saved = !!source && job.asset?.contentType === 'video/mp4';
          const reusable = featureOn('studioReuse') ? studioReuseDraft(job, studio.routes) : null;
          return (
            <article
              className="cs-tile"
              key={job.id}
              hidden={focused !== null && job.id !== focused}
              aria-label={t('{name} result', { name: label(job) })}
            >
              <div className="cs-media">
                {saved && (
                  <video
                    ref={videoRefs[job.id]}
                    src={source!}
                    muted
                    playsInline
                    preload="metadata"
                    aria-label={t('{name} generated clip', {
                      name: label(job),
                    })}
                    onLoadedMetadata={(event) => {
                      const value = event.currentTarget.duration;
                      if (Number.isFinite(value) && value > 0)
                        setDurations((current) => ({
                          ...current,
                          [job.id]: value,
                        }));
                    }}
                    onTimeUpdate={(event) => {
                      if (!isPlaying.current || leader?.id !== job.id) return;
                      const next = Math.min(
                        event.currentTarget.currentTime,
                        duration,
                      );
                      positionRef.current = next;
                      setPosition(next);
                      for (const other of ready) {
                        const follower = videos.current.get(other.id);
                        if (
                          other.id !== job.id &&
                          follower &&
                          follower.readyState >= 2 &&
                          !follower.seeking &&
                          !follower.ended &&
                          Math.abs(follower.currentTime - next) > 0.2
                        )
                          follower.currentTime = Math.min(
                            next,
                            follower.duration,
                          );
                      }
                    }}
                    onEnded={() => {
                      if (leader?.id === job.id) {
                        pause();
                        positionRef.current = duration;
                        setPosition(duration);
                      }
                    }}
                    onError={() => {
                      pause();
                      setFailed((current) => ({ ...current, [job.id]: true }));
                    }}
                  />
                )}
                {(!saved || failed[job.id]) && (
                  <div className="cs-media-error">
                    <span>
                      {failed[job.id]
                        ? t('Playback unavailable')
                        : t(status(job))}
                    </span>
                    {failed[job.id] && (
                      <button
                        type="button"
                        onClick={() => {
                          pause();
                          setFailed((current) => ({
                            ...current,
                            [job.id]: false,
                          }));
                          videos.current.get(job.id)?.load();
                        }}
                      >
                        {t('Reload clip')}
                      </button>
                    )}
                    {job.canRecover && (
                      <button
                        type="button"
                        disabled={studio.busy}
                        onClick={() => void studio.recover(job.id)}
                      >
                        {t('Check existing request')}
                      </button>
                    )}
                    {['queued', 'dispatching', 'polling'].includes(job.state) &&
                      !job.cancelRequested && (
                        <button
                          type="button"
                          disabled={studio.busy}
                          onClick={() => void studio.cancel(job.id)}
                        >
                          {t('Request cancellation')}
                        </button>
                      )}
                  </div>
                )}
              </div>
              <footer className="cs-caption">
                <span className="cs-provider">
                  {model && (
                    <Image
                      className="cw-provider-icon cs-provider-icon"
                      src={`/brand/providers/${model.providerId}.svg`}
                      width={20}
                      height={20}
                      alt=""
                    />
                  )}
                  <span>{label(job)}</span>
                </span>
                <details
                  className="cs-menu"
                  ref={(element) => {
                    if (element) menus.current.set(job.id, element);
                    else menus.current.delete(job.id);
                  }}
                  onToggle={(event) => {
                    if (event.currentTarget.open)
                      for (const [id, menu] of menus.current)
                        if (id !== job.id) menu.open = false;
                  }}
                >
                  <summary
                    data-icon-trigger
                    aria-label={t('Actions for {name} result', {
                      name: label(job),
                    })}
                  >
                    <MotionIcon name="more" size={18} />
                  </summary>
                  <div className="cs-menu-content">
                    <button
                      type="button"
                      onClick={() => {
                        pause();
                        closeMenus();
                        setFocused(focused ? null : job.id);
                      }}
                    >
                      {focused
                        ? t('Return to compare')
                        : t('Focus on this clip')}
                    </button>
                    {featureOn('studioReuse') && <button
                      type="button"
                      disabled={studio.busy || !!studio.review || !reusable}
                      title={!reusable ? 'This model or format is no longer available.' : undefined}
                      onClick={() => {
                        const current = studioReuseDraft(job, studio.routes);
                        if (!current) { onToast('Refresh Studio to check the currently available formats.'); return; }
                        pause();
                        closeMenus();
                        onReuse(current.draft);
                        onToast(current.formatChanged
                          ? `Prompt ready. The original format is unavailable; the draft uses ${current.format}. Review a fresh quote before generating.`
                          : `Prompt and ${current.format} settings ready. Edit your draft, then review a fresh quote.`);
                      }}
                    >Use prompt again</button>}
                    {saved && (
                      <a
                        href={studio.assetUrl(job, true)!}
                        download={`conclave-${job.asset!.id}.mp4`}
                        onClick={closeMenus}
                      >
                        {t('Download clip')}
                      </a>
                    )}
                    {saved &&
                      (deleting === job.id ? (
                        <>
                          <span>
                            {t(
                              'Delete this saved clip? Its job, charge and receipt remain. This does not issue a refund.',
                            )}
                          </span>
                          <button
                            type="button"
                            disabled={studio.busy}
                            onClick={() => {
                              pause();
                              void studio.deleteClip(job.id).then((done) => {
                                if (done) {
                                  closeMenus();
                                  setDeleting(null);
                                }
                              });
                            }}
                          >
                            {t('Confirm delete clip')}
                          </button>
                          <button
                            type="button"
                            disabled={studio.busy}
                            onClick={() => setDeleting(null)}
                          >
                            {t('Keep clip')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={studio.busy}
                          onClick={() => setDeleting(job.id)}
                        >
                          {t('Delete clip')}
                        </button>
                      ))}
                    <span>
                      {job.billing.actualUsd6 === null
                        ? t('{amount} USD reserved', {
                            amount: formatAccountUsd6(job.billing.maximumUsd6),
                          })
                        : t('{amount} USD settled', {
                            amount: formatAccountUsd6(job.billing.actualUsd6),
                          })}
                    </span>
                  </div>
                </details>
              </footer>
            </article>
          );
        })}
      </div>
      <fieldset className="cs-transport">
        <legend className="cs-sr-only">{t('Saved clip playback')}</legend>
        <button
          className="cs-play"
          type="button"
          onClick={() => void play()}
          disabled={!playable}
          aria-label={playing ? t('Pause clips') : t('Play clips')}
        >
          {playing ? (
            <Pause
              size={23}
              fill="currentColor"
              strokeWidth={1}
              aria-hidden="true"
            />
          ) : (
            <Play
              size={23}
              fill="currentColor"
              strokeWidth={1}
              aria-hidden="true"
            />
          )}
        </button>
        <span className="cs-time" aria-hidden="true">
          {time(Math.min(position, duration))} / {time(duration)}
        </span>
        <input
          className="cs-seek"
          type="range"
          min={0}
          max={duration || 1}
          step={0.05}
          value={Math.min(position, duration)}
          disabled={!playable}
          aria-label={t('Seek saved clips')}
          aria-valuetext={t('{position} of {duration}', {
            position: time(position),
            duration: time(duration),
          })}
          style={
            {
              '--cs-progress': `${duration ? (position / duration) * 100 : 0}%`,
            } as CSSProperties
          }
          onChange={(event) => {
            pause();
            seek(Number(event.target.value));
          }}
        />
        {visible.length > 1 && (
          <span className="cs-linked" title={t('Linked playback')}>
            <Link2 size={22} strokeWidth={1.5} aria-hidden="true" />
            <span className="cs-sr-only">{t('Playback is linked')}</span>
          </span>
        )}
      </fieldset>
    </div>
  );
}
