import { ReceiptsList } from '@/components/dashboard/receipts';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'History — Anonymo' };

export default function ReceiptsPage() {
  return (
    <WorkspaceShell section="History" title="History" lede="Every paid message from this device, each with a signed receipt you can check.">
      <ReceiptsList />
    </WorkspaceShell>
  );
}
