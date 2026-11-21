// Optional updates that ship switched off, so a deploy never turns one on by surprise. The dashboard is built with
// NEXT_PUBLIC_ANONYMO_UPDATES listing the ones that are on, comma-separated, or "all":
//
// Faces is released in the live workspace. The following switches are independent.
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
//
// Demo mode (?demo=1) shows every update, so each can be tried and filmed without a key or a deploy that has it on.

export const UPDATE_IDS = ['history', 'images', 'usage', 'catchup', 'status', 'compare', 'vanish', 'vault', 'video', 'faces'] as const;
export type UpdateId = (typeof UPDATE_IDS)[number];

export function parseUpdates(raw: string | undefined): ReadonlySet<UpdateId> {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes('all')) return new Set(UPDATE_IDS);
  return new Set(UPDATE_IDS.filter((id) => parts.includes(id)));
}

export const BUILT_WITH = parseUpdates(process.env.NEXT_PUBLIC_ANONYMO_UPDATES);

/** Whether an update is on: built with it, or this tab is in demo mode. */
export const updateOn = (id: UpdateId, demo: boolean) => id === 'faces' || demo || BUILT_WITH.has(id);
