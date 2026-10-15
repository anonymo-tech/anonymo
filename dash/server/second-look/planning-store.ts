import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CoolHeadSettings,
  ExitPlanInput,
  PlanningResponse,
  SavedExitPlan,
} from '../../lib/second-look/planning.ts';
import { planningResponse } from '../../lib/client/planning-contracts.ts';
import { transaction } from '../db/database.ts';
import { requireCondition } from '../core/errors.ts';
import {
  configuredKeyring,
  decryptText,
  encryptText,
} from '../core/encryption.ts';

const defaults = (): CoolHeadSettings => ({
  enabled: true,
  timezone: 'UTC',
  dailyBudgetUsd6: null,
});
const capabilities: PlanningResponse['capabilities'] = {
  priceWatch: false,
  notificationDelivery: false,
  executesTrades: false,
  behaviorHistory: false,
};
const scope = (account: string, kind: string) =>
  `second-look-planning:${account}:${kind}`;

async function readState(
  client: PoolClient,
  accountId: string,
): Promise<PlanningResponse> {
  const keyring = configuredKeyring();
  const settings = await client.query<{
    revision: number;
    settings_ciphertext: string;
  }>(
    'SELECT revision,settings_ciphertext FROM second_look_planning WHERE account_id=$1',
    [accountId],
  );
  const plans = await client.query<{ payload_ciphertext: string; id: string }>(
    'SELECT id,payload_ciphertext FROM second_look_exit_plans WHERE account_id=$1 ORDER BY created_at DESC,id LIMIT 26',
    [accountId],
  );
  const row = settings.rows[0];
  const result = {
    revision: row?.revision ?? 0,
    coolHead: row
      ? (JSON.parse(
          await decryptText(
            row.settings_ciphertext,
            scope(accountId, 'settings'),
            keyring,
          ),
        ) as CoolHeadSettings)
      : defaults(),
    exitPlans: await Promise.all(
      plans.rows.map(
        async (p) =>
          JSON.parse(
            await decryptText(
              p.payload_ciphertext,
              scope(accountId, p.id),
              keyring,
            ),
          ) as SavedExitPlan,
      ),
    ),
    capabilities,
  };
  requireCondition(
    planningResponse(result),
    503,
    'PLANNING_UNAVAILABLE',
    'Saved planning settings could not be read.',
  );
  return result;
}
export async function getPlanning(pool: Pool, accountId: string) {
  return transaction(pool, async (client) => {
    // Read settings and plans from the same MVCC snapshot.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return readState(client, accountId);
  });
}
type Change =
  | { kind: 'settings'; settings: CoolHeadSettings }
  | { kind: 'create'; plan: ExitPlanInput }
  | { kind: 'delete'; id: string };
export async function changePlanning(
  pool: Pool,
  accountId: string,
  revision: number,
  change: Change,
) {
  return transaction(pool, async (client) => {
    const account = await client.query(
      'SELECT id FROM accounts WHERE id=$1 FOR UPDATE',
      [accountId],
    );
    requireCondition(
      account.rowCount === 1,
      401,
      'SESSION_REQUIRED',
      'Sign in again.',
    );
    const state = await readState(client, accountId);
    requireCondition(
      state.revision === revision,
      409,
      'PLANNING_REVISION_CONFLICT',
      'Planning settings changed. Refresh before saving again.',
    );
    const keyring = configuredKeyring();
    const updatedSettings =
      change.kind === 'settings' ? change.settings : state.coolHead;
    await client.query(
      `INSERT INTO second_look_planning(account_id,revision,settings_ciphertext) VALUES($1,$2,$3)
      ON CONFLICT(account_id) DO UPDATE SET revision=EXCLUDED.revision,settings_ciphertext=EXCLUDED.settings_ciphertext,updated_at=now()`,
      [
        accountId,
        revision + 1,
        await encryptText(
          JSON.stringify(updatedSettings),
          scope(accountId, 'settings'),
          keyring,
        ),
      ],
    );
    if (change.kind === 'create') {
      requireCondition(
        state.exitPlans.length < 25,
        409,
        'EXIT_PLAN_LIMIT',
        'Up to 25 reminder plans can be saved.',
      );
      requireCondition(
        !state.exitPlans.some(
          (p) =>
            p.walletId.toLowerCase() === change.plan.walletId.toLowerCase() &&
            p.mint === change.plan.mint,
        ),
        409,
        'EXIT_PLAN_EXISTS',
        'A reminder plan already exists for this wallet and token.',
      );
      const wallet = await client.query(
        'SELECT id FROM second_look_wallets WHERE account_id=$1 AND id=$2',
        [accountId, change.plan.walletId],
      );
      requireCondition(
        wallet.rowCount === 1,
        404,
        'WALLET_NOT_FOUND',
        'This linked wallet is unavailable.',
      );
      const now = new Date().toISOString();
      const plan: SavedExitPlan = {
        ...change.plan,
        walletId: change.plan.walletId.toLowerCase(),
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        mode: 'reminder',
        status: 'awaiting_feed',
      };
      await client.query(
        'INSERT INTO second_look_exit_plans(id,account_id,wallet_id,payload_ciphertext) VALUES($1,$2,$3,$4)',
        [
          plan.id,
          accountId,
          plan.walletId,
          await encryptText(
            JSON.stringify(plan),
            scope(accountId, plan.id),
            keyring,
          ),
        ],
      );
    } else if (change.kind === 'delete') {
      const removed = await client.query(
        'DELETE FROM second_look_exit_plans WHERE account_id=$1 AND id=$2',
        [accountId, change.id],
      );
      requireCondition(
        removed.rowCount === 1,
        404,
        'EXIT_PLAN_NOT_FOUND',
        'This reminder plan is unavailable.',
      );
    }
    return readState(client, accountId);
  });
}
