import { formatAccountUsd6 } from '../../lib/client/account-records.ts';

type Billing = {
  maximumUsd6: string | null;
  actualUsd6: string | null;
};
type BilledAnswer = { live?: { billing?: Billing } };

const knownAmount = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

/** Exact USD6 display, with at least four decimal places and no rounding. */
export function formatAnswerUsd6(value: string): string | null {
  if (!knownAmount(value)) return null;
  const amount = BigInt(value);
  // Format the fraction with the shared helper; a multi-answer sum can exceed
  // its per-account input limit even when each individual amount is valid.
  const fraction = formatAccountUsd6((amount % 1_000_000n).toString()).split('.')[1];
  return `$${amount / 1_000_000n}.${fraction.padEnd(4, '0')}`;
}

export function answerCosts(billing?: Billing) {
  if (!billing || !knownAmount(billing.maximumUsd6)) return null;
  if (billing.actualUsd6 !== null && !knownAmount(billing.actualUsd6)) return null;
  return {
    quoted: formatAnswerUsd6(billing.maximumUsd6)!,
    settled: billing.actualUsd6 === null ? null : formatAnswerUsd6(billing.actualUsd6),
  };
}

/** A comparison total is available only when every live answer has both amounts. */
export function sumAnswerCosts(answers: readonly BilledAnswer[]) {
  if (answers.length < 2) return null;
  let maximum = 0n;
  let actual = 0n;
  for (const answer of answers) {
    const billing = answer.live?.billing;
    if (!billing || !knownAmount(billing.maximumUsd6) || !knownAmount(billing.actualUsd6))
      return null;
    maximum += BigInt(billing.maximumUsd6);
    actual += BigInt(billing.actualUsd6);
  }
  return {
    quoted: formatAnswerUsd6(maximum.toString())!,
    settled: formatAnswerUsd6(actual.toString())!,
  };
}
