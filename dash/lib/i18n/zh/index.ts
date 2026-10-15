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
import production from './production.ts';
import answerCosts from './answer-costs.ts';
import answerSources from './answer-sources.ts';
import onlyOneSaid from './only-one-said.ts';
import savedCouncils from './saved-councils.ts';
import blindRecord from './blind-record.ts';
import failureReasons from './failure-reasons.ts';
import explorerLinks from './explorer-links.ts';
import pdfReferences from './pdf-references.ts';

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
  ...production,
  ...answerCosts,
  ...answerSources,
  ...onlyOneSaid,
  ...savedCouncils,
  ...blindRecord,
  ...failureReasons,
  ...explorerLinks,
  ...pdfReferences,
};

export default zh;
