import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';
import { ConnectView } from '@/components/dashboard/connect';

export const metadata = { title: 'Pair my coding tool — Anonymo' };

// Update 05: More → Pair a coding tool, behind the `connect` update switch.
export default function DashboardConnectPage() {
  return (
    <WorkspaceShell section="MCP" title="Pair my coding tool" lede="Use Anonymo inside Cursor or Claude Code. Your key stays on your computer.">
      <UpdateGate id="connect">
        <ConnectView />
      </UpdateGate>
    </WorkspaceShell>
  );
}
