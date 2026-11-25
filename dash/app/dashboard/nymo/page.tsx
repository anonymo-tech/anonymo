import { NymoPanel } from '@/components/dashboard/nymo-panel';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: '$NYMO — Anonymo' };

export default function NymoPage() {
  return (
    <WorkspaceShell section="$NYMO" title="$NYMO">
      <UpdateGate id="stake"><NymoPanel /></UpdateGate>
    </WorkspaceShell>
  );
}
