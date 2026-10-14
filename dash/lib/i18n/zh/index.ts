import type { Dictionary } from '../index.ts';
import site from './site.ts';
import landing from './landing.ts';
import landingMotion from './landing-motion.ts';
import docs from './docs.ts';
import chat from './chat.ts';
import chatParts from './chat-parts.ts';
import pages from './pages.ts';
import account from './account.ts';
import deposits from './deposits.ts';
import solanaBriefs from './solana-briefs.ts';
import studio from './studio.ts';

/** Every area's strings in one table. An English key that appears in two areas takes the later entry. */
const zh: Dictionary = {
  ...site,
  ...landing,
  ...landingMotion,
  ...docs,
  ...pages,
  ...account,
  ...deposits,
  ...solanaBriefs,
  ...studio,
  ...chatParts,
  ...chat,
};

export default zh;
