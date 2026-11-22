import { PayInWallet } from '@/components/pay-in-wallet';
import { PublicPage } from '@/components/site-chrome';

export const metadata = {
  title: 'Pay from your wallet — Anonymo',
  description: 'Add stablecoin credit to an Anonymo key from a wallet app.',
  robots: { index: false },
};

export default function PayPage() {
  return (
    <PublicPage>
      <div className="page-title">
        <h1>Pay from your wallet</h1>
        <p>Add credit to your Anonymo key from this wallet. The key itself never leaves your dashboard: this page only knows its keyCommit.</p>
      </div>
      <PayInWallet />
    </PublicPage>
  );
}
