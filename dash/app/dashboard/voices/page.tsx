import { MoVoices } from '@/components/dashboard/mo-voices';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';
import { UpdateGate } from '@/components/dashboard/update-gate';

export const metadata = { title: 'Voices — Anonymo' };

export default function VoicesPage() {
  return <WorkspaceShell section="Voices"><UpdateGate id="movoice"><MoVoices /></UpdateGate></WorkspaceShell>;
}
