import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { BUILT_WITH } from '@/lib/anonymo/updates';

// The workspace is per-device and holds nothing worth indexing, so search engines are asked to skip it.
export const metadata = { robots: { index: false, follow: false } };
export const viewport: Viewport | undefined = BUILT_WITH.has('app') ? { viewportFit: 'cover' } : undefined;

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return children;
}
