import type {
  CoolHeadSettings,
  ExitPlanInput,
  PlanningResponse,
} from '../second-look/planning.ts';
import { object } from './second-look.ts';

const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const bps = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 10000;
const price = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^(0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(v) &&
  /[1-9]/.test(v);
const leg = (v: unknown) =>
  v === null || (object(v) && price(v.priceUsd) && bps(v.sizeBps));
const time = (v: unknown) =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
export function coolHeadSettings(v: unknown): v is CoolHeadSettings {
  if (
    !object(v) ||
    typeof v.enabled !== 'boolean' ||
    typeof v.timezone !== 'string' ||
    v.timezone.length > 80
  )
    return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v.timezone });
  } catch {
    return false;
  }
  return (
    v.dailyBudgetUsd6 === null ||
    (typeof v.dailyBudgetUsd6 === 'string' &&
      /^[1-9]\d{0,14}$/.test(v.dailyBudgetUsd6))
  );
}
export function exitPlanInput(v: unknown): v is ExitPlanInput {
  if (
    !object(v) ||
    !uuid(v.walletId) ||
    typeof v.mint !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.mint) ||
    !leg(v.takeProfit) ||
    !leg(v.stopLoss)
  )
    return false;
  if (!v.takeProfit && !v.stopLoss) return false;
  if (
    v.trailingBps !== null &&
    (!bps(v.trailingBps) || v.trailingBps >= 10000 || !v.stopLoss)
  )
    return false;
  if (object(v.takeProfit) && object(v.stopLoss)) {
    const exact = (p: string) => {
      const [a, b = ''] = p.split('.');
      return BigInt(a + b.padEnd(18, '0'));
    };
    if (
      exact(v.takeProfit.priceUsd as string) <=
      exact(v.stopLoss.priceUsd as string)
    )
      return false;
  }
  return true;
}
export function planningResponse(v: unknown): v is PlanningResponse {
  return (
    object(v) &&
    Number.isSafeInteger(v.revision) &&
    Number(v.revision) >= 0 &&
    coolHeadSettings(v.coolHead) &&
    Array.isArray(v.exitPlans) &&
    v.exitPlans.length <= 25 &&
    new Set(v.exitPlans.map((p: unknown) => (object(p) ? p.id : null))).size ===
      v.exitPlans.length &&
    v.exitPlans.every(
      (p: unknown) =>
        object(p) &&
        uuid(p.id) &&
        time(p.createdAt) &&
        time(p.updatedAt) &&
        p.mode === 'reminder' &&
        p.status === 'awaiting_feed' &&
        exitPlanInput(p),
    ) &&
    object(v.capabilities) &&
    [
      'priceWatch',
      'notificationDelivery',
      'executesTrades',
      'behaviorHistory',
    ].every((k) => (v.capabilities as Record<string, unknown>)[k] === false)
  );
}
