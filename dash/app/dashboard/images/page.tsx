import { ImageStudio } from '@/components/dashboard/image-studio';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Images — Anonymo' };

export default function ImagesPage() {
  return (
    <WorkspaceShell section="Images" title="Image studio" lede="Generate signed images and download the ones you want to keep.">
      <UpdateGate id="images" also="studio">
        <ImageStudio />
      </UpdateGate>
    </WorkspaceShell>
  );
}
