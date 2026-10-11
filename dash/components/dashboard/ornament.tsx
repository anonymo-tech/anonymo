export function Flourish({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`dw-flourish ${className}`}
      viewBox="0 0 140 80"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 72C5 34 23 4 70 8c25 2 35 18 24 28-14 14-38-1-26-11 8-7 14 5 5 7M5 72c7-37 35-57 63-51M5 72c20-28 43-36 65-29 19 7 14 23 1 19-7-3-4-10 1-8M11 57C0 25 11 0 24 5c15 5 1 24-3 14M23 42C21 11 53-3 61 5M20 51c27 6 32 28 19 26-10-1-6-12-2-10M44 30c5-11 18-18 25-13"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M5 72c13-15 20-28 24-44-2 24-7 33-24 44Zm17-30C9 27 15 8 24 5c-5 11-4 19-2 37Zm19-12C40 11 49 3 61 5c-9 6-15 13-20 25Z"
        fill="currentColor"
      />
      <path
        d="M33 39c17-2 28 5 34 12-15-7-22-8-34-12ZM9 69c12-2 20 0 29 7-11-3-18-3-29-7Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Corners() {
  return (
    <div className="dw-corners" aria-hidden="true">
      <Flourish />
      <Flourish />
      <Flourish />
      <Flourish />
    </div>
  );
}

export function Seal({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={`dw-seal ${small ? "is-small" : ""}`}
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="60" cy="60" r="51" stroke="currentColor" strokeWidth=".8" />
      <circle
        cx="60"
        cy="60"
        r="44"
        stroke="currentColor"
        strokeDasharray="1 5"
      />
      <path
        d="M60 13 67 43 90 30 77 53 107 60 77 67 90 90 67 77 60 107 53 77 30 90 43 67 13 60 43 53 30 30 53 43Z"
        stroke="currentColor"
      />
      <path
        d="m60 35 5 20 20 5-20 5-5 20-5-20-20-5 20-5Z"
        fill="currentColor"
      />
    </svg>
  );
}
