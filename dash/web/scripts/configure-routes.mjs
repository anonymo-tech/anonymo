import { readFile, stat } from 'node:fs/promises';
import { createDatabase } from '../server/db/database.ts';
import {
  fetchRouteCatalog,
  installReviewedRoutes,
  validateRouteCatalog,
  validateRouteReview,
} from '../server/routes/route-registry.ts';

const args = process.argv.slice(2);
const flags = new Set(args.slice(1));
const allowed = new Set(['--install', '--check-catalog', '--enable-reviewed']);
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
      'Usage: node --experimental-strip-types scripts/configure-routes.mjs REVIEW.json [--check-catalog] [--install [--enable-reviewed]]\nDefault: validate locally; no database writes or network requests. Enabled routes require --install --enable-reviewed and a fresh public catalog check.\n',
    );
    process.exitCode = 1;
  } else {
    if ((await stat(args[0])).size > 262144) throw new Error();
    const bytes = await readFile(args[0]);
    if (bytes.byteLength > 262144) throw new Error();
    const document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    const routes = validateRouteReview(document);
    const catalog =
      flags.has('--check-catalog') || flags.has('--enable-reviewed')
        ? await fetchRouteCatalog()
        : undefined;
    if (catalog) validateRouteCatalog(routes, catalog);
    if (flags.has('--install')) {
      if (!process.env.CONCLAVE_DATABASE_URL) throw new Error();
      pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 1);
      const result = await installReviewedRoutes(pool, document, {
        enableReviewed: flags.has('--enable-reviewed'),
        catalog,
      });
      process.stdout.write(
        JSON.stringify({
          action: 'installed',
          ...result,
          catalogChecked: Boolean(catalog),
        }) + '\n',
      );
    } else {
      process.stdout.write(
        JSON.stringify({
          action: 'validated_only',
          routes: routes.length,
          requestedEnabled: routes.filter((route) => route.enabled).length,
          catalogChecked: Boolean(catalog),
          privacyTier: 'unverified',
          databaseChanged: false,
        }) + '\n',
      );
    }
  }
} catch (error) {
  const safe =
    typeof error?.code === 'string' && /^ROUTE_[A-Z_]{1,60}$/.test(error.code)
      ? error.code
      : 'ROUTE_CONFIGURATION_FAILED';
  process.stderr.write(JSON.stringify({ code: safe }) + '\n');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
