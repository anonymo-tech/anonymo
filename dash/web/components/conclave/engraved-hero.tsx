"use client";

import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import "./engraved-hero.css";

const EngravedSurface = lazy(() => import("./engraved-hero-surface"));

class ShaderFallbackBoundary extends Component<
  { children: ReactNode; onUnavailable: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onUnavailable();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Keep the poster in the server render; GPU work only exists in a visible hero. */
export function EngravedHero({ paused = false }: { paused?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setReduced(preference.matches);
    const syncVisibility = () => setDocumentVisible(!document.hidden);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(element);
    preference.addEventListener("change", syncPreference);
    document.addEventListener("visibilitychange", syncVisibility);
    syncPreference();
    syncVisibility();
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", syncPreference);
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

  const active = visible && documentVisible && !paused && !reduced && !unavailable;
  return (
    <div
      ref={host}
      className="engraved-hero"
      aria-hidden="true"
      data-hero-renderer={unavailable ? "fallback" : active ? "active" : "still"}
    >
      <Image className="engraved-hero-poster" src="/media/conclave-hero-poster.jpg" alt="" fill priority unoptimized />
      {active && (
        <ShaderFallbackBoundary onUnavailable={() => setUnavailable(true)}>
          <Suspense fallback={null}>
            <EngravedSurface onUnavailable={() => setUnavailable(true)} />
          </Suspense>
        </ShaderFallbackBoundary>
      )}
      <div className="engraved-hero-shade" />
    </div>
  );
}
