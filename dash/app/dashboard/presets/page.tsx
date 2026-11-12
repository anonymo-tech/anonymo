import { WorkspaceShell } from '@/components/dashboard/workspace-shell';
import { PresetsView } from '@/components/presets-view';

export const metadata = { title: 'Presets — Anonymo' };

export default function DashboardPresetsPage() {
  return (
    <WorkspaceShell section="Presets">
      <PresetsView />
    </WorkspaceShell>
  );
}
