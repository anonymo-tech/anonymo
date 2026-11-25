import { UpdateGate } from '@/components/dashboard/update-gate';
import { VideoStudio } from '@/components/dashboard/video-studio';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Video studio — Anonymo' };

export default function VideoPage() {
  return (
    <WorkspaceShell section="Video" title="Video studio" lede="Turn a text prompt into a silent clip.">
      <UpdateGate id="video" also="studio">
        <VideoStudio />
      </UpdateGate>
    </WorkspaceShell>
  );
}
