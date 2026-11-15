import { KeyPanel } from '@/components/dashboard/key-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'API key — Anonymo' };

export default function KeyPage() {
  return (
    <WorkspaceShell section="API key" title="API key" lede="No account. Just your key.">
      <KeyPanel />
    </WorkspaceShell>
  );
}
