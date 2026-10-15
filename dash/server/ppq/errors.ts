const messages = {
  unavailable: 'AI service is not configured.',
  invalid_request: 'The AI request is not supported.',
  privacy_unavailable: 'Verified private inference is not available.',
  authentication: 'AI service authorization is unavailable.',
  insufficient_credit: 'AI service credit is unavailable.',
  conflict: 'The generation request conflicts with an existing operation.',
  not_found: 'The AI operation was not found.',
  provider_unavailable: 'The AI provider is unavailable.',
  timeout: 'The AI request timed out.',
  cancelled: 'The AI request was interrupted.',
  invalid_response: 'The AI provider returned an unusable response.',
  response_too_large: 'The AI response exceeded the supported size.',
  stream_interrupted: 'The AI response did not finish.',
  generation_failed: 'The AI generation did not complete.',
} as const;

export type PpqErrorCode = keyof typeof messages;

/** Deliberately never retains an upstream body, URL, headers, key, or cause. */
export class PpqError extends Error {
  readonly code: PpqErrorCode;
  readonly billingAmbiguous: boolean;
  constructor(code: PpqErrorCode, billingAmbiguous = false) {
    super(messages[code]);
    this.name = 'PpqError';
    this.code = code;
    this.billingAmbiguous = billingAmbiguous;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      billingAmbiguous: this.billingAmbiguous,
    };
  }
}

export function publicPpqError(error: unknown) {
  return (
    error instanceof PpqError
      ? error
      : new PpqError('provider_unavailable', true)
  ).toJSON();
}
