import { ImageLibrary } from '@/components/dashboard/image-library';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Library — Anonymo' };

export default function LibraryPage() {
  return (
    <WorkspaceShell section="Library" title="Library" lede="Images you’ve saved in this browser.">
      <UpdateGate id="vault">
        <ImageLibrary />
      </UpdateGate>
    </WorkspaceShell>
  );
}
