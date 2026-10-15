import { ServiceError, requireCondition } from '../core/errors.ts';
import { object, canonicalAmount, safeText } from './providers.ts';
import { parseReviewedTokenEvidence } from './deep.ts';
import type { TokenDeep } from '../../lib/second-look/token.ts';
export type DeepProducerConfig = { endpoint: string; fetch?: typeof fetch };
export type DeepProducerMarker = {
  endpoint: string;
  requestId: string;
  mint: string;
  startedAt: string;
  evidenceId: string;
  maximumUsd6: '100000';
};
export type DeepProducerResult =
  | { state: 'pending' }
  | { state: 'rejected' }
  | { state: 'completed'; deep: TokenDeep };
export function deepProducerConfig(
  env: Record<string, string | undefined> = process.env,
): DeepProducerConfig | null {
  if (env.CONCLAVE_SECOND_LOOK_CLAIMS_ENABLED !== 'true') return null;
  try {
    const u = new URL(env.CONCLAVE_SECOND_LOOK_CLAIMS_PRODUCER_URL ?? '');
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/v1/token-claims'
    )
      return null;
    return { endpoint: u.href };
  } catch {
    return null;
  }
}
/** This owned producer must durably deduplicate before any paid review work. GET never schedules work. */
export async function requestDeepProducer(
  marker: DeepProducerMarker,
  method: 'POST' | 'GET',
  config: DeepProducerConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  requireCondition(
    config.endpoint === marker.endpoint &&
      deepProducerConfig({
        CONCLAVE_SECOND_LOOK_CLAIMS_ENABLED: 'true',
        CONCLAVE_SECOND_LOOK_CLAIMS_PRODUCER_URL: config.endpoint,
      }),
    503,
    'TOKEN_PRODUCER_UNAVAILABLE',
    'The original claim producer is not configured.',
  );
  const abort = new AbortController(),
    stop = () => abort.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(stop, 15000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const interrupted = new Promise<never>((_, reject) =>
    abort.signal.addEventListener('abort', () => reject(new Error()), {
      once: true,
    }),
  );
  try {
    if (abort.signal.aborted) throw new Error();
    const response = await Promise.race([
      (config.fetch ?? fetch)(
        `${marker.endpoint}${method === 'GET' ? `/${marker.requestId}` : ''}`,
        {
          method,
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: abort.signal,
          headers: {
            Accept: 'application/json',
            ...(method === 'POST'
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          ...(method === 'POST'
            ? {
                body: JSON.stringify({
                  version: 1,
                  requestId: marker.requestId,
                  idempotencyKey: marker.requestId,
                  mint: marker.mint,
                  cluster: 'mainnet-beta',
                  maximumUsd6: marker.maximumUsd6,
                  maximumClaims: 5,
                  minimumIndependentFamilies: 3,
                  requireOpenWeightFamily: true,
                  requireFreshRetrievalAfter: marker.startedAt,
                  noAdditionalAccountCharge: true,
                }),
              }
            : {}),
        },
      ),
      interrupted,
    ]);
    requireCondition(
      response.ok &&
        response.headers.get('content-type')?.split(';')[0] ===
          'application/json',
      503,
      'TOKEN_PRODUCER_UNAVAILABLE',
      'The claim review outcome is not yet known.',
    );
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > 2097152))
      throw new Error();
    reader = response.body?.getReader();
    if (!reader) throw new Error();
    let size = 0;
    const parts: Uint8Array[] = [];
    for (;;) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (next.done) break;
      size += next.value.length;
      if (size > 2097152) throw new Error();
      parts.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    throw new ServiceError(
      503,
      'TOKEN_PRODUCER_OUTCOME_UNKNOWN',
      'The claim review outcome is unknown. Read the saved report to recover; do not start another paid check.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    void reader?.cancel().catch(() => {});
    try {
      reader?.releaseLock();
    } catch {
      /* Pending reads settle on cancellation. */
    }
  }
}
export async function parseDeepProducerResult(
  raw: unknown,
  marker: DeepProducerMarker,
  artifact: unknown,
  now = Date.now(),
): Promise<DeepProducerResult> {
  const d = object(raw);
  function valid(v: unknown): asserts v {
    requireCondition(
      v,
      503,
      'TOKEN_PRODUCER_INVALID',
      'The claim producer returned unverified evidence.',
    );
  }
  valid(
    d.version === 1 &&
      d.requestId === marker.requestId &&
      d.mint === marker.mint &&
      d.maximumUsd6 === '100000' &&
      d.cluster === 'mainnet-beta',
  );
  if (['queued', 'running', 'unknown'].includes(d.state as string))
    return { state: 'pending' };
  if (d.state === 'rejected') {
    valid(d.chargedUsd6 === '0' && d.definitive === true);
    return { state: 'rejected' };
  }
  valid(
    d.state === 'completed' &&
      d.definitive === true &&
      BigInt(canonicalAmount(d.chargedUsd6)) <= 100000n,
  );
  const review = object(d.claimReview),
    plan = object(review.plan);
  valid(
    typeof plan.createdAtMs === 'number' &&
      plan.createdAtMs >= Date.parse(marker.startedAt) &&
      Array.isArray(plan.sources),
  );
  for (const rawSource of plan.sources) {
    const s = object(rawSource);
    valid(
      typeof s.capturedAtMs === 'number' &&
        s.capturedAtMs >= Date.parse(marker.startedAt) &&
        s.capturedAtMs <= now,
    );
  }
  const scope = object(plan.scope);
  valid(scope.scopeId === marker.mint);
  const completed = safeText(d.completedAt, 32);
  valid(
    new Date(completed).toISOString() === completed &&
      Date.parse(completed) >= Date.parse(marker.startedAt) &&
      Date.parse(completed) <= now,
  );
  const old = object(artifact),
    oldDeep = object(old.deep);
  const parsed = await parseReviewedTokenEvidence(
    {
      ...old,
      observedAt: completed,
      expiresAt: new Date(now + 60000).toISOString(),
      checks: [],
      deep: { launch: oldDeep.launch, claimReview: review },
    },
    marker.mint,
    now,
  );
  valid(parsed.deep?.status === 'complete');
  return {
    state: 'completed',
    deep: {
      ...parsed.deep!,
      limitations: [
        'Fresh claim-source snapshots were retrieved and reviewed by the configured producer after this approval. Exact quotations and family agreement were independently revalidated.',
        'The producer is a trusted integration boundary. Model agreement and quote presence do not establish external truth.',
        ...parsed.deep!.limitations,
      ],
    },
  };
}
