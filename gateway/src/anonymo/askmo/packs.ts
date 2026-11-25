export const CHECKLIST = "What a professional would check";
export const REGION_NOTES = "Region notes";

export const TOPIC_PACKS = {
  health: {
    checks: "Cover relevant symptoms and timing, medical history, medications, red flags, and which exam or test could change the assessment.",
    region: "Use the person's region for screening guidance, medicine availability, and care options. Ask for the region if it would affect those details.",
  },
  legal: {
    checks: "Cover jurisdiction, dates and deadlines, the actual documents, what evidence exists, and which exceptions could change the analysis.",
    region: "Distinguish national and local rules. Ask for jurisdiction when needed and prefer current legislation, regulators, or courts in that jurisdiction.",
  },
  money: {
    checks: "Cover residency, tax year, filing status, costs, assumptions, and the records needed to verify eligibility or calculate the outcome.",
    region: "Use the applicable country and local tax rules. Ask for the tax year and location when missing, and avoid inferring currency or residency.",
  },
  relationships: {
    checks: "Cover the people’s goals, observed patterns, boundaries, power dynamics, and any signs that a safety plan or outside support would help.",
    region: "Account for cultural context and local support options where relevant. Ask for location before suggesting a local service.",
  },
  negotiation: {
    checks: "Cover alternatives, the other side's incentives, comparable offers, decision authority, and which terms to get in writing.",
    region: "Distinguish local market norms from general negotiation advice. Identify any employment or contract rules that depend on where the parties are based.",
  },
  feedback: {
    checks: "Cover the intended audience, criteria for success, concrete examples, the strongest counterargument, and what to test next.",
    region: "Consider local audience expectations, language, and benchmarks where relevant. Identify which assumptions would need to be checked in the target market.",
  },
} as const;

export type Topic = keyof typeof TOPIC_PACKS;
export const isTopic = (value: unknown): value is Topic => typeof value === "string" && Object.hasOwn(TOPIC_PACKS, value);

export function answerInstructions(topic: Topic | null): string {
  const pack = topic ? TOPIC_PACKS[topic] : null;
  return [
    "You are Ask Mo. Give a direct answer and be clear about what the search results establish and what remains uncertain.",
    "For each factual sentence or list item, put one or more provided source numbers immediately before its final punctuation, like A claim [1][2]. Only cite sources that support the statement. Write simple paragraphs and lists. No URLs or source list in the answer.",
    pack && `Include the exact heading "## ${CHECKLIST}" followed by a checklist tailored to this question. ${pack.checks}`,
    pack && `Include the exact heading "## ${REGION_NOTES}" when location matters. ${pack.region}`,
  ].filter(Boolean).join("\n");
}
