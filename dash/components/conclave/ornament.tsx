import Link from "@/components/site-link";
import type { ReactNode } from "react";
import { HorseMark } from "./horse-mark";
import { Wordmark } from "./wordmark";

export function Ornament({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`ornament ${className}`}
      viewBox="0 0 240 64"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="1.15">
        <path d="M4 33h57c23 0 34-5 45-14M236 33h-57c-23 0-34-5-45-14M12 38h45c21 0 40-3 51-14M228 38h-45c-21 0-40-3-51-14" />
        <path d="M109 31C83 1 62 5 68 21c5 13 22 6 14-3m27 17C84 18 92 48 77 48c-12 0-8-14 0-10M131 31c26-30 47-26 41-10-5 13-22 6-14-3m-27 17c25-17 17 13 32 13 12 0 8-14 0-10M113 30c-13-17-5-22-12-26 16 4 18 13 17 25m9 1c13-17 5-22 12-26-16 4-18 13-17 25" />
        <path
          d="M120 4c0 20-4 23-10 30 6 7 10 15 10 26 0-11 4-19 10-26-6-7-10-10-10-30Z"
          fill="currentColor"
        />
        <path d="M104 39c-3 10 4 17 10 11m22-11c3 10-4 17-10 11" />
      </g>
    </svg>
  );
}

export function Flourish({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`frame-flourish ${className}`}
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="1.05">
        <path d="M5 115V32C5 15 15 5 32 5h83M12 104V34c0-13 9-22 22-22h70M3 73c35 0 12-46 48-41 24 3 9 31-2 19-7-9 12-13 15-1m-39-36c-3 18 33 9 24 30M14 87c28-12 0-43 20-49M84 13c-12 28-43 0-49 20" />
        <path d="M22 72c21-4 27-22 17-25-11-3-9 13-2 11M71 22c-4 21-22 27-25 17-3-11 13-9 11-2M9 57c10-5 15-17 8-29 17 4 25 1 28-12M17 23c12 8 19 20 17 27M18 22c11 12 18 14 30 12" />
        <path
          d="M19 67c15-5 18-16 16-21-7 3-12 7-16 21Zm46-49c-5 15-16 18-21 16 3-7 7-12 21-16Z"
          fill="currentColor"
        />
        <path
          d="M7 7c9 0 11 2 15 5-3 4-5 6-5 15C9 22 6 17 7 7Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

export function OrnateFrame({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ornate-frame ${className}`}>
      <Flourish className="corner-tl" />
      <Flourish className="corner-tr" />
      <Flourish className="corner-bl" />
      <Flourish className="corner-br" />
      {children}
    </div>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/"
      className={`conclave-brand ${compact ? "brand-compact" : ""}`}
      aria-label="Conclave home"
    >
      <HorseMark className="brand-horse" />
      <Wordmark />
      <sup>®</sup>
    </Link>
  );
}
