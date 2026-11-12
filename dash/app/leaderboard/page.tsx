import { PublicPage } from '@/components/site-chrome';
import { LeaderboardView } from '@/components/trust-views';

export const metadata = {
  title: 'Refusal leaderboard — Anonymo',
  description: 'How often each route refused a legal request over the last 30 days, from counts only.',
};

export default function LeaderboardPage() {
  return (
    <PublicPage wide>
      <div className="page-title">
        <h1>Refusal leaderboard</h1>
        <p>
          How often each route refused a request that passed the floor, over the last 30 days. When a route refuses, Anonymo
          reroutes to a different model family and refunds the attempt, so you never pay for a refusal. These are counts
          only: no prompt or reply text is kept.
        </p>
      </div>
      <LeaderboardView />
    </PublicPage>
  );
}
