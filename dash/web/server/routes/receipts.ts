import type { Pool } from 'pg';
import { getOwnedReceipt } from '../receipts/service.ts';
import { jsonResponse, uuidField } from '../core/http.ts';
import { one } from '../db/database.ts';
import { requireCondition } from '../core/errors.ts';
import { nextCursor, readCursor } from '../core/pagination.ts';

export async function receiptRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (path === 'receipts') {
    const scope = `${accountId}:receipts`,
      cursor = readCursor(
        new URL(request.url).searchParams.get('cursor'),
        scope,
      );
    const result = await pool.query(
      `SELECT r.id,r.call_id AS "callId",r.media_job_id AS "mediaJobId",r.issued_at AS "issuedAt",r.payload->>'actualUsd6' AS "actualUsd6",
      CASE WHEN bi.receipt_id IS NULL THEN 'signed_pending_batch' ELSE 'signed_pending_anchor' END AS state,
      to_char(r.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime",
      f.base_usd6::text AS "feeBaseUsd6",f.platform_fee_usd6::text AS "platformFeeUsd6",f.burn_reserve_usd6::text AS "burnReserveUsd6"
      FROM receipts r LEFT JOIN receipt_batch_items bi ON bi.receipt_id=r.id
      LEFT JOIN hold_platform_fees f ON f.hold_id=r.hold_id WHERE r.account_id=$1
      AND NOT EXISTS(SELECT 1 FROM comparison_calls cc JOIN comparisons co ON co.id=cc.comparison_id WHERE cc.call_id=r.call_id AND co.blind AND co.revealed_at IS NULL)
      AND ($2::timestamptz IS NULL OR (r.issued_at,r.id)<($2::timestamptz,$3::uuid))
      ORDER BY r.issued_at DESC,r.id DESC LIMIT 51`,
      [accountId, cursor?.time ?? null, cursor?.id ?? null],
    );
    return jsonResponse({
      receipts: result.rows
        .slice(0, 50)
        .map(
          ({
            cursorTime: _cursorTime,
            mediaJobId,
            feeBaseUsd6,
            platformFeeUsd6,
            burnReserveUsd6,
            ...signed
          }) => {
            // The split is ledger data outside the signed receipt bytes; the
            // signed actualUsd6 is the total charged (base + platform fee).
            const receipt =
              feeBaseUsd6 === null
                ? signed
                : {
                    ...signed,
                    platformFee: {
                      baseUsd6: feeBaseUsd6,
                      platformFeeUsd6,
                      burnReserveUsd6,
                    },
                  };
            return mediaJobId
              ? { ...receipt, kind: 'media', mediaJobId }
              : receipt;
          },
        ),
      nextCursor: nextCursor(result.rows, 50, scope),
    });
  }
  const match = /^receipts\/([^/]+)(?:\/proof)?$/.exec(path);
  if (match) {
    const id = uuidField(match[1]);
    const hidden = await one(
      pool,
      `SELECT r.id FROM receipts r JOIN comparison_calls cc ON cc.call_id=r.call_id JOIN comparisons co ON co.id=cc.comparison_id
      WHERE r.id=$1 AND r.account_id=$2 AND co.blind AND co.revealed_at IS NULL`,
      [id, accountId],
    );
    requireCondition(
      !hidden,
      409,
      'BLIND_COMPARISON',
      'Reveal the comparison model names before opening this receipt.',
    );
    return jsonResponse(await getOwnedReceipt(pool, accountId, id));
  }
  return null;
}
