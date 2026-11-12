import { ReceiptView } from '@/components/dashboard/receipts';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Receipt — Anonymo' };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <WorkspaceShell section="Receipt">
      <ReceiptView id={decodeURIComponent(id)} />
    </WorkspaceShell>
  );
}
