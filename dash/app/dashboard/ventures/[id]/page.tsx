import { notFound } from 'next/navigation';
import { updateOn } from '@/lib/anonymo/updates';
import { VentureBoard } from '@/components/dashboard/venture-board';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = updateOn('ventures', false) ? { title: 'Crew board — Anonymo Ventures' } : {};

export default async function VentureBoardPage({ params }: { params: Promise<{ id: string }> }) {
  if (!updateOn('ventures', false)) notFound();
  const { id } = await params;
  return (
    <WorkspaceShell section="Ventures">
      <VentureBoard id={decodeURIComponent(id)} />
    </WorkspaceShell>
  );
}
