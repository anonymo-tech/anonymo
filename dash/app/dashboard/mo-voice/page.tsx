import { MoVoiceCall } from '@/components/dashboard/mo-voice-call';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';
import { UpdateGate } from '@/components/dashboard/update-gate';

export const metadata = { title: 'Mo Voice — Anonymo' };

export default function MoVoicePage() {
  return <WorkspaceShell section="Mo Voice"><UpdateGate id="movoice"><MoVoiceCall /></UpdateGate></WorkspaceShell>;
}
