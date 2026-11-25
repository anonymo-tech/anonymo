import { UpdateGate } from '@/components/dashboard/update-gate';
import { CreatorDiscover } from '@/components/dashboard/creator-discover';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Discover — Anonymo' };

export default function Page() {
  return <WorkspaceShell section="Discover" title="Discover" lede="Find characters people actually come back to.">
    <UpdateGate id="creators"><CreatorDiscover /></UpdateGate>
  </WorkspaceShell>;
}
