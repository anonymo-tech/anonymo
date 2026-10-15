import type { Pool } from 'pg';
import { isFomoTopTenBundle, fomoTopTenSummary, type FomoTopTenBundle } from '../../lib/second-look/fomo-top10.ts';
import { FOMO_HANDLE } from '../../lib/second-look/fomo.ts';
import { jsonResponse } from '../core/http.ts';
import { ServiceError } from '../core/errors.ts';

export async function readFomoTopTen(pool: Pool): Promise<FomoTopTenBundle> {
  const row = (await pool.query<{ document: unknown }>("SELECT document FROM fomo_public_snapshots WHERE id='top10-30d'" )).rows[0];
  if (!row || !isFomoTopTenBundle(row.document)) throw new ServiceError(503, 'FOMO_RESEARCH_REFRESHING', 'The research collection is refreshing. Please try again shortly.');
  return row.document;
}
export async function savedFomoProfile(pool: Pool, handle: string) {
  const bundle = await readFomoTopTen(pool);
  const row = bundle.entries.find(e => e.handle.toLowerCase() === handle.toLowerCase());
  if (!row) throw new ServiceError(404, 'FOMO_PROFILE_NOT_COLLECTED', 'Start with one of the ten collected profiles below. More history is being added daily.');
  return row.analysis;
}
/** Free public reads only. No model jobs, user data or write endpoint. */
export async function publicFomoRoute(pool: Pool, request: Request, path: string) {
  if (request.method !== 'GET') return null;
  if (path === 'second-look/fomo/leaderboard') return jsonResponse(fomoTopTenSummary(await readFomoTopTen(pool)));
  const match = /^second-look\/fomo\/profiles\/([^/]+)$/.exec(path);
  if (!match) return null;
  if (!FOMO_HANDLE.test(match[1])) throw new ServiceError(400, 'FOMO_INPUT_INVALID', 'Choose a collected FOMO profile.');
  return jsonResponse({ analysis: await savedFomoProfile(pool, match[1]) });
}
