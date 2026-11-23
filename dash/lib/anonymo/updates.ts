// Optional updates that ship switched off, so a deploy never turns one on by surprise. The dashboard is built with
// NEXT_PUBLIC_ANONYMO_UPDATES listing the ones that are on, comma-separated, or "all":
//
// Faces, Night Call (voice), Move In (movein), Side by Side (sidebyside) and Tickets (tickets) are released in the live
// workspace: they are on in every build. The following switches are independent.
//
//   history   chats saved in this browser (opt-in), rename, export, delete, and "wipe this device"
//   images    the image studio (needs the gateway's media routes on: ANONYMO_FEATURE_MEDIA)
//   compare   side-by-side image model comparisons (needs the image studio)
//   video     the video studio (needs the gateway's media routes on: ANONYMO_FEATURE_MEDIA)
//   usage     usage, statements and spending limits for the key
//   catchup   "catch me up": a long chat summarized into a fresh one
//   status    the public status page
//   vanish    disappearing saved chats and the Escape panic key
//   vault     passphrase protection for saved chats and the local image library
//   ventures  Anonymo Ventures: the crew of Mos builds a business, live (needs the gateway's /v1/ventures routes)
//   talk      in chat: hold to talk (transcribed by Anonymo) and read replies aloud with a stock voice
//   story     long-form writing with chapters and a story bible
//   memory    device-only character facts and suggestions after replies
//   faces     Character Studio: customizable plush characters and expressive portraits
//   voice     Night Call: a voice call page with a sleep timer (speech in stays on the device)
//   movein    bring characters and chats from other apps, read in the browser
//   sidebyside one question answered by three models at once, then merged
//   tickets   hand someone a funded key as a link, a QR code or a printed ticket
//   share     Sealed Share: a chat shared as a link that Anonymo can't read (sealed in the browser)
//   pricetag  in chat: the estimated price of a message before sending, this chat's charges so far, and a per-chat limit
//   auto      in chat: the Auto model (anonymo-auto) picks a model for each message and shows which one answered
//   search    in chat: "Search the web" sends the model as :online and shows the sources under the answer
//   photos    in chat: attach up to 4 photos for models that take images (shrunk in the browser, never saved)
//   mask      01 Mask my details: personal details in a draft are masked on the device before sending
//   circle    02 Circle anything: point at part of a picture or PDF page and ask about it
//   excerpt   03 Send only this part: send one selected excerpt instead of the whole document
//   safepost  06 Make this safe to post: cover details in a screenshot and save a flattened clean copy
//   proof     07 Show me the proof: tap a cited claim to see the exact quote checked against the local document
//   connect   05 Pair my coding tool: MCP setup for Cursor and Claude Code, verified by a receipt from the tool
//   walletreview 08 What am I signing?: a read-only review of a pasted token approval
//
// Ventures requires an explicit build opt-in. Demo mode shows the other updates, so each can be tried and filmed without a key or a deploy that has it on.

export const UPDATE_IDS = ['history', 'images', 'usage', 'catchup', 'status', 'compare', 'vanish', 'vault', 'video', 'faces', 'talk', 'story', 'memory', 'voice', 'movein', 'sidebyside', 'tickets', 'share', 'pricetag', 'auto', 'search', 'photos', 'ventures', 'mask', 'circle', 'excerpt', 'safepost', 'proof', 'connect', 'walletreview'] as const;
export type UpdateId = (typeof UPDATE_IDS)[number];

export function parseUpdates(raw: string | undefined): ReadonlySet<UpdateId> {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const all = parts.includes('all');
  return new Set(UPDATE_IDS.filter((id) => parts.includes(id) || (all && id !== 'ventures')));
}

export const BUILT_WITH = parseUpdates(process.env.NEXT_PUBLIC_ANONYMO_UPDATES);

/** Updates that are released: on in every build, with no switch. */
export const RELEASED: ReadonlySet<UpdateId> = new Set(['faces', 'voice', 'movein', 'sidebyside', 'tickets', 'mask', 'circle', 'excerpt', 'safepost', 'proof', 'connect', 'walletreview']);

/** Whether an update is on: released, built with it, or this tab is in demo mode. */
export const updateOn = (id: UpdateId, demo: boolean) => RELEASED.has(id) || BUILT_WITH.has(id) || (demo && id !== 'ventures');
