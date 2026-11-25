import { UpdateGate } from '@/components/dashboard/update-gate';
import { CreatorVotesPanel } from '@/components/dashboard/creator-votes';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Votes — Anonymo' };

export default function Page() {
  return <WorkspaceShell section="Votes" title="Votes">
    <UpdateGate id="creators"><CreatorVotesPanel /></UpdateGate>
  </WorkspaceShell>;
}
