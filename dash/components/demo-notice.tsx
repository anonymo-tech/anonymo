'use client';

import { useAnonymo } from './anonymo-provider';

/** Says plainly when the page shows demo fixtures from the in-browser mock gateway. */
export function DemoNotice({ inline = false }: { inline?: boolean }) {
  const { ready, demo } = useAnonymo();
  if (!ready || !demo) return null;
  return (
    <p className={inline ? 'demo-notice demo-notice-inline' : 'demo-notice'} role="note">
      <strong>Demo mode.</strong> Data comes from a mock gateway in your browser: no model runs, no money moves.
    </p>
  );
}
