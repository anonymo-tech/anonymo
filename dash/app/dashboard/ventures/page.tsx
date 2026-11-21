import { notFound } from 'next/navigation';
import { updateOn } from '@/lib/anonymo/updates';
import { VenturesLauncher } from '@/components/dashboard/ventures';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = updateOn('ventures', false) ? { title: 'Ventures — Anonymo' } : {};

export default function VenturesPage() {
  if (!updateOn('ventures', false)) notFound();
  return (
    <WorkspaceShell section="Ventures">
      <VenturesLauncher />
    </WorkspaceShell>
  );
}
