import bs58 from 'bs58';

export type DepositCluster = 'devnet' | 'mainnet-beta';
export type DepositCapability = {
  configured: boolean;
  recoveryConfigured: boolean;
  reason: string;
  cluster: DepositCluster | null;
  mint: string | null;
  maximumUsd6: string | null;
  recipientWallet: string | null;
  recipientTokenAccount: string | null;
  intentSeconds: 900;
  networkVerified: false;
  transactionFormat: 'spl-transfer-checked-v1';
  walletSubmission: boolean;
};
export type DepositIntent = {
  id: string;
  state: 'awaiting_payment' | 'credited';
  status: 'awaiting_payment' | 'expired' | 'credited';
  paymentWindowOpen: boolean;
  canReconcile: boolean;
  amountUsd6: string;
  reference: string;
  cluster: DepositCluster;
  mint: string;
  recipientWallet: string;
  recipientTokenAccount: string;
  sourceWallet: string;
  createdAt: string;
  expiresAt: string;
  settlement: null | {
    signature: string;
    transactionId: string;
    slot: string;
    blockTime: number;
    verifiedAt: string;
  };
};
export type DepositCreation = Readonly<{
  amountUsd6: string;
  sourceWallet: string;
  idempotencyKey: string;
}>;
export class DepositClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'DepositClientError';
    this.code = code;
    this.status = status;
  }
}
const mints = {
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;
const maximumAmount = 9_000_000_000_000_000n;
const invalid = (): never => {
  throw new DepositClientError(
    'INVALID_RESPONSE',
    'The deposit response could not be checked. Read the saved intent before continuing.',
  );
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    return invalid();
  return value;
};
const bool = (value: unknown): boolean => {
  if (typeof value !== 'boolean') return invalid();
  return value;
};
const uuid = (value: unknown): string => {
  const parsed = text(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      parsed,
    )
  )
    return invalid();
  return parsed;
};
const timestamp = (value: unknown): string => {
  const parsed = text(value, 40);
  if (!parsed.endsWith('Z') || !Number.isFinite(Date.parse(parsed)))
    return invalid();
  return parsed;
};
const amount = (value: unknown): string => {
  const parsed = text(value, 16);
  if (!/^[1-9][0-9]{0,15}$/.test(parsed) || BigInt(parsed) > maximumAmount)
    return invalid();
  return parsed;
};
const cluster = (value: unknown): DepositCluster => {
  if (value !== 'devnet' && value !== 'mainnet-beta') return invalid();
  return value;
};
const base58 = (value: unknown, length: number): string => {
  const parsed = text(value, Math.ceil(length * 1.38));
  try {
    const bytes = bs58.decode(parsed);
    if (bytes.length !== length || bs58.encode(bytes) !== parsed)
      return invalid();
    return parsed;
  } catch {
    return invalid();
  }
};
const address = (value: unknown) => base58(value, 32);
const nullable = <T>(value: unknown, parse: (v: unknown) => T): T | null =>
  value === null ? null : parse(value);
export function parseDepositAmount(value: string): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/.test(value.trim())
  )
    throw new DepositClientError(
      'INVALID_AMOUNT',
      'Enter a positive USDC amount with at most six decimal places, such as 5 or 0.500001.',
    );
  const [whole, fraction = ''] = value.trim().split('.');
  const parsed = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (parsed <= 0n || parsed > maximumAmount)
    throw new DepositClientError(
      'INVALID_AMOUNT',
      'The amount is outside the supported range.',
    );
  return parsed.toString();
}
export function formatDepositAmount(value: string): string {
  const parsed = BigInt(amount(value));
  return `${parsed / 1_000_000n}.${(parsed % 1_000_000n).toString().padStart(6, '0')}`;
}
export function depositSignature(value: string): string {
  try {
    return base58(typeof value === 'string' ? value.trim() : value, 64);
  } catch {
    throw new DepositClientError(
      'INVALID_SIGNATURE',
      'Enter one existing Solana transaction signature in base58 format, not a wallet address or a transaction URL.',
    );
  }
}
export function parseDepositCapability(value: unknown): DepositCapability {
  const c = record(value);
  if (
    c.intentSeconds !== 900 ||
    c.networkVerified !== false ||
    c.transactionFormat !== 'spl-transfer-checked-v1'
  )
    return invalid();
  const parsed: DepositCapability = {
    configured: bool(c.configured),
    recoveryConfigured: bool(c.recoveryConfigured),
    reason: text(c.reason, 160),
    cluster: nullable(c.cluster, cluster),
    mint: nullable(c.mint, address),
    maximumUsd6: nullable(c.maximumUsd6, amount),
    recipientWallet: nullable(c.recipientWallet, address),
    recipientTokenAccount: nullable(c.recipientTokenAccount, address),
    intentSeconds: 900,
    networkVerified: false,
    transactionFormat: 'spl-transfer-checked-v1',
    walletSubmission: bool(c.walletSubmission),
  };
  if (
    parsed.mint !== null &&
    (!parsed.cluster || parsed.mint !== mints[parsed.cluster])
  )
    return invalid();
  if (
    (parsed.configured || parsed.recoveryConfigured) &&
    (!parsed.cluster ||
      parsed.mint !== mints[parsed.cluster] ||
      !parsed.recipientWallet ||
      !parsed.recipientTokenAccount ||
      parsed.recipientWallet === parsed.recipientTokenAccount)
  )
    return invalid();
  if (parsed.configured && !parsed.maximumUsd6) return invalid();
  if (parsed.walletSubmission && !parsed.configured) return invalid();
  return parsed;
}
export function parseDeposit(
  value: unknown,
  expectedId?: string,
): DepositIntent {
  const d = record(value),
    network = cluster(d.cluster);
  if (
    !['awaiting_payment', 'credited'].includes(String(d.state)) ||
    !['awaiting_payment', 'expired', 'credited'].includes(String(d.status))
  )
    return invalid();
  const parsed: DepositIntent = {
    id: uuid(d.id),
    state: d.state as DepositIntent['state'],
    status: d.status as DepositIntent['status'],
    paymentWindowOpen: bool(d.paymentWindowOpen),
    canReconcile: bool(d.canReconcile),
    amountUsd6: amount(d.amountUsd6),
    reference: address(d.reference),
    cluster: network,
    mint: address(d.mint),
    recipientWallet: address(d.recipientWallet),
    recipientTokenAccount: address(d.recipientTokenAccount),
    sourceWallet: address(d.sourceWallet),
    createdAt: timestamp(d.createdAt),
    expiresAt: timestamp(d.expiresAt),
    settlement: null,
  };
  if (
    (expectedId && parsed.id !== expectedId) ||
    parsed.mint !== mints[network] ||
    Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt) ||
    new Set([
      parsed.reference,
      parsed.mint,
      parsed.recipientWallet,
      parsed.recipientTokenAccount,
      parsed.sourceWallet,
    ]).size !== 5
  )
    return invalid();
  if (
    (parsed.state === 'credited') !== (parsed.status === 'credited') ||
    (parsed.paymentWindowOpen && parsed.status !== 'awaiting_payment') ||
    (parsed.state === 'credited' && parsed.canReconcile)
  )
    return invalid();
  if (d.settlement !== null) {
    const s = record(d.settlement),
      slot = text(s.slot, 16);
    if (
      !/^(0|[1-9][0-9]{0,15})$/.test(slot) ||
      BigInt(slot) > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof s.blockTime !== 'number' ||
      !Number.isSafeInteger(s.blockTime) ||
      s.blockTime < Math.floor(Date.parse(parsed.createdAt) / 1000) ||
      s.blockTime >= Math.floor(Date.parse(parsed.expiresAt) / 1000)
    )
      return invalid();
    parsed.settlement = {
      signature: base58(s.signature, 64),
      transactionId: uuid(s.transactionId),
      slot,
      blockTime: s.blockTime,
      verifiedAt: timestamp(s.verifiedAt),
    };
  }
  if ((parsed.state === 'credited') !== (parsed.settlement !== null))
    return invalid();
  return parsed;
}
export function makeDepositCreation(
  amountUsd6: string,
  sourceWallet: string,
  idempotencyKey: string,
): DepositCreation {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) return invalid();
  return Object.freeze({
    amountUsd6: amount(amountUsd6),
    sourceWallet: address(sourceWallet),
    idempotencyKey,
  });
}
export function sameDepositTerms(a: DepositIntent, b: DepositIntent): boolean {
  return (
    [
      'id',
      'amountUsd6',
      'sourceWallet',
      'reference',
      'cluster',
      'mint',
      'recipientWallet',
      'recipientTokenAccount',
      'createdAt',
      'expiresAt',
    ] as const
  ).every((key) => a[key] === b[key]);
}
const errors: Record<string, string> = {
  DEPOSITS_UNAVAILABLE:
    'New deposits are disabled or missing operator configuration. No transfer is initiated by this interface.',
  DEPOSIT_RECOVERY_UNAVAILABLE:
    'Deposit recovery is not enabled for this network. Keep the original intent and transaction signature.',
  DEPOSIT_POLICY_UNAVAILABLE:
    'The original intent’s network and treasury are not configured for recovery. Keep its ID and original transaction signature.',
  DEPOSIT_INTENT_LIMIT:
    'This account already has the maximum number of active intents. Open an existing intent or wait for its payment window to close.',
  INVALID_DEPOSIT_SOURCE:
    'Use your verified source wallet, distinct from the treasury and token accounts.',
  DEPOSIT_LIMIT: 'The amount exceeds the configured deposit limit.',
  DEPOSIT_NOT_FOUND:
    'This deposit intent is unavailable to the current account.',
  DEPOSIT_UNAVAILABLE:
    'This intent is no longer awaiting payment. Read its saved status.',
  DEPOSIT_ALREADY_CREDITED:
    'This intent or transaction was already credited. Read the saved intent and account activity.',
  WALLET_NOT_VERIFIED:
    'Sign in through Account with this source wallet before creating its deposit intent.',
  INVALID_AMOUNT:
    'Enter a positive USDC amount with at most six decimal places within the configured limit.',
  IDEMPOTENCY_CONFLICT:
    'This request key has different saved terms. Read recent intents before creating another.',
  RPC_UNAVAILABLE:
    'Recovery for this intent’s network is not configured. The original signature is retained here.',
  SOLANA_RPC_UNAVAILABLE:
    'The configured Solana reader could not complete verification. Keep the original signature and read the saved intent before trying again.',
  SOLANA_RPC_TIMEOUT:
    'Verification timed out. Keep the original signature and read saved status before checking again.',
  SOLANA_NOT_FINALIZED:
    'This transaction is not available as finalized on the intent’s network. It may be pending, unavailable in RPC history, or from another network.',
  SOLANA_WRONG_CLUSTER:
    'The configured RPC reported a different network. This response did not verify the deposit.',
  SOLANA_TRANSACTION_FAILED:
    'The submitted transaction failed on chain and does not verify a deposit.',
  SOLANA_UNSUPPORTED_TRANSACTION:
    'This transaction version is not supported by the deposit verifier.',
  SOLANA_UNSUPPORTED_INSTRUCTION:
    'This transaction contains an unsupported instruction. Ordinary wallet sends without the required deposit reference may not be accepted.',
  SOLANA_AMBIGUOUS_DEPOSIT:
    'This transaction contains ambiguous transfer evidence and was not accepted as this deposit.',
  SOLANA_DEPOSIT_MISMATCH:
    'The transaction does not match this intent’s amount, source wallet, recipient, reference, or original time window.',
  SOLANA_INVALID_RESPONSE:
    'The network response could not be verified. Read saved status before checking the original signature again.',
  SOLANA_INCOMPLETE_METADATA:
    'The required transaction evidence is incomplete. The deposit has not been verified by this response.',
};
export function depositErrorMessage(error: unknown): string {
  return error instanceof DepositClientError
    ? error.message
    : 'The deposit request did not complete. Read saved status before trying again.';
}
export function createDepositsClient(
  accountId: string,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
) {
  const owner = uuid(accountId);
  const timeoutMs = options.timeoutMs ?? 40000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    return invalid();
  async function request(
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    const abort = new AbortController(),
      relay = () => abort.abort();
    options.signal?.addEventListener('abort', relay, { once: true });
    let timedOut = false,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(
        `/api/${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'same-origin',
          mode: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          signal: abort.signal,
          headers: {
            Accept: 'application/json',
            'X-Conclave-Account-Id': owner,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      abort.signal.throwIfAborted();
      if (response.status === 401) {
        void response.body?.cancel().catch(() => {});
        throw new DepositClientError(
          'ACCOUNT_CHANGED',
          'Your account session changed or expired. Sign in again before accessing deposits.',
          401,
        );
      }
      if (!response.body) return invalid();
      reader = response.body.getReader();
      const limit = response.ok ? 131072 : 65536,
        decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0,
        encoded = '';
      while (true) {
        abort.signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit)
          throw new DepositClientError(
            'RESPONSE_TOO_LARGE',
            'The response exceeded the read limit. Read saved status; an interrupted request may still have completed.',
          );
        encoded += decoder.decode(part.value, { stream: true });
      }
      abort.signal.throwIfAborted();
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
              : {},
          detail =
            envelope.error &&
            typeof envelope.error === 'object' &&
            !Array.isArray(envelope.error)
              ? (envelope.error as Record<string, unknown>)
              : {};
        const code =
          typeof detail.code === 'string' && /^[A-Z_]{1,80}$/.test(detail.code)
            ? detail.code
            : 'REQUEST_FAILED';
        throw new DepositClientError(
          code,
          response.status === 429
            ? 'Too many deposit requests. Wait a moment before trying again.'
            : (errors[code] ??
                'The deposit request did not complete. Read saved status before trying again.'),
          response.status,
        );
      }
      if (!response.headers.get('content-type')?.includes('application/json'))
        return invalid();
      return record(parsed);
    } catch (failure) {
      if (options.signal?.aborted)
        throw new DOMException('Aborted', 'AbortError');
      if (timedOut)
        throw new DepositClientError(
          'REQUEST_TIMEOUT',
          'The request timed out. Read saved status; recover a new intent with its original request key or check the original transaction signature again.',
        );
      if (failure instanceof DepositClientError) throw failure;
      throw new DepositClientError(
        'NETWORK_ERROR',
        'The deposit service could not be reached. Read saved status before retrying the same request.',
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
      abort.abort();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  return {
    async capability(): Promise<DepositCapability> {
      return parseDepositCapability(await request('deposits/capabilities'));
    },
    async wallets(): Promise<string[]> {
      const session = await request('auth/session');
      if (
        session.accountId !== owner ||
        !Array.isArray(session.identities) ||
        session.identities.length > 64
      )
        return invalid();
      const wallets: string[] = [];
      for (const raw of session.identities) {
        const identity = record(raw);
        if (identity.kind === 'solana') wallets.push(address(identity.subject));
        else if (identity.kind !== 'passkey') return invalid();
      }
      return [...new Set(wallets)];
    },
    async list(
      cursor?: string | null,
    ): Promise<{ deposits: DepositIntent[]; nextCursor: string | null }> {
      const page = await request(
        `deposits${cursor ? `?${new URLSearchParams({ cursor: text(cursor, 2048) })}` : ''}`,
      );
      if (!Array.isArray(page.deposits) || page.deposits.length > 20)
        return invalid();
      const deposits = page.deposits.map((value) => parseDeposit(value));
      if (
        new Set(deposits.map((deposit) => deposit.id)).size !== deposits.length
      )
        return invalid();
      return {
        deposits,
        nextCursor: nullable(page.nextCursor, (value) => text(value, 2048)),
      };
    },
    async read(intentId: string): Promise<DepositIntent> {
      return parseDeposit(
        (await request(`deposits/${uuid(intentId)}`)).deposit,
        intentId,
      );
    },
    async create(
      input: DepositCreation,
      expected: DepositCapability,
    ): Promise<{ deposit: DepositIntent; replayed: boolean }> {
      const body = makeDepositCreation(
        input.amountUsd6,
        input.sourceWallet,
        input.idempotencyKey,
      );
      const response = await request('deposits', body),
        deposit = parseDeposit(response.deposit);
      if (
        deposit.amountUsd6 !== body.amountUsd6 ||
        deposit.sourceWallet !== body.sourceWallet ||
        deposit.cluster !== expected.cluster ||
        deposit.mint !== expected.mint ||
        deposit.recipientWallet !== expected.recipientWallet ||
        deposit.recipientTokenAccount !== expected.recipientTokenAccount
      )
        return invalid();
      return { deposit, replayed: bool(response.replayed) };
    },
    async reconcile(
      intent: DepositIntent,
      signature: string,
    ): Promise<{
      deposit: DepositIntent;
      credited: true;
      replayed: boolean;
      transactionId: string;
    }> {
      const candidate = depositSignature(signature),
        response = await request(`deposits/${uuid(intent.id)}/reconcile`, {
          signature: candidate,
        });
      const deposit = parseDeposit(response.deposit, intent.id),
        transactionId = uuid(response.transactionId);
      if (
        response.credited !== true ||
        deposit.state !== 'credited' ||
        !sameDepositTerms(intent, deposit) ||
        deposit.settlement?.signature !== candidate ||
        deposit.settlement.transactionId !== transactionId
      )
        return invalid();
      return {
        deposit,
        credited: true,
        replayed: bool(response.replayed),
        transactionId,
      };
    },
  };
}
