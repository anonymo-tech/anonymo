import {
  SolanaError,
  assertGenesis,
  cluster,
  record,
  requireSolana,
  type SolanaCluster,
} from './validation.ts';

const PAYMENT_RPC_METHODS = [
  'getGenesisHash',
  'getTokenAccountsByOwner',
  'getMultipleAccounts',
  'getLatestBlockhash',
  'getBlockHeight',
  'isBlockhashValid',
  'getFeeForMessage',
  'simulateTransaction',
  'getSignatureStatuses',
  'getTransaction',
  'getSignaturesForAddress',
  'sendTransaction',
] as const;
export type PaymentRpcMethod = (typeof PAYMENT_RPC_METHODS)[number];
export type PaymentRpc = {
  readonly cluster: SolanaCluster;
  call(
    method: PaymentRpcMethod,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown>;
  verifyGenesis(signal?: AbortSignal): Promise<void>;
};
export type PaymentRpcOptions = {
  rpcUrl: string;
  cluster: SolanaCluster;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  maximumBytes?: number;
};

/** Trusted server-only endpoint, static errors and a finite RPC allowlist.
 * Preparation uses reads/simulation only. The separate explicit submit workflow
 * owns sendTransaction; this transport never retries or broadcasts on its own. */
export function createPaymentRpc(options: PaymentRpcOptions): PaymentRpc {
  requireSolana(typeof window === 'undefined', 'invalid_configuration');
  const network = cluster(options.cluster);
  let endpoint: URL;
  try {
    endpoint = new URL(options.rpcUrl);
  } catch {
    throw new SolanaError('invalid_configuration');
  }
  requireSolana(
    endpoint.protocol === 'https:' &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.hash &&
      options.rpcUrl.length <= 2048,
    'invalid_configuration',
  );
  const fetcher = options.fetcher ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maximum = options.maximumBytes ?? 1024 * 1024;
  requireSolana(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 1 &&
      timeoutMs <= 30_000 &&
      Number.isSafeInteger(maximum) &&
      maximum >= 128 &&
      maximum <= 4 * 1024 * 1024,
    'invalid_configuration',
  );

  async function rpc(
    method: PaymentRpcMethod,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    requireSolana(
      PAYMENT_RPC_METHODS.includes(method) &&
        Array.isArray(params) &&
        params.length <= 4,
      'invalid_input',
    );
    let encoded: string;
    try {
      encoded = JSON.stringify(params);
    } catch {
      throw new SolanaError('invalid_input');
    }
    requireSolana(encoded.length <= 12000, 'invalid_input');
    requireSolana(!signal?.aborted, 'cancelled');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null = null;
    const interrupted = () =>
      new SolanaError(timedOut ? 'rpc_timeout' : 'cancelled');
    const wait = <T>(promise: Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const cancel = () => reject(interrupted());
        if (controller.signal.aborted) {
          void promise.catch(() => {});
          cancel();
          return;
        }
        controller.signal.addEventListener('abort', cancel, { once: true });
        promise.then(
          (value) => {
            controller.signal.removeEventListener('abort', cancel);
            resolve(value);
          },
          (failure) => {
            controller.signal.removeEventListener('abort', cancel);
            reject(failure);
          },
        );
      });
    try {
      const id = crypto.randomUUID();
      const response = await wait(
        fetcher(endpoint.href, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
        }).then((response) => {
          if (controller.signal.aborted)
            void response.body?.cancel().catch(() => {});
          return response;
        }),
      );
      body = response.body;
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw new SolanaError('rpc_unavailable');
      }
      requireSolana(
        response.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase() === 'application/json',
        'invalid_response',
      );
      requireSolana(response.body, 'invalid_response');
      reader = response.body.getReader();
      const declared = response.headers.get('content-length');
      requireSolana(
        !declared || (/^[0-9]+$/.test(declared) && Number(declared) <= maximum),
        'response_too_large',
      );
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let length = 0;
      while (true) {
        const next = await wait(reader.read());
        if (next.done) break;
        length += next.value.byteLength;
        requireSolana(length <= maximum, 'response_too_large');
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      let payload: Record<string, unknown>;
      try {
        payload = record(JSON.parse(text));
      } catch {
        throw new SolanaError('invalid_response');
      }
      requireSolana(
        payload.jsonrpc === '2.0' &&
          payload.id === id &&
          Object.hasOwn(payload, 'result') &&
          !Object.hasOwn(payload, 'error'),
        'invalid_response',
      );
      return payload.result;
    } catch (failure) {
      if (failure instanceof SolanaError) throw failure;
      if (controller.signal.aborted) throw interrupted();
      throw new SolanaError('rpc_unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else if (body) void body.cancel().catch(() => {});
    }
  }

  return Object.freeze({
    cluster: network,
    call: rpc,
    async verifyGenesis(signal?: AbortSignal) {
      assertGenesis(network, await rpc('getGenesisHash', [], signal));
    },
  });
}
