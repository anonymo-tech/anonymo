import { KeyPanel } from '@/components/dashboard/key-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'API key — Anonymo' };

export default function KeyPage() {
  return (
    <WorkspaceShell section="Key" title="Your key">
      <KeyPanel />
    </WorkspaceShell>
  );
}
