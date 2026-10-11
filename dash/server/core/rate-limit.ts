import type { Pool } from 'pg';
import { ServiceError } from './errors.ts';

export async function rateLimit(pool: Pool, bucket: string, limit: number, windowSeconds = 60) {
  const result = await pool.query<{ hits: number }>(
    `INSERT INTO rate_limits(bucket,window_start,hits)
     VALUES($1,to_timestamp(floor(extract(epoch FROM now())/$2)*$2),1)
     ON CONFLICT(bucket,window_start) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits`, [bucket, windowSeconds]);
  if (result.rows[0].hits > limit) throw new ServiceError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.', true);
}

// Every route branch that spends configured Solana RPC quota also counts
// against this shared bucket, so many cheap accounts cannot multiply
// operator RPC spend.
export const RPC_GLOBAL_BUCKET = 'solana-rpc:global';
export const RPC_GLOBAL_LIMIT = 600;
/** Per client (edge IP, else account) across all RPC-spending branches. */
export const RPC_CLIENT_LIMIT = 60;

/**
 * Bucket key for one client ahead of a shared bucket. Behind the edge the
 * trusted connecting-IP header identifies the client; otherwise the caller's
 * browser cookie hash does. Neither value is stored in clear.
 */
export async function clientBucket(request: Request, fallbackHash: string) {
  const ip = request.headers.get('cf-connecting-ip');
  if (ip && /^[0-9A-Fa-f.:]{3,45}$/.test(ip)) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`client-rate-limit\u0000${ip}`),
    );
    return Buffer.from(digest).toString('hex').slice(0, 32);
  }
  return `browser:${fallbackHash}`;
}
