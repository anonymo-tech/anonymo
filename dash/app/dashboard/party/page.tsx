import { Party } from '@/components/dashboard/party';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Party — Anonymo' };

export default function PartyPage() {
  return (
    <WorkspaceShell section="Party" title="Party" lede="An AI game master for you and five friends.">
      <UpdateGate id="party"><Party /></UpdateGate>
    </WorkspaceShell>
  );
}
