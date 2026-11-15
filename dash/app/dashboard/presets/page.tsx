import { WorkspaceShell } from '@/components/dashboard/workspace-shell';
import { PresetsView } from '@/components/presets-view';

export const metadata = { title: 'Presets — Anonymo' };

export default function DashboardPresetsPage() {
  return (
    <WorkspaceShell section="Frontend presets" title="Frontend presets" lede="One-paste setups for the frontends you already use.">
      <PresetsView />
    </WorkspaceShell>
  );
}
