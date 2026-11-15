import { Overview } from '@/components/dashboard/overview';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Overview — Anonymo' };

export default function DashboardPage() {
  return (
    <WorkspaceShell section="Overview" title="Overview" lede="Your key, your balance and your receipts, at a glance.">
      <Overview />
    </WorkspaceShell>
  );
}
