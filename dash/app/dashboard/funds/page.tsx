import { FundsPanel } from '@/components/dashboard/funds-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Funds — Anonymo' };

export default function FundsPage() {
  return (
    <WorkspaceShell section="Funds" title="Funds" lede="Manage credit for this key. Withdrawals return to the wallet that supplied the funds.">
      <FundsPanel />
    </WorkspaceShell>
  );
}
