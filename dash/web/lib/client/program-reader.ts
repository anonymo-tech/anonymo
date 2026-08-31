import bs58 from 'bs58';
import {
  PROGRAM_READER_LIMITS,
  PROGRAM_LOADER_IDS,
  PROGRAM_READER_VERSION,
  PROGRAM_WARNING_SEVERITY,
  type ProgramHistoryEvent,
  type ProgramInspection,
  type ProgramWarning,
} from '../solana/program-reader.ts';

export type { ProgramInspection } from '../solana/program-reader.ts';
export class ProgramReaderError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'ProgramReaderError';
    this.code = code;
    this.status = status;
  }
}
const networks = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;
const invalid = (): never => {
  throw new ProgramReaderError(
    'INVALID_RESPONSE',
    'The program response could not be checked consistently. No result is shown.',
  );
};
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    return invalid();
  return result;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /\p{Cc}/u.test(value.replace(/[\t\r\n]/g, ''))
  )
    return invalid();
  return value;
}
function integer(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
  min = 0,
): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= min &&
    value <= max
    ? value
    : invalid();
}
function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}
function choice<const T extends string>(
  value: unknown,
  choices: readonly T[],
): T {
  return typeof value === 'string' && choices.includes(value as T)
    ? (value as T)
    : invalid();
}
function list<T>(
  value: unknown,
  max: number,
  parse: (value: unknown) => T,
): T[] {
  return Array.isArray(value) && value.length <= max
    ? value.map(parse)
    : invalid();
}
function base58(value: unknown, size = 32): string {
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
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

export function programAddress(value: string): string {
  try {
    if (typeof value !== 'string') return invalid();
    return base58(value.trim());
  } catch {
    throw new ProgramReaderError(
      'INVALID_ADDRESS',
      'Enter one Solana program address in base58 format, not a URL, private key, or recovery phrase.',
    );
  }
}
export function programReaderErrorMessage(error: unknown): string {
  return error instanceof ProgramReaderError
    ? error.message
    : 'The program read did not complete. Your entered address is still here.';
}
function warning(value: unknown): ProgramWarning {
  const entry = record(value, ['code', 'severity', 'message']);
  if (
    typeof entry.code !== 'string' ||
    !Object.hasOwn(PROGRAM_WARNING_SEVERITY, entry.code)
  )
    return invalid();
  const code = entry.code as ProgramWarning['code'];
  const severity = choice(entry.severity, ['info', 'warning']);
  if (PROGRAM_WARNING_SEVERITY[code] === 'warning' && severity !== 'warning')
    return invalid();
  return { code, severity, message: text(entry.message, 1024) };
}
function historyEvent(value: unknown): ProgramHistoryEvent {
  const entry = record(value, [
    'signature',
    'slot',
    'blockTime',
    'kind',
    'instruction',
    'loader',
  ]);
  const instruction = text(entry.instruction, 16);
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2}))?$/.test(instruction))
    return invalid();
  return {
    signature: base58(entry.signature, 64),
    slot: integer(entry.slot),
    blockTime: nullable(entry.blockTime, (value) =>
      integer(value, 8_640_000_000_000),
    ),
    kind: choice(entry.kind, ['deploy', 'upgrade', 'deploy-or-redeploy']),
    instruction,
    loader: choice(entry.loader, ['v1', 'v2', 'v3', 'v4']),
  };
}

/** A finalized loader-state snapshot is not a verified build or a safety verdict. */
export function parseProgramInspection(
  value: unknown,
  expectedAddress: string,
): ProgramInspection {
  const root = record(value, [
    'readerVersion',
    'cluster',
    'genesisHash',
    'address',
    'contextSlot',
    'finality',
    'exists',
    'owner',
    'executable',
    'loader',
    'status',
    'programDataAddress',
    'authority',
    'mutability',
    'lastDeploymentSlot',
    'loaderStateSlot',
    'nextVersionAddress',
    'verifiedBuild',
    'history',
    'warnings',
  ]);
  const cluster = choice(root.cluster, ['devnet', 'mainnet-beta']);
  if (
    root.readerVersion !== PROGRAM_READER_VERSION ||
    root.finality !== 'finalized' ||
    root.verifiedBuild !== 'not-checked' ||
    root.genesisHash !== networks[cluster]
  )
    return invalid();
  const address = base58(root.address);
  if (address !== programAddress(expectedAddress)) return invalid();
  const authorityInput = record(root.authority, ['status', 'address']);
  const authority: ProgramInspection['authority'] = {
    status: choice(authorityInput.status, ['present', 'none', 'unknown']),
    address: nullable(authorityInput.address, base58),
  };
  if ((authority.status === 'present') !== (authority.address !== null))
    return invalid();
  const historyInput = record(root.history, [
    'status',
    'address',
    'limit',
    'scannedSignatures',
    'verifiedTransactions',
    'unavailableTransactions',
    'complete',
    'events',
  ]);
  if (
    historyInput.limit !== PROGRAM_READER_LIMITS.historySignatures ||
    historyInput.complete !== false
  )
    return invalid();
  const history: ProgramInspection['history'] = {
    status: choice(historyInput.status, [
      'not-scanned',
      'bounded',
      'unavailable',
    ]),
    address: nullable(historyInput.address, base58),
    limit: 8,
    scannedSignatures: integer(
      historyInput.scannedSignatures,
      PROGRAM_READER_LIMITS.historySignatures,
    ),
    verifiedTransactions: integer(
      historyInput.verifiedTransactions,
      PROGRAM_READER_LIMITS.historySignatures,
    ),
    unavailableTransactions: integer(
      historyInput.unavailableTransactions,
      PROGRAM_READER_LIMITS.historySignatures,
    ),
    complete: false,
    events: list(
      historyInput.events,
      PROGRAM_READER_LIMITS.historyEvents,
      historyEvent,
    ),
  };
  if (
    history.verifiedTransactions + history.unavailableTransactions >
      history.scannedSignatures ||
    new Set(history.events.map((event) => event.signature)).size >
      history.verifiedTransactions
  )
    return invalid();
  if (
    new Set(
      history.events.map((event) => `${event.signature}:${event.instruction}`),
    ).size !== history.events.length
  )
    return invalid();
  if (
    history.status === 'not-scanned' &&
    (history.scannedSignatures ||
      history.verifiedTransactions ||
      history.unavailableTransactions ||
      history.events.length ||
      history.address !== null)
  )
    return invalid();
  if (history.status !== 'not-scanned' && history.address === null)
    return invalid();
  if (
    history.status === 'unavailable' &&
    (history.scannedSignatures ||
      history.verifiedTransactions ||
      history.unavailableTransactions ||
      history.events.length)
  )
    return invalid();
  const result: ProgramInspection = {
    readerVersion: PROGRAM_READER_VERSION,
    cluster,
    genesisHash: networks[cluster],
    address,
    contextSlot: integer(root.contextSlot),
    finality: 'finalized',
    exists: bool(root.exists),
    owner: nullable(root.owner, base58),
    executable: nullable(root.executable, bool),
    loader: nullable(root.loader, (value) =>
      choice(value, ['v1', 'v2', 'v3', 'v4', 'native', 'unknown']),
    ),
    status: choice(root.status, [
      'not-found',
      'not-program',
      'unsupported',
      'deployed',
      'retracted',
      'finalized',
    ]),
    programDataAddress: nullable(root.programDataAddress, base58),
    authority,
    mutability: choice(root.mutability, [
      'upgradeable',
      'immutable',
      'unknown',
    ]),
    lastDeploymentSlot: nullable(root.lastDeploymentSlot, integer),
    loaderStateSlot: nullable(root.loaderStateSlot, integer),
    nextVersionAddress: nullable(root.nextVersionAddress, base58),
    verifiedBuild: 'not-checked',
    history,
    warnings: list(
      root.warnings,
      Object.keys(PROGRAM_WARNING_SEVERITY).length,
      warning,
    ),
  };
  const codes = new Set(result.warnings.map((entry) => entry.code));
  if (codes.size !== result.warnings.length || !codes.has('BUILD_UNVERIFIED'))
    return invalid();
  if (history.status !== 'not-scanned' && !codes.has('HISTORY_BOUNDED'))
    return invalid();
  if (authority.status === 'unknown' && result.mutability !== 'unknown')
    return invalid();
  if (authority.status === 'present' && result.mutability !== 'upgradeable')
    return invalid();
  if (authority.status === 'none' && result.mutability !== 'immutable')
    return invalid();
  if (result.mutability === 'upgradeable' && authority.status !== 'present')
    return invalid();
  if (result.mutability === 'immutable' && authority.status !== 'none')
    return invalid();
  if (authority.status === 'present' && !codes.has('UPGRADE_AUTHORITY'))
    return invalid();
  if (result.status === 'not-found' && !codes.has('ACCOUNT_NOT_FOUND'))
    return invalid();
  if (result.status === 'not-program' && !codes.has('NOT_PROGRAM'))
    return invalid();
  if (
    result.status === 'unsupported' &&
    !codes.has('UNSUPPORTED_LOADER') &&
    !codes.has('UNSUPPORTED_STATE')
  )
    return invalid();
  if (result.status === 'retracted' && !codes.has('PROGRAM_RETRACTED'))
    return invalid();
  if (
    result.nextVersionAddress !== null &&
    !codes.has('NEXT_VERSION_UNINSPECTED')
  )
    return invalid();
  if (history.status === 'unavailable' && !codes.has('HISTORY_UNAVAILABLE'))
    return invalid();
  if (history.unavailableTransactions > 0 && !codes.has('HISTORY_INCOMPLETE'))
    return invalid();
  if (
    result.lastDeploymentSlot !== null &&
    result.lastDeploymentSlot > result.contextSlot
  )
    return invalid();
  if (
    result.loaderStateSlot !== null &&
    result.loaderStateSlot > result.contextSlot
  )
    return invalid();
  if (!result.exists) {
    if (
      result.status !== 'not-found' ||
      result.owner !== null ||
      result.executable !== null ||
      result.loader !== null
    )
      return invalid();
  } else if (
    result.status === 'not-found' ||
    result.owner === null ||
    result.executable === null ||
    result.loader === null
  )
    return invalid();
  if (result.status === 'not-program' && result.executable !== false)
    return invalid();
  if (
    result.status === 'unsupported' &&
    (result.executable !== true ||
      result.loader === 'v1' ||
      result.loader === 'v2')
  )
    return invalid();
  if (
    result.loader !== null &&
    result.loader !== 'unknown' &&
    result.owner !== PROGRAM_LOADER_IDS[result.loader]
  )
    return invalid();
  if (
    result.loader === 'unknown' &&
    Object.values(PROGRAM_LOADER_IDS).some((owner) => owner === result.owner)
  )
    return invalid();
  const decoded = ['deployed', 'retracted', 'finalized'].includes(
    result.status,
  );
  if (!decoded) {
    if (
      result.authority.status !== 'unknown' ||
      result.mutability !== 'unknown' ||
      result.lastDeploymentSlot !== null ||
      result.loaderStateSlot !== null ||
      result.nextVersionAddress !== null ||
      result.programDataAddress !== null ||
      history.status !== 'not-scanned'
    )
      return invalid();
  } else {
    if (
      !result.exists ||
      result.executable !== true ||
      result.loader === null ||
      result.loader === 'native' ||
      result.loader === 'unknown'
    )
      return invalid();
    if (result.loader === 'v1' || result.loader === 'v2') {
      if (
        result.status !== 'deployed' ||
        result.authority.status !== 'none' ||
        result.mutability !== 'immutable' ||
        result.programDataAddress !== null ||
        result.lastDeploymentSlot !== null ||
        result.loaderStateSlot !== null ||
        result.nextVersionAddress !== null
      )
        return invalid();
    } else if (result.loader === 'v3') {
      if (
        result.status !== 'deployed' ||
        result.programDataAddress === null ||
        result.lastDeploymentSlot === null ||
        result.loaderStateSlot !== null ||
        result.nextVersionAddress !== null ||
        result.authority.status === 'unknown'
      )
        return invalid();
    } else {
      if (
        result.programDataAddress !== null ||
        result.loaderStateSlot === null ||
        result.nextVersionAddress !== null ||
        history.events.length !== 0 ||
        !codes.has('LOADER_VERSION_UNVERIFIED') ||
        !codes.has('HISTORY_INCOMPLETE')
      )
        return invalid();
      if (result.status === 'finalized') {
        if (
          result.authority.status !== 'none' ||
          result.mutability !== 'immutable'
        )
          return invalid();
      } else if (
        result.authority.status !== 'present' ||
        result.mutability !== 'upgradeable' ||
        result.nextVersionAddress !== null
      )
        return invalid();
      if (result.status === 'retracted') {
        if (result.lastDeploymentSlot !== null) return invalid();
      } else if (result.lastDeploymentSlot !== result.loaderStateSlot)
        return invalid();
    }
    if (
      history.status === 'not-scanned' ||
      history.address !== (result.programDataAddress ?? result.address)
    )
      return invalid();
  }
  if (
    history.events.some(
      (event) =>
        event.loader !== result.loader ||
        event.slot > result.contextSlot ||
        ((event.loader === 'v1' || event.loader === 'v2') &&
          event.kind !== 'deploy') ||
        (event.loader === 'v3' &&
          event.kind !== 'deploy' &&
          event.kind !== 'upgrade') ||
        event.loader === 'v4',
    )
  )
    return invalid();
  if (
    history.events.some(
      (event, index) =>
        index > 0 && event.slot > history.events[index - 1]!.slot,
    )
  )
    return invalid();
  return result;
}

const messages: Record<string, string> = {
  RPC_UNAVAILABLE:
    'A Solana RPC network is not configured for this workspace. Your entered address is still here.',
  SOLANA_RPC_UNAVAILABLE:
    'The configured RPC could not complete this read. Your entered address is still here; try again later.',
  SOLANA_RPC_TIMEOUT:
    'The RPC read timed out. No transaction was sent. You can try reading this address again.',
  SOLANA_WRONG_CLUSTER:
    'The RPC reported a different network than the configured cluster. No program result is shown.',
  SOLANA_INVALID_CONFIGURATION:
    'The Solana reader is not configured correctly. No program result is available.',
  SOLANA_INVALID_RESPONSE:
    'The RPC response could not be checked consistently. No program result is shown.',
};

/** Explicit account-bound read; no mount request, storage, automatic retry or write method. */
export async function readProgramInspection(
  address: string,
  accountId: string,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ProgramInspection> {
  const candidate = programAddress(address);
  if (
    typeof accountId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      accountId,
    )
  )
    throw new ProgramReaderError(
      'ACCOUNT_REQUIRED',
      'Sign in to inspect a program.',
      401,
    );
  options.signal?.throwIfAborted();
  const controller = new AbortController(),
    timeoutMs = options.timeoutMs ?? 35000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new ProgramReaderError(
      'INVALID_TIMEOUT',
      'The program read could not start.',
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
      const cancel = () => reject(new DOMException('Aborted', 'AbortError'));
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
        (error) => {
          controller.signal.removeEventListener('abort', cancel);
          reject(error);
        },
      );
    });
  try {
    const response = await wait(
      (options.fetch ?? globalThis.fetch)('/api/program-inspections', {
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
        body: JSON.stringify({ address: candidate }),
      }).then((response) => {
        if (controller.signal.aborted)
          void response.body?.cancel().catch(() => {});
        return response;
      }),
    );
    controller.signal.throwIfAborted();
    if (response.status === 401) {
      void response.body?.cancel().catch(() => {});
      throw new ProgramReaderError(
        'ACCOUNT_REQUIRED',
        'Your account session changed or expired. Sign in again before reading a program.',
        401,
      );
    }
    const limit = response.ok ? 65536 : 16384;
    if (!response.body) return invalid();
    reader = response.body.getReader();
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^[0-9]+$/.test(declared) || Number(declared) > limit)
    )
      return invalid();
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    )
      return invalid();
    let encoded = '',
      bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      controller.signal.throwIfAborted();
      const part = await wait(reader.read());
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit)
        throw new ProgramReaderError(
          'RESPONSE_TOO_LARGE',
          'The program response exceeded this view’s read limit. No result is shown.',
        );
      encoded += decoder.decode(part.value, { stream: true });
    }
    controller.signal.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded + decoder.decode());
    } catch {
      return invalid();
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
      throw new ProgramReaderError(
        code,
        response.status === 429
          ? 'Too many program reads. Wait a moment before trying again.'
          : (messages[code] ??
              'The program read did not complete. Your entered address is still here.'),
        response.status,
      );
    }
    return parseProgramInspection(
      record(parsed, ['program']).program,
      candidate,
    );
  } catch (failure) {
    if (options.signal?.aborted)
      throw new DOMException('Aborted', 'AbortError');
    if (timedOut)
      throw new ProgramReaderError(
        'REQUEST_TIMEOUT',
        'The program read timed out. Your entered address is still here.',
      );
    if (failure instanceof ProgramReaderError) throw failure;
    throw new ProgramReaderError(
      'READ_UNAVAILABLE',
      'The program read did not complete. Your entered address is still here.',
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
