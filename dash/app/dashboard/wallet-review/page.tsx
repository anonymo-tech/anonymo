import { UpdateGate } from '@/components/dashboard/update-gate';
import { WorkspaceShell } from '@/components/dashboard/workspace-shell';
import { WalletReview } from '@/components/dashboard/wallet-review';

export const metadata = { title: 'What am I signing? — Anonymo' };

// 08 What am I signing? A read-only review of a wallet request the person pastes in or brings over from chat.
export default function WalletReviewPage() {
  return (
    <WorkspaceShell section="Wallet request" title="What am I signing?" lede="Paste a wallet request to see what it allows before you approve it in your wallet. Nothing is signed or sent from here.">
      <UpdateGate id="walletreview">
        <WalletReview />
      </UpdateGate>
    </WorkspaceShell>
  );
}
