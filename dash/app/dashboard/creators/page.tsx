import { UpdateGate } from '@/components/dashboard/update-gate';
import { CreatorDashboard } from '@/components/dashboard/creator-dashboard';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Creator Cut — Anonymo' };

export default function Page() {
  return <WorkspaceShell section="Creator Cut" title="Creator Cut" lede="A share of what your characters bring in.">
    <UpdateGate id="creators"><CreatorDashboard /></UpdateGate>
  </WorkspaceShell>;
}
