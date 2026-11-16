import type { ReactNode } from 'react';

// The workspace is per-device and holds nothing worth indexing, so search engines are asked to skip it.
export const metadata = { robots: { index: false, follow: false } };

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return children;
}
