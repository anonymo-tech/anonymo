// Two duties of an AI chat service, kept in the browser (nothing here is sent or stored):
//   - Say it is an AI: a notice that is always on screen, repeated in the thread at least every 3 hours of a session
//     (New York GBL §§1700–1704; California SB 243; EU AI Act Art. 50).
//   - A crisis protocol: when someone writes about suicide or self-harm, show crisis lines next to the answer
//     (New York GBL §§1700–1704; California SB 243). Sources: docs/legal/region-defaults.md. It never blocks the chat: fiction and venting are allowed.

export const AI_NOTICE = 'You’re talking to an AI, not a person. Characters are fictional.';
export const AI_REMINDER = 'Reminder: you’re talking to an AI, not a person.';
export const AI_NOTICE_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** True when a reminder is due: at least AI_NOTICE_INTERVAL_MS since the last one. */
export const reminderDue = (lastAt: number, now = Date.now()) => now - lastAt >= AI_NOTICE_INTERVAL_MS;

const SELF_HARM = [
  /\bsuicid(?:e|es|al|ality)\b/i,
  /\b(?:kill|killing|hang|hanging|shoot|shooting|drown|drowning)\s+myself\b/i,
  /\b(?:end|ending|take|taking)\s+my\s+(?:own\s+)?life\b/i,
  /\bend(?:ing)?\s+it\s+all\b/i,
  /\b(?:want|wanted|wanting)\s+to\s+die\b/i,
  /\bwish\s+i\s+(?:was|were)\s+dead\b/i,
  /\bbetter\s+off\s+dead\b/i,
  /\bno\s+reason\s+to\s+(?:live|go\s+on)\b/i,
  /\bdon[’']?t\s+want\s+to\s+(?:live|be\s+alive|exist|wake\s+up)\b/i,
  /\bself[\s-]?harm(?:ing)?\b/i,
  /\b(?:hurt|hurting|harm|harming|cut|cutting|burn|burning|starve|starving)\s+myself\b/i,
  /\boverdos(?:e|ing)\s+on\s+purpose\b/i,
];

/** Whether a message talks about suicide or self-harm, in the first person or not. Deliberately broad. */
export const mentionsSelfHarm = (text: string) => SELF_HARM.some((r) => r.test(text));

export type CrisisLine = { where: string; what: string; href: string; action: string };

export const CRISIS_LINES: CrisisLine[] = [
  { where: 'United States', what: '988 Suicide & Crisis Lifeline', href: 'tel:988', action: 'Call or text 988' },
  { where: 'United States', what: 'Crisis Text Line', href: 'sms:741741?body=HOME', action: 'Text HOME to 741741' },
  { where: 'Anywhere', what: 'Find a Helpline lists free, confidential lines in your country', href: 'https://findahelpline.com', action: 'findahelpline.com' },
];
