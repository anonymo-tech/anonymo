import { LinkRows } from '@/components/dashboard/link-rows';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Developers — Anonymo' };

export default function DevelopersPage() {
  return (
    <WorkspaceShell section="Developers" title="Developers" lede="Use your key from another app, a coding tool or your own code.">
      <LinkRows label="Developer tools" list="developers" />
    </WorkspaceShell>
  );
}
