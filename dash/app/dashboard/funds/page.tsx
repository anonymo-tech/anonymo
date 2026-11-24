import './funds.css';
import { FundsPanel } from '@/components/dashboard/funds-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Balance — Anonymo' };

export default function FundsPage() {
  return (
    <WorkspaceShell section="Balance">
      <FundsPanel />
    </WorkspaceShell>
  );
}
