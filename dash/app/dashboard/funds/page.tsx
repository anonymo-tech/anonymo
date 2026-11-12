import { FundsPanel } from '@/components/dashboard/funds-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Balance & deposits — Anonymo' };

export default function FundsPage() {
  return (
    <WorkspaceShell section="Balance & deposits">
      <FundsPanel />
    </WorkspaceShell>
  );
}
