import { EXPLANATION_FLAG_SEVERITY } from '../../lib/solana/explanation.ts';
import type {
  ExplanationFlag,
  ExplainedInstruction,
} from '../../lib/solana/explanation.ts';
import { record, requireSolana } from './validation.ts';

export type { ExplanationFlag, ExplainedInstruction };

/** A decoder may raise a warning, but cannot weaken its defined severity. */
export function addFlag(
  result: ExplainedInstruction,
  code: ExplanationFlag['code'],
  severity: ExplanationFlag['severity'],
  message: string,
) {
  const rank = { info: 0, warning: 1, critical: 2 };
  const minimum = EXPLANATION_FLAG_SEVERITY[code];
  result.flags.push({
    code,
    severity: rank[severity] < rank[minimum] ? minimum : severity,
    message,
    instruction: result.location,
  });
}

export function unsupported(
  result: ExplainedInstruction,
  message = 'This program instruction is not supported by the deterministic decoder.',
) {
  addFlag(result, 'UNSUPPORTED_INSTRUCTION', 'warning', message);
}

export function parsedInfo(raw: Record<string, unknown>) {
  const parsed = record(raw.parsed);
  requireSolana(
    typeof parsed.type === 'string' &&
      /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(parsed.type),
    'invalid_response',
  );
  return { type: parsed.type, info: record(parsed.info) };
}
