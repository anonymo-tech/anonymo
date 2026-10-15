import { createHash } from 'node:crypto';
import { decimalRatio } from './pnl.ts';

export type ExitLeg = 'take_profit' | 'stop' | 'trailing_stop';
export type ExitPriceLeg = { price: string; sizePercent: string };
export type ExitReminderPlan = {
  id: string;
  revision: string;
  mint: string;
  quoteCurrency: string;
  takeProfit?: ExitPriceLeg;
  stop?: ExitPriceLeg;
  trailing?: { distancePercent: string; sizePercent: string };
  /** Both quotes must be this fresh; defaults to 30 seconds. */
  quoteMaxAgeMs?: number;
};
export type ExitQuote = {
  source: string;
  id: string;
  mint: string;
  quoteCurrency: string;
  price: string;
  /** Canonical UTC ISO timestamp, with milliseconds. */
  observedAt: string;
};
type QuoteCheckpoint = Pick<ExitQuote, 'source' | 'id' | 'observedAt'>;
export type ExitWatchState = {
  version: 1;
  planId: string;
  planRevision: string;
  planFingerprint: string;
  lastEvaluationAt: string | null;
  lastRead: { primary: QuoteCheckpoint; crosscheck: QuoteCheckpoint } | null;
  highWaterPrice: string | null;
  awaitingAgreement: boolean;
  agreeingReads: 0 | 1;
  emittedLegs: ExitLeg[];
};
export type ExitReminder = {
  kind: 'reminder';
  id: string;
  planId: string;
  planRevision: string;
  mint: string;
  quoteCurrency: string;
  leg: ExitLeg;
  sizePercent: string;
  observedPrice: string;
  thresholdPrice: string;
  at: string;
  evidence: { primary: ExitQuote; crosscheck: ExitQuote };
};
export type ExitEvaluationStatus =
  | 'watching'
  | 'triggered'
  | 'quote_unavailable'
  | 'quote_invalid'
  | 'quote_stale'
  | 'quote_disagreement'
  | 'confirming_agreement'
  | 'ignored_replay';
export type ExitEvaluation = {
  state: ExitWatchState;
  status: ExitEvaluationStatus;
  reminders: ExitReminder[];
};
export type ExitEvaluationInput = {
  now: string;
  primary: ExitQuote | null;
  crosscheck: ExitQuote | null;
};

type Decimal = { numerator: bigint; denominator: bigint };
const legs: ExitLeg[] = ['take_profit', 'stop', 'trailing_stop'];
function decimal(value: string): Decimal {
  const [numerator, denominator] = decimalRatio(value);
  return { numerator, denominator };
}
function compare(a: Decimal, b: Decimal) {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
function normalized(value: string) {
  decimal(value);
  return value.includes('.')
    ? value.replace(/0+$/, '').replace(/\.$/, '')
    : value;
}
function positive(value: string) {
  const parsed = decimal(value);
  if (parsed.numerator <= 0n) throw new Error('Exit prices must be positive.');
  return parsed;
}
function percentage(value: string, allowHundred = true) {
  const parsed = positive(value);
  const max = 100n * parsed.denominator;
  if (parsed.numerator > max || (!allowHundred && parsed.numerator === max))
    throw new Error('Invalid exit percentage.');
}
function identifier(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    /\p{Cc}/u.test(value)
  )
    throw new Error('Invalid exit identifier.');
}
function timestamp(value: string) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw new Error('Exit timestamps must be canonical UTC instants.');
  return ms;
}
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Validates and binds an immutable plan revision; amounts never pass through Number. */
function planFingerprint(plan: ExitReminderPlan) {
  for (const value of [plan.id, plan.revision, plan.mint, plan.quoteCurrency])
    identifier(value);
  if (!plan.takeProfit && !plan.stop && !plan.trailing)
    throw new Error('An exit plan needs at least one reminder.');
  const priceLeg = (leg?: ExitPriceLeg) => {
    if (!leg) return null;
    positive(leg.price);
    percentage(leg.sizePercent);
    return {
      price: normalized(leg.price),
      sizePercent: normalized(leg.sizePercent),
    };
  };
  const takeProfit = priceLeg(plan.takeProfit),
    stop = priceLeg(plan.stop);
  if (
    takeProfit &&
    stop &&
    compare(decimal(takeProfit.price), decimal(stop.price)) <= 0
  )
    throw new Error('Take-profit price must be above the stop price.');
  if (plan.trailing) {
    percentage(plan.trailing.distancePercent, false);
    percentage(plan.trailing.sizePercent);
  }
  const maxAge = plan.quoteMaxAgeMs ?? 30_000;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 300_000)
    throw new Error('Invalid exit quote freshness window.');
  return hash({
    id: plan.id,
    revision: plan.revision,
    mint: plan.mint,
    quoteCurrency: plan.quoteCurrency,
    takeProfit,
    stop,
    trailing: plan.trailing
      ? {
          distancePercent: normalized(plan.trailing.distancePercent),
          sizePercent: normalized(plan.trailing.sizePercent),
        }
      : null,
    quoteMaxAgeMs: maxAge,
  });
}

export function createExitWatchState(plan: ExitReminderPlan): ExitWatchState {
  return {
    version: 1,
    planId: plan.id,
    planRevision: plan.revision,
    planFingerprint: planFingerprint(plan),
    lastEvaluationAt: null,
    lastRead: null,
    highWaterPrice: null,
    awaitingAgreement: false,
    agreeingReads: 0,
    emittedLegs: [],
  };
}

function validateState(plan: ExitReminderPlan, state: ExitWatchState) {
  if (
    state.version !== 1 ||
    state.planId !== plan.id ||
    state.planRevision !== plan.revision ||
    state.planFingerprint !== planFingerprint(plan) ||
    typeof state.awaitingAgreement !== 'boolean' ||
    ![0, 1].includes(state.agreeingReads) ||
    (!state.awaitingAgreement && state.agreeingReads !== 0) ||
    !Array.isArray(state.emittedLegs) ||
    state.emittedLegs.length > 3 ||
    new Set(state.emittedLegs).size !== state.emittedLegs.length ||
    state.emittedLegs.some((leg) => !legs.includes(leg))
  )
    throw new Error('Exit state does not match the immutable plan revision.');
  if (state.lastEvaluationAt !== null) timestamp(state.lastEvaluationAt);
  if (state.highWaterPrice !== null) positive(state.highWaterPrice);
  if (state.lastRead !== null) {
    for (const read of [state.lastRead.primary, state.lastRead.crosscheck]) {
      identifier(read.source);
      identifier(read.id);
      timestamp(read.observedAt);
    }
  }
}
function checkpoint(quote: ExitQuote): QuoteCheckpoint {
  return { source: quote.source, id: quote.id, observedAt: quote.observedAt };
}

/** Exact terminating decimal: a price times (100 - trailing %) / 100. */
function trailingThreshold(high: string, distancePercent: string) {
  const peak = decimal(high),
    distance = decimal(distancePercent);
  const numerator =
    peak.numerator * (100n * distance.denominator - distance.numerator);
  const denominator = peak.denominator * distance.denominator * 100n;
  const scale = denominator.toString().length - 1;
  const digits = numerator.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

/**
 * Pure reminder evaluation; this module never signs, submits or executes a trade.
 *
 * Durable callers must serialize evaluations for a plan revision and atomically
 * persist the returned state and an outbox row keyed by each reminder.id. Deliver
 * the outbox idempotently; do not send before that commit. Retrying the same old
 * state yields the same IDs, while committed emittedLegs prevents repeat alerts.
 * Editing a plan requires a new revision and a fresh state, never reusing this one.
 *
 * The source adapter must supply independent feeds and immutable observation IDs;
 * timestamps describe the underlying quote, not the time a cached quote was read.
 * Recovery requires two new agreeing pairs: BOTH source timestamps must advance.
 * Disagreement is abs(primary - crosscheck) / primary > 3%, calculated exactly.
 * A trailing high starts at the first trusted reading, and only advances while
 * agreement is confirmed. Size percentages describe each leg independently; these
 * are reminders, not amounts executed or deducted from a position.
 */
export function evaluateExitPlan(
  plan: ExitReminderPlan,
  previous: ExitWatchState,
  input: ExitEvaluationInput,
): ExitEvaluation {
  validateState(plan, previous);
  const now = timestamp(input.now);
  const state: ExitWatchState = {
    ...previous,
    lastRead: previous.lastRead
      ? {
          primary: { ...previous.lastRead.primary },
          crosscheck: { ...previous.lastRead.crosscheck },
        }
      : null,
    emittedLegs: [...previous.emittedLegs],
  };
  const finish = (status: ExitEvaluationStatus): ExitEvaluation => ({
    state,
    status,
    reminders: [],
  });
  if (
    state.lastEvaluationAt !== null &&
    now < timestamp(state.lastEvaluationAt)
  )
    return finish('ignored_replay');
  state.lastEvaluationAt = input.now;
  const unavailable = (status: ExitEvaluationStatus) => {
    state.agreeingReads = 0;
    return finish(status);
  };
  const { primary, crosscheck } = input;
  if (!primary || !crosscheck) return unavailable('quote_unavailable');
  let primaryPrice: Decimal, crossPrice: Decimal;
  try {
    for (const quote of [primary, crosscheck]) {
      identifier(quote.source);
      identifier(quote.id);
      timestamp(quote.observedAt);
      if (
        quote.mint !== plan.mint ||
        quote.quoteCurrency !== plan.quoteCurrency
      )
        throw new Error('Quote identity mismatch.');
    }
    if (primary.source === crosscheck.source)
      throw new Error('Quote sources must differ.');
    primaryPrice = positive(primary.price);
    crossPrice = positive(crosscheck.price);
  } catch {
    return unavailable('quote_invalid');
  }
  const primaryAt = timestamp(primary.observedAt),
    crossAt = timestamp(crosscheck.observedAt);
  if (primaryAt > now || crossAt > now) return unavailable('quote_invalid');
  const maxAge = plan.quoteMaxAgeMs ?? 30_000;
  if (now - primaryAt > maxAge || now - crossAt > maxAge)
    return unavailable('quote_stale');
  const previousRead = state.lastRead;
  const primaryAdvanced =
    !previousRead || primaryAt > timestamp(previousRead.primary.observedAt);
  const crossAdvanced =
    !previousRead || crossAt > timestamp(previousRead.crosscheck.observedAt);
  if (
    previousRead &&
    (primaryAt < timestamp(previousRead.primary.observedAt) ||
      crossAt < timestamp(previousRead.crosscheck.observedAt) ||
      (!primaryAdvanced && !crossAdvanced) ||
      (primaryAdvanced &&
        primary.source === previousRead.primary.source &&
        primary.id === previousRead.primary.id) ||
      (crossAdvanced &&
        crosscheck.source === previousRead.crosscheck.source &&
        crosscheck.id === previousRead.crosscheck.id))
  )
    return finish('ignored_replay');
  const signedDifference =
    primaryPrice.numerator * crossPrice.denominator -
    crossPrice.numerator * primaryPrice.denominator;
  const difference =
    signedDifference < 0n ? -signedDifference : signedDifference;
  if (
    difference * 100n >
    primaryPrice.numerator * crossPrice.denominator * 3n
  ) {
    // One feed can reveal a discrepancy before the other feed publishes again.
    state.lastRead = {
      primary: checkpoint(primary),
      crosscheck: checkpoint(crosscheck),
    };
    state.awaitingAgreement = true;
    state.agreeingReads = 0;
    return finish('quote_disagreement');
  }
  if (!primaryAdvanced || !crossAdvanced) return finish('ignored_replay');
  state.lastRead = {
    primary: checkpoint(primary),
    crosscheck: checkpoint(crosscheck),
  };
  if (state.awaitingAgreement) {
    if (state.agreeingReads === 0) {
      state.agreeingReads = 1;
      return finish('confirming_agreement');
    }
    state.awaitingAgreement = false;
    state.agreeingReads = 0;
  }
  if (
    state.highWaterPrice === null ||
    compare(primaryPrice, decimal(state.highWaterPrice)) > 0
  )
    state.highWaterPrice = normalized(primary.price);
  const reminders: ExitReminder[] = [];
  const maybeRemind = (
    leg: ExitLeg,
    sizePercent: string,
    thresholdPrice: string,
    reached: boolean,
  ) => {
    if (!reached || state.emittedLegs.includes(leg)) return;
    state.emittedLegs.push(leg);
    reminders.push({
      kind: 'reminder',
      id: hash(['exit-reminder-v1', plan.id, plan.revision, leg]),
      planId: plan.id,
      planRevision: plan.revision,
      mint: plan.mint,
      quoteCurrency: plan.quoteCurrency,
      leg,
      sizePercent: normalized(sizePercent),
      observedPrice: normalized(primary.price),
      thresholdPrice,
      at: input.now,
      evidence: { primary: { ...primary }, crosscheck: { ...crosscheck } },
    });
  };
  if (plan.takeProfit)
    maybeRemind(
      'take_profit',
      plan.takeProfit.sizePercent,
      normalized(plan.takeProfit.price),
      compare(primaryPrice, decimal(plan.takeProfit.price)) >= 0,
    );
  if (plan.stop)
    maybeRemind(
      'stop',
      plan.stop.sizePercent,
      normalized(plan.stop.price),
      compare(primaryPrice, decimal(plan.stop.price)) <= 0,
    );
  if (plan.trailing) {
    const high = decimal(state.highWaterPrice),
      distance = decimal(plan.trailing.distancePercent);
    const threshold = {
      numerator:
        high.numerator * (100n * distance.denominator - distance.numerator),
      denominator: high.denominator * distance.denominator * 100n,
    };
    maybeRemind(
      'trailing_stop',
      plan.trailing.sizePercent,
      trailingThreshold(state.highWaterPrice, plan.trailing.distancePercent),
      compare(primaryPrice, threshold) <= 0,
    );
  }
  return {
    state,
    status: reminders.length ? 'triggered' : 'watching',
    reminders,
  };
}
