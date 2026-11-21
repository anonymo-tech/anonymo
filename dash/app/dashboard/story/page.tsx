import { StoryStudio } from '@/components/dashboard/story-studio';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Story Studio — Anonymo' };

export default function StoryPage() {
  return (
    <WorkspaceShell section="Story" title="Story Studio" lede="Write chapter by chapter with a story bible at hand.">
      <UpdateGate id="story">
        <StoryStudio />
      </UpdateGate>
    </WorkspaceShell>
  );
}
