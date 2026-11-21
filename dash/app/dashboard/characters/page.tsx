import { CharactersPanel } from '@/components/dashboard/characters-panel';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Characters — Anonymo' };

export default function CharactersPage() {
  return (
    <WorkspaceShell section="Characters" title="Characters" lede="Import a character card. Private cards are sealed on this device before they leave it.">
      <CharactersPanel />
    </WorkspaceShell>
  );
}
