import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase } from '../server/db/database.ts';
import { internalTestingAllowed } from '../server/ledger/test-credits.ts';
import {
  pendingHolds,
  reconciliationPlan,
  resolvePendingHold,
} from '../server/ledger/reconciliation.ts';

const usage = `Usage: reconcile-holds.mjs [--list]
       reconcile-holds.mjs (--hold <holdId|callId> | --all) (--settle-usage | --settle-max | --release) [--yes]

Lists chat holds left reconciliation_pending, or resolves them:
  --settle-usage  charge the canonical cost the worker recorded (capped at the reservation)
  --settle-max    charge the reserved maximum
  --release       charge nothing and return the whole reservation
Platform fee and burn reserve follow the quote's fixed terms. Without --yes
nothing is written and the planned settlement is printed. Resolving a hold
that is no longer pending changes nothing.`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RefusedError extends Error {}

export function parseReconcileArguments(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        list: { type: 'boolean' },
        hold: { type: 'string' },
        all: { type: 'boolean' },
        'settle-usage': { type: 'boolean' },
        'settle-max': { type: 'boolean' },
        release: { type: 'boolean' },
        yes: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new RefusedError(usage);
  }
  const actions = ['settle-usage', 'settle-max', 'release'].filter(
    (name) => values[name],
  );
  const target = values.hold !== undefined || values.all;
  if (!target && !actions.length && !values.yes) return { mode: 'list' };
  if (
    values.list ||
    actions.length !== 1 ||
    (values.hold !== undefined) === Boolean(values.all)
  )
    throw new RefusedError(usage);
  if (values.hold !== undefined && !uuid.test(values.hold))
    throw new RefusedError('--hold must be a hold or call UUID.');
  return {
    mode: 'resolve',
    action: actions[0],
    hold: values.hold?.toLowerCase() ?? null,
    write: Boolean(values.yes),
  };
}

/** Local operator tool. It never contacts a chain or provider; the database comes from CONCLAVE_DATABASE_URL. */
export async function reconcileFromCli(argv, env = process.env) {
  if (!internalTestingAllowed(env))
    throw new RefusedError(
      'Refused: requires CONCLAVE_INTERNAL_TESTING=true, no production marker, a loopback or sslmode=verify-full CONCLAVE_DATABASE_URL and (if set) a loopback CONCLAVE_APP_ORIGIN.',
    );
  const input = parseReconcileArguments(argv);
  const pool = createDatabase(env.CONCLAVE_DATABASE_URL, 2);
  try {
    const pending = await pendingHolds(pool);
    if (input.mode === 'list') {
      const reserved = pending.reduce(
        (sum, hold) => sum + BigInt(hold.maximumUsd6),
        0n,
      );
      return {
        pending: pending.map((hold) => ({
          ...hold,
          plans: Object.fromEntries(
            ['settle-usage', 'settle-max', 'release'].map((action) => [
              action,
              reconciliationPlan(hold, action),
            ]),
          ),
        })),
        count: pending.length,
        reservedUsd6: reserved.toString(),
      };
    }
    let targets = pending;
    if (input.hold) {
      targets = pending.filter(
        (hold) => hold.holdId === input.hold || hold.callId === input.hold,
      );
      if (!targets.length) {
        // Idempotent: report a hold that was already resolved.
        const settled = await pool.query(
          `SELECT h.id,h.state,h.captured_usd6::text AS captured,x.resolution FROM holds h JOIN calls c ON c.hold_id=h.id
          LEFT JOIN hold_reconciliations x ON x.hold_id=h.id WHERE h.id=$1 OR c.id=$1`,
          [input.hold],
        );
        if (!settled.rows.length)
          throw new RefusedError('No chat hold or call has this identifier.');
        const row = settled.rows[0];
        return {
          action: input.action,
          written: false,
          results: [
            {
              holdId: row.id,
              changed: false,
              holdState: row.state,
              capturedUsd6: row.captured,
              resolution: row.resolution,
            },
          ],
        };
      }
    }
    if (!input.write)
      return {
        action: input.action,
        written: false,
        dryRun: true,
        results: targets.map((hold) => ({
          holdId: hold.holdId,
          callId: hold.callId,
          reasonCode: hold.reasonCode,
          ...reconciliationPlan(hold, input.action),
        })),
      };
    const results = [];
    for (const hold of targets)
      results.push(await resolvePendingHold(pool, hold.holdId, input.action));
    return {
      action: input.action,
      written: results.some((result) => result.changed),
      results,
    };
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await reconcileFromCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // Messages are fixed text or service codes; connection details are never printed.
    const message =
      error instanceof RefusedError
        ? error.message
        : error?.code && /^[A-Z_]+$/.test(error.code)
          ? `Reconciliation failed: ${error.code}`
          : 'Reconciliation failed. Check that migrations are applied (pnpm db:migrate).';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
