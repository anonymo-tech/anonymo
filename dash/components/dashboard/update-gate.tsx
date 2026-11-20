'use client';

// Shows an update's page only when that update is on (lib/anonymo/updates.ts); otherwise a short "not yet" notice.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { updateOn, type UpdateId } from '@/lib/anonymo/updates';

export function UpdateGate({ id, children }: { id: UpdateId; children: ReactNode }) {
  const { ready, demo } = useAnonymo();
  if (!ready) return null;
  if (updateOn(id, demo)) return <>{children}</>;
  return (
    <div className="notice row">
      <span style={{ flex: 1 }}>This isn’t switched on yet. It’s coming soon.</span>
      <Link className="btn btn-small" href="/dashboard">
        Back to the workspace
      </Link>
    </div>
  );
}
