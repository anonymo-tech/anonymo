// Demo gateway pieces for update "tickets". A ticket is an ordinary key, so the demo gateway needs no ticket routes:
// POST /keys makes it, the simulated deposit funds it, GET /balance and POST /withdraw do the rest. The one thing it
// was missing is what the real gateway does with a key that has run out.

import type { KeyCaps } from '../types.ts';

/**
 * A key past `caps.expires_at` is refused on every authenticated route, exactly as the gateway's resolveKey() does
 * (gateway/src/api/auth.ts: 401 `key_expired`). That includes GET /balance and POST /withdraw: with the gateway as it
 * is, credit left on an expired key cannot be read or taken back. If the gateway changes that, change it here too.
 */
export function expiredKeyRefusal(
  caps: Pick<KeyCaps, 'expires_at'>,
  now: number,
  fail: (status: number, type: string, message: string) => Response,
): Response | null {
  const at = caps.expires_at ? Date.parse(caps.expires_at) : Number.NaN;
  return Number.isFinite(at) && at < now ? fail(401, 'key_expired', 'This API key has expired.') : null;
}
