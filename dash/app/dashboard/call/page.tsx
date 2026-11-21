import { NightCall } from '@/components/dashboard/night-call';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Night Call — Anonymo' };

// Update "voice": a full-screen voice call with the model or a character (components/dashboard/night-call.tsx).
export default function CallPage() {
  return (
    <WorkspaceShell section="Night Call">
      <UpdateGate id="voice">
        <NightCall />
      </UpdateGate>
    </WorkspaceShell>
  );
}
