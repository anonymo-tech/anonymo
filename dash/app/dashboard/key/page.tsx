import { KeyPanel } from '@/components/dashboard/key-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Key — Anonymo' };

export default function KeyPage() {
  return (
    <WorkspaceShell section="Key">
      <KeyPanel />
    </WorkspaceShell>
  );
}
