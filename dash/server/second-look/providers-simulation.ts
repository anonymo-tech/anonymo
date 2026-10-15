import { ServiceError, requireCondition } from '../core/errors.ts';
import { address, SOLANA_NETWORKS } from '../solana/validation.ts';
import {
  object,
  integer,
  canonicalAmount,
  safeText,
  type TokenProviderConfig,
} from './providers.ts';
import { blankChecks, fact, source } from './token-facts.ts';
import type { TokenCheck } from '../../lib/second-look/token.ts';
export type ForkProbeConfig = { endpoint: string; fetch?: typeof fetch };
export function forkProbeConfig(
  env: Record<string, string | undefined> = process.env,
): ForkProbeConfig | null {
  if (env.CONCLAVE_SECOND_LOOK_SIMULATION_ENABLED !== 'true') return null;
  try {
    const u = new URL(env.CONCLAVE_SECOND_LOOK_FORK_URL ?? '');
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/v1/token-roundtrip' ||
      (u.protocol !== 'https:' &&
        !(
          u.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)
        ))
    )
      return null;
    return { endpoint: u.href };
  } catch {
    return null;
  }
}
function valid(value: unknown): asserts value {
  requireCondition(
    value,
    503,
    'TOKEN_SIMULATION_INVALID',
    'The fork simulation did not return valid bound evidence.',
  );
}
/** Both legs execute in one disposable fork. No signatures or broadcast method are sent. */
export function parseForkProbe(
  value: unknown,
  mint: string,
  now = Date.now(),
): TokenCheck {
  const data = object(value);
  valid(
    data.version === 1 &&
      data.method === 'mainnet-fork' &&
      data.cluster === 'mainnet-beta' &&
      data.genesisHash === SOLANA_NETWORKS['mainnet-beta'].genesisHash &&
      address(data.mint) === mint &&
      data.simulationOnly === true &&
      data.broadcast === false &&
      data.quoteMint === SOLANA_NETWORKS['mainnet-beta'].usdcMint &&
      data.quoteDecimals === 6,
  );
  const observed = safeText(data.observedAt, 32);
  valid(
    new Date(observed).toISOString() === observed &&
      Date.parse(observed) <= now &&
      Date.parse(observed) > now - 30000,
  );
  const slot = integer(data.contextSlot),
    buy = object(data.buy),
    sell = object(data.sell);
  valid(buy.success === true && typeof sell.success === 'boolean');
  const input = BigInt(canonicalAmount(data.inputQuoteRaw)),
    minimum = BigInt(canonicalAmount(buy.minimumOutputRaw)),
    received = BigInt(canonicalAmount(buy.receivedRaw)),
    sold = BigInt(canonicalAmount(sell.inputRaw)),
    returned = BigInt(canonicalAmount(data.returnedQuoteRaw)),
    networkFee = BigInt(canonicalAmount(data.networkFeeQuoteUsd6));
  valid(
    input === 20000000n &&
      minimum > 0n &&
      received >= minimum &&
      sold === minimum &&
      networkFee <= 20000000n &&
      returned <= input * 100n,
  );
  valid(
    data.feeValuationSource === 'fork-quote-snapshot' &&
      typeof data.probeId === 'string' &&
      /^[a-f0-9]{64}$/.test(data.probeId),
  );
  valid(
    sell.success
      ? sell.errorCode === null
      : typeof sell.errorCode === 'string' &&
          /^[A-Z0-9_]{1,80}$/.test(sell.errorCode),
  );
  const loss = input - returned + networkFee;
  const cost = loss > 0n ? Number((loss * 1000000n) / input) / 10000 : 0;
  const src = source('reviewed-simulation', Date.parse(observed), String(slot));
  src.expiresAt = new Date(Date.parse(observed) + 60000).toISOString();
  return {
    ...blankChecks()[3],
    status: 'complete',
    sources: [src],
    facts: [
      fact(
        'roundtripSucceeded',
        'Buy then sell succeeded in the fork',
        sell.success,
      ),
      fact(
        'roundtripCostPercent',
        'Roundtrip cost including valued network fees (%)',
        cost,
      ),
      fact('probeMethod', 'Simulation method', 'mainnet-fork'),
      fact('probeId', 'Probe evidence digest', data.probeId as string),
      fact('notionalUsd6', 'Probe notional USD6', '20000000'),
      fact(
        'minimumOutputRaw',
        'Sell leg raw input (buy minimum output)',
        minimum.toString(),
      ),
      fact(
        'simulationError',
        'Simulation failure code',
        sell.errorCode as string | null,
      ),
    ],
    limitations: [
      'This disposable fork probe was not broadcast. A simulated result does not guarantee a later real trade or quote.',
      'Network fees are valued using the fork service’s bound quote snapshot.',
    ],
  };
}
export async function runForkProbe(
  mint: string,
  config: ForkProbeConfig,
  signal?: AbortSignal,
): Promise<TokenCheck> {
  address(mint);
  valid(
    forkProbeConfig({
      CONCLAVE_SECOND_LOOK_SIMULATION_ENABLED: 'true',
      CONCLAVE_SECOND_LOOK_FORK_URL: config.endpoint,
    }),
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(stop, 15000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () =>
        reject(
          new ServiceError(
            503,
            'TOKEN_SIMULATION_UNAVAILABLE',
            'The fork simulation was interrupted.',
          ),
        ),
      { once: true },
    );
  });
  try {
    if (controller.signal.aborted) throw new Error();
    const response = await Promise.race([
      (config.fetch ?? fetch)(config.endpoint, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: 1,
          mint,
          cluster: 'mainnet-beta',
          quoteMint: SOLANA_NETWORKS['mainnet-beta'].usdcMint,
          notionalUsd6: '20000000',
          sellSizing: 'buy-minimum-output',
          neverBroadcast: true,
        }),
      }),
      abortPromise,
    ]);
    valid(
      response.ok &&
        response.headers.get('content-type')?.split(';')[0] ===
          'application/json',
    );
    const length = response.headers.get('content-length');
    valid(!length || (/^\d+$/.test(length) && Number(length) <= 32768));
    reader = response.body?.getReader();
    valid(reader);
    let size = 0;
    const parts: Uint8Array[] = [];
    for (;;) {
      const part = await Promise.race([reader.read(), abortPromise]);
      if (part.done) break;
      size += part.value.length;
      valid(size <= 32768);
      parts.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return parseForkProbe(
      JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
      mint,
    );
  } catch {
    throw new ServiceError(
      503,
      'TOKEN_SIMULATION_UNAVAILABLE',
      'A usable buy-and-sell fork simulation is unavailable.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    void reader?.cancel().catch(() => {});
    try {
      reader?.releaseLock();
    } catch {
      /* Cancellation settles separately. */
    }
  }
}
export function simulationReady(config: TokenProviderConfig) {
  return config.simulation && !!forkProbeConfig();
}
