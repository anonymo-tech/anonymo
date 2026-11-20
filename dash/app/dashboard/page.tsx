import { Overview } from '@/components/dashboard/overview';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';
import { ContractAddress } from '@/components/contract-address';

export const metadata = { title: 'Overview — Anonymo' };

export default function DashboardPage() {
  return (
    <WorkspaceShell section="Overview" title="Overview" lede="Your key, your balance and your receipts, at a glance.">
      <ContractAddress className="ca-dash" />
      <Overview />
    </WorkspaceShell>
  );
}
