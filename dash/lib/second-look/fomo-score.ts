/** A display contract for independent model judgments, never a factual credit/trust rating. */
export const FOMO_SCORE_INSTRUCTIONS = `Finish your detailed evidence audit with exactly one fenced block labeled fomo-score containing valid JSON:
{"version":1,"score":null,"confidence":"low","summary":"Explain the strongest evidence and the specific missing verification, citing source IDs.","strengths":["An evidenced strength with source ID"],"risks":["An observed concern with source ID"],"missing":["A material unknown"]}
Conclave's account-performance grade and its separate public-call sample score are deterministic calculations, never chosen by a language model. If a CONCLAVE PUBLIC CALL STUDY is supplied, cite and explain its score with its exact scope in your prose. The numeric footer below remains reserved for account-wide reconciled performance. The public-feed evidence in this request does not satisfy that contract: use score:null. Do not invent, estimate, reproduce an old score, or assign a numerical score from aggregate PnL. Do not treat missing data as zero, failure or fraud.
Confidence describes the completeness and reliability of this evidence, not whether a trader is favorable. Missing history or wallet attribution requires low confidence. Cite the deterministic check IDs and original source IDs. Distinguish an observed claim, corroboration and an independently verified fact. Assess net performance, downside, consistency, execution, callout timing, source reliability and incentives wherever actual evidence allows; explicitly identify unknowns. Follower count and a badge do not establish investment merit. Four models reading the same snapshot are not four independent factual sources.
Keep the full explanation. Include up to 3 strengths, 3 evidenced concerns and 3 missing checks; use empty arrays where appropriate. This is not a probability, future-return forecast, safety guarantee or recommendation. Do not claim other models agree. Put the block after the full analysis, never inside source quotations.`;

export type FomoScore = {
  version: 1;
  score: number | null;
  confidence: "low" | "medium" | "high";
  summary: string;
  strengths: string[];
  risks: string[];
  missing: string[];
};

/** Some providers return a JSON fence under the requested score heading. Accept only that explicit section. */
function normalizeScoreFence(output: string) {
  const normalized = output.replace(
    /^#{1,6}[ \t]+(?:FOMO|Account|Callout) score[ \t]*\r?\n(?:[ \t]*\r?\n)*```(?:json|fomo-score)?[ \t]*\r?\n/gim,
    "```fomo-score\n",
  );
  // Some models label an otherwise exact abstention footer as JSON. Only
  // normalize the terminal contract; ordinary JSON and numeric ratings stay prose.
  return normalized.replace(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*\s*$/gm, (block, body: string, offset: number) => {
    if (normalized.slice(offset + block.length).trim() || body.length > 18000) return block;
    try {
      const value = JSON.parse(body);
      const keys = ["version", "score", "confidence", "summary", "strengths", "risks", "missing"];
      const text = (s: unknown) => typeof s === "string" && s.trim().length > 0 && s.length <= 1500;
      const list = (v: unknown) => Array.isArray(v) && v.length <= 6 && v.every(text);
      if (!value || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
          value.version !== 1 || value.score !== null || !["low", "medium", "high"].includes(value.confidence) ||
          !text(value.summary) || !list(value.strengths) || !list(value.risks) || !list(value.missing)) return block;
      return "```fomo-score\n" + body + "```";
    } catch { return block; }
  });
}

export function parseFomoScore(output: string): FomoScore | null {
  const blocks = [
    ...normalizeScoreFence(output).matchAll(/^```fomo-score\s*\r?\n([\s\S]*?)^```\s*$/gm),
  ];
  if (blocks.length !== 1 || blocks[0][1].length > 18000) return null;
  try {
    const value = JSON.parse(blocks[0][1]);
    const text = (s: unknown) => typeof s === "string" && s.trim().length > 0 && s.length <= 1500;
    const list = (items: unknown) => Array.isArray(items) && items.length <= 6 && items.every(text);
    if (
      !value ||
      typeof value !== "object" ||
      value.version !== 1 ||
      !(
        value.score === null ||
        (Number.isInteger(value.score) && value.score >= 0 && value.score <= 100)
      ) ||
      !["low", "medium", "high"].includes(value.confidence) ||
      !text(value.summary) ||
      !list(value.strengths) ||
      !list(value.risks) ||
      !list(value.missing)
    )
      return null;
    return {
      version: 1,
      score: value.score,
      confidence: value.confidence,
      summary: value.summary,
      strengths: value.strengths,
      risks: value.risks,
      missing: value.missing,
    };
  } catch {
    return null;
  }
}

/** Keep a partial structured footer out of the streaming prose; never invent a score from prose. */
export function fomoAnalysisBody(output: string): string {
  const withoutComplete = normalizeScoreFence(output)
    .replace(/^```fomo-score\s*\r?\n[\s\S]*?^```[ \t]*$/gm, "")
    .trimEnd();
  const marker = /^```fomo-score\s*(?:\r?\n|$)/m.exec(withoutComplete);
  return marker ? withoutComplete.slice(0, marker.index).trimEnd() : withoutComplete;
}
