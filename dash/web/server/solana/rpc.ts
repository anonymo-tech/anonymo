import { explainParsedTransaction } from './explain.ts';
import { readPreSignInspection, type PreSignReadMethod } from './pre-sign.ts';
import {
  readProgramInspection,
  type ProgramReadMethod,
} from './program-reader.ts';
import type { DepositEvidence } from './deposit.ts';
import {
  SolanaError,
  assertGenesis,
  cluster,
  finalizedStatus,
  list,
  record,
  requireSolana,
  signature,
  uint,
  type SolanaCluster,
} from './validation.ts';

export type SolanaReaderOptions = {
  rpcUrl: string;
  cluster: SolanaCluster;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  maximumBytes?: number;
};

/** The endpoint is trusted server configuration, never request data. No write methods exist. */
export function createSolanaReader(options: SolanaReaderOptions) {
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
    method: ProgramReadMethod | PreSignReadMethod,
    params: unknown[],
    signal?: AbortSignal,
    byteLimit = maximum,
  ): Promise<unknown> {
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
        !declared ||
          (/^[0-9]+$/.test(declared) && Number(declared) <= byteLimit),
        'response_too_large',
      );
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let length = 0;
      while (true) {
        const next = await wait(reader.read());
        if (next.done) break;
        length += next.value.byteLength;
        requireSolana(length <= byteLimit, 'response_too_large');
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

  async function read(
    signatureInput: string,
    encoding: 'json' | 'jsonParsed',
    signal?: AbortSignal,
  ): Promise<DepositEvidence> {
    const txid = signature(signatureInput);
    const genesisHash = await rpc('getGenesisHash', [], signal);
    assertGenesis(network, genesisHash);
    const statuses = record(
      await rpc(
        'getSignatureStatuses',
        [[txid], { searchTransactionHistory: true }],
        signal,
      ),
    );
    const values = list(statuses.value, 1);
    requireSolana(values.length === 1, 'invalid_response');
    const status = values[0];
    const finalized = finalizedStatus(status, encoding === 'jsonParsed');
    const transaction = await rpc(
      'getTransaction',
      [
        txid,
        {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
          encoding,
        },
      ],
      signal,
    );
    requireSolana(transaction !== null, 'not_finalized');
    const root = record(transaction);
    requireSolana(
      root.version === 'legacy' || root.version === 0,
      'unsupported_transaction',
    );
    requireSolana(uint(root.slot) === finalized.slot, 'invalid_response');
    const meta = record(root.meta);
    requireSolana(Object.hasOwn(meta, 'err'), 'invalid_response');
    requireSolana(
      (meta.err === null) === (record(status).err === null),
      'invalid_response',
    );
    const signatures = list(record(root.transaction).signatures).map(signature);
    requireSolana(signatures[0] === txid, 'invalid_response');
    return {
      cluster: network,
      genesisHash: genesisHash as string,
      signature: txid,
      status,
      transaction,
    };
  }
  return Object.freeze({
    readPreSign: (transaction: string, signal?: AbortSignal) =>
      readPreSignInspection(
        network,
        (method, params, innerSignal) =>
          rpc(method, params, innerSignal, Math.min(maximum, 512 * 1024)),
        transaction,
        signal,
      ),
    readProgram: (program: string, signal?: AbortSignal) =>
      readProgramInspection(
        network,
        (method, params, innerSignal) =>
          rpc(method, params, innerSignal, Math.min(maximum, 256 * 1024)),
        program,
        signal,
      ),
    readDepositEvidence: (txid: string, signal?: AbortSignal) =>
      read(txid, 'json', signal),
    async readExplanation(txid: string, signal?: AbortSignal) {
      const evidence = await read(txid, 'jsonParsed', signal);
      const explanation = explainParsedTransaction(evidence.transaction);
      return {
        cluster: network,
        genesisHash: evidence.genesisHash,
        ...explanation,
        finality: 'finalized' as const,
        flags: explanation.flags.filter(
          (flag) => flag.code !== 'FINALITY_UNVERIFIED',
        ),
      };
    },
  });
}
