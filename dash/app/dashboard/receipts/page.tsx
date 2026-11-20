import { ReceiptsList } from '@/components/dashboard/receipts';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';

export const metadata = { title: 'Receipts — Anonymo' };

export default function ReceiptsPage() {
  return (
    <WorkspaceShell section="Receipts" title="Receipts" lede="Look up a signed receipt or revisit one from this device.">
      <ReceiptsList />
    </WorkspaceShell>
  );
}
