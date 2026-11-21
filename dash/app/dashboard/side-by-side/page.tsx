import { SideBySide } from '@/components/dashboard/side-by-side';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Side by side — Anonymo' };

export default function SideBySidePage() {
  return (
    <WorkspaceShell section="Side by side" title="Side by side" lede="Ask once. Three models answer at the same time, each with its own signed receipt. Then merge them into one.">
      <UpdateGate id="sidebyside">
        <SideBySide />
      </UpdateGate>
    </WorkspaceShell>
  );
}
