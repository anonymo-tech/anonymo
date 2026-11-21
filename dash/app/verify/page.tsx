import { PublicPage } from '@/components/site-chrome';
import { VerifyReceipt } from '@/components/verify-receipt';

export const metadata = {
  title: 'Verify a receipt — Anonymo',
  description: 'Check a signed Anonymo receipt: which routes answered, what each cost, refused attempts refunded, and the signature.',
};

export default function VerifyPage() {
  return (
    <PublicPage>
      <div className="page-title">
        <h1>Verify a receipt</h1>
        <p>
          Every call returns a signed receipt. Paste its id to see which routes answered, what each cost and whether the
          signature is valid. A route that refused shows as refunded and billed $0. Receipts hold no prompt or reply text.
        </p>
      </div>
      <VerifyReceipt />
    </PublicPage>
  );
}
