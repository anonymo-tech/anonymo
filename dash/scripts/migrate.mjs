import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase, transaction } from '../server/db/database.ts';

export async function migrate(pool) {
  const directory = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));
  const files = (await readdir(directory)).filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name)).sort();
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('conclave_schema_migration'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of files) {
      const sql = await readFile(new URL(`../server/db/migrations/${name}`, import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (previous.rows.length) {
        if (previous.rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
  });
  return files.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.CONCLAVE_DATABASE_URL) throw new Error('CONCLAVE_DATABASE_URL is required.');
  const pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 1);
  try {
    const count = await migrate(pool);
    process.stdout.write(`Schema verified: ${count} migration(s).\n`);
  } finally { await pool.end(); }
}
