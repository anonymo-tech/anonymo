import { CharactersPanel } from '@/components/dashboard/characters-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Characters — Anonymo' };

export default function CharactersPage() {
  return (
    <WorkspaceShell section="Characters">
      <CharactersPanel />
    </WorkspaceShell>
  );
}
