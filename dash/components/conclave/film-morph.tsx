'use client';

import { useT } from '@/lib/i18n';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  FILM_MORPH_STILL_TIME,
  seekFilmMorph,
  type FilmMorphFrame,
  type FilmPanel,
} from './film-morph-engine';
import './film-morph.css';

function Arrow({
  x,
  y,
  paper = false,
}: {
  x: number;
  y: number;
  paper?: boolean;
}) {
  return (
    <path
      className={paper ? 'fm-paper-stroke' : 'fm-stroke'}
      d={`M${x} ${y + 5}h10m-4-4 4 4-4 4`}
    />
  );
}

function Check({
  x,
  y,
  paper = false,
}: {
  x: number;
  y: number;
  paper?: boolean;
}) {
  return (
    <path
      className={paper ? 'fm-paper-stroke' : 'fm-stroke'}
      d={`m${x} ${y + 4} 3.5 3.5 7-8`}
    />
  );
}

function Content({
  id,
  frame,
  prefix,
  children,
}: {
  id: FilmPanel;
  frame: FilmMorphFrame;
  prefix: string;
  children: ReactNode;
}) {
  const pose = frame.panels.find((panel) => panel.id === id)!;
  return (
    <g
      data-film-panel={id}
      opacity={pose.opacity}
      visibility={pose.opacity > 0 ? 'visible' : 'hidden'}
      transform={`translate(0 ${pose.y})`}
      filter={`url(#${prefix}-${id}-blur)`}
    >
      {children}
    </g>
  );
}

function FilmScene({
  frame,
  prefix,
}: {
  frame: FilmMorphFrame;
  prefix: string;
}) {
  const t = useT();
  const { compact, width, shape } = frame;
  const margin = compact ? 14 : 21;
  const headingY = compact ? 28 : 35;
  const maxWidth = width - 2;
  const tabWidth = (maxWidth - margin * 2) / 4;
  const tabsY = compact ? 43 : 64;
  const tabsHeight = compact ? 55 : 78;
  const rowFirst = compact ? 55 : 82;
  const rowGap = compact ? 25 : 43;
  const dragY =
    (compact ? 49 : 64) +
    ((compact ? 86 : 128) - (compact ? 49 : 64)) * frame.drag;
  const dragX = margin + 4 * frame.drag;
  const dissentWidth = maxWidth * 0.97;
  const directionWidth = maxWidth * 0.95;
  const briefX = maxWidth * 0.52;
  const briefY = compact ? 48 : 69;
  const briefWidth = directionWidth - briefX - margin;
  const briefHeight = compact ? 70 : 105;
  const targetY = briefY + briefHeight / 2;
  const branchPose = frame.panels.find((panel) => panel.id === 'direction')!;

  return (
    <svg
      viewBox={`0 0 ${width} ${frame.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={`${prefix}-surface`}>
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={shape.radius}
          />
        </clipPath>
        <clipPath id={`${prefix}-active-tab`}>
          <rect
            x={frame.tabs.left}
            y={tabsY}
            width={Math.max(1, frame.tabs.right - frame.tabs.left)}
            height={tabsHeight}
            rx={compact ? 8 : 11}
          />
        </clipPath>
        {frame.panels.map((panel) => (
          <filter
            key={panel.id}
            id={`${prefix}-${panel.id}-blur`}
            x="-10%"
            y="-15%"
            width="120%"
            height="130%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation={panel.blur} />
          </filter>
        ))}
      </defs>

      <rect
        data-film-surface
        x={shape.x}
        y={shape.y}
        width={shape.width}
        height={shape.height}
        rx={shape.radius}
        className="fm-surface"
      />

      <g clipPath={`url(#${prefix}-surface)`}>
        <Content id="question" frame={frame} prefix={prefix}>
          <text x={margin} y={headingY} className="fm-heading">
            {t("What are we missing?")}
          </text>
          <text x={margin} y={compact ? 52 : 62} className="fm-secondary">
            {t("Bring another point of view.")}
          </text>
          <circle
            cx={maxWidth * 0.94 - 26}
            cy={compact ? 51 : 49}
            r={compact ? 12 : 16}
            className="fm-ink"
          />
          <Arrow x={maxWidth * 0.94 - 31} y={compact ? 46 : 44} paper />
        </Content>

        <Content id="perspectives" frame={frame} prefix={prefix}>
          <text x={margin} y={headingY} className="fm-heading">
            {t("Four perspectives.")}
          </text>
          <rect
            x={margin - 2}
            y={tabsY - 3}
            width={maxWidth - margin * 2 + 4}
            height={tabsHeight + 6}
            rx={compact ? 10 : 13}
            className="fm-inset"
          />
          <rect
            x={frame.tabs.left}
            y={tabsY}
            width={Math.max(1, frame.tabs.right - frame.tabs.left)}
            height={tabsHeight}
            rx={compact ? 8 : 11}
            className="fm-ink"
          />
          {['Look', 'Ask', 'Link', 'Test'].map((label, i) => (
            <text
              key={label}
              x={margin + tabWidth * (i + 0.5)}
              y={compact ? 89 : 126}
              textAnchor="middle"
              className="fm-label"
            >
              {t(label)}
            </text>
          ))}
          <g clipPath={`url(#${prefix}-active-tab)`}>
            {['Look', 'Ask', 'Link', 'Test'].map((label, i) => (
              <text
                key={label}
                x={margin + tabWidth * (i + 0.5)}
                y={compact ? 89 : 126}
                textAnchor="middle"
                className="fm-label fm-paper"
              >
                {t(label)}
              </text>
            ))}
          </g>
          <text x={margin} y={compact ? 120 : 179} className="fm-secondary">
            {t("One question. Four angles.")}
          </text>
          {!compact && (
            <path
              d={`M${margin} 190h${maxWidth - margin * 2}`}
              className="fm-rule"
            />
          )}
        </Content>

        <Content id="compare" frame={frame} prefix={prefix}>
          <text x={margin} y={headingY} className="fm-heading">
            {t("A pattern emerges.")}
          </text>
          {['Wider view', 'Open question', 'Useful link', 'Different take'].map(
            (label, i) => {
              const y = rowFirst + rowGap * i;
              const lineX = compact ? maxWidth - 75 : maxWidth - 119;
              const lineWidth = compact ? 34 : 70;
              return (
                <g key={label}>
                  <rect
                    x={margin - 4}
                    y={y - (compact ? 12 : 18)}
                    width={maxWidth - margin * 2 + 8}
                    height={compact ? 24 : 37}
                    rx={compact ? 6 : 8}
                    className={i === 3 ? 'fm-red-inset' : 'fm-inset'}
                    opacity={0.45 + frame.rows[i] * 0.55}
                  />
                  <text x={compact ? 42 : 54} y={y + 4} className="fm-label">
                    {t(label)}
                  </text>
                  <path
                    d={`M${lineX} ${y}h${lineWidth}`}
                    className="fm-track"
                  />
                  <path
                    d={`M${lineX} ${y}h${lineWidth * [0.84, 0.66, 0.84, 0.45][i] * frame.rows[i]}`}
                    className={
                      i === 3 ? 'fm-red-line fm-bar' : 'fm-stroke fm-bar'
                    }
                  />
                  <g opacity={frame.rows[i]}>
                    {i === 3 ? (
                      <path
                        d={`M${maxWidth - 24} ${y - 5}v7m0 3v.5`}
                        className="fm-red-line"
                      />
                    ) : (
                      <Check x={maxWidth - 30} y={y - 5} />
                    )}
                  </g>
                </g>
              );
            },
          )}
          {!compact && (
            <text x={margin} y="235" className="fm-secondary">
              {t("Agreement is only half the picture.")}
            </text>
          )}
        </Content>

        <Content id="dissent" frame={frame} prefix={prefix}>
          <text x={margin} y={headingY} className="fm-heading">
            {t("Keep the difference.")}
          </text>
          <rect
            x={margin}
            y={compact ? 83 : 122}
            width={dissentWidth - margin * 2}
            height={compact ? 38 : 43}
            rx="9"
            className="fm-keep-slot"
          />
          <text
            x={dissentWidth / 2}
            y={compact ? 106 : 148}
            textAnchor="middle"
            className="fm-secondary"
            opacity={1 - frame.kept}
          >
            {t("Keep this view")}
          </text>
          <g>
            <rect
              x={dragX}
              y={dragY}
              width={dissentWidth - margin * 2 - 8 * frame.drag}
              height={compact ? 30 : 38}
              rx="8"
              className="fm-dissent-card"
            />
            <text
              x={dragX + (compact ? 29 : 36)}
              y={dragY + (compact ? 20 : 24)}
              className="fm-label"
            >
              {compact ? t('Another angle.') : t('An angle worth keeping.')}
            </text>
            <g opacity={frame.kept}>
              <Check
                x={dissentWidth - margin - 22}
                y={dragY + (compact ? 10 : 15)}
              />
            </g>
          </g>
          <text x={margin} y={compact ? 134 : 184} className="fm-secondary">
            {t("A place for dissent.")}
          </text>
        </Content>

        <Content id="direction" frame={frame} prefix={prefix}>
          <text x={margin} y={headingY} className="fm-heading">
            {t("Shared direction.")}
          </text>
          {frame.nodes.map((node, i) => (
            <path
              key={i}
              d={`M${node.x + node.radius + 3} ${node.y} C${briefX - 52} ${node.y},${briefX - 40} ${targetY},${briefX - 13} ${targetY}`}
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={1 - frame.branches[i]}
              className={i === 3 ? 'fm-red-line' : 'fm-branch'}
            />
          ))}
          <path
            d={`M${briefX - 15} ${targetY}h15m-5-4 5 4-5 4`}
            className="fm-stroke"
            opacity={Math.min(...frame.branches)}
          />
          <rect
            x={briefX}
            y={briefY}
            width={briefWidth}
            height={briefHeight}
            rx={compact ? 8 : 11}
            className="fm-ink"
          />
          <path
            d={`M${briefX + 15} ${briefY + 14}h13l5 5v17h-18zM${briefX + 28} ${briefY + 14}v6h5`}
            className="fm-paper-stroke"
          />
          <text
            x={briefX + 15}
            y={briefY + (compact ? 54 : 63)}
            className="fm-heading fm-paper"
          >
            {t("Brief")}
          </text>
          {!compact && (
            <path
              d={`M${briefX + 16} ${briefY + 78}h${briefWidth - 33}`}
              className="fm-paper-rule"
            />
          )}
          <g opacity={frame.brief}>
            <Check x={briefX + briefWidth - 26} y={briefY + 17} paper />
          </g>
          <text
            x={margin}
            y={compact ? 135 : 219}
            className="fm-secondary fm-final-copy"
          >
            {t("Many minds. Your next move.")}
          </text>
        </Content>

        {/* Four shared nodes travel from tabs to rows to a retained dissent to a Brief. */}
        {frame.nodes.map((node, i) => (
          <g
            key={i}
            data-film-node={i}
            transform={`translate(${node.x} ${node.y})`}
            opacity={node.opacity}
          >
            <circle
              r={node.radius}
              className={i === 3 ? 'fm-node-red' : 'fm-node'}
            />
            <text
              y={compact ? 4 : 4.5}
              textAnchor="middle"
              className="fm-node-letter"
            >
              {['A', 'B', 'C', 'D'][i]}
            </text>
          </g>
        ))}
        {!compact && (
          <path
            d={`M${margin} 51h${Math.max(0, shape.width - margin * 2)}`}
            className="fm-rule"
            opacity={branchPose.opacity}
          />
        )}
      </g>

      <g
        data-film-cursor
        transform={`translate(${frame.cursor.x} ${frame.cursor.y})`}
        opacity={frame.cursor.opacity}
      >
        <circle
          r={frame.cursor.ring}
          opacity={frame.cursor.ringOpacity}
          className="fm-cursor-ring"
        />
        <path
          transform={`scale(${frame.cursor.scale * (compact ? 0.88 : 1)})`}
          d="M0 0v20l5.2-5 4.2 8 4-2-4.3-8 7.3-.5Z"
          className="fm-cursor"
        />
      </g>
    </svg>
  );
}

/** A decorative, seekable UI study synchronized to the source film. */
export function FilmMorph({
  videoRef,
  paused = false,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  paused?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  const synchronizeRef = useRef<(() => void) | null>(null);
  const [frame, setFrame] = useState(() => seekFilmMorph(0));
  const prefix = `film-morph-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  useEffect(() => {
    pausedRef.current = paused;
    synchronizeRef.current?.();
  }, [paused]);

  useEffect(() => {
    const element = rootRef.current;
    const media = videoRef.current;
    if (!element || !media) return;
    const root = element;
    const video = media;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = root.clientWidth || 410;
    let visible = false;
    let disposed = false;
    let request: number | null = null;

    const stop = () => {
      if (request !== null) window.cancelAnimationFrame(request);
      request = null;
    };
    const paint = () => {
      if (disposed) return;
      setFrame(
        seekFilmMorph(
          reducedMotion.matches ? FILM_MORPH_STILL_TIME : video.currentTime,
          width,
        ),
      );
    };
    const canRun = () =>
      visible &&
      !document.hidden &&
      !pausedRef.current &&
      !reducedMotion.matches &&
      !video.paused &&
      !video.ended &&
      !video.error &&
      !disposed;
    const tick = () => {
      request = null;
      if (!canRun()) return;
      paint();
      request = window.requestAnimationFrame(tick);
    };
    const synchronize = () => {
      stop();
      if (visible && !document.hidden) paint();
      if (canRun()) request = window.requestAnimationFrame(tick);
    };
    const resize = () => {
      width = root.clientWidth || width;
      synchronize();
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        synchronize();
      },
      { threshold: 0 },
    );
    const sizeObserver = new ResizeObserver(resize);
    observer.observe(root);
    sizeObserver.observe(root);
    synchronizeRef.current = synchronize;
    const events = [
      'loadeddata',
      'playing',
      'pause',
      'seeked',
      'seeking',
      'ended',
      'emptied',
      'error',
    ] as const;
    events.forEach((event) => video.addEventListener(event, synchronize));
    // timeupdate catches explicit seeks/paused updates; rAF owns playing frames.
    const timeUpdate = () => {
      if (!canRun()) synchronize();
    };
    video.addEventListener('timeupdate', timeUpdate);
    document.addEventListener('visibilitychange', synchronize);
    reducedMotion.addEventListener('change', synchronize);
    return () => {
      disposed = true;
      stop();
      synchronizeRef.current = null;
      observer.disconnect();
      sizeObserver.disconnect();
      events.forEach((event) => video.removeEventListener(event, synchronize));
      video.removeEventListener('timeupdate', timeUpdate);
      document.removeEventListener('visibilitychange', synchronize);
      reducedMotion.removeEventListener('change', synchronize);
    };
  }, [videoRef]);

  return (
    <div
      ref={rootRef}
      className={`film-morph ${frame.compact ? 'film-morph-compact' : ''}`}
      data-film-morph-state={frame.state}
      data-film-morph-phase={frame.phase}
      aria-hidden="true"
    >
      <FilmScene frame={frame} prefix={prefix} />
    </div>
  );
}
