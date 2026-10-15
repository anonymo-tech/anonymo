'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Minus,
  Pause,
  Play,
  Plus,
} from 'lucide-react';
import { Ornament, OrnateFrame } from './ornament';
import {
  roadmapChapters,
  secondLookFeatures,
  type RoadmapTrack,
} from './publication-data';

export function PublicationMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPaused(media.matches);
    update();
    media.addEventListener('change', update);
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in-view');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.06 },
    );
    root.current
      ?.querySelectorAll('[data-pub-reveal]')
      .forEach((item) => observer.observe(item));
    root.current?.setAttribute('data-motion-ready', 'true');
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, []);
  return (
    <div
      ref={root}
      className={`publication${paused ? ' publication--still' : ''}`}
    >
      {children}
      <button
        className="pub-motion"
        onClick={() => setPaused(!paused)}
        aria-label={paused ? 'Play page animations' : 'Pause page animations'}
        title={paused ? 'Play animations' : 'Pause animations'}
      >
        {paused ? <Play size={14} /> : <Pause size={14} />}
      </button>
    </div>
  );
}

export function SecondLookExplorer() {
  const [selected, setSelected] = useState(0);
  const feature = secondLookFeatures[selected];
  return (
    <div className="pub-explorer">
      <div
        className="pub-feature-menu"
        role="group"
        aria-label="Explore Second Look tools"
      >
        {secondLookFeatures.map((item, index) => (
          <button
            key={item.id}
            aria-pressed={selected === index}
            aria-controls="second-look-detail"
            onClick={() => setSelected(index)}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            {item.name}
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
      <OrnateFrame className="pub-feature-stage">
        <div
          id="second-look-detail"
          className="pub-feature-detail"
          key={feature.id}
          role="region"
          aria-label={feature.name}
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="pub-feature-meta">
            <span className="pub-micro">{feature.phase}</span>
            <span className="pub-status">Product direction</span>
          </div>
          <div className="pub-feature-title">
            <h3>{feature.line}</h3>
            <img
              src={`/brand/icons/conclave-${feature.icon}-halftone-v1.png`}
              alt=""
              width="120"
              height="120"
              loading="lazy"
            />
          </div>
          <p>{feature.description}</p>
          <ul>
            {feature.checks.map((check, index) => (
              <li key={check}>
                <span className="pub-check-number">0{index + 1}</span>
                {check}
                <Check size={16} />
              </li>
            ))}
          </ul>
          <p className="pub-feature-note">{feature.note}</p>
        </div>
      </OrnateFrame>
    </div>
  );
}

export function RoadmapExplorer() {
  const [track, setTrack] = useState<RoadmapTrack | 'All'>('All');
  useEffect(() => {
    let frame = 0;
    const revealLinkedChapter = () => {
      const id = window.location.hash.slice(1);
      if (!roadmapChapters.some((chapter) => chapter.id === id)) return;
      setTrack('All');
      frame = window.requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView({ block: 'start' }),
      );
    };
    window.addEventListener('hashchange', revealLinkedChapter);
    return () => {
      window.removeEventListener('hashchange', revealLinkedChapter);
      window.cancelAnimationFrame(frame);
    };
  }, []);
  const tracks = ['All', 'Workspace', 'Second Look', 'Access'] as const;
  const count = roadmapChapters.filter(
    (chapter) => track === 'All' || chapter.track === track,
  ).length;
  return (
    <div className="pub-roadmap-explorer">
      <div className="pub-filter-bar">
        <div
          className="pub-filters"
          role="group"
          aria-label="Filter roadmap by product track"
        >
          {tracks.map((item) => (
            <button
              key={item}
              onClick={() => setTrack(item)}
              aria-pressed={track === item}
            >
              {item === 'All' ? 'The full picture' : item}
            </button>
          ))}
        </div>
        <span className="pub-micro" role="status">
          {String(count).padStart(2, '0')} CHAPTERS
        </span>
      </div>
      <div className="pub-roadmap-list">
        {roadmapChapters.map((chapter) => (
          <section
            key={chapter.id}
            id={chapter.id}
            className={`pub-roadmap-chapter pub-track-${chapter.track.toLowerCase().replace(' ', '-')}`}
            hidden={track !== 'All' && chapter.track !== track}
          >
            <div className="pub-chapter-rail">
              <span>{chapter.number}</span>
              <i />
            </div>
            <div className="pub-chapter-main">
              <div className="pub-chapter-meta">
                <span className="pub-micro">{chapter.label}</span>
                <span
                  className={`pub-status${chapter.status === 'In development' ? ' pub-status--building' : ''}`}
                >
                  {chapter.status}
                </span>
              </div>
              <div className="pub-chapter-heading">
                <div>
                  <h3>{chapter.title}</h3>
                  <p>{chapter.line}</p>
                </div>
                <img
                  src={`/brand/icons/conclave-${chapter.icon}-halftone-v1.png`}
                  alt=""
                  width="112"
                  height="112"
                  loading="lazy"
                />
              </div>
              <div className="pub-feature-list">
                {chapter.features.map((feature) => (
                  <details key={feature.name}>
                    <summary>
                      <span>{feature.name}</span>
                      <Plus className="pub-plus" size={17} />
                      <Minus className="pub-minus" size={17} />
                    </summary>
                    <p>{feature.description}</p>
                  </details>
                ))}
              </div>
              <div className="pub-milestone">
                <span className="pub-micro">THE NEXT MILESTONE</span>
                <p>{chapter.milestone}</p>
              </div>
            </div>
          </section>
        ))}
      </div>
      <div className="pub-roadmap-end">
        <Ornament />
        <span className="pub-micro">MANY CHAPTERS. ONE CONCLAVE.</span>
        <a href="#top" aria-label="Back to the top of the roadmap">
          <ArrowDown size={18} />
        </a>
      </div>
    </div>
  );
}
