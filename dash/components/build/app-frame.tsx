'use client';

// Update "build": the frame a built app runs in. The app gets an opaque origin (no allow-same-origin), so it cannot read
// this site's storage, the key or cookies; its policy blocks the network; and if it ever navigates the frame away from
// the document it was given (a link, a redirect), the frame is emptied and the person is told why.

import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { BUILD_SANDBOX, sandboxed } from '@/lib/anonymo/build';

export type AppFrameHandle = { restart: () => void; fullscreen: () => void; focus: () => void };

export const AppFrame = forwardRef<AppFrameHandle, { html: string; title: string; className?: string }>(function AppFrame(
  { html, title, className = '' },
  ref,
) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [run, setRun] = useState(0);
  const doc = useMemo(() => sandboxed(html), [html]);
  // Loads counted per document and run, so a new app or a restart starts fresh.
  const loads = useRef<{ doc: string; run: number; n: number }>({ doc: '', run: -1, n: 0 });
  const [stoppedAt, setStoppedAt] = useState<{ doc: string; run: number } | null>(null);
  const stopped = stoppedAt?.doc === doc && stoppedAt.run === run;

  useImperativeHandle(ref, () => ({
    restart: () => setRun((n) => n + 1),
    fullscreen: () => void frame.current?.requestFullscreen?.().catch(() => {}),
    focus: () => frame.current?.focus(),
  }));

  return (
    <div className={`app-frame ${className}`}>
      {stopped ? (
        <output className="app-frame-stopped">
          <p>This app tried to open another page, so it was stopped.</p>
          <button type="button" className="btn btn-small" onClick={() => setRun((n) => n + 1)}>Run it again</button>
        </output>
      ) : (
        <iframe
          key={run}
          ref={frame}
          title={title}
          srcDoc={doc}
          sandbox={BUILD_SANDBOX}
          allow="fullscreen; gamepad; autoplay"
          referrerPolicy="no-referrer"
          onLoad={() => {
            if (loads.current.doc !== doc || loads.current.run !== run) loads.current = { doc, run, n: 0 };
            loads.current.n += 1;
            // The first load is the app itself. Any later one means it navigated away from what it was given.
            if (loads.current.n > 1) setStoppedAt({ doc, run });
            else frame.current?.focus();
          }}
        />
      )}
    </div>
  );
});
