import { MoveIn } from '@/components/dashboard/move-in';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Move in — Anonymo' };

export default function MoveInPage() {
  return (
    <WorkspaceShell section="Move in" title="Move in" lede="Bring your characters and chats from other apps. Your export is read in this browser, and nothing is uploaded.">
      <UpdateGate id="movein">
        <MoveIn />
      </UpdateGate>
    </WorkspaceShell>
  );
}
