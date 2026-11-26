import { redirect } from 'next/navigation';

// The workspace opens on Chat. Old links to /dashboard keep their query (demo mode, offer codes) on the way.
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, one);
  }
  const rest = query.toString();
  redirect(`/dashboard/chat${rest ? `?${rest}` : ''}`);
}
