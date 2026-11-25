// The dashboard uses the shared companion signals for display and disclosures. Check the finalized handle-free
// transcript here as well, so a direct socket client still gets the interruption before a provider sees it.
export function crisisSignal(text: string) {
  return /\bsuicid(?:e|es|al|ality)\b|\bself[\s-]?harm(?:ing)?\b|\b(?:kill|killing|hang|hanging|shoot|shooting|drown|drowning|hurt|hurting|harm|harming|cut|cutting|burn|burning|starve|starving)\s+myself\b|\b(?:end|ending|take|taking)\s+my\s+(?:own\s+)?life\b|\b(?:want(?:ed|ing)? to die|better off dead|end(?:ing)? it all|wish i (?:was|were) dead|no reason to (?:live|go on)|don[’']?t want to (?:live|be alive|exist|wake up)|overdos(?:e|ing) on purpose)\b/i.test(text);
}
