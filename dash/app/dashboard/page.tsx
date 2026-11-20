import { Overview } from '@/components/dashboard/overview';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';
import { ContractAddress } from '@/components/contract-address';

export const metadata = { title: 'Overview — Anonymo' };

export default function DashboardPage() {
  return (
    <WorkspaceShell section="Overview">
      <Overview />
      <details className="contract-details"><summary>Coin contract address</summary><ContractAddress /></details>
    </WorkspaceShell>
  );
}
