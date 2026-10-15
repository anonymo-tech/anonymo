import { FOMO_SCORE_INSTRUCTIONS } from './fomo-score.ts';
/** Recognize our saved research envelope for display only; never rewrite history. */
export function fomoPromptPresentation(prompt: string): { title: string; sourcePrompt: string } | null {
  const start = '\n\nBEGIN UNTRUSTED EVIDENCE JSON\n\n';
  const end = '\n\nEND UNTRUSTED EVIDENCE JSON';
  if (!prompt.endsWith(end) && !prompt.endsWith(FOMO_SCORE_INSTRUCTIONS)) return null;
  const evidenceStart = prompt.indexOf(start);
  if (evidenceStart < 0) return null;
  try {
    const evidenceEnd = prompt.indexOf(end, evidenceStart + start.length);
    if (evidenceEnd < 0) return null;
    const tail = prompt.slice(evidenceEnd + end.length);
    if (tail && tail !== '\n\n' + FOMO_SCORE_INSTRUCTIONS && !tail.startsWith('\n\nCONCLAVE RESEARCH CHECKS ')) return null;
    const evidence = JSON.parse(prompt.slice(evidenceStart + start.length, evidenceEnd));
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
    const { title, input, sources } = evidence;
    if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\r\n]/.test(title)) return null;
    if (!input || !['profile', 'callout'].includes(input.kind) || !Array.isArray(sources)) return null;
    const heading = `${title}\n\nYou are one of four independently selected research models. Produce an extensive, evidence-led analysis of this FOMO ${input.kind}.\n\n`;
    if (!prompt.startsWith(heading)) return null;
    return { title, sourcePrompt: prompt };
  } catch {
    return null;
  }
}
