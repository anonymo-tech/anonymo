import { PublicPage } from '@/components/site-chrome';
import { StatusView } from '@/components/status-view';
import { UpdateGate } from '@/components/dashboard/update-gate';

export const metadata = {
  title: 'Status — Anonymo',
  description: 'Is Anonymo up? Live checks, 90 days of uptime, speed by service and incidents, from counts only.',
};

export default function StatusPage() {
  return (
    <PublicPage wide>
      <div className="page-title">
        <h1>Status</h1>
        <p>Is Anonymo up right now, and how has it been? Live checks from your browser, plus the gateway’s own counts. No request content is kept, so there is none here.</p>
      </div>
      <UpdateGate id="status">
        <StatusView />
      </UpdateGate>
    </PublicPage>
  );
}
