import { readFile, stat } from 'node:fs/promises';
import { createDatabase } from '../server/db/database.ts';
import {
  fetchMediaCatalog,
  installReviewedMediaRoutes,
  validateMediaCatalog,
  validateMediaReview,
} from '../server/media/registry.ts';

const args = process.argv.slice(2),
  flags = new Set(args.slice(1));
const allowed = new Set(['--refresh-catalog', '--install', '--enable']);
let pool;
try {
  if (
    !args[0] ||
    args[0].startsWith('--') ||
    args.slice(1).some((flag) => !allowed.has(flag)) ||
    flags.size !== args.length - 1 ||
    (flags.has('--enable') && !flags.has('--install')) ||
    (flags.has('--install') && !flags.has('--refresh-catalog'))
  ) {
    process.stderr.write(
      'Usage: node --experimental-strip-types scripts/configure-media-routes.mjs REVIEW.json [--refresh-catalog] [--install [--enable]]\nDefault: local review validation only; no network or database writes. Installation requires explicit --refresh-catalog. Enabled entries also require --enable and recorded privacy/terms signoff.\n',
    );
    process.exitCode = 1;
  } else {
    if ((await stat(args[0])).size > 262144) throw new Error();
    const bytes = await readFile(args[0]);
    if (bytes.byteLength > 262144) throw new Error();
    const document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    const routes = validateMediaReview(document);
    const catalog = flags.has('--refresh-catalog')
      ? await fetchMediaCatalog()
      : undefined;
    if (catalog) validateMediaCatalog(routes, catalog);
    if (flags.has('--install')) {
      if (!process.env.CONCLAVE_DATABASE_URL) throw new Error();
      pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 1);
      const result = await installReviewedMediaRoutes(pool, document, {
        enableReviewed: flags.has('--enable'),
        catalog,
      });
      process.stdout.write(
        JSON.stringify({
          action: 'installed',
          ...result,
          catalogChecked: true,
        }) + '\n',
      );
    } else
      process.stdout.write(
        JSON.stringify({
          action: 'validated_only',
          routes: routes.length,
          requestedEnabled: routes.filter((r) => r.enabled).length,
          catalogChecked: Boolean(catalog),
          privacyTier: 'unverified',
          databaseChanged: false,
        }) + '\n',
      );
  }
} catch (error) {
  const code =
    typeof error?.code === 'string' && /^MEDIA_[A-Z_]{1,64}$/.test(error.code)
      ? error.code
      : 'MEDIA_CONFIGURATION_FAILED';
  process.stderr.write(JSON.stringify({ code }) + '\n');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
