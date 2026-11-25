// Mirror the plain-text crisis signals in the workspace for messages sent directly to the bot.
const selfHarm = [
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

export function crisisNotice(text: string) {
  return selfHarm.some((pattern) => pattern.test(text))
    ? "If you might hurt yourself, call your local emergency number now. In the U.S., call or text 988. Find a Helpline lists support in other countries."
    : null;
}
