"use client";

import Image from "next/image";
import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./about-film.css";

export function AboutFilm({ still = false }: { still?: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const film = useRef<HTMLVideoElement>(null);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [inView, setInView] = useState(false);
  const [tabVisible, setTabVisible] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const motionDisabled = still || reducedMotion;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(media.matches);
    const updateVisibility = () => setTabVisible(!document.hidden);
    const frame = window.requestAnimationFrame(() => {
      updateMotion();
      updateVisibility();
    });
    const observer = new IntersectionObserver(
      ([entry]) =>
        setInView(entry.isIntersecting && entry.intersectionRatio >= 0.15),
      { threshold: [0, 0.15, 0.5] },
    );
    if (stage.current) observer.observe(stage.current);
    media.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      media.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  useEffect(() => {
    const video = film.current;
    if (!video) return;
    let cancelled = false;
    if (!motionDisabled && inView && tabVisible && !userPaused && !failed) {
      void video.play().catch(() => {
        if (!cancelled) setBlocked(true);
      });
    } else {
      video.pause();
    }
    return () => {
      cancelled = true;
      video.pause();
    };
  }, [motionDisabled, inView, tabVisible, userPaused, failed]);

  function playFromControl(replay = false) {
    const video = film.current;
    if (!video || motionDisabled || !inView || document.hidden) return;
    setBlocked(false);
    setUserPaused(false);
    if (failed) {
      setFailed(false);
      video.load();
    }
    if (replay) {
      video.currentTime = 0;
      setProgress(0);
    }
    void video.play().catch(() => setBlocked(true));
  }

  function togglePlayback() {
    if (playing) {
      setUserPaused(true);
      film.current?.pause();
    } else {
      playFromControl();
    }
  }

  const playbackStatus = motionDisabled
    ? "The poster is shown because site motion is paused or reduced motion is enabled."
    : failed
      ? "The film is unavailable. Use replay to retry."
      : blocked
        ? "Your browser paused automatic playback. Press play to watch the film."
        : playing
          ? "The film is playing silently."
          : "The film is paused.";

  return (
    <section
      className="cl-about-section"
      id="manifesto"
      aria-labelledby="cl-about-title"
    >
      <div className="cl-about-surface">
        <div className="cl-about-heading">
          <h2 id="cl-about-title">Good thinking has good company.</h2>
          <p>
            Conclave is a multi-model AI workspace. Bring different perspectives
            into one room, compare what they see, and understand where your
            information goes. The final word is yours.
          </p>
        </div>

        <div
          ref={stage}
          className={`cl-about-stage ${motionDisabled || failed ? "cl-about-show-poster" : ""}`}
        >
          <video
            ref={film}
            className="cl-about-video"
            src="/media/conclave-about-film.webm?v=white-accents"
            poster="/media/conclave-about-poster.png?v=white-accents"
            aria-label="Conclave about film"
            aria-describedby="cl-about-film-description"
            muted
            loop
            playsInline
            preload="metadata"
            tabIndex={-1}
            onPlaying={() => {
              setPlaying(true);
              setBlocked(false);
            }}
            onPause={() => setPlaying(false)}
            onError={() => {
              setFailed(true);
              setPlaying(false);
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              setProgress(
                Number.isFinite(video.duration) && video.duration > 0
                  ? Math.min(1, Math.max(0, video.currentTime / video.duration))
                  : 0,
              );
            }}
          />
          <Image
            className="cl-about-poster"
            src="/media/conclave-about-poster.png?v=white-accents"
            alt=""
            aria-hidden="true"
            unoptimized
            fill
            sizes="(max-width: 600px) calc(100vw - 64px), (max-width: 1600px) 88vw, 1400px"
          />
          <div className="cl-about-progress" aria-hidden="true">
            <span
              style={{ transform: `scaleX(${motionDisabled ? 0 : progress})` }}
            />
          </div>
        </div>

        <div className="cl-about-controls">
          <span className="cl-about-control-rule" aria-hidden="true" />
          {failed && (
            <p className="cl-about-error">Film unavailable. Replay to retry.</p>
          )}
          <div className="cl-about-buttons">
            <button
              type="button"
              onClick={togglePlayback}
              disabled={motionDisabled}
              aria-label={
                playing
                  ? "Pause Conclave about film"
                  : "Play Conclave about film"
              }
              aria-describedby="cl-about-playback-status"
              title={
                motionDisabled
                  ? "Motion is paused"
                  : playing
                    ? "Pause film"
                    : "Play film"
              }
            >
              {playing ? (
                <Pause size={22} strokeWidth={1.6} />
              ) : (
                <Play size={22} strokeWidth={1.6} />
              )}
            </button>
            <button
              type="button"
              onClick={() => playFromControl(true)}
              disabled={motionDisabled}
              aria-label="Replay Conclave about film"
              aria-describedby="cl-about-playback-status"
              title={motionDisabled ? "Motion is paused" : "Replay film"}
            >
              <RotateCcw size={22} strokeWidth={1.6} />
            </button>
          </div>
        </div>
        <p className="cl-about-sr-only" id="cl-about-film-description">
          A silent, fifteen-second visual introduction to Conclave: a workspace
          for comparing model perspectives and inspecting how information is
          routed.
        </p>
        <output
          className="cl-about-sr-only"
          id="cl-about-playback-status"
          aria-live="polite"
        >
          {playbackStatus}
        </output>
      </div>
    </section>
  );
}
