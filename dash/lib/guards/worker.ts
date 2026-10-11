import { scanPrompt, type GuardScanResult } from './index.ts';

export interface GuardWorkerRequest {
  id: string | number;
  text: string;
}

export interface GuardWorkerResponse extends GuardScanResult {
  id: string | number | null;
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
    return { id: id as string | number, ...scanPrompt(record.text) };
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
