import { BuildStudio } from '@/components/build/build-studio';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Build — Anonymo' };

export default function BuildPage() {
  return (
    <WorkspaceShell section="Build" title="Build" lede="Describe an app or a game. Play it here, change it, share it.">
      <UpdateGate id="build">
        <BuildStudio />
      </UpdateGate>
    </WorkspaceShell>
  );
}
