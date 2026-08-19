import { strictJson } from './strict-json.ts';

/** Generated assessments cite saved model responses; quote matching does not verify meaning. */
export const BRIEF_SYNTHESIS_LIMITS = Object.freeze({
  responseBytes: 32768,
  summaryCharacters: 1600,
  quoteCharacters: 400,
  quotesPerSummary: 3,
  topicCharacters: 240,
  topics: 8,
});

export type SynthesisEvidence = { callId: string; answer: string };
export type BriefSourceQuote = { text: string; start: number; end: number };
export type BriefSynthesisAnalysis = {
  version: 1;
  summaries: { callId: string; text: string; quotes: BriefSourceQuote[] }[];
  matrix: {
    topic: string;
    positions: {
      callId: string;
      position: 'agrees' | 'disagrees' | 'unclear';
      quote: BriefSourceQuote | null;
    }[];
  }[];
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(): never {
  throw new Error('INVALID_BRIEF_SYNTHESIS');
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(row, field))
  )
    invalid();
  return row;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /\p{Cc}/u.test(value.replace(/[\t\r\n]/g, ''))
  )
    invalid();
  return value;
}
function list(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    invalid();
  return value;
}
function sourceMap(evidence: readonly SynthesisEvidence[]) {
  if (evidence.length < 1 || evidence.length > 4) invalid();
  const sources = new Map<string, string>();
  for (const row of evidence) {
    if (!uuid.test(row.callId) || sources.has(row.callId)) invalid();
    sources.set(row.callId, text(row.answer, 24000));
  }
  return sources;
}
function sourceId(value: unknown, sources: Map<string, string>) {
  if (typeof value !== 'string' || !sources.has(value)) invalid();
  return value;
}
function quote(
  value: unknown,
  source: string,
  stored: boolean,
): BriefSourceQuote {
  const row = stored ? object(value, ['text', 'start', 'end']) : null;
  const content = text(
    row ? row.text : value,
    BRIEF_SYNTHESIS_LIMITS.quoteCharacters,
  );
  // Offsets are UTF-16 code-unit indices into the original saved response.
  // The server derives them from exact text, without relying on model arithmetic.
  const start = source.indexOf(content),
    end = start + content.length;
  if (start < 0 || (row && (row.start !== start || row.end !== end))) invalid();
  return { text: content, start, end };
}
function parse(
  value: unknown,
  evidence: readonly SynthesisEvidence[],
  stored: boolean,
): BriefSynthesisAnalysis {
  const sources = sourceMap(evidence),
    row = object(value, ['version', 'summaries', 'matrix']);
  if (row.version !== 1) invalid();
  const summaries = list(row.summaries, sources.size, sources.size).map(
    (value) => {
      const item = object(value, ['callId', 'text', 'quotes']);
      const callId = sourceId(item.callId, sources);
      const quotes = list(
        item.quotes,
        1,
        BRIEF_SYNTHESIS_LIMITS.quotesPerSummary,
      ).map((value) => quote(value, sources.get(callId)!, stored));
      if (new Set(quotes.map((item) => item.text)).size !== quotes.length)
        invalid();
      return {
        callId,
        text: text(item.text, BRIEF_SYNTHESIS_LIMITS.summaryCharacters),
        quotes,
      };
    },
  );
  if (new Set(summaries.map((item) => item.callId)).size !== sources.size)
    invalid();
  const matrix = list(row.matrix, 1, BRIEF_SYNTHESIS_LIMITS.topics).map(
    (value) => {
      const item = object(value, ['topic', 'positions']);
      const positions = list(item.positions, sources.size, sources.size).map(
        (
          value,
        ): BriefSynthesisAnalysis['matrix'][number]['positions'][number] => {
          const cell = object(value, ['callId', 'position', 'quote']);
          const callId = sourceId(cell.callId, sources);
          if (
            cell.position !== 'agrees' &&
            cell.position !== 'disagrees' &&
            cell.position !== 'unclear'
          )
            invalid();
          if (cell.quote === null && cell.position !== 'unclear') invalid();
          return {
            callId,
            position: cell.position,
            quote:
              cell.quote === null
                ? null
                : quote(cell.quote, sources.get(callId)!, stored),
          };
        },
      );
      if (new Set(positions.map((item) => item.callId)).size !== sources.size)
        invalid();
      return {
        topic: text(item.topic, BRIEF_SYNTHESIS_LIMITS.topicCharacters),
        positions,
      };
    },
  );
  if (
    new Set(matrix.map((item) => item.topic.trim().toLowerCase())).size !==
    matrix.length
  )
    invalid();
  return { version: 1, summaries, matrix };
}

/** The entire result is rejected if any source, quote, summary or matrix cell is invalid. */
export function parseSynthesisOutput(
  output: string,
  evidence: readonly SynthesisEvidence[],
): BriefSynthesisAnalysis {
  if (
    typeof output !== 'string' ||
    new TextEncoder().encode(output).byteLength >
      BRIEF_SYNTHESIS_LIMITS.responseBytes
  )
    invalid();
  let value: unknown;
  try {
    value = strictJson(output, BRIEF_SYNTHESIS_LIMITS.responseBytes);
  } catch {
    return invalid();
  }
  return parse(value, evidence, false);
}

/** Revalidate stored or browser-delivered analysis against the immutable evidence. */
export function parseSynthesisAnalysis(
  value: unknown,
  evidence: readonly SynthesisEvidence[],
): BriefSynthesisAnalysis {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536)
    invalid();
  return parse(value, evidence, true);
}
