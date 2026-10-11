export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function requireCondition(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new ServiceError(status, code, message);
}
