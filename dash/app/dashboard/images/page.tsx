import { ImageStudio } from '@/components/dashboard/image-studio';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Images — Anonymo' };

export default function ImagesPage() {
  return (
    <WorkspaceShell section="Images" title="Image studio" lede="Describe it. Get it. Signed as AI-made, kept only in this tab.">
      <UpdateGate id="images">
        <ImageStudio />
      </UpdateGate>
    </WorkspaceShell>
  );
}
