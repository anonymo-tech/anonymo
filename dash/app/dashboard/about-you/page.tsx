import { AboutYou } from '@/components/dashboard/about-you';
import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'About you — Anonymo' };

export default function AboutYouPage() {
  return (
    <WorkspaceShell section="About you" title="About you" lede="Your profile is saved on this device.">
      <UpdateGate id="aboutyou">
        <AboutYou />
      </UpdateGate>
    </WorkspaceShell>
  );
}
