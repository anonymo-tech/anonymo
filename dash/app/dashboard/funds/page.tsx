import { FundsPanel } from '@/components/dashboard/funds-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Funds — Anonymo' };

export default function FundsPage() {
  return (
    <WorkspaceShell section="Funds" title="Funds" lede="Add credit with stablecoins or the coin. Unused stablecoin credit can always go back to the wallet it came from.">
      <FundsPanel />
    </WorkspaceShell>
  );
}
