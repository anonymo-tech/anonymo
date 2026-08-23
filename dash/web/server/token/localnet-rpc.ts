import { ServiceError, requireCondition } from '../core/errors.ts';
import {
  SOLANA_NETWORKS,
  U64_MAX,
  address,
  base58Bytes,
  list,
  record,
  signature as checkSignature,
  uint,
} from '../solana/validation.ts';
import {
  requireWriteCapableToken,
  type PlatformTokenConfig,
  type PlatformTokenUnavailable,
} from './config.ts';

// Write-capable JSON-RPC client for the token executor. It exists for localnet
// (solana-test-validator) and devnet rehearsals only: construction fails with
// TOKEN_MAINNET_LOCKED unless the configured cluster is write-capable. Like
// server/solana/rpc.ts it bounds response sizes and request time, treats the
// endpoint as trusted configuration and never puts endpoints, payloads or
// signatures into error messages.

export type TokenRpcMethod =
  | 'getGenesisHash'
  | 'getLatestBlockhash'
  | 'sendTransaction'
  | 'getSignatureStatuses'
  | 'getTokenAccountBalance'
  | 'getTokenSupply'
  | 'getAccountInfo'
  | 'getBlockHeight';

export type LatestBlockhash = { blockhash: string; lastValidBlockHeight: number };
export type TokenAmount = { amountRaw: bigint; decimals: number };
export type AccountInfo = {
  owner: string;
  lamports: bigint;
  data: Uint8Array;
  executable: boolean;
};
export type SignatureStatus =
  | { state: 'unknown' }
  | { state: 'failed'; slot: number }
  | { state: 'processed' | 'confirmed'; slot: number }
  | { state: 'finalized'; slot: number };

/** The surface the executor and the buyback simulation depend on; tests fake it. */
export interface TokenRpc {
  readonly cluster: PlatformTokenConfig['cluster'];
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(): Promise<LatestBlockhash>;
  /** Submits base64 wire bytes with preflight enabled; returns the signature. */
  sendTransaction(base64: string): Promise<string>;
  getSignatureStatuses(signatures: string[]): Promise<SignatureStatus[]>;
  getTokenAccountBalance(tokenAccount: string): Promise<TokenAmount>;
  getTokenSupply(mint: string): Promise<TokenAmount>;
  getAccountInfo(account: string): Promise<AccountInfo | null>;
  getBlockHeight(): Promise<number>;
  /** Polls until the signature is finalized; fails closed on error or expiry. */
  waitForFinalized(
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<{ slot: number }>;
}

export type TokenRpcOptions = {
  config: PlatformTokenConfig | PlatformTokenUnavailable;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  maximumBytes?: number;
  /** Delay between finalization polls. */
  pollIntervalMs?: number;
  /** Upper bound on the time spent waiting for finalization. */
  finalizationTimeoutMs?: number;
};

function rpcError(code: string, message: string, retryable = false): never {
  throw new ServiceError(503, code, message, retryable);
}

function tokenAmount(value: unknown): TokenAmount {
  const body = record(record(value).value);
  requireCondition(
    typeof body.amount === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(body.amount),
    503,
    'TOKEN_RPC_INVALID_RESPONSE',
    'The token balance response is invalid.',
  );
  const amountRaw = BigInt(body.amount);
  requireCondition(
    amountRaw <= U64_MAX,
    503,
    'TOKEN_RPC_INVALID_RESPONSE',
    'The token balance response is invalid.',
  );
  return { amountRaw, decimals: uint(body.decimals, 9) };
}

function parseStatus(value: unknown): SignatureStatus {
  if (value === null) return { state: 'unknown' };
  const status = record(value);
  const slot = uint(status.slot);
  if (Object.hasOwn(status, 'err') && status.err !== null)
    return { state: 'failed', slot };
  if (status.confirmationStatus === 'finalized')
    return { state: 'finalized', slot };
  if (status.confirmationStatus === 'confirmed')
    return { state: 'confirmed', slot };
  if (status.confirmationStatus === 'processed')
    return { state: 'processed', slot };
  return rpcError(
    'TOKEN_RPC_INVALID_RESPONSE',
    'The signature status response is invalid.',
  );
}

export function createTokenRpc(options: TokenRpcOptions): TokenRpc {
  requireCondition(
    typeof window === 'undefined',
    503,
    'TOKEN_RPC_UNAVAILABLE',
    'The token RPC client is server-only.',
  );
  const config = requireWriteCapableToken(options.config);
  const endpoint = new URL(config.rpcUrl);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maximum = options.maximumBytes ?? 1024 * 1024;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const finalizationTimeoutMs = options.finalizationTimeoutMs ?? 90_000;
  requireCondition(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 1 &&
      timeoutMs <= 30_000 &&
      Number.isSafeInteger(maximum) &&
      maximum >= 128 &&
      maximum <= 4 * 1024 * 1024 &&
      Number.isSafeInteger(pollIntervalMs) &&
      pollIntervalMs >= 10 &&
      pollIntervalMs <= 10_000 &&
      Number.isSafeInteger(finalizationTimeoutMs) &&
      finalizationTimeoutMs >= pollIntervalMs &&
      finalizationTimeoutMs <= 600_000,
    503,
    'CONFIGURATION_REQUIRED',
    'The token RPC client options are invalid.',
  );

  async function rpc(method: TokenRpcMethod, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const id = crypto.randomUUID();
      const response = await fetcher(endpoint.href, {
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
      });
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        rpcError('TOKEN_RPC_UNAVAILABLE', 'The token RPC endpoint is unavailable.', true);
      }
      requireCondition(
        response.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase() === 'application/json' && response.body,
        503,
        'TOKEN_RPC_INVALID_RESPONSE',
        'The token RPC response is invalid.',
      );
      const declared = response.headers.get('content-length');
      requireCondition(
        !declared || (/^[0-9]+$/.test(declared) && Number(declared) <= maximum),
        503,
        'TOKEN_RPC_RESPONSE_TOO_LARGE',
        'The token RPC response is too large.',
      );
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        requireCondition(
          length <= maximum,
          503,
          'TOKEN_RPC_RESPONSE_TOO_LARGE',
          'The token RPC response is too large.',
        );
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      let payload: Record<string, unknown>;
      try {
        payload = record(JSON.parse(text));
      } catch {
        return rpcError('TOKEN_RPC_INVALID_RESPONSE', 'The token RPC response is invalid.');
      }
      requireCondition(
        payload.jsonrpc === '2.0' && payload.id === id,
        503,
        'TOKEN_RPC_INVALID_RESPONSE',
        'The token RPC response is invalid.',
      );
      if (Object.hasOwn(payload, 'error')) {
        // Preflight failures and malformed transactions surface here. The
        // error body is not repeated: it can echo the submitted payload.
        rpcError('TOKEN_RPC_REJECTED', 'The token RPC request was rejected.');
      }
      requireCondition(
        Object.hasOwn(payload, 'result'),
        503,
        'TOKEN_RPC_INVALID_RESPONSE',
        'The token RPC response is invalid.',
      );
      return payload.result;
    } catch (failure) {
      if (failure instanceof ServiceError) throw failure;
      if (timedOut) rpcError('TOKEN_RPC_TIMEOUT', 'The token RPC request timed out.', true);
      return rpcError('TOKEN_RPC_UNAVAILABLE', 'The token RPC endpoint is unavailable.', true);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }

  /** Unwraps `{ context, value }` responses. */
  const valueOf = (result: unknown) => record(result).value;

  const client: TokenRpc = {
    cluster: config.cluster,
    async getGenesisHash() {
      const hash = await rpc('getGenesisHash', []);
      // Localnet genesis differs per validator start; devnet must match the pin.
      const value = address(hash);
      if (config.cluster === 'devnet')
        requireCondition(
          value === SOLANA_NETWORKS.devnet.genesisHash,
          503,
          'TOKEN_WRONG_CLUSTER',
          'The token RPC endpoint is on the wrong network.',
        );
      // A localnet label with a loopback tunnel to a public network would
      // otherwise send real transfers and burns: every known public genesis
      // hash is refused on localnet before anything is signed or sent.
      if (config.cluster === 'localnet')
        requireCondition(
          !Object.values(SOLANA_NETWORKS).some((network) => network.genesisHash === value),
          503,
          'TOKEN_MAINNET_LOCKED',
          'The localnet token RPC endpoint reports a public network.',
        );
      return value;
    },
    async getLatestBlockhash() {
      const value = record(
        valueOf(await rpc('getLatestBlockhash', [{ commitment: 'finalized' }])),
      );
      base58Bytes(value.blockhash, 32);
      return {
        blockhash: value.blockhash as string,
        lastValidBlockHeight: uint(value.lastValidBlockHeight),
      };
    },
    async sendTransaction(base64) {
      requireCondition(
        typeof base64 === 'string' &&
          base64.length > 0 &&
          base64.length <= 1644 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(base64),
        400,
        'TOKEN_TRANSACTION_INVALID',
        'The transaction bytes are invalid.',
      );
      const result = await rpc('sendTransaction', [
        base64,
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3,
        },
      ]);
      return checkSignature(result);
    },
    async getSignatureStatuses(signatures) {
      requireCondition(
        signatures.length >= 1 && signatures.length <= 256,
        400,
        'TOKEN_TRANSACTION_INVALID',
        'The signature list is invalid.',
      );
      const checked = signatures.map(checkSignature);
      const values = list(
        valueOf(
          await rpc('getSignatureStatuses', [
            checked,
            { searchTransactionHistory: true },
          ]),
        ),
        checked.length,
      );
      requireCondition(
        values.length === checked.length,
        503,
        'TOKEN_RPC_INVALID_RESPONSE',
        'The signature status response is invalid.',
      );
      return values.map(parseStatus);
    },
    async getTokenAccountBalance(tokenAccount) {
      return tokenAmount(
        await rpc('getTokenAccountBalance', [
          address(tokenAccount),
          { commitment: 'finalized' },
        ]),
      );
    },
    async getTokenSupply(mint) {
      return tokenAmount(
        await rpc('getTokenSupply', [address(mint), { commitment: 'finalized' }]),
      );
    },
    async getAccountInfo(account) {
      const value = valueOf(
        await rpc('getAccountInfo', [
          address(account),
          { commitment: 'finalized', encoding: 'base64' },
        ]),
      );
      if (value === null) return null;
      const info = record(value);
      const data = list(info.data, 2);
      requireCondition(
        typeof data[0] === 'string' && data[1] === 'base64' && data[0].length <= maximum,
        503,
        'TOKEN_RPC_INVALID_RESPONSE',
        'The account response is invalid.',
      );
      requireCondition(
        typeof info.lamports === 'number' && Number.isSafeInteger(info.lamports) && info.lamports >= 0,
        503,
        'TOKEN_RPC_INVALID_RESPONSE',
        'The account response is invalid.',
      );
      return {
        owner: address(info.owner),
        lamports: BigInt(info.lamports),
        data: new Uint8Array(Buffer.from(data[0], 'base64')),
        executable: info.executable === true,
      };
    },
    async getBlockHeight() {
      return uint(await rpc('getBlockHeight', [{ commitment: 'finalized' }]));
    },
    async waitForFinalized(signature, lastValidBlockHeight) {
      const txid = checkSignature(signature);
      requireCondition(
        Number.isSafeInteger(lastValidBlockHeight) && lastValidBlockHeight >= 0,
        400,
        'TOKEN_TRANSACTION_INVALID',
        'The block height bound is invalid.',
      );
      const deadline = Date.now() + finalizationTimeoutMs;
      while (true) {
        const [status] = await client.getSignatureStatuses([txid]);
        if (status!.state === 'finalized') return { slot: status!.slot };
        if (status!.state === 'failed')
          rpcError('TOKEN_TRANSACTION_FAILED', 'The token transaction failed on chain.');
        if (status!.state === 'unknown') {
          // Past the blockhash's validity the transaction can no longer land.
          const height = await client.getBlockHeight();
          if (height > lastValidBlockHeight)
            rpcError('TOKEN_TRANSACTION_EXPIRED', 'The token transaction expired unconfirmed.');
        }
        if (Date.now() >= deadline)
          rpcError('TOKEN_NOT_FINALIZED', 'The token transaction was not finalized in time.', true);
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },
  };
  return client;
}
