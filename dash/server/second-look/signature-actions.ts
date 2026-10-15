import { isIP } from 'node:net';
import { scanPrompt } from '../../lib/guards/index.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { address, type SolanaCluster } from '../solana/validation.ts';
import { parseSerializedTransaction } from '../solana/serialized.ts';

export type ReviewedActionEndpoint = {
  url: string;
  cluster: SolanaCluster;
  source: string;
  reviewedAt: string;
  expiresAt: string;
};
const unavailable = () =>
  new ServiceError(
    503,
    'ACTION_UNAVAILABLE',
    'This Action could not be inspected under the reviewed endpoint policy. No transaction was signed or submitted.',
  );
function https(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw unavailable();
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    u.hash ||
    isIP(u.hostname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      u.hostname,
    ) ||
    /\.(?:local|localhost|internal|test|invalid)$/.test(u.hostname) ||
    scanPrompt(value).findings.some((f) => f.severity === 'block')
  )
    throw unavailable();
  return u.href;
}
/** Decode only syntax. Neither a Blink wrapper nor actions.json is fetched. */
export function actionEndpoint(value: string) {
  try {
    if (value.startsWith('solana-action:'))
      return https(decodeURIComponent(value.slice(14)));
    const u = new URL(https(value));
    if (u.searchParams.has('action')) {
      if (u.searchParams.getAll('action').length !== 1) throw unavailable();
      const nested = u.searchParams.get('action')!;
      if (!nested.startsWith('solana-action:')) throw unavailable();
      return https(decodeURIComponent(nested.slice(14)));
    }
    return u.href;
  } catch {
    throw unavailable();
  }
}
export function signatureActionEndpoints(
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): ReviewedActionEndpoint[] {
  try {
    const raw = env.CONCLAVE_SIGNATURE_ACTIONS;
    if (!raw || raw.length > 65536) return [];
    const value = JSON.parse(raw);
    if (
      value?.version !== 1 ||
      !Array.isArray(value.endpoints) ||
      value.endpoints.length > 64
    )
      return [];
    const rows = value.endpoints.map((r: ReviewedActionEndpoint) => {
      if (
        !r ||
        (r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') ||
        typeof r.reviewedAt !== 'string' ||
        typeof r.expiresAt !== 'string' ||
        !r.reviewedAt.endsWith('Z') ||
        !r.expiresAt.endsWith('Z') ||
        !(
          Date.parse(r.reviewedAt) <= now &&
          Date.parse(r.reviewedAt) >= now - 86400000 &&
          Date.parse(r.expiresAt) > now &&
          Date.parse(r.expiresAt) <= Date.parse(r.reviewedAt) + 86400000
        )
      )
        throw unavailable();
      const url = https(r.url),
        source = https(r.source);
      if (url !== r.url) throw unavailable();
      return {
        url,
        source,
        cluster: r.cluster,
        reviewedAt: r.reviewedAt,
        expiresAt: r.expiresAt,
      };
    });
    if (
      new Set(rows.map((r: ReviewedActionEndpoint) => r.url)).size !==
      rows.length
    )
      return [];
    return rows;
  } catch {
    return [];
  }
}
export async function resolveSignatureAction(
  input: { url: string; account: string; actionHref?: string },
  options: {
    cluster: SolanaCluster;
    endpoints?: ReviewedActionEndpoint[];
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    now?: () => number;
    timeoutMs?: number;
  },
) {
  const now = (options.now ?? Date.now)();
  // Revalidate even injected records; requests cannot supply this configuration.
  const endpoints = signatureActionEndpoints(
    {
      CONCLAVE_SIGNATURE_ACTIONS: JSON.stringify({
        version: 1,
        endpoints:
          options.endpoints ?? signatureActionEndpoints(process.env, now),
      }),
    },
    now,
  );
  const endpoint = actionEndpoint(input.url),
    review = endpoints.find(
      (r) => r.url === endpoint && r.cluster === options.cluster,
    );
  requireCondition(
    review,
    503,
    'ACTION_NOT_REVIEWED',
    'This exact Action endpoint is not freshly reviewed for the configured network. Paste transaction bytes for a local inspection instead.',
  );
  const account = address(input.account),
    controller = new AbortController();
  const timeout = options.timeoutMs ?? 8000;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 8000 ||
    options.signal?.aborted
  )
    throw unavailable();
  const abort = () => controller.abort(),
    timer = setTimeout(abort, timeout);
  options.signal?.addEventListener('abort', abort, { once: true });
  const wait = <T>(promise: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const cancel = () => reject(unavailable());
      if (controller.signal.aborted) {
        void promise.catch(() => {});
        cancel();
        return;
      }
      controller.signal.addEventListener('abort', cancel, { once: true });
      void promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', cancel));
    });
  const read = async (url: string, method: 'GET' | 'POST') => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (controller.signal.aborted) throw unavailable();
      const response = await wait(
        (options.fetcher ?? fetch)(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(method === 'POST'
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          ...(method === 'POST' ? { body: JSON.stringify({ account }) } : {}),
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        }).then((r) => {
          if (controller.signal.aborted) void r.body?.cancel().catch(() => {});
          return r;
        }),
      );
      if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== url) ||
        !response.body ||
        response.headers.get('content-type')?.split(';')[0] !==
          'application/json'
      ) {
        void response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0,
        raw = '';
      while (true) {
        const part = await wait(reader.read());
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 32768) throw unavailable();
        raw += decoder.decode(part.value, { stream: true });
      }
      const value = JSON.parse(raw + decoder.decode());
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw unavailable();
      return value;
    } finally {
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  };
  try {
    const metadata = await read(endpoint, 'GET');
    if (
      (metadata.type !== undefined && metadata.type !== 'action') ||
      (metadata.disabled !== undefined && metadata.disabled !== false) ||
      metadata.error !== undefined ||
      !['title', 'description', 'label', 'icon'].every(
        (k) =>
          typeof metadata[k] === 'string' &&
          metadata[k].length > 0 &&
          metadata[k].length <= 2048,
      )
    )
      throw unavailable();
    let target = endpoint;
    if (metadata.links !== undefined) {
      const actions = metadata.links?.actions;
      if (
        !Array.isArray(actions) ||
        !actions.length ||
        actions.length > 16 ||
        !input.actionHref
      )
        throw new ServiceError(
          400,
          'ACTION_SELECTION_REQUIRED',
          'Choose one exact, parameter-free Action endpoint before inspection.',
        );
      const selected = actions.filter(
        (a: { href?: unknown }) => a?.href === input.actionHref,
      );
      if (selected.length !== 1) throw unavailable();
      const action = selected[0];
      if (
        (action.type !== undefined && action.type !== 'transaction') ||
        (action.parameters !== undefined &&
          (!Array.isArray(action.parameters) || action.parameters.length > 0))
      )
        throw unavailable();
      target = https(new URL(input.actionHref, endpoint).href);
      if (
        new URL(target).origin !== new URL(endpoint).origin ||
        !endpoints.some(
          (r) => r.url === target && r.cluster === options.cluster,
        )
      )
        throw unavailable();
    } else if (input.actionHref !== undefined) throw unavailable();
    // Never follow returned next links or invoke an Action callback after inspection.
    const result = await read(target, 'POST');
    if (
      (result.type !== undefined && result.type !== 'transaction') ||
      typeof result.transaction !== 'string' ||
      result.error !== undefined
    )
      throw unavailable();
    const parsed = parseSerializedTransaction(result.transaction);
    if (!parsed.staticAccounts.some((a) => a.signer && a.address === account))
      throw unavailable();
    return {
      transaction: result.transaction,
      provenance: {
        endpoint,
        transactionEndpoint: target,
        account,
        reviewedAt: review.reviewedAt,
        expiresAt: review.expiresAt,
        source: review.source,
        chainSubmission: false as const,
      },
    };
  } catch (error) {
    if (
      error instanceof ServiceError &&
      ['ACTION_NOT_REVIEWED', 'ACTION_SELECTION_REQUIRED'].includes(error.code)
    )
      throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
  }
}
