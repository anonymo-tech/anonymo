import { AskMo } from '@/components/dashboard/ask-mo';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Ask Mo — Anonymo' };

export default function AskMoPage() {
  return (
    <WorkspaceShell section="Ask Mo" title="Ask Mo" lede="Ask anything. Keep the receipt.">
      <UpdateGate id="askmo">
        <AskMo />
      </UpdateGate>
    </WorkspaceShell>
  );
}
