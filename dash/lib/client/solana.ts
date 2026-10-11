import bs58 from 'bs58';

import {
  EXPLANATION_FLAG_SEVERITY,
  SOLANA_DECODER_VERSION,
} from '../solana/explanation.ts';
import type {
  ExplanationFlag,
  ExplainedInstruction,
} from '../solana/explanation.ts';
export type {
  ExplanationFlag,
  ExplainedInstruction,
} from '../solana/explanation.ts';

export type TransactionExplanation = {
  decoderVersion: typeof SOLANA_DECODER_VERSION;
  cluster: 'devnet' | 'mainnet-beta';
  genesisHash: string;
  signature: string;
  slot: number;
  execution: 'succeeded' | 'failed' | 'unknown';
  finality: 'finalized';
  instructions: ExplainedInstruction[];
  flags: ExplanationFlag[];
};
export class ExplainerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'ExplainerError';
    this.code = code;
    this.status = status;
  }
}
const networks = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;
const flagCodes = new Set(Object.keys(EXPLANATION_FLAG_SEVERITY));
const severityRank = { info: 0, warning: 1, critical: 2 };
const unsafeControl = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      code < 9 ||
      code === 11 ||
      code === 12 ||
      (code > 13 && code < 32) ||
      code === 127
    );
  });
const errorMessages: Record<string, string> = {
  RPC_UNAVAILABLE:
    'A Solana RPC network is not configured for this workspace. Your entered signature is still here.',
  SOLANA_RPC_UNAVAILABLE:
    'The configured Solana RPC could not complete this read. Your entered signature is still here; try again later.',
  SOLANA_RPC_TIMEOUT:
    'The Solana RPC read timed out. No transaction was sent. You can try reading this signature again.',
  SOLANA_NOT_FINALIZED:
    'This signature was not found as finalized on the configured network. It may be pending, unavailable in the RPC history, or from another network.',
  SOLANA_WRONG_CLUSTER:
    'The RPC reported a different network than the configured cluster. No explanation is shown.',
  SOLANA_INVALID_CONFIGURATION:
    'The Solana reader is not configured correctly. No explanation is available.',
  SOLANA_UNSUPPORTED_TRANSACTION:
    'This transaction version is not supported by the current decoder. No complete explanation is available.',
  SOLANA_UNSUPPORTED_INSTRUCTION:
    'The decoder does not support one or more instructions in this transaction.',
  SOLANA_INVALID_RESPONSE:
    'The RPC response could not be checked consistently. No explanation is shown.',
  SOLANA_INCOMPLETE_METADATA:
    'Required transaction metadata was unavailable. No complete explanation is available.',
  SOLANA_TRANSACTION_FAILED:
    'The transaction failed. This response did not include a complete explanation of its attempted instructions.',
  SOLANA_INVALID_INPUT:
    'Enter one existing Solana transaction signature in base58 format.',
};
const invalid = (): never => {
  throw new ExplainerError(
    'INVALID_RESPONSE',
    'The transaction explanation could not be checked. No result is shown.',
  );
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
};
function base58(value: unknown, size: number): string {
  if (
    typeof value !== 'string' ||
    value.length < size ||
    value.length > Math.ceil(size * 1.38)
  )
    return invalid();
  try {
    const bytes = bs58.decode(value);
    if (bytes.length !== size || bs58.encode(bytes) !== value) return invalid();
    return value;
  } catch {
    return invalid();
  }
}
export function transactionSignature(value: string): string {
  if (typeof value !== 'string')
    throw new ExplainerError(
      'INVALID_SIGNATURE',
      'Enter one existing Solana transaction signature in base58 format.',
    );
  const candidate = value.trim();
  try {
    return base58(candidate, 64);
  } catch {
    throw new ExplainerError(
      'INVALID_SIGNATURE',
      'Enter one existing Solana transaction signature in base58 format, not a wallet address or transaction URL.',
    );
  }
}
export function explainerErrorMessage(error: unknown): string {
  return error instanceof ExplainerError
    ? error.message
    : 'The transaction read did not complete. Your entered signature is still here.';
}

/** Validate the server's typed decoder result; strings remain text, never markup or links. */
export function parseExplanation(
  value: unknown,
  expectedSignature: string,
): TransactionExplanation {
  let budget = 524288;
  const text = (value: unknown, maximum: number): string => {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > maximum ||
      unsafeControl(value)
    )
      return invalid();
    budget -= value.length;
    if (budget < 0) return invalid();
    return value;
  };
  const list = <T>(
    value: unknown,
    max: number,
    parse: (value: unknown) => T,
  ): T[] => {
    if (!Array.isArray(value) || value.length > max) return invalid();
    return value.map(parse);
  };
  const location = (value: unknown) => {
    const result = text(value, 8);
    if (
      !/^(?:[0-9]|[1-5][0-9]|6[0-3])(?:\.(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7]))?$/.test(
        result,
      )
    )
      return invalid();
    return result;
  };
  const flag = (value: unknown): ExplanationFlag => {
    const entry = record(value),
      code = text(entry.code, 80);
    if (
      !flagCodes.has(code) ||
      typeof entry.severity !== 'string' ||
      !['info', 'warning', 'critical'].includes(entry.severity)
    )
      return invalid();
    const typedCode = code as ExplanationFlag['code'];
    if (
      severityRank[entry.severity as ExplanationFlag['severity']] <
      severityRank[EXPLANATION_FLAG_SEVERITY[typedCode]]
    )
      return invalid();
    return {
      code: typedCode,
      severity: entry.severity as ExplanationFlag['severity'],
      message: text(entry.message, 1024),
      ...(entry.instruction === undefined
        ? {}
        : { instruction: location(entry.instruction) }),
    };
  };
  const root = record(value);
  if (root.decoderVersion !== SOLANA_DECODER_VERSION) return invalid();
  if (root.cluster !== 'devnet' && root.cluster !== 'mainnet-beta')
    return invalid();
  if (
    root.genesisHash !== networks[root.cluster] ||
    root.finality !== 'finalized'
  )
    return invalid();
  if (
    typeof root.execution !== 'string' ||
    !['succeeded', 'failed', 'unknown'].includes(root.execution)
  )
    return invalid();
  if (
    typeof root.slot !== 'number' ||
    !Number.isSafeInteger(root.slot) ||
    root.slot < 0
  )
    return invalid();
  const signature = base58(root.signature, 64);
  if (signature !== expectedSignature) return invalid();
  const instructions = list(
    root.instructions,
    256,
    (value): ExplainedInstruction => {
      const entry = record(value),
        inputFields = record(entry.fields),
        fields: Record<string, string> = {};
      if (Object.keys(inputFields).length > 16) return invalid();
      for (const [key, value] of Object.entries(inputFields)) {
        if (
          !/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key) ||
          ['constructor', 'prototype', '__proto__'].includes(key)
        )
          return invalid();
        fields[key] = text(value, 256);
      }
      const result = {
        location: location(entry.location),
        programId:
          entry.programId === null ? null : base58(entry.programId, 32),
        kind: text(entry.kind, 80),
        description: text(entry.description, 1024),
        fields,
        flags: list(entry.flags, 8, flag),
      };
      if (result.flags.some((item) => item.instruction !== result.location))
        return invalid();
      if (
        result.kind === 'unknown' &&
        !result.flags.some((item) =>
          [
            'UNKNOWN_PROGRAM',
            'UNSUPPORTED_INSTRUCTION',
            'UNSUPPORTED_TOKEN_PROGRAM',
            'MALFORMED_INSTRUCTION',
          ].includes(item.code),
        )
      )
        return invalid();
      if (
        result.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' &&
        !result.flags.some(
          (item) => item.code === 'TOKEN_2022_STATE_UNINSPECTED',
        )
      )
        return invalid();
      return result;
    },
  );
  const locations = new Set(
    instructions.map((instruction) => instruction.location),
  );
  if (locations.size !== instructions.length) return invalid();
  const flags = list(root.flags, 2051, flag);
  if (
    flags.some(
      (item) =>
        item.instruction !== undefined && !locations.has(item.instruction),
    )
  )
    return invalid();
  // Preserve every instruction warning and the strongest duplicate severity.
  const all = new Map<string, ExplanationFlag>();
  for (const item of [
    ...flags,
    ...instructions.flatMap((instruction) => instruction.flags),
  ]) {
    const key = `${item.code}:${item.instruction ?? ''}:${item.message}`;
    const existing = all.get(key);
    if (
      !existing ||
      severityRank[item.severity] > severityRank[existing.severity]
    )
      all.set(key, item);
  }
  const globalFlag = (code: ExplanationFlag['code']) =>
    [...all.values()].some(
      (item) => item.code === code && item.instruction === undefined,
    );
  if (
    (root.execution === 'failed' && !globalFlag('TRANSACTION_FAILED')) ||
    (root.execution === 'unknown' && !globalFlag('INCOMPLETE_METADATA')) ||
    (instructions.length === 0 && !globalFlag('INCOMPLETE_METADATA'))
  )
    return invalid();
  const rank = { critical: 0, warning: 1, info: 2 };
  return {
    decoderVersion: SOLANA_DECODER_VERSION,
    cluster: root.cluster,
    genesisHash: root.genesisHash as string,
    signature,
    slot: root.slot,
    execution: root.execution as TransactionExplanation['execution'],
    finality: 'finalized',
    instructions,
    flags: [...all.values()].sort(
      (a, b) => rank[a.severity] - rank[b.severity],
    ),
  };
}

export async function readTransactionExplanation(
  signature: string,
  accountId: string,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<TransactionExplanation> {
  const candidate = transactionSignature(signature);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      accountId,
    )
  )
    throw new ExplainerError(
      'ACCOUNT_REQUIRED',
      'Sign in to inspect a transaction.',
      401,
    );
  options.signal?.throwIfAborted();
  const controller = new AbortController(),
    timeoutMs = options.timeoutMs ?? 40000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new ExplainerError(
      'INVALID_TIMEOUT',
      'The transaction read could not start.',
    );
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abortWait = () => reject(new DOMException('Aborted', 'AbortError'));
      if (controller.signal.aborted) {
        void promise.catch(() => {});
        abortWait();
        return;
      }
      controller.signal.addEventListener('abort', abortWait, { once: true });
      promise.then(
        (value) => {
          controller.signal.removeEventListener('abort', abortWait);
          resolve(value);
        },
        (failure) => {
          controller.signal.removeEventListener('abort', abortWait);
          reject(failure);
        },
      );
    });
  try {
    const response = await wait(
      (options.fetch ?? globalThis.fetch)('/api/explanations', {
        method: 'POST',
        credentials: 'same-origin',
        mode: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Conclave-Account-Id': accountId,
        },
        body: JSON.stringify({ signature: candidate }),
      }).then((response) => {
        if (controller.signal.aborted)
          void response.body?.cancel().catch(() => {});
        return response;
      }),
    );
    controller.signal.throwIfAborted();
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      throw new ExplainerError(
        'ACCOUNT_REQUIRED',
        'Your account session changed or expired. Sign in again before reading a transaction.',
        401,
      );
    }
    const limit = response.ok ? 1048576 : 65536;
    if (!response.body) return invalid();
    reader = response.body.getReader();
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^[0-9]+$/.test(declared) || Number(declared) > limit)
    )
      return invalid();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0,
      encoded = '';
    while (true) {
      controller.signal.throwIfAborted();
      const part = await wait(reader.read());
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit)
        throw new ExplainerError(
          'RESPONSE_TOO_LARGE',
          'The transaction explanation exceeded this view’s read limit. No result is shown.',
        );
      encoded += decoder.decode(part.value, { stream: true });
    }
    controller.signal.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded + decoder.decode());
    } catch {
      if (response.ok) return invalid();
      parsed = {};
    }
    if (!response.ok) {
      const envelope =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      const error =
        envelope.error &&
        typeof envelope.error === 'object' &&
        !Array.isArray(envelope.error)
          ? (envelope.error as Record<string, unknown>)
          : {};
      const code =
        typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code)
          ? error.code
          : 'REQUEST_FAILED';
      throw new ExplainerError(
        code,
        response.status === 401
          ? 'Your account session changed or expired. Sign in again before reading a transaction.'
          : response.status === 429
            ? 'Too many transaction reads. Wait a moment before trying again.'
            : (errorMessages[code] ??
              'The transaction read did not complete. Your entered signature is still here.'),
        response.status,
      );
    }
    if (!response.headers.get('content-type')?.includes('application/json'))
      return invalid();
    return parseExplanation(record(parsed).explanation, candidate);
  } catch (error) {
    if (options.signal?.aborted)
      throw new DOMException('Aborted', 'AbortError');
    if (timedOut)
      throw new ExplainerError(
        'REQUEST_TIMEOUT',
        'The transaction read timed out. Your entered signature is still here.',
      );
    if (error instanceof ExplainerError) throw error;
    throw new ExplainerError(
      'READ_UNAVAILABLE',
      'The transaction read did not complete. Your entered signature is still here.',
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
