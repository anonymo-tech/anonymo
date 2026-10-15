export type LedgerEntry = {
  id: string;
  kind:
    | 'deposit'
    | 'hold'
    | 'capture'
    | 'release'
    | 'refund'
    | 'internal_test_credit'
    | 'promotional_credit';
  createdAt: string;
  availableDeltaUsd6: string;
  reservedDeltaUsd6: string;
};
export type ReceiptSummary = {
  id: string;
  issuedAt: string;
  actualUsd6: string;
  state: 'signed_pending_batch' | 'signed_pending_anchor';
} & (
  | { kind: 'call'; callId: string; mediaJobId?: never }
  | { kind: 'media'; callId: null; mediaJobId: string }
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Account records could not be verified.');
  return value as Record<string, unknown>;
}
function identifier(value: unknown) {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new Error('Account records could not be verified.');
  return value;
}
function date(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('Account records could not be verified.');
  return value;
}
function money(value: unknown, signed = false) {
  if (
    typeof value !== 'string' ||
    !(signed ? /^-?(0|[1-9]\d{0,15})$/ : /^(0|[1-9]\d{0,15})$/).test(value)
  )
    throw new Error('Account amounts could not be verified.');
  return value;
}
function cursor(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(value))
    throw new Error('Account records could not be verified.');
  return value;
}

export function formatAccountUsd6(value: string) {
  const amount = BigInt(money(value, true)),
    absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '−' : ''}${absolute / 1_000_000n}.${(
    absolute % 1_000_000n
  )
    .toString()
    .padStart(6, '0')
    .replace(/0{1,4}$/, '')}`;
}

export function createAccountRecordsClient(
  accountId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
) {
  identifier(accountId);
  async function get(path: string) {
    const response = await fetcher(`/api/${path}`, {
      method: 'GET',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: { 'X-Conclave-Account-Id': accountId },
    });
    if (response.status === 401) {
      if (typeof window !== 'undefined')
        window.dispatchEvent(
          new CustomEvent('conclave:session-change', {
            detail: { reason: 'signed-out' },
          }),
        );
      throw new Error(
        'Your session changed. Sign in again to view account records.',
      );
    }
    if (!response.ok)
      throw new Error('Account records are unavailable. Refresh to try again.');
    if (
      !response.headers.get('content-type')?.includes('application/json') ||
      !response.body
    )
      throw new Error('Account records could not be verified.');
    const reader = response.body.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0,
      text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 262144)
          throw new Error('Account records exceed the download limit.');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return record(JSON.parse(text));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return {
    async ledger(next?: string | null) {
      const value = await get(
        `ledger${next ? `?cursor=${encodeURIComponent(cursor(next)!)}` : ''}`,
      );
      if (!Array.isArray(value.entries) || value.entries.length > 50)
        throw new Error('Account records could not be verified.');
      const entries: LedgerEntry[] = value.entries.map((item) => {
        const row = record(item);
        if (
          ![
            'deposit',
            'hold',
            'capture',
            'release',
            'refund',
            'internal_test_credit',
            'promotional_credit',
          ].includes(String(row.kind))
        )
          throw new Error('Account records could not be verified.');
        return {
          id: identifier(row.id),
          kind: row.kind as LedgerEntry['kind'],
          createdAt: date(row.createdAt),
          availableDeltaUsd6: money(row.availableDeltaUsd6, true),
          reservedDeltaUsd6: money(row.reservedDeltaUsd6, true),
        };
      });
      return { entries, nextCursor: cursor(value.nextCursor) };
    },
    async receipts(next?: string | null) {
      const value = await get(
        `receipts${next ? `?cursor=${encodeURIComponent(cursor(next)!)}` : ''}`,
      );
      if (!Array.isArray(value.receipts) || value.receipts.length > 50)
        throw new Error('Account records could not be verified.');
      const receipts: ReceiptSummary[] = value.receipts.map((item) => {
        const row = record(item);
        if (
          !['signed_pending_batch', 'signed_pending_anchor'].includes(
            String(row.state),
          )
        )
          throw new Error('Receipt status could not be verified.');
        const common = {
          id: identifier(row.id),
          issuedAt: date(row.issuedAt),
          actualUsd6: money(row.actualUsd6),
          state: row.state as ReceiptSummary['state'],
        };
        if (row.kind === 'media' && row.callId === null)
          return {
            ...common,
            kind: 'media',
            callId: null,
            mediaJobId: identifier(row.mediaJobId),
          };
        if (
          (row.kind === undefined || row.kind === 'call') &&
          row.mediaJobId === undefined
        )
          return { ...common, kind: 'call', callId: identifier(row.callId) };
        throw new Error('The receipt source could not be verified.');
      });
      return { receipts, nextCursor: cursor(value.nextCursor) };
    },
    async receipt(id: string) {
      const result = await get(`receipts/${identifier(id)}/proof`),
        receipt = record(result.receipt),
        payload = record(receipt.payload);
      if (payload.receiptId !== id || typeof receipt.signature !== 'string')
        throw new Error('The receipt does not match this request.');
      // Downloading a signed document is not proof of signer trust or chain finality.
      return result;
    },
  };
}
