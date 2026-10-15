import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isFomoTopTenBundle } from '../lib/second-look/fomo-top10.ts';
import { createDatabase, transaction } from '../server/db/database.ts';

export async function publishFomoSnapshot(pool, bundle, now = Date.now()) {
  if (!isFomoTopTenBundle(bundle) || JSON.stringify(bundle).length > 8_000_000) throw Error('INVALID_FOMO_PUBLIC_BUNDLE');
  if (Date.parse(bundle.generatedAt) > now + 300_000 || Date.parse(bundle.generatedAt) < now - 48*3600_000) throw Error('FOMO_BATCH_DATE_INVALID');
  if (Date.parse(bundle.leaderboard.observedAt) < now - 48*3600_000) throw Error('FOMO_LEADERBOARD_TOO_OLD');
  const text = JSON.stringify(bundle), sha256 = createHash('sha256').update(text).digest('hex');
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('conclave_fomo_public_snapshot'))");
    const old = (await client.query("SELECT generated_at,sha256 FROM fomo_public_snapshots WHERE id='top10-30d' FOR UPDATE")).rows[0];
    if (old?.sha256 === sha256) return { changed: false, sha256, profiles: 10 };
    if (old && new Date(old.generated_at).getTime() >= Date.parse(bundle.generatedAt)) throw Error('FOMO_BATCH_NOT_NEWER');
    await client.query("INSERT INTO fomo_public_snapshots(id,generated_at,sha256,document) VALUES('top10-30d',$1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET generated_at=EXCLUDED.generated_at,sha256=EXCLUDED.sha256,document=EXCLUDED.document,updated_at=now()", [bundle.generatedAt,sha256,text]);
    return { changed: true, sha256, profiles: 10 };
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file || !process.env.CONCLAVE_DATABASE_URL) throw Error('BUNDLE_AND_PRIVILEGED_DATABASE_REQUIRED');
  const raw = await readFile(file, 'utf8');
  if (raw.length > 8_000_000) throw Error('FOMO_BATCH_TOO_LARGE');
  const pool = createDatabase(process.env.CONCLAVE_DATABASE_URL,1);
  try { console.log(JSON.stringify(await publishFomoSnapshot(pool,JSON.parse(raw)))); }
  finally { await pool.end(); }
}
