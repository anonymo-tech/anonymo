import bs58 from 'bs58';
import type { SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import type { StandardConnectFeature } from '@wallet-standard/features';
import {
  buildDepositTransaction,
  decodeTransactionBase64,
  encodeTransactionBase64,
  validateSignedDepositTransaction,
  validateUnsignedDepositTransaction,
  type DepositTransactionTerms,
} from '../solana/deposit-transaction.ts';
import {
  parseDeposit,
  sameDepositTerms,
  type DepositIntent,
} from './deposits.ts';
import {
  solanaAccounts,
  type StandardWallet,
  type WalletAccount,
} from './service.ts';

export type DepositPayment = {
  id: string;
  intentId: string;
  state: 'prepared' | 'submitted' | 'finalized' | 'failed' | 'expired';
  sourceTokenAccount: string;
  messageBase64: string;
  unsignedTransaction: string;
  recentBlockhash: string;
  lastValidBlockHeight: string;
  contextSlot: string;
  feeLamports: string;
  createRecipientAccount: boolean;
  recipientWallet: string | null;
  accountCreationLamports: string;
  preparedAt: string;
  expiresAt: string;
  signature: string | null;
  submittedAt: string | null;
  acknowledgedAt: string | null;
  finalizedAt: string | null;
  failureCode: string | null;
  canSign: boolean;
  canSubmit: boolean;
};
export type SignedDepositPayment = Readonly<{
  paymentId: string;
  signedTransaction: string;
}>;
export class DepositPaymentError extends Error {
  readonly code: string;
  readonly status: number;
  readonly outcomeUnknown: boolean;
  constructor(
    code: string,
    message: string,
    status = 0,
    outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'DepositPaymentError';
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}
const invalid = (): never => {
  throw new DepositPaymentError(
    'INVALID_RESPONSE',
    'The saved payment could not be verified. Read its status before continuing.',
  );
};
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid();
  return v as Record<string, unknown>;
};
const id = (v: unknown): string => {
  if (
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    )
  )
    return invalid();
  return v.toLowerCase();
};
const boolean = (v: unknown): boolean =>
  typeof v === 'boolean' ? v : invalid();
const uint = (v: unknown): string => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9][0-9]{0,15})$/.test(v) ||
    BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return invalid();
  return v;
};
const address = (v: unknown, bytes = 32): string => {
  if (typeof v !== 'string' || v.length > 88) return invalid();
  try {
    if (bs58.decode(v).length !== bytes || bs58.encode(bs58.decode(v)) !== v)
      return invalid();
  } catch {
    return invalid();
  }
  return v;
};
const timestamp = (v: unknown): string => {
  if (
    typeof v !== 'string' ||
    v.length > 30 ||
    !v.endsWith('Z') ||
    !Number.isFinite(Date.parse(v))
  )
    return invalid();
  return v;
};
const nullable = <T>(v: unknown, parse: (v: unknown) => T): T | null =>
  v === null ? null : parse(v);
export function depositPaymentTerms(
  payment: Pick<DepositPayment, 'sourceTokenAccount' | 'recentBlockhash'> &
    Partial<Pick<DepositPayment, 'createRecipientAccount' | 'recipientWallet'>>,
  intent: DepositIntent,
): DepositTransactionTerms {
  return {
    sourceWallet: intent.sourceWallet,
    sourceTokenAccount: payment.sourceTokenAccount,
    recipientTokenAccount: intent.recipientTokenAccount,
    mint: intent.mint,
    reference: intent.reference,
    amountUsd6: intent.amountUsd6,
    recentBlockhash: payment.recentBlockhash,
    createRecipientAccount: payment.createRecipientAccount ?? false,
    recipientWallet: intent.recipientWallet,
  };
}
export function parseDepositPayment(
  value: unknown,
  intent: DepositIntent,
): DepositPayment {
  const v = record(value);
  if (
    !['prepared', 'submitted', 'finalized', 'failed', 'expired'].includes(
      String(v.state),
    )
  )
    return invalid();
  const payment: DepositPayment = {
    id: id(v.id),
    intentId: id(v.intentId),
    state: v.state as DepositPayment['state'],
    sourceTokenAccount: address(v.sourceTokenAccount),
    recentBlockhash: address(v.recentBlockhash),
    messageBase64:
      typeof v.messageBase64 === 'string' ? v.messageBase64 : invalid(),
    unsignedTransaction:
      typeof v.unsignedTransaction === 'string'
        ? v.unsignedTransaction
        : invalid(),
    lastValidBlockHeight: uint(v.lastValidBlockHeight),
    contextSlot: uint(v.contextSlot),
    feeLamports: uint(v.feeLamports),
    createRecipientAccount:
      v.createRecipientAccount === undefined
        ? false
        : boolean(v.createRecipientAccount),
    recipientWallet:
      v.recipientWallet === undefined
        ? null
        : nullable(v.recipientWallet, address),
    accountCreationLamports:
      v.accountCreationLamports === undefined
        ? '0'
        : uint(v.accountCreationLamports),
    preparedAt: timestamp(v.preparedAt),
    expiresAt: timestamp(v.expiresAt),
    signature: nullable(v.signature, (v) => address(v, 64)),
    submittedAt: nullable(v.submittedAt, timestamp),
    acknowledgedAt: nullable(v.acknowledgedAt, timestamp),
    finalizedAt: nullable(v.finalizedAt, timestamp),
    failureCode: nullable(v.failureCode, (v) =>
      typeof v === 'string' && /^[A-Z_]{1,80}$/.test(v) ? v : invalid(),
    ),
    canSign: boolean(v.canSign),
    canSubmit: boolean(v.canSubmit),
  };
  if (
    (payment.createRecipientAccount &&
      (payment.recipientWallet !== intent.recipientWallet ||
        payment.accountCreationLamports === '0')) ||
    (!payment.createRecipientAccount &&
      payment.accountCreationLamports !== '0') ||
    (payment.recipientWallet !== null &&
      payment.recipientWallet !== intent.recipientWallet) ||
    payment.intentId !== intent.id ||
    Date.parse(payment.preparedAt) < Date.parse(intent.createdAt) ||
    Date.parse(payment.preparedAt) >= Date.parse(intent.expiresAt) ||
    Date.parse(payment.expiresAt) <= Date.parse(payment.preparedAt) ||
    Date.parse(payment.expiresAt) >
      Math.min(
        Date.parse(intent.expiresAt),
        Date.parse(payment.preparedAt) + 90_000,
      ) ||
    (payment.canSign &&
      (payment.state !== 'prepared' ||
        payment.signature !== null ||
        !intent.paymentWindowOpen)) ||
    (payment.canSubmit &&
      (!['prepared', 'submitted'].includes(payment.state) ||
        !intent.paymentWindowOpen)) ||
    (payment.state === 'prepared' &&
      (payment.signature !== null || payment.submittedAt !== null)) ||
    (payment.state === 'submitted' &&
      (!payment.signature || !payment.submittedAt)) ||
    (payment.acknowledgedAt !== null && !payment.signature) ||
    (payment.finalizedAt !== null && payment.state !== 'finalized') ||
    (payment.state === 'finalized' &&
      (!payment.signature ||
        !payment.finalizedAt ||
        intent.state !== 'credited' ||
        payment.signature !== intent.settlement?.signature))
  )
    return invalid();
  try {
    const terms = depositPaymentTerms(payment, intent),
      built = buildDepositTransaction(terms);
    validateUnsignedDepositTransaction(
      decodeTransactionBase64(payment.unsignedTransaction),
      terms,
    );
    if (encodeTransactionBase64(built.message) !== payment.messageBase64)
      return invalid();
  } catch {
    return invalid();
  }
  return payment;
}
export function sameDepositPayment(
  a: DepositPayment,
  b: DepositPayment,
): boolean {
  return (
    (
      [
        'id',
        'intentId',
        'sourceTokenAccount',
        'unsignedTransaction',
        'messageBase64',
        'recentBlockhash',
        'lastValidBlockHeight',
        'contextSlot',
        'feeLamports',
        'createRecipientAccount',
        'recipientWallet',
        'accountCreationLamports',
        'preparedAt',
        'expiresAt',
      ] as const
    ).every((key) => a[key] === b[key]) &&
    (a.signature === null || a.signature === b.signature)
  );
}
export function formatLamports(value: string) {
  const amount = BigInt(uint(value));
  return `${amount / 1_000_000_000n}.${(amount % 1_000_000_000n).toString().padStart(9, '0')}`;
}
export function depositPaymentErrorMessage(error: unknown): string {
  if (
    error instanceof DepositPaymentError &&
    error.code === 'DEPOSIT_RENT_CHANGED'
  )
    return 'The account-creation rent estimate changed. Check the saved payment status before continuing; do not create another transfer.';
  return error instanceof DepositPaymentError
    ? error.message
    : 'The payment request did not finish. Read the saved payment status before continuing.';
}
function signFeature(wallet: StandardWallet) {
  return wallet.features['solana:signTransaction'] as
    | SolanaSignTransactionFeature['solana:signTransaction']
    | undefined;
}
export function isDepositWallet(wallet: StandardWallet): boolean {
  try {
    const sign = signFeature(wallet),
      connect = wallet.features['standard:connect'] as
        | StandardConnectFeature['standard:connect']
        | undefined,
      events = wallet.features['standard:events'] as
        | { on?: unknown }
        | undefined;
    return (
      typeof wallet.name === 'string' &&
      wallet.name.length > 0 &&
      wallet.name.length <= 80 &&
      wallet.chains.includes('solana:mainnet') &&
      typeof connect?.connect === 'function' &&
      typeof events?.on === 'function' &&
      typeof sign?.signTransaction === 'function' &&
      Array.isArray(sign.supportedTransactionVersions) &&
      sign.supportedTransactionVersions.includes('legacy')
    );
  } catch {
    return false;
  }
}
function matchingAccount(
  wallet: StandardWallet,
  source: string,
  accounts = wallet.accounts,
) {
  return solanaAccounts(accounts).find(
    (account) =>
      account.address === source &&
      account.chains.includes('solana:mainnet') &&
      account.features.includes('solana:signTransaction'),
  );
}
export async function connectDepositWallet(
  wallet: StandardWallet,
  source: string,
): Promise<WalletAccount> {
  if (!isDepositWallet(wallet))
    throw new DepositPaymentError(
      'UNSUPPORTED_WALLET',
      'Choose a Solana mainnet wallet that supports signing a legacy transaction.',
    );
  const result = await (
    wallet.features[
      'standard:connect'
    ] as StandardConnectFeature['standard:connect']
  ).connect();
  const account = matchingAccount(wallet, source, result.accounts);
  if (!account || !matchingAccount(wallet, source))
    throw new DepositPaymentError(
      'WALLET_CHANGED',
      'Connect the exact source wallet saved in this intent.',
    );
  return account;
}
export async function signDepositPayment(
  wallet: StandardWallet,
  account: WalletAccount,
  payment: DepositPayment,
  intent: DepositIntent,
  options: {
    signal?: AbortSignal;
    current?: () => boolean;
    now?: () => number;
  } = {},
): Promise<SignedDepositPayment> {
  const original = parseDeposit(intent);
  const check = () => {
    options.signal?.throwIfAborted();
    if (options.current && !options.current())
      throw new DepositPaymentError(
        'PAYMENT_INTERRUPTED',
        'The account or view changed. No new payment will be submitted. Read saved status.',
      );
    if (
      original.cluster !== 'mainnet-beta' ||
      !isDepositWallet(wallet) ||
      !matchingAccount(wallet, original.sourceWallet) ||
      account.address !== original.sourceWallet ||
      !solanaAccounts([account]).length ||
      !account.chains.includes('solana:mainnet') ||
      !account.features.includes('solana:signTransaction')
    )
      throw new DepositPaymentError(
        'WALLET_CHANGED',
        'The wallet or account no longer matches this mainnet payment.',
      );
  };
  check();
  const snapshot = parseDepositPayment(payment, original);
  if (
    !snapshot.canSign ||
    snapshot.signature ||
    Date.parse(snapshot.expiresAt) <= (options.now?.() ?? Date.now())
  )
    throw new DepositPaymentError(
      'PAYMENT_RECOVERY_ONLY',
      'This payment is no longer available for signing. Check the existing transfer instead.',
    );
  let outputs: Awaited<
    ReturnType<
      SolanaSignTransactionFeature['solana:signTransaction']['signTransaction']
    >
  >;
  try {
    outputs = await signFeature(wallet)!.signTransaction({
      account,
      chain: 'solana:mainnet',
      transaction: decodeTransactionBase64(snapshot.unsignedTransaction),
    });
  } catch {
    check();
    throw new DepositPaymentError(
      'WALLET_DECLINED',
      'The wallet did not return a signed transfer. No transaction was submitted by Conclave.',
    );
  }
  check();
  try {
    if (!Array.isArray(outputs) || outputs.length !== 1) return invalid();
    const verified = validateSignedDepositTransaction(
      outputs[0].signedTransaction,
      depositPaymentTerms(snapshot, original),
    );
    return Object.freeze({
      paymentId: snapshot.id,
      signedTransaction: encodeTransactionBase64(verified.signedTransaction),
    });
  } catch {
    throw new DepositPaymentError(
      'WALLET_TRANSACTION_MISMATCH',
      'The wallet returned a changed or invalid transfer. Conclave did not submit it.',
    );
  }
}
const recoveryMessage =
  'Read the saved payment and recover the same transfer. Do not create another payment.';
export function createDepositPaymentClient(
  accountId: string,
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
) {
  const owner = id(accountId),
    timeoutMs = options.timeoutMs ?? 40000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    return invalid();
  async function request(path: string, body?: unknown) {
    options.signal?.throwIfAborted();
    const controller = new AbortController(),
      relay = () => controller.abort();
    options.signal?.addEventListener('abort', relay, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelRead = () => {
      void reader?.cancel().catch(() => {});
    };
    controller.signal.addEventListener('abort', cancelRead, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(
        `/api/deposits/${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'same-origin',
          mode: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
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
      if (response.status === 401) {
        await response.body?.cancel();
        throw new DepositPaymentError(
          'ACCOUNT_CHANGED',
          'Your account changed or expired. Sign in again before accessing this payment.',
          401,
        );
      }
      if (
        response.headers.get('content-type')?.split(';')[0].trim() !==
          'application/json' ||
        !response.body
      ) {
        await response.body?.cancel();
        return invalid();
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0,
        text = '';
      while (true) {
        controller.signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 32768) return invalid();
        text += decoder.decode(part.value, { stream: true });
      }
      controller.signal.throwIfAborted();
      const result = record(JSON.parse(text + decoder.decode()));
      if (!response.ok) {
        const detail =
          result.error && typeof result.error === 'object'
            ? (result.error as Record<string, unknown>)
            : {};
        const code =
          typeof detail.code === 'string' && /^[A-Z_]{1,80}$/.test(detail.code)
            ? detail.code
            : 'PAYMENT_UNAVAILABLE';
        throw new DepositPaymentError(
          code,
          response.status === 503
            ? `Wallet payment is unavailable. ${recoveryMessage}`
            : response.status === 429
              ? 'Too many requests. Wait before reading saved payment status again.'
              : `The payment request was not completed. ${recoveryMessage}`,
          response.status,
        );
      }
      return result;
    } catch (failure) {
      if (failure instanceof DepositPaymentError) throw failure;
      throw new DepositPaymentError(
        'PAYMENT_INTERRUPTED',
        `The response was interrupted. ${recoveryMessage}`,
      );
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancelRead);
      options.signal?.removeEventListener('abort', relay);
      controller.abort();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  function envelope(
    raw: Record<string, unknown>,
    original: DepositIntent,
    expected?: DepositPayment,
  ) {
    const deposit = parseDeposit(raw.deposit, original.id);
    if (!sameDepositTerms(original, deposit)) return invalid();
    const payment =
      raw.payment === null ? null : parseDepositPayment(raw.payment, deposit);
    if (expected && (!payment || !sameDepositPayment(expected, payment)))
      return invalid();
    return { deposit, payment };
  }
  async function submit(
    intent: DepositIntent,
    payment: DepositPayment,
    approval: SignedDepositPayment,
  ) {
    const original = parseDeposit(intent),
      snapshot = parseDepositPayment(payment, original);
    if (approval.paymentId !== snapshot.id) return invalid();
    const verified = validateSignedDepositTransaction(
      decodeTransactionBase64(approval.signedTransaction),
      depositPaymentTerms(snapshot, original),
    );
    const body = {
      paymentId: snapshot.id,
      signedTransaction: encodeTransactionBase64(verified.signedTransaction),
    };
    try {
      const raw = await request(`${id(original.id)}/payment/submit`, body),
        result = envelope(raw, original, snapshot);
      if (!result.payment || result.payment.signature !== verified.signature)
        return invalid();
      return {
        ...result,
        payment: result.payment,
        submitted: boolean(raw.submitted),
        replayed: boolean(raw.replayed),
      };
    } catch (failure) {
      throw new DepositPaymentError(
        failure instanceof DepositPaymentError
          ? failure.code
          : 'PAYMENT_INTERRUPTED',
        `The submission outcome is not established by this response. ${recoveryMessage}`,
        failure instanceof DepositPaymentError ? failure.status : 0,
        true,
      );
    }
  }
  return {
    async read(intent: DepositIntent, expected?: DepositPayment) {
      const original = parseDeposit(intent);
      return envelope(
        await request(`${id(original.id)}/payment`),
        original,
        expected,
      );
    },
    async prepare(intent: DepositIntent) {
      const original = parseDeposit(intent),
        raw = await request(`${id(original.id)}/payment`, {}),
        result = envelope(raw, original);
      if (!result.payment) return invalid();
      return {
        ...result,
        payment: result.payment,
        replayed: boolean(raw.replayed),
      };
    },
    submit,
    async recover(intent: DepositIntent, cursor: string | null = null) {
      if (cursor !== null && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
        return invalid();
      const original = parseDeposit(intent),
        raw = await request(`${id(original.id)}/recover`, { cursor });
      const deposit = parseDeposit(raw.deposit, original.id),
        search = record(raw.search),
        credited = boolean(raw.credited);
      if (
        !sameDepositTerms(original, deposit) ||
        credited !== (deposit.state === 'credited') ||
        typeof search.checked !== 'number' ||
        !Number.isInteger(search.checked) ||
        search.checked < 0 ||
        search.checked > 8 ||
        search.exhaustive !== false ||
        !['credited', 'no_match_on_page', 'incomplete'].includes(
          String(search.status),
        ) ||
        credited !== (search.status === 'credited') ||
        (search.nextCursor !== null &&
          (typeof search.nextCursor !== 'string' ||
            !/^[A-Za-z0-9_-]{1,512}$/.test(search.nextCursor)))
      )
        return invalid();
      const transactionId = nullable(raw.transactionId, id);
      if (
        credited
          ? transactionId !== deposit.settlement?.transactionId
          : transactionId !== null
      )
        return invalid();
      return {
        deposit,
        credited,
        replayed: boolean(raw.replayed),
        transactionId,
        search: {
          checked: search.checked,
          nextCursor: search.nextCursor as string | null,
          status: search.status as
            | 'credited'
            | 'no_match_on_page'
            | 'incomplete',
          exhaustive: false as const,
        },
      };
    },
    async retry(intent: DepositIntent, payment: DepositPayment) {
      const original = parseDeposit(intent),
        snapshot = parseDepositPayment(payment, original);
      if (!snapshot.signature) return invalid();
      try {
        const raw = await request(`${id(original.id)}/payment/retry`, {
            paymentId: snapshot.id,
          }),
          result = envelope(raw, original, snapshot);
        if (!result.payment) return invalid();
        return {
          ...result,
          payment: result.payment,
          submitted: boolean(raw.submitted),
          replayed: boolean(raw.replayed),
        };
      } catch (failure) {
        throw new DepositPaymentError(
          failure instanceof DepositPaymentError
            ? failure.code
            : 'PAYMENT_INTERRUPTED',
          `The resubmission outcome is not established. ${recoveryMessage}`,
          failure instanceof DepositPaymentError ? failure.status : 0,
          true,
        );
      }
    },
  };
}
