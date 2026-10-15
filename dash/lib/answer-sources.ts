export type AnswerSource = { url: string; domain: string; label?: string };

/** Extract links as written; URL parsing normalises only the deduplication key. No requests. */
export function extractAnswerSources(text: string): AnswerSource[] {
  const sources: AnswerSource[] = [];
  const seen = new Set<string>();
  const starts = /(?<![\w:/])(\[([^\]\n]*)\]\(\s*<?|<)?(https?:\/\/)/gi;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(text)) && sources.length < 20) {
    const start = starts.lastIndex - match[3].length;
    let end = starts.lastIndex;
    let parentheses = 0;
    for (; end < text.length; end++) {
      const character = text[end];
      if (/[\s<>"'`[\]{}\u201c\u201d\u2018\u2019\uff09\u3011\u300b]/u.test(character)) break;
      if (character === '(') parentheses++;
      if (character === ')') {
        if (parentheses === 0) break;
        parentheses--;
      }
    }
    const url = text.slice(start, end).replace(/[.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u2026]+$/u, '');
    starts.lastIndex = end;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      const label = match[2]?.trim();
      sources.push({ url, domain: parsed.hostname, ...(label ? { label } : {}) });
    } catch {
      // An incomplete or malformed URL is not a source link.
    }
  }
  return sources;
}
