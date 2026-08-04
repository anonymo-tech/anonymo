import { ServiceError, requireCondition } from './errors.ts';

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set('Content-Type', 'application/json; charset=utf-8');
  result.set('Cache-Control', 'no-store');
  result.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(value), { status, headers: result });
}

export function assertSameOrigin(request: Request, origin: string) {
  requireCondition(request.headers.get('origin') === origin, 403, 'ORIGIN_REJECTED', 'This request did not originate from this workspace.');
  const site = request.headers.get('sec-fetch-site');
  requireCondition(!site || site === 'same-origin' || site === 'none', 403, 'ORIGIN_REJECTED', 'Cross-site requests are not allowed.');
  requireCondition(new URL(request.url).origin === origin, 403, 'ORIGIN_REJECTED', 'The request origin does not match the configured service.');
}

export async function readJson(request: Request, maxBytes = 32_768): Promise<Record<string, unknown>> {
  requireCondition(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json', 415, 'JSON_REQUIRED', 'Send an application/json request.');
  const length = request.headers.get('content-length');
  if (length) requireCondition(/^\d+$/.test(length) && Number(length) <= maxBytes, 413, 'REQUEST_TOO_LARGE', 'This request is too large.');
  const reader = request.body?.getReader();
  requireCondition(reader, 400, 'INVALID_REQUEST', 'A JSON object is required.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ServiceError(413, 'REQUEST_TOO_LARGE', 'This request is too large.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const object: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    requireCondition(object && typeof object === 'object' && !Array.isArray(object), 400, 'INVALID_REQUEST', 'A JSON object is required.');
    return object as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(400, 'INVALID_REQUEST', 'The request is not valid JSON.');
  } finally {
    reader.releaseLock();
  }
}

export function stringField(body: Record<string, unknown>, key: string, maxLength: number) {
  const value = body[key];
  requireCondition(typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength,
    400, 'INVALID_REQUEST', `The ${key} field is invalid.`);
  return value;
}

export function uuidField(value: unknown) {
  requireCondition(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    400, 'INVALID_REQUEST', 'A valid identifier is required.');
  return value;
}

export async function handleApi(action: () => Promise<Response>): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const response = await action();
    response.headers.set('X-Request-Id', requestId);
    return response;
  } catch (error) {
    const known = error instanceof ServiceError;
    // Provider bodies, database errors, prompts and credentials never enter public errors.
    return jsonResponse({ error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'The request could not be completed.',
      retryable: known ? error.retryable : false,
      requestId,
    } }, known ? error.status : 500, { 'X-Request-Id': requestId });
  }
}
