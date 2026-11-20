import { UpdateGate } from '@/components/dashboard/update-gate';
import { UsagePanel } from '@/components/dashboard/usage-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Usage — Anonymo' };

export default function UsagePage() {
  return (
    <WorkspaceShell section="Usage" title="Usage & limits" lede="What this key spent, how long the balance lasts, and where it stops.">
      <UpdateGate id="usage">
        <UsagePanel />
      </UpdateGate>
    </WorkspaceShell>
  );
}
