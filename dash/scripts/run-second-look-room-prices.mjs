import { createDatabase } from '../server/db/database.ts';
import { runRoomPriceWorker } from '../server/second-look/room-price-worker.ts';
if (process.argv.slice(2).join(' ') !== '--once')
  throw Error('Use --once for a bounded room-price observation run.');
let pool;
try {
  if (!process.env.CONCLAVE_DATABASE_URL)
    throw Error('Database configuration is required');
  pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 2);
  console.log(JSON.stringify(await runRoomPriceWorker(pool)));
} catch {
  console.error(
    'Room price observation is unavailable. No provider details or credentials are logged.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
