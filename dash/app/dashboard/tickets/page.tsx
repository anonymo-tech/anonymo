import { TicketsPanel } from '@/components/dashboard/tickets';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Tickets — Anonymo' };

export default function TicketsPage() {
  return (
    <WorkspaceShell section="Tickets" title="Tickets" lede="Hand another adult a funded key as a link, a code or a printed ticket. They chat in seconds, with no account and no wallet.">
      <UpdateGate id="tickets">
        <TicketsPanel />
      </UpdateGate>
    </WorkspaceShell>
  );
}
