import { scanPrompt, type GuardScanResult } from './index.ts';
import { scanPersonal, type PersonalFinding } from './personal.ts';

export interface GuardWorkerRequest {
  id: string | number;
  text: string;
  /** Feature 01: also suggest masks for personal details. Off by default, so the response shape is unchanged. */
  personal?: boolean;
}

export interface GuardWorkerResponse extends GuardScanResult {
  id: string | number | null;
  personal?: PersonalFinding[];
}

/** A malformed request never echoes its body or an exception to the caller. */
export function handleGuardRequest(value: unknown): GuardWorkerResponse {
  const record =
    value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  const id = record?.id;
  const validId =
    (typeof id === 'string' && id.length > 0 && id.length <= 128) ||
    (typeof id === 'number' && Number.isSafeInteger(id));
  if (!record || !validId || typeof record.text !== 'string') {
    return {
      id: validId ? (id as string | number) : null,
      findings: [
        {
          start: 0,
          end: 0,
          type: 'input',
          severity: 'block',
          code: 'input.invalid-request',
          message: 'The text could not be checked safely. Do not send it.',
        },
      ],
      redacted: '',
    };
  }
  try {
    const result = scanPrompt(record.text);
    if (record.personal !== true) return { id: id as string | number, ...result };
    // A text that could not be checked gets no suggestions: the review must not look complete.
    const failed = result.findings.some((finding) => finding.type === 'input');
    return { id: id as string | number, ...result, personal: failed ? [] : scanPersonal(record.text) };
  } catch {
    return {
      id: id as string | number,
      findings: [
        {
          start: 0,
          end: 0,
          type: 'input',
          severity: 'block',
          code: 'input.scan-failed',
          message: 'The text could not be checked safely. Do not send it.',
        },
      ],
      redacted: '',
    };
  }
}
