import './funds.css';
import { FundsPanel } from '@/components/dashboard/funds-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Funds — Anonymo' };

export default function FundsPage() {
  return (
    <WorkspaceShell section="Funds">
      <FundsPanel />
    </WorkspaceShell>
  );
}
