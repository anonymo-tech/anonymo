import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ServiceError, requireCondition } from '../core/errors.ts';
import { one, transaction } from '../db/database.ts';
import {
  epoch,
  exactObject,
  hex,
  identifier,
  toBytes,
  utcTime,
} from './canonical.ts';
import {
  buildReceiptTree,
  MAX_RECEIPTS_PER_TREE,
  normalizeRoot,
  normalizeSignedReceipt,
  receiptAccountCommitment,
  receiptPublicKey,
  signReceipt,
  signerMapKey,
  verifyReceiptInclusion,
  verifyReceiptSignature,
  type ReceiptProof,
  type ReceiptRoot,
  type SignedReceipt,
  type TrustedSigner,
  type TrustedSignerMap,
} from './index.ts';

export type ReceiptSigner = {
  keyId: string;
  epoch: number;
  seed: Uint8Array;
  trust: TrustedSignerMap;
};
export type ReceiptBatch = {
  id: string;
  hour: string;
  state: 'pending_anchor';
  root: ReceiptRoot;
};
export type ReceiptEnvelope = {
  receipt: SignedReceipt;
  batch: (ReceiptBatch & { proof: ReceiptProof }) | null;
};
const MAX_SIGNER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const publicationLock =
  "SELECT pg_advisory_xact_lock(hashtext('conclave_receipt_publication_v1'))";
const unavailable = () =>
  new ServiceError(
    503,
    'RECEIPT_SIGNER_UNAVAILABLE',
    'Receipt signing is not configured for the current period.',
  );
const integrity = () =>
  new ServiceError(
    409,
    'RECEIPT_INTEGRITY_FAILED',
    'This receipt could not be matched to its captured payment.',
  );

/** Operator configuration only. Never populate this registry from a downloaded receipt. */
export function receiptTrustFromValues(value: unknown): TrustedSignerMap {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > 128)
      throw new Error();
    const trust = new Map<string, TrustedSigner>();
    for (const raw of value) {
      const item = exactObject(raw, [
        'keyId',
        'epoch',
        'publicKey',
        'validFrom',
        'validUntil',
        'revoked',
      ]);
      const signer: TrustedSigner = {
        keyId: identifier(item.keyId),
        epoch: epoch(item.epoch),
        publicKey: hex(item.publicKey, 32),
        validFrom: utcTime(item.validFrom),
        validUntil: utcTime(item.validUntil),
        revoked: item.revoked as boolean,
      };
      const duration =
        Date.parse(signer.validUntil!) - Date.parse(signer.validFrom);
      if (
        typeof signer.revoked !== 'boolean' ||
        duration <= 0 ||
        duration > MAX_SIGNER_WINDOW_MS
      )
        throw new Error();
      const key = signerMapKey(signer.keyId, signer.epoch);
      if (trust.has(key)) throw new Error();
      trust.set(key, Object.freeze(signer));
    }
    return trust;
  } catch {
    throw unavailable();
  }
}

export function configuredReceiptTrust(
  env: Record<string, string | undefined> = process.env,
): TrustedSignerMap {
  try {
    const raw = env.CONCLAVE_RECEIPT_TRUSTED_SIGNERS;
    if (!raw || raw.length > 65536) throw new Error();
    return receiptTrustFromValues(JSON.parse(raw));
  } catch {
    throw unavailable();
  }
}

function checkedSigner(signer: ReceiptSigner, now: string): TrustedSigner {
  try {
    const registered = signer.trust.get(
      signerMapKey(signer.keyId, signer.epoch),
    );
    if (!registered) throw new Error();
    // Validate even explicitly injected configurations; mutable maps are not authority shortcuts.
    receiptTrustFromValues([registered]);
    if (
      registered.revoked ||
      registered.publicKey !== receiptPublicKey(signer.seed) ||
      now < registered.validFrom ||
      now >= registered.validUntil!
    )
      throw new Error();
    return registered;
  } catch {
    throw unavailable();
  }
}

export function configuredReceiptSigner(
  env: Record<string, string | undefined> = process.env,
): ReceiptSigner {
  try {
    const keyId = identifier(env.CONCLAVE_RECEIPT_SIGNER_KEY_ID);
    if (!/^[1-9][0-9]{0,9}$/.test(env.CONCLAVE_RECEIPT_SIGNER_EPOCH ?? ''))
      throw new Error();
    const signerEpoch = epoch(Number(env.CONCLAVE_RECEIPT_SIGNER_EPOCH));
    const seed = toBytes(hex(env.CONCLAVE_RECEIPT_SIGNER_SEED_HEX, 32));
    const trust = configuredReceiptTrust(env);
    const registered = trust.get(signerMapKey(keyId, signerEpoch));
    if (
      !registered ||
      registered.validFrom !==
        utcTime(env.CONCLAVE_RECEIPT_SIGNER_VALID_FROM) ||
      registered.validUntil !== utcTime(env.CONCLAVE_RECEIPT_SIGNER_VALID_UNTIL)
    )
      throw new Error();
    const signer = { keyId, epoch: signerEpoch, seed, trust };
    checkedSigner(signer, new Date().toISOString());
    return signer;
  } catch {
    throw unavailable();
  }
}

function uuid(value: unknown): asserts value is string {
  requireCondition(
    typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      ),
    400,
    'INVALID_RECEIPT_REFERENCE',
    'A valid receipt reference is required.',
  );
}
function hour(value: string): string {
  try {
    const checked = utcTime(value);
    if (!checked.endsWith(':00:00.000Z')) throw new Error();
    return checked;
  } catch {
    throw new ServiceError(
      400,
      'INVALID_RECEIPT_HOUR',
      'Use a UTC hour boundary.',
    );
  }
}
function rowReceipt(row: {
  payload: unknown;
  signature: unknown;
}): SignedReceipt {
  try {
    return normalizeSignedReceipt({
      payload: row.payload,
      signature: row.signature,
    });
  } catch {
    throw integrity();
  }
}
async function databaseNow(client: PoolClient): Promise<string> {
  const result = await one<{ at: Date }>(
    client,
    'SELECT clock_timestamp() AS at',
  );
  return result!.at.toISOString();
}
type Source = {
  call_id: string;
  hold_id: string;
  request_hash: string;
  route_version_id: string;
  captured_usd6: string;
  state: string;
  hold_state: string;
  consistent: boolean;
};

/** No prompt, wallet, input ciphertext, or provider response enters the receipt. */
export async function issueCallReceipt(
  pool: Pool,
  input: { accountId: string; callId: string },
  signer: ReceiptSigner,
): Promise<{ receipt: SignedReceipt; replayed: boolean }> {
  uuid(input.accountId);
  uuid(input.callId);
  return transaction(pool, async (client) => {
    await client.query(publicationLock);
    // Match settlement's account → hold → call lock order, preventing lock inversion.
    const owner = await one(
      client,
      'SELECT id FROM accounts WHERE id=$1 FOR UPDATE',
      [input.accountId],
    );
    requireCondition(
      owner,
      404,
      'RECEIPT_CALL_NOT_FOUND',
      'This call is unavailable.',
    );
    const hold = await one(
      client,
      `SELECT h.id FROM holds h JOIN calls c ON c.hold_id=h.id
      WHERE c.id=$1 AND c.account_id=$2 AND h.account_id=$2 FOR UPDATE OF h`,
      [input.callId, input.accountId],
    );
    requireCondition(
      hold,
      404,
      'RECEIPT_CALL_NOT_FOUND',
      'This call is unavailable.',
    );
    const source = await one<Source>(
      client,
      `SELECT c.id AS call_id,h.id AS hold_id,h.request_hash,c.route_version_id,
      h.captured_usd6::text,c.state,h.state AS hold_state,
      (p.account_id=c.account_id AND q.account_id=c.account_id AND q.project_id=c.project_id
       AND q.route_version_id=c.route_version_id AND q.request_hash=h.request_hash) AS consistent
      FROM calls c JOIN holds h ON h.id=c.hold_id JOIN quotes q ON q.id=h.quote_id
      JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND c.account_id=$2 FOR UPDATE OF c`,
      [input.callId, input.accountId],
    );
    requireCondition(
      source,
      404,
      'RECEIPT_CALL_NOT_FOUND',
      'This call is unavailable.',
    );
    requireCondition(
      source.hold_state === 'captured' &&
        /^[1-9][0-9]{0,15}$/.test(source.captured_usd6 ?? '') &&
        ['succeeded', 'failed', 'cancelled'].includes(source.state),
      409,
      'RECEIPT_NOT_SETTLED',
      'A confirmed captured payment is required for a receipt.',
    );
    if (!source.consistent || !/^[0-9a-f]{64}$/.test(source.request_hash))
      throw integrity();
    const entries = await client.query<{
      kind: string;
      owner_id: string | null;
      amount_usd6: string;
    }>(
      `SELECT a.kind,a.owner_id,e.amount_usd6::text FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id=t.id JOIN ledger_accounts a ON a.id=e.ledger_account_id
       WHERE t.reference=$1 AND t.kind='capture'`,
      [`capture:${source.hold_id}`],
    );
    if (
      entries.rows.length !== 2 ||
      !entries.rows.some(
        (e) =>
          e.kind === 'reserved' &&
          e.owner_id === input.accountId &&
          e.amount_usd6 === `-${source.captured_usd6}`,
      ) ||
      !entries.rows.some(
        (e) =>
          e.kind === 'revenue' &&
          e.owner_id === null &&
          e.amount_usd6 === source.captured_usd6,
      )
    )
      throw integrity();
    const previous = await one<{ payload: unknown; signature: string }>(
      client,
      'SELECT payload,signature FROM receipts WHERE call_id=$1',
      [input.callId],
    );
    if (previous) {
      const receipt = rowReceipt(previous);
      if (
        receipt.payload.version !== 1 ||
        receipt.payload.callId !== source.call_id ||
        receipt.payload.holdId !== source.hold_id ||
        receipt.payload.actualUsd6 !== source.captured_usd6 ||
        receipt.payload.requestDigest !== source.request_hash ||
        receipt.payload.routeVersion !== source.route_version_id
      )
        throw integrity();
      return { receipt, replayed: true };
    }
    const now = await databaseNow(client);
    checkedSigner(signer, now);
    const receipt = signReceipt(
      {
        version: 1,
        receiptId: randomUUID(),
        callId: source.call_id,
        holdId: source.hold_id,
        routeVersion: source.route_version_id,
        signerKeyId: signer.keyId,
        signerEpoch: signer.epoch,
        issuedAt: now,
        actualUsd6: source.captured_usd6,
        requestDigest: source.request_hash,
      },
      signer.seed,
    );
    if (!verifyReceiptSignature(receipt, signer.trust, now).valid)
      throw unavailable();
    await client.query(
      `INSERT INTO receipts(id,account_id,call_id,hold_id,issued_at,batch_hour,payload,signature)
      VALUES($1,$2,$3,$4,$5,date_trunc('hour',$5::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$6,$7)`,
      [
        receipt.payload.receiptId,
        input.accountId,
        input.callId,
        source.hold_id,
        now,
        receipt.payload,
        receipt.signature,
      ],
    );
    return { receipt, replayed: false };
  });
}

type MediaSource = {
  job_id: string;
  hold_id: string;
  request_hash: string;
  route_version_id: string;
  model_id: string;
  modality: 'image' | 'video';
  state: 'completed' | 'failed' | 'cancelled';
  captured_usd6: string | null;
  maximum_usd6: string;
  hold_state: string;
  provider_reference_hash: string | null;
  provider_reference: string | null;
  dispatched_at: Date | null;
  consistent: boolean;
};

async function checkMediaSettlement(
  client: PoolClient,
  accountId: string,
  source: MediaSource,
) {
  const actual = BigInt(source.captured_usd6!),
    maximum = BigInt(source.maximum_usd6);
  if (actual < 0n || maximum <= 0n || actual > maximum) throw integrity();
  for (const [kind, amount, destination] of [
    ['capture', actual, 'revenue'],
    ['release', maximum - actual, 'available'],
  ] as const) {
    const entries = await client.query<{
      kind: string;
      owner_id: string | null;
      amount_usd6: string;
      transaction_kind: string;
    }>(
      `SELECT a.kind,a.owner_id,e.amount_usd6::text,t.kind AS transaction_kind FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id=t.id JOIN ledger_accounts a ON a.id=e.ledger_account_id
       WHERE t.reference=$1`,
      [`${kind}:${source.hold_id}`],
    );
    if (amount === 0n) {
      const tx = await one(
        client,
        'SELECT id FROM ledger_transactions WHERE reference=$1',
        [`${kind}:${source.hold_id}`],
      );
      if (tx) throw integrity();
    } else if (
      entries.rows.length !== 2 ||
      !entries.rows.every((e) => e.transaction_kind === kind) ||
      !entries.rows.some(
        (e) =>
          e.kind === 'reserved' &&
          e.owner_id === accountId &&
          e.amount_usd6 === `-${amount}`,
      ) ||
      !entries.rows.some(
        (e) =>
          e.kind === destination &&
          e.owner_id === (destination === 'revenue' ? null : accountId) &&
          e.amount_usd6 === amount.toString(),
      )
    )
      throw integrity();
  }
}

/** Signs only known settled media usage. Asset delivery is deliberately not attested. */
export async function issueMediaReceipt(
  pool: Pool,
  input: { accountId: string; mediaJobId: string },
  signer: ReceiptSigner,
): Promise<{ receipt: SignedReceipt; replayed: boolean }> {
  uuid(input.accountId);
  uuid(input.mediaJobId);
  return transaction(pool, async (client) => {
    await client.query(publicationLock);
    const owner = await one(
      client,
      'SELECT id FROM accounts WHERE id=$1 FOR UPDATE',
      [input.accountId],
    );
    requireCondition(
      owner,
      404,
      'RECEIPT_MEDIA_NOT_FOUND',
      'This media job is unavailable.',
    );
    const hold = await one(
      client,
      `SELECT h.id FROM holds h JOIN media_jobs j ON j.hold_id=h.id WHERE j.id=$1 AND j.account_id=$2 AND h.account_id=$2 FOR UPDATE OF h`,
      [input.mediaJobId, input.accountId],
    );
    requireCondition(
      hold,
      404,
      'RECEIPT_MEDIA_NOT_FOUND',
      'This media job is unavailable.',
    );
    const source = await one<MediaSource>(
      client,
      `SELECT j.id AS job_id,h.id AS hold_id,j.request_hash,j.route_version_id,
      r.model_id,j.modality,j.state,h.captured_usd6::text,h.maximum_usd6::text,h.state AS hold_state,
      j.provider_reference_hash,h.provider_reference,j.dispatched_at,
      (p.account_id=j.account_id AND q.account_id=j.account_id AND q.project_id=j.project_id
       AND q.route_version_id=j.route_version_id AND q.request_hash=j.request_hash
       AND h.request_hash=j.request_hash AND r.modality=j.modality) AS consistent
      FROM media_jobs j JOIN holds h ON h.id=j.hold_id JOIN quotes q ON q.id=h.quote_id
      JOIN projects p ON p.id=j.project_id JOIN route_versions r ON r.id=j.route_version_id
      WHERE j.id=$1 AND j.account_id=$2 FOR UPDATE OF j`,
      [input.mediaJobId, input.accountId],
    );
    requireCondition(
      source,
      404,
      'RECEIPT_MEDIA_NOT_FOUND',
      'This media job is unavailable.',
    );
    requireCondition(
      ['captured', 'released'].includes(source.hold_state) &&
        /^(0|[1-9][0-9]{0,15})$/.test(source.captured_usd6 ?? '') &&
        ['completed', 'failed', 'cancelled'].includes(source.state),
      409,
      'RECEIPT_NOT_SETTLED',
      'A confirmed settled payment is required for a receipt.',
    );
    if (
      !source.consistent ||
      !/^[0-9a-f]{64}$/.test(source.request_hash) ||
      (source.captured_usd6 === '0') !== (source.hold_state === 'released') ||
      source.provider_reference !== source.provider_reference_hash ||
      (source.provider_reference_hash !== null &&
        !/^[0-9a-f]{64}$/.test(source.provider_reference_hash)) ||
      ((source.captured_usd6 !== '0' || source.state === 'completed') &&
        source.provider_reference_hash === null) ||
      (source.state === 'cancelled' &&
        (source.captured_usd6 !== '0' ||
          source.dispatched_at !== null ||
          source.provider_reference_hash !== null))
    )
      throw integrity();
    await checkMediaSettlement(client, input.accountId, source);
    const accountCommitment = await receiptAccountCommitment(
      input.accountId,
      source.hold_id,
    );
    const terms = {
      version: 2 as const,
      kind: 'media' as const,
      mediaJobId: source.job_id,
      holdId: source.hold_id,
      accountCommitment,
      routeVersion: source.route_version_id,
      modelId: source.model_id,
      modality: source.modality,
      actualUsd6: source.captured_usd6!,
      settlement: source.hold_state as 'captured' | 'released',
      generationState: source.state,
      requestDigest: source.request_hash,
      providerReferenceDigest: source.provider_reference_hash,
      assetDelivery: 'not_attested' as const,
    };
    const previous = await one<{ payload: unknown; signature: string }>(
      client,
      'SELECT payload,signature FROM receipts WHERE media_job_id=$1',
      [input.mediaJobId],
    );
    if (previous) {
      const receipt = rowReceipt(previous);
      if (
        Object.entries(terms).some(
          ([key, value]) => Reflect.get(receipt.payload, key) !== value,
        )
      )
        throw integrity();
      return { receipt, replayed: true };
    }
    const now = await databaseNow(client);
    checkedSigner(signer, now);
    const receipt = signReceipt(
      {
        ...terms,
        receiptId: randomUUID(),
        signerKeyId: signer.keyId,
        signerEpoch: signer.epoch,
        issuedAt: now,
      },
      signer.seed,
    );
    if (!verifyReceiptSignature(receipt, signer.trust, now).valid)
      throw unavailable();
    await client.query(
      `INSERT INTO receipts(id,account_id,media_job_id,hold_id,issued_at,batch_hour,payload,signature)
      VALUES($1,$2,$3,$4,$5,date_trunc('hour',$5::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$6,$7)`,
      [
        receipt.payload.receiptId,
        input.accountId,
        input.mediaJobId,
        source.hold_id,
        now,
        receipt.payload,
        receipt.signature,
      ],
    );
    return { receipt, replayed: false };
  });
}

/** Owned lookup returns a pending proof, never asserts chain finality. */
export async function getOwnedReceipt(
  pool: Pool,
  accountId: string,
  receiptId: string,
): Promise<ReceiptEnvelope> {
  uuid(accountId);
  uuid(receiptId);
  const row = await one<{
    payload: unknown;
    signature: string;
    batch_id: string | null;
    hour: Date | null;
    root: unknown;
    proof: ReceiptProof;
  }>(
    pool,
    `SELECT r.payload,r.signature,b.id AS batch_id,b.hour,b.root,i.proof FROM receipts r
     LEFT JOIN receipt_batch_items i ON i.receipt_id=r.id LEFT JOIN receipt_batches b ON b.id=i.batch_id
     WHERE r.id=$1 AND r.account_id=$2`,
    [receiptId, accountId],
  );
  requireCondition(
    row,
    404,
    'RECEIPT_NOT_FOUND',
    'This receipt is unavailable.',
  );
  const receipt = rowReceipt(row);
  if (!row.batch_id) return { receipt, batch: null };
  const root = normalizeRoot(row.root);
  if (!(await verifyReceiptInclusion(receipt, row.proof, root)))
    throw integrity();
  return {
    receipt,
    batch: {
      id: row.batch_id,
      hour: row.hour!.toISOString(),
      state: 'pending_anchor',
      root,
      proof: row.proof,
    },
  };
}

/** Seals an entire completed issuance hour once. Empty hours produce no root. */
export async function buildReceiptHour(
  pool: Pool,
  hourUTC: string,
  trust: TrustedSignerMap,
): Promise<{ batch: ReceiptBatch | null; replayed: boolean }> {
  const at = hour(hourUTC);
  return transaction(pool, async (client) => {
    await client.query(publicationLock);
    const now = await databaseNow(client);
    requireCondition(
      Date.parse(at) + 3600000 <= Date.parse(now),
      409,
      'RECEIPT_HOUR_OPEN',
      'This receipt hour has not finished.',
    );
    const previous = await one<{ id: string; hour: Date; root: unknown }>(
      client,
      'SELECT id,hour,root FROM receipt_batches WHERE hour=$1',
      [at],
    );
    if (previous)
      return {
        batch: {
          id: previous.id,
          hour: previous.hour.toISOString(),
          state: 'pending_anchor',
          root: normalizeRoot(previous.root),
        },
        replayed: true,
      };
    const rows = await client.query<{ payload: unknown; signature: string }>(
      'SELECT payload,signature FROM receipts WHERE batch_hour=$1 ORDER BY id LIMIT $2',
      [at, MAX_RECEIPTS_PER_TREE + 1],
    );
    if (!rows.rows.length) return { batch: null, replayed: false };
    requireCondition(
      rows.rows.length <= MAX_RECEIPTS_PER_TREE,
      409,
      'RECEIPT_HOUR_CAPACITY',
      'This hour exceeds the receipt batch capacity and requires an operator review.',
    );
    const receipts = rows.rows.map(rowReceipt);
    requireCondition(
      receipts.every(
        (receipt) => verifyReceiptSignature(receipt, trust, now).valid,
      ),
      409,
      'RECEIPT_SIGNER_NOT_TRUSTED',
      'A receipt signer is missing, revoked, or invalid.',
    );
    const tree = await buildReceiptTree(receipts);
    const batch: ReceiptBatch = {
      id: randomUUID(),
      hour: at,
      state: 'pending_anchor',
      root: tree.root,
    };
    await client.query(
      'INSERT INTO receipt_batches(id,hour,root) VALUES($1,$2,$3)',
      [batch.id, at, tree.root],
    );
    await client.query(
      `INSERT INTO receipt_batch_items(receipt_id,batch_id,leaf_index,proof)
      SELECT x.receipt_id::uuid,$1,x.leaf_index,x.proof
      FROM jsonb_to_recordset($2::jsonb) AS x(receipt_id text,leaf_index integer,proof jsonb)`,
      [
        batch.id,
        JSON.stringify(
          tree.receiptIds.map((id, index) => ({
            receipt_id: id,
            leaf_index: index,
            proof: tree.proofs[index],
          })),
        ),
      ],
    );
    return { batch, replayed: false };
  });
}

export async function issuePendingReceipts(
  pool: Pool,
  signer: ReceiptSigner,
  limit = 100,
): Promise<{ issued: number; replayed: number }> {
  requireCondition(
    Number.isInteger(limit) && limit >= 1 && limit <= 1000,
    400,
    'INVALID_RECEIPT_LIMIT',
    'The receipt limit must be between 1 and 1000.',
  );
  const pending = await pool.query<{
    kind: 'call' | 'media';
    id: string;
    account_id: string;
  }>(
    `SELECT kind,id,account_id FROM (
      SELECT 'call' AS kind,c.id,c.account_id,c.created_at FROM calls c JOIN holds h ON h.id=c.hold_id
      LEFT JOIN receipts r ON r.call_id=c.id WHERE h.state='captured' AND h.captured_usd6>0
        AND c.state IN ('succeeded','failed','cancelled') AND r.id IS NULL
      UNION ALL
      SELECT 'media' AS kind,j.id,j.account_id,j.created_at FROM media_jobs j JOIN holds h ON h.id=j.hold_id
      LEFT JOIN receipts r ON r.media_job_id=j.id WHERE h.state IN ('captured','released') AND h.captured_usd6 IS NOT NULL
        AND j.state IN ('completed','failed','cancelled') AND r.id IS NULL
    ) pending ORDER BY created_at,id LIMIT $1`,
    [limit],
  );
  let issued = 0,
    replayed = 0;
  for (const item of pending.rows) {
    const result =
      item.kind === 'call'
        ? await issueCallReceipt(
            pool,
            { accountId: item.account_id, callId: item.id },
            signer,
          )
        : await issueMediaReceipt(
            pool,
            { accountId: item.account_id, mediaJobId: item.id },
            signer,
          );
    if (result.replayed) replayed++;
    else issued++;
  }
  return { issued, replayed };
}

export async function buildCompletedReceiptHours(
  pool: Pool,
  trust: TrustedSignerMap,
  limit = 24,
): Promise<ReceiptBatch[]> {
  requireCondition(
    Number.isInteger(limit) && limit >= 1 && limit <= 168,
    400,
    'INVALID_RECEIPT_LIMIT',
    'The batch limit must be between 1 and 168.',
  );
  const hours = await pool.query<{ batch_hour: Date }>(
    `SELECT DISTINCT r.batch_hour FROM receipts r
    LEFT JOIN receipt_batches b ON b.hour=r.batch_hour WHERE b.id IS NULL
    AND r.batch_hour + interval '1 hour' <= clock_timestamp() ORDER BY r.batch_hour LIMIT $1`,
    [limit],
  );
  const batches: ReceiptBatch[] = [];
  for (const row of hours.rows) {
    const result = await buildReceiptHour(
      pool,
      row.batch_hour.toISOString(),
      trust,
    );
    if (result.batch) batches.push(result.batch);
  }
  return batches;
}
