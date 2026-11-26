import { LinkRows } from '@/components/dashboard/link-rows';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Settings — Anonymo' };

export default function SettingsPage() {
  return (
    <WorkspaceShell
      section="Privacy & data"
      title="Privacy & data"
      lede="What Anonymo keeps in this browser, and how to bring things in or take them out."
    >
      <LinkRows label="Your data" list="settings" />
    </WorkspaceShell>
  );
}
