import { createDatabase } from '../server/db/database.ts';
import { phase2Readiness } from '../server/second-look/phase2-readiness.ts';
const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== '--database'))
  throw new Error(
    'Use no arguments for configuration only, or --database for read-only inspection.',
  );
let pool;
try {
  if (args[0] === '--database' && process.env.CONCLAVE_DATABASE_URL)
    pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 1);
  const report = await phase2Readiness({ env: process.env, pool });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // Incomplete readiness is a nonzero status; this command never activates anything.
  if (!report.fullPhase2Ready) process.exitCode = 1;
} catch {
  process.stdout.write(
    JSON.stringify({
      mode: 'read_only',
      configurationReady: false,
      activationValidated: false,
      fullPhase2Ready: false,
      error: 'READINESS_CHECK_UNAVAILABLE',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
