import { ResearchDesk } from '@/components/research/research-desk';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Deep Research — Anonymo' };

export default function ResearchPage() {
  return (
    <WorkspaceShell section="Research" title="Deep Research" lede="One question in, a full report with sources out.">
      <UpdateGate id="research">
        <ResearchDesk />
      </UpdateGate>
    </WorkspaceShell>
  );
}
