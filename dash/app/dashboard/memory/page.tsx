import { UpdateGate } from '@/components/dashboard/update-gate';
import { VaultMemoryPage } from '@/components/dashboard/vault-memory-page';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Memory — Anonymo' };

export default function MemoryPage() {
  return (
    <WorkspaceShell section="Memory" title="Memory" lede="Memory that’s yours.">
      <UpdateGate id="vaultsync">
        <VaultMemoryPage />
      </UpdateGate>
    </WorkspaceShell>
  );
}
