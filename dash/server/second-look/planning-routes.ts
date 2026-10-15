import type { Pool } from 'pg';
import {
  coolHeadSettings,
  exitPlanInput,
} from '../../lib/client/planning-contracts.ts';
import { jsonResponse, readJson, uuidField } from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import { address } from '../solana/validation.ts';
import { changePlanning, getPlanning } from './planning-store.ts';

export async function planningRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path === 'second-look/planning' && request.method === 'GET')
    return jsonResponse(await getPlanning(pool, accountId));
  const settings =
    path === 'second-look/planning/cool-head' && request.method === 'PATCH';
  const create =
    path === 'second-look/planning/exit-plans' && request.method === 'POST';
  const remove =
    request.method === 'DELETE'
      ? /^second-look\/planning\/exit-plans\/([^/]+)$/.exec(path)
      : null;
  if (!settings && !create && !remove) return null;
  const body = await readJson(request, 4096);
  const revision = body.revision;
  requireCondition(
    typeof revision === 'number' &&
      Number.isSafeInteger(revision) &&
      revision >= 0 &&
      revision < 2_147_483_647,
    400,
    'INVALID_REQUEST',
    'A valid planning revision is required.',
  );
  const keys = settings
    ? ['revision', 'enabled', 'timezone', 'dailyBudgetUsd6']
    : create
      ? [
          'revision',
          'walletId',
          'mint',
          'takeProfit',
          'stopLoss',
          'trailingBps',
        ]
      : ['revision'];
  requireCondition(
    Object.keys(body).every((k) => keys.includes(k)),
    400,
    'INVALID_REQUEST',
    'Unsupported planning fields.',
  );
  if (settings) {
    requireCondition(
      coolHeadSettings(body),
      400,
      'INVALID_BUDGET',
      'Enter a valid daily budget and timezone.',
    );
    return jsonResponse(
      await changePlanning(pool, accountId, revision, {
        kind: 'settings',
        settings: {
          enabled: body.enabled,
          timezone: body.timezone,
          dailyBudgetUsd6: body.dailyBudgetUsd6,
        },
      }),
    );
  }
  if (create) {
    requireCondition(
      exitPlanInput(body),
      400,
      'INVALID_EXIT_PLAN',
      'Enter a valid target or stop and percentage.',
    );
    for (const value of [body.takeProfit, body.stopLoss])
      if (value)
        requireCondition(
          Object.keys(value).every((k) => ['priceUsd', 'sizeBps'].includes(k)),
          400,
          'INVALID_EXIT_PLAN',
          'Unsupported reminder leg fields.',
        );
    try {
      address(body.mint);
    } catch {
      requireCondition(
        false,
        400,
        'INVALID_EXIT_PLAN',
        'Enter a canonical Solana mint address.',
      );
    }
    return jsonResponse(
      await changePlanning(pool, accountId, revision, {
        kind: 'create',
        plan: {
          walletId: body.walletId.toLowerCase(),
          mint: body.mint,
          takeProfit: body.takeProfit,
          stopLoss: body.stopLoss,
          trailingBps: body.trailingBps,
        },
      }),
      201,
    );
  }
  return jsonResponse(
    await changePlanning(pool, accountId, revision, {
      kind: 'delete',
      id: uuidField(remove![1]),
    }),
  );
}
