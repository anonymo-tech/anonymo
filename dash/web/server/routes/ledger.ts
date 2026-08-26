import type { Pool } from 'pg';
import { nextCursor, readCursor } from '../core/pagination.ts';
import { jsonResponse } from '../core/http.ts';

export async function ledgerRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
) {
  if (path !== 'ledger' || request.method !== 'GET') return null;
  const scope = `${accountId}:ledger`,
    cursor = readCursor(new URL(request.url).searchParams.get('cursor'), scope);
  const rows = await pool.query(
    `SELECT t.id,t.kind,t.created_at AS "createdAt",
    COALESCE(sum(e.amount_usd6) FILTER(WHERE a.kind='available'),0)::text AS "availableDeltaUsd6",
    COALESCE(sum(e.amount_usd6) FILTER(WHERE a.kind='reserved'),0)::text AS "reservedDeltaUsd6",
    (SELECT json_build_object('baseUsd6',f.base_usd6::text,'platformFeeUsd6',f.platform_fee_usd6::text,
      'burnReserveUsd6',f.burn_reserve_usd6::text) FROM hold_platform_fees f
      WHERE f.hold_id=CASE WHEN t.kind='capture' AND t.reference ~ '^capture:[0-9a-f-]{36}$'
        THEN substr(t.reference,9)::uuid END) AS "platformFee",
    to_char(t.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
    FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id JOIN ledger_accounts a ON a.id=e.ledger_account_id
    WHERE a.owner_id=$1 AND ($2::timestamptz IS NULL OR (t.created_at,t.id)<($2::timestamptz,$3::uuid))
    GROUP BY t.id ORDER BY t.created_at DESC,t.id DESC LIMIT 51`,
    [accountId, cursor?.time ?? null, cursor?.id ?? null],
  );
  return jsonResponse({
    entries: rows.rows
      .slice(0, 50)
      .map(({ cursorTime: _cursorTime, platformFee, ...entry }) =>
        // A capture under platform-fee terms carries its split; others are unchanged.
        platformFee ? { ...entry, platformFee } : entry,
      ),
    nextCursor: nextCursor(rows.rows, 50, scope),
  });
}
