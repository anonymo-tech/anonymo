'use client';

import { useT } from '@/lib/i18n';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import Image from 'next/image';
import { ChevronDown, Link2, Pause, Play } from 'lucide-react';
import { MotionIcon } from './motion-icon';
import '../../app/dashboard/studio-page.css';

export const STUDIO_MODELS = [
  {
    id: 'runway',
    name: 'Runway',
    family: 'Runway',
    providerId: 'runway',
    specialty: 'Runway video · Not connected',
  },
  {
    id: 'veo',
    name: 'Veo',
    family: 'Google',
    providerId: 'gemini',
    specialty: 'Google video · Not connected',
  },
  {
    id: 'sora',
    name: 'Sora',
    family: 'OpenAI',
    providerId: 'openai',
    specialty: 'OpenAI video · Not connected',
  },
  {
    id: 'kling',
    name: 'Kling',
    family: 'Kling AI',
    providerId: 'kling',
    specialty: 'Kling video · Not connected',
  },
] as const;

type StudioModel = (typeof STUDIO_MODELS)[number];
type StudioSample = 'a' | 'b';
export type StudioPageProps = {
  active: boolean;
  modelIds: string[];
  onToast: (message: string) => void;
};

function sampleFor(modelId: string) {
  return modelId === 'veo' || modelId === 'kling' ? 'b' : 'a';
}

function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds + 0.001));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function StudioProvider({ model }: { model: StudioModel }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="cs-provider-fallback" aria-hidden="true">
      {model.name[0]}
    </span>
  ) : (
    <Image
      className="cw-provider-icon cs-provider-icon"
      src={`/brand/providers/${model.providerId}.svg`}
      width={20}
      height={20}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export function StudioPage({ active, modelIds, onToast }: StudioPageProps) {
  const t = useT();
  const headingId = useId();
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const menus = useRef(new Map<string, HTMLDetailsElement>());
  const playRequest = useRef(0);
  const playingRef = useRef(false);
  const positionRef = useRef(0);
  const mounted = useRef(false);
  const sampleUrls = useRef(new Map<StudioSample, string>());
  const sampleRequests = useRef(new Map<StudioSample, AbortController>());
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [comparing, setComparing] = useState(true);
  const [focusedId, setFocusedId] = useState('runway');
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [sampleSources, setSampleSources] = useState<
    Partial<Record<StudioSample, string>>
  >({});
  const [sampleErrors, setSampleErrors] = useState<
    Partial<Record<StudioSample, boolean>>
  >({});
  const modelKey =
    [...new Set(modelIds)]
      .filter((id) => STUDIO_MODELS.some((model) => model.id === id))
      .slice(0, 4)
      .join('|') || 'runway|veo';
  const models = useMemo(
    () =>
      modelKey
        .split('|')
        .map((id) => STUDIO_MODELS.find((model) => model.id === id)!),
    [modelKey],
  );
  const previousModelKey = useRef(modelKey);
  const videoRefs = useMemo(
    () =>
      Object.fromEntries(
        models.map((model) => [
          model.id,
          (element: HTMLVideoElement | null) => {
            if (element) videos.current.set(model.id, element);
            else {
              videos.current.get(model.id)?.pause();
              videos.current.delete(model.id);
            }
          },
        ]),
      ),
    [models, videos],
  );
  const focusedModel =
    models.find((model) => model.id === focusedId) || models[0];
  const showingComparison = comparing && models.length > 1;
  const visibleModels = showingComparison ? models : [focusedModel];
  const availableModels = visibleModels.filter(
    (model) => !failed[model.id] && !sampleErrors[sampleFor(model.id)],
  );
  const leaderId = availableModels[0]?.id;
  const knownDurations = models
    .filter((model) => !failed[model.id] && !sampleErrors[sampleFor(model.id)])
    .map((model) => durations[model.id])
    .filter((value) => Number.isFinite(value) && value > 0);
  const duration = knownDurations.length ? Math.min(...knownDurations) : 6;
  const pending = availableModels.some(
    (model) => !sampleSources[sampleFor(model.id)] || !durations[model.id],
  );
  const playable = active && !pending && availableModels.length > 0;
  const currentTime = Math.min(position, duration);

  const loadSample = useCallback(
    async (sample: StudioSample) => {
      sampleRequests.current.get(sample)?.abort();
      const controller = new AbortController();
      sampleRequests.current.set(sample, controller);
      try {
        const response = await fetch(`/media/studio-take-${sample}.mp4`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Sample request failed');
        const blob = await response.blob();
        if (!blob.size || blob.type.includes('text/html'))
          throw new Error('Sample media unavailable');
        if (controller.signal.aborted || !mounted.current) return;
        const url = URL.createObjectURL(
          new Blob([blob], { type: 'video/mp4' }),
        );
        const previous = sampleUrls.current.get(sample);
        sampleUrls.current.set(sample, url);
        if (previous) URL.revokeObjectURL(previous);
        setSampleSources((current) => ({ ...current, [sample]: url }));
        setSampleErrors((current) => ({ ...current, [sample]: false }));
      } catch {
        if (!controller.signal.aborted && mounted.current)
          setSampleErrors((current) => ({ ...current, [sample]: true }));
      } finally {
        if (sampleRequests.current.get(sample) === controller)
          sampleRequests.current.delete(sample);
      }
    },
    [sampleRequests, sampleUrls, mounted, setSampleSources, setSampleErrors],
  );

  useEffect(() => {
    mounted.current = true;
    const requests = sampleRequests.current;
    const urls = sampleUrls.current;
    const frame = requestAnimationFrame(() => {
      void loadSample('a');
      void loadSample('b');
    });
    return () => {
      cancelAnimationFrame(frame);
      mounted.current = false;
      for (const request of requests.values()) request.abort();
      requests.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [loadSample, mounted, sampleRequests, sampleUrls]);

  const stopMedia = useCallback(() => {
    playRequest.current += 1;
    playingRef.current = false;
    for (const video of videos.current.values()) video.pause();
  }, [playRequest, playingRef, videos]);

  const pauseAll = useCallback(() => {
    stopMedia();
    setPlaying(false);
  }, [stopMedia, setPlaying]);

  const closeMenus = useCallback(() => {
    for (const menu of menus.current.values()) menu.open = false;
  }, [menus]);

  function seekAll(value: number) {
    const next = Math.max(0, Math.min(value, duration));
    positionRef.current = next;
    setPosition(next);
    for (const video of videos.current.values()) {
      if (video.readyState < 1 || !Number.isFinite(video.duration)) continue;
      video.currentTime = Math.min(next, Math.max(0, video.duration - 0.001));
    }
  }

  useEffect(() => {
    if (previousModelKey.current === modelKey) return;
    previousModelKey.current = modelKey;
    stopMedia();
    positionRef.current = 0;
    for (const video of videos.current.values()) {
      if (video.readyState >= 1) video.currentTime = 0;
    }
    closeMenus();
  }, [modelKey, stopMedia, closeMenus, previousModelKey]);

  useEffect(() => {
    if (!active) {
      stopMedia();
      closeMenus();
    }
  }, [active, stopMedia, closeMenus]);

  useEffect(() => {
    const elements = videos.current;
    function onVisibilityChange() {
      if (document.hidden) pauseAll();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      playRequest.current += 1;
      playingRef.current = false;
      for (const video of elements.values()) video.pause();
    };
  }, [pauseAll]);

  useEffect(() => {
    if (!active) return;
    function onPointerDown(event: PointerEvent) {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.cs-menu')
      )
        closeMenus();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const openMenu = [...menus.current.values()].find((menu) => menu.open);
      if (!openMenu) return;
      closeMenus();
      openMenu.querySelector<HTMLElement>('summary')?.focus();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active, closeMenus]);

  async function togglePlayback() {
    if (playingRef.current) {
      pauseAll();
      return;
    }
    if (!playable || document.hidden) return;
    const elements = availableModels
      .map((model) => videos.current.get(model.id))
      .filter((video): video is HTMLVideoElement => Boolean(video));
    if (!elements.length) return;
    seekAll(positionRef.current >= duration - 0.05 ? 0 : positionRef.current);
    const request = ++playRequest.current;
    playingRef.current = true;
    setPlaying(true);
    const results = await Promise.allSettled(
      elements.map(async (video) => video.play()),
    );
    if (request !== playRequest.current) return;
    if (results.some((result) => result.status === 'rejected')) {
      pauseAll();
      onToast(
        t(
          'The sample could not play. Try Play again, or reload the clip from its preview.',
        ),
      );
    }
  }

  function updateTime(id: string, video: HTMLVideoElement) {
    if (!playingRef.current || id !== leaderId) return;
    const time = Math.min(video.currentTime, duration);
    positionRef.current = time;
    setPosition(time);
    for (const model of availableModels) {
      if (model.id === id) continue;
      const follower = videos.current.get(model.id);
      if (
        follower &&
        follower.readyState >= 2 &&
        !follower.seeking &&
        Math.abs(follower.currentTime - time) > 0.15
      ) {
        follower.currentTime = Math.min(time, follower.duration);
      }
    }
    if (time >= duration - 0.025) {
      pauseAll();
      positionRef.current = duration;
      setPosition(duration);
    }
  }

  function changeView(id: string, compare: boolean) {
    pauseAll();
    closeMenus();
    setFocusedId(id);
    setComparing(compare);
  }

  function toggleView() {
    pauseAll();
    closeMenus();
    setFocusedId(focusedModel.id);
    setComparing((current) => !current);
  }

  function mediaError(id: string) {
    pauseAll();
    setFailed((current) => ({ ...current, [id]: true }));
    onToast(
      t(
        'A sample clip could not load. Use Reload sample in its preview to try again.',
      ),
    );
  }

  function reloadSample(id: string) {
    pauseAll();
    const sample = sampleFor(id);
    setFailed((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([modelId]) => sampleFor(modelId) !== sample,
        ),
      ),
    );
    setDurations((current) => {
      const next = { ...current };
      for (const model of models)
        if (sampleFor(model.id) === sample) delete next[model.id];
      return next;
    });
    setSampleErrors((current) => ({ ...current, [sample]: false }));
    setSampleSources((current) => {
      const next = { ...current };
      delete next[sample];
      return next;
    });
    void loadSample(sample);
  }

  return (
    <section className="cs-page" hidden={!active} aria-labelledby={headingId}>
      <header className="cs-heading">
        <div className="cs-heading-copy">
          <h1 id={headingId}>{t('Studio')}</h1>
          <p>{t('Sample clips · Models not connected')}</p>
        </div>
        {models.length > 1 && (
          <button
            className="cs-view-toggle"
            type="button"
            aria-label={
              showingComparison
                ? t('Compare view. Focus on {name} sample', {
                    name: focusedModel.name,
                  })
                : t('Focus view. Compare all sample clips')
            }
            onClick={toggleView}
          >
            {showingComparison ? t('Compare') : t('Focus')}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className={`cs-stage${showingComparison ? '' : ' is-focused'}`}>
        <div className="cs-grid">
          {models.map((model) => {
            const sample = sampleFor(model.id);
            const source = `/media/studio-take-${sample}.mp4`;
            const poster = `/media/studio-take-${sample}.webp`;
            return (
              <article
                key={model.id}
                className="cs-tile"
                hidden={!showingComparison && model.id !== focusedModel.id}
                aria-label={t('{name} sample preview', { name: model.name })}
              >
                <div className="cs-media">
                  <video
                    ref={videoRefs[model.id]}
                    src={sampleSources[sample]}
                    poster={poster}
                    muted
                    playsInline
                    preload="metadata"
                    aria-label={t(
                      'Prepared sample clip {sample}; {name} is not connected',
                      { sample: sample.toUpperCase(), name: model.name },
                    )}
                    onLoadedMetadata={(event) => {
                      const video = event.currentTarget;
                      if (
                        !Number.isFinite(video.duration) ||
                        video.duration <= 0
                      )
                        return;
                      setDurations((current) => ({
                        ...current,
                        [model.id]: video.duration,
                      }));
                      setFailed((current) => ({
                        ...current,
                        [model.id]: false,
                      }));
                      video.currentTime = Math.min(
                        positionRef.current,
                        video.duration,
                      );
                      if (model.id === leaderId) setPosition(video.currentTime);
                    }}
                    onPause={(event) => {
                      if (!event.currentTarget.paused) return;
                      if (model.id === leaderId && playingRef.current)
                        pauseAll();
                      else if (!playingRef.current) setPlaying(false);
                    }}
                    onSeeked={(event) => {
                      if (!playingRef.current && model.id === leaderId)
                        setPosition(event.currentTarget.currentTime);
                    }}
                    onTimeUpdate={(event) =>
                      updateTime(model.id, event.currentTarget)
                    }
                    onEnded={() => {
                      if (model.id !== leaderId) return;
                      pauseAll();
                      positionRef.current = duration;
                      setPosition(duration);
                    }}
                    onError={() => {
                      if (sampleSources[sample]) mediaError(model.id);
                    }}
                  />
                  {!sampleSources[sample] && !sampleErrors[sample] && (
                    <span className="cs-media-loading">
                      {t('Loading sample…')}
                    </span>
                  )}
                  {(failed[model.id] || sampleErrors[sample]) && (
                    <div className="cs-media-error">
                      <span>{t('Sample clip unavailable')}</span>
                      <button
                        type="button"
                        onClick={() => reloadSample(model.id)}
                      >
                        {t('Reload sample')}
                      </button>
                    </div>
                  )}
                </div>
                <footer className="cs-caption">
                  <span className="cs-provider">
                    <StudioProvider model={model} />
                    <span>{model.name}</span>
                  </span>
                  <details
                    className="cs-menu"
                    ref={(element) => {
                      if (element) menus.current.set(model.id, element);
                      else menus.current.delete(model.id);
                    }}
                    onToggle={(event) => {
                      if (!event.currentTarget.open) return;
                      for (const [id, menu] of menus.current) {
                        if (id !== model.id) menu.open = false;
                      }
                    }}
                  >
                    <summary
                      data-icon-trigger
                      aria-label={t('Actions for {name} sample', {
                        name: model.name,
                      })}
                    >
                      <MotionIcon name="more" size={18} />
                    </summary>
                    <div className="cs-menu-content">
                      <button
                        type="button"
                        onClick={() => changeView(model.id, false)}
                      >
                        {t('Focus on this clip')}
                      </button>
                      {models.length > 1 && !showingComparison && (
                        <button
                          type="button"
                          onClick={() => changeView(model.id, true)}
                        >
                          {t('Return to compare')}
                        </button>
                      )}
                      <a
                        href={source}
                        download={`conclave-sample-${sample}.mp4`}
                        onClick={closeMenus}
                      >
                        {t('Download sample')}
                      </a>
                    </div>
                  </details>
                </footer>
              </article>
            );
          })}
        </div>

        <fieldset className="cs-transport">
          <legend className="cs-sr-only">{t('Sample playback')}</legend>
          <button
            className="cs-play"
            type="button"
            onClick={togglePlayback}
            disabled={!playable}
            aria-label={
              playing
                ? t('Pause sample clips')
                : currentTime >= duration - 0.05
                  ? t('Replay sample clips')
                  : t('Play sample clips')
            }
            title={
              pending
                ? t('Loading sample clips')
                : playing
                  ? t('Pause')
                  : t('Play')
            }
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
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <input
            className="cs-seek"
            type="range"
            min={0}
            max={duration}
            step={0.05}
            value={currentTime}
            disabled={!playable}
            aria-label={t('Seek sample clips')}
            aria-valuetext={t('{position} of {duration}', {
              position: formatTime(currentTime),
              duration: formatTime(duration),
            })}
            style={
              {
                '--cs-progress': `${(currentTime / duration) * 100}%`,
              } as CSSProperties
            }
            onChange={(event) => seekAll(Number(event.target.value))}
          />
          {showingComparison && (
            <span className="cs-linked" title={t('Linked sample playback')}>
              <Link2 size={22} strokeWidth={1.5} aria-hidden="true" />
              <span className="cs-sr-only">
                {t('Sample playback is linked')}
              </span>
            </span>
          )}
        </fieldset>
      </div>
    </section>
  );
}
