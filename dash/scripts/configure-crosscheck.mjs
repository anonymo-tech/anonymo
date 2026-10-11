import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createDatabase } from '../server/db/database.ts';
import {
  checkReviewedRosters,
  installReviewedRosters,
  validateCrossCheckReview,
} from '../server/crosscheck/registry.ts';

const args = process.argv.slice(2);
const flags = new Set(args.slice(1));
const allowed = new Set(['--check-routes', '--install', '--enable-reviewed']);
let pool;
try {
  if (
    !args[0] ||
    args[0].startsWith('--') ||
    args.slice(1).some((flag) => !allowed.has(flag)) ||
    flags.size !== args.length - 1 ||
    (flags.has('--enable-reviewed') && !flags.has('--install'))
  ) {
    process.stderr.write(
      'Usage: node --experimental-strip-types scripts/configure-crosscheck.mjs REVIEW.json [--check-routes] [--install [--enable-reviewed]]\nDefault: validate locally; no database writes or provider requests. --check-routes performs a read-only database preflight. Enabled roster insertion requires --install --enable-reviewed. Execution environment gates are never changed.\n',
    );
    process.exitCode = 1;
  } else {
    const maximumBytes = 131072;
    const file = await open(args[0], constants.O_RDONLY | constants.O_NONBLOCK);
    let document;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error();
      const bytes = Buffer.alloc(maximumBytes + 1);
      let size = 0;
      while (size <= maximumBytes) {
        const chunk = await file.read(bytes, size, bytes.length - size);
        size += chunk.bytesRead;
        if (!chunk.bytesRead) break;
      }
      if (size > maximumBytes) throw new Error();
      document = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
      );
    } finally {
      await file.close();
    }
    const rosters = validateCrossCheckReview(document);
    if (flags.has('--install') || flags.has('--check-routes')) {
      if (!process.env.CONCLAVE_DATABASE_URL) throw new Error();
      pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 1);
      const install = flags.has('--install');
      const result = install
        ? await installReviewedRosters(pool, document, {
            enableReviewed: flags.has('--enable-reviewed'),
          })
        : await checkReviewedRosters(pool, document);
      process.stdout.write(
        JSON.stringify({
          action: install ? 'installed' : 'database_checked_only',
          ...result,
          databaseChanged: install && result.installed > 0,
          providerRequests: 0,
          executionGateChanged: false,
        }) + '\n',
      );
    } else {
      process.stdout.write(
        JSON.stringify({
          action: 'validated_only',
          rosters: rosters.length,
          requestedEnabled: rosters.filter((roster) => roster.enabled).length,
          databaseChecked: false,
          databaseChanged: false,
          providerRequests: 0,
          executionGateChanged: false,
        }) + '\n',
      );
    }
  }
} catch (error) {
  const code =
    typeof error?.code === 'string' &&
    /^CROSSCHECK_[A-Z_]{1,60}$/.test(error.code)
      ? error.code
      : 'CROSSCHECK_CONFIGURATION_FAILED';
  process.stderr.write(JSON.stringify({ code }) + '\n');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
