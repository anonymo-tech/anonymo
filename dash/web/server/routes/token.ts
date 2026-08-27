import type { Pool } from 'pg';
import { jsonResponse } from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import { burnReserveStats } from '../ledger/platform-fee.ts';
import { listTokenBurns, tokenBurnSummary } from '../token/burn-ledger.ts';

/**
 * Read-only, ledger-derived token routes. No chain is read here: the on-chain
 * fields come from recorded burns, which only exist after the executor saw the
 * transactions finalized. Signed-in only (dispatch resolves the session), no
 * account data in any response.
 */
export async function tokenRoutes(
  pool: Pool,
  request: Request,
  path: string,
): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (path === 'token/burn-reserve') {
    const [stats, summary] = await Promise.all([
      burnReserveStats(pool),
      tokenBurnSummary(pool),
    ]);
    return jsonResponse({
      burnReserve: { ...stats, onChain: { ...stats.onChain, ...summary } },
    });
  }
  if (path === 'token/burns') {
    const raw = new URL(request.url).searchParams.get('limit');
    requireCondition(
      raw === null || /^(?:[1-9]|[1-9][0-9]|100)$/.test(raw),
      400,
      'INVALID_LIMIT',
      'Choose a limit between 1 and 100.',
    );
    return jsonResponse({
      burns: await listTokenBurns(pool, { limit: raw === null ? 20 : Number(raw) }),
    });
  }
  return null;
}
