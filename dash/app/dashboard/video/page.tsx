import { UpdateGate } from '@/components/dashboard/update-gate';
import { VideoStudio } from '@/components/dashboard/video-studio';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Video studio — Anonymo' };

export default function VideoPage() {
  return (
    <WorkspaceShell section="Video">
      <UpdateGate id="video" also="studio">
        <VideoStudio />
      </UpdateGate>
    </WorkspaceShell>
  );
}
