import {
  deepProducerConfig,
  requestDeepProducer,
  parseDeepProducerResult,
  type DeepProducerConfig,
  type DeepProducerMarker,
} from './deep-producer.ts';
import {
  forkProbeConfig,
  type ForkProbeConfig,
} from './providers-simulation.ts';
import { deriveTokenCalibration } from './token-calibration.ts';
import type { Pool, PoolClient } from 'pg';
import { one, transaction } from '../db/database.ts';
import { ledgerAccount, post } from '../ledger/ledger.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { address } from '../solana/validation.ts';
import {
  tokenCapability,
  tokenProviderConfig,
  createTokenProviders,
  type TokenProviderConfig,
  type TokenProviders,
} from './providers.ts';
import {
  collectTokenFacts,
  blankChecks,
  type TokenFacts,
} from './token-facts.ts';
import { evaluateTokenFacts, cacheSeconds } from './token-rules.ts';
import { parseReviewedTokenEvidence, applyReviewedEvidence } from './deep.ts';
import type { TokenReport, TokenQuote } from '../../lib/second-look/token.ts';

type QuoteRow = {
  id: string;
  account_id: string;
  mint: string;
  mode: 'standard' | 'deep';
  maximum_usd6: string;
  evidence_id: string | null;
  quota_day: string | Date;
  expires_at: Date;
  created_at: Date;
};
type ReportRow = {
  id: string;
  account_id: string;
  quote_id: string;
  state: TokenReport['state'];
  billing_state: TokenReport['billing']['state'];
  maximum_usd6: string;
  actual_usd6: string | null;
  document: TokenReport & { _producer?: DeepProducerMarker };
  lease_id: string;
  lease_expires_at: Date;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const hash = async (value: unknown) =>
  Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical(value)),
    ),
  ).toString('hex');
async function lockAccount(db: PoolClient, id: string, active = true) {
  requireCondition(
    await one(
      db,
      'SELECT id FROM accounts WHERE id=$1 AND (NOT $2::boolean OR disabled_at IS NULL) FOR UPDATE',
      [id, active],
    ),
    401,
    'ACCOUNT_UNAVAILABLE',
    'This account is unavailable.',
  );
}
async function now(db: PoolClient) {
  return (await one<{ now: Date; day: string }>(
    db,
    "SELECT clock_timestamp() AS now,(clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day",
  ))!;
}
export async function consumeAnonymousTokenBudget(
  db: PoolClient,
  day: string,
  globalLimit: number,
) {
  await db.query(
    'INSERT INTO secondlook_token_global_usage(day) VALUES($1) ON CONFLICT DO NOTHING',
    [day],
  );
  const global = await one<{ used: number }>(
    db,
    'SELECT used FROM secondlook_token_global_usage WHERE day=$1 FOR UPDATE',
    [day],
  );
  requireCondition(
    global && global.used < globalLimit,
    429,
    'TOKEN_FREE_BUDGET_EXHAUSTED',
    'The free-check budget is exhausted. Only existing fresh cached reports are available.',
  );
  await db.query(
    'UPDATE secondlook_token_global_usage SET used=used+1 WHERE day=$1',
    [day],
  );
}
/** The Telegram linked-account path uses the same counter; caller must hold the account lock. */
export async function consumeFreeTokenQuota(
  db: PoolClient,
  accountId: string,
  day: string,
  globalLimit: number,
  cached = false,
) {
  await db.query(
    'INSERT INTO secondlook_token_usage(account_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [accountId, day],
  );
  const used = await one<{ used: number }>(
    db,
    'SELECT used FROM secondlook_token_usage WHERE account_id=$1 AND day=$2 FOR UPDATE',
    [accountId, day],
  );
  requireCondition(
    used && used.used < 10,
    409,
    'TOKEN_FREE_QUOTA_EXHAUSTED',
    'The ten free daily token checks have been used. Request a new quote.',
  );
  if (!cached) await consumeAnonymousTokenBudget(db, day, globalLimit);
  await db.query(
    'UPDATE secondlook_token_usage SET used=used+1 WHERE account_id=$1 AND day=$2',
    [accountId, day],
  );
}
export async function reserveLinkedTokenFreeCheck(
  pool: Pool,
  accountId: string,
  config = tokenProviderConfig(),
) {
  return transaction(pool, async (db) => {
    await lockAccount(db, accountId);
    const time = await now(db);
    await consumeFreeTokenQuota(
      db,
      accountId,
      time.day,
      config.freeDailyGlobalLimit,
    );
  });
}
export async function installTokenEvidence(
  pool: Pool,
  artifact: unknown,
  mint: string,
) {
  const parsed = await parseReviewedTokenEvidence(artifact, address(mint));
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO secondlook_token_evidence(id,mint,artifact,artifact_hash,observed_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
    [
      id,
      mint,
      JSON.stringify(artifact),
      await hash(artifact),
      parsed.observedAt,
      parsed.expiresAt,
    ],
  );
  return id;
}
export async function installTokenCalibration(pool: Pool, artifact: unknown) {
  const derived = deriveTokenCalibration(artifact);
  const parsed = derived.artifact;
  requireCondition(
    derived.accepted,
    409,
    'TOKEN_CALIBRATION_GATE_FAILED',
    'The observed buy-time dataset did not pass the calibration gates.',
  );
  await pool.query(
    'INSERT INTO secondlook_token_calibration(id,artifact) VALUES($1,$2)',
    [crypto.randomUUID(), JSON.stringify(parsed)],
  );
}
async function evidence(pool: Pool, id: string | null, mint: string) {
  if (!id) return null;
  const row = await one<{ artifact: unknown; artifact_hash: string }>(
    pool,
    'SELECT artifact,artifact_hash FROM secondlook_token_evidence WHERE id=$1 AND mint=$2 AND expires_at>clock_timestamp()',
    [id, mint],
  );
  if (!row || (await hash(row.artifact)) !== row.artifact_hash) return null;
  try {
    return await parseReviewedTokenEvidence(row.artifact, mint);
  } catch {
    return null;
  }
}
async function latestEvidence(pool: Pool, mint: string) {
  return one<{ id: string }>(
    pool,
    'SELECT id FROM secondlook_token_evidence WHERE mint=$1 AND expires_at>clock_timestamp() ORDER BY observed_at DESC,id DESC LIMIT 1',
    [mint],
  );
}
async function calibration(pool: Pool) {
  return (
    (
      await one<{ artifact: unknown }>(
        pool,
        'SELECT artifact FROM secondlook_token_calibration ORDER BY created_at DESC,id DESC LIMIT 1',
      )
    )?.artifact ?? null
  );
}
function quoteView(row: QuoteRow, remaining: number): TokenQuote {
  return {
    id: row.id,
    mint: row.mint,
    mode: row.mode,
    maximumUsd6: row.maximum_usd6,
    expiresAt: row.expires_at.toISOString(),
    freeRemaining: remaining,
    limitations: [
      'This is a fixed maximum card price, charged only after an explicitly approved usable report is saved.',
      'Some sources may be unavailable; missing simulation keeps the result Checking. Missing calibration withholds verdict words.',
      ...(row.mode === 'deep'
        ? [
            'Deep costs up to $0.10. With a configured fresh-claim producer, this authorizes one bounded request including retrieval and independent reviews. Unknown outcomes retain the reservation; recovery never submits another request. Otherwise only already-reviewed snapshots are used.',
          ]
        : []),
    ],
  };
}
export async function quoteTokenCheck(
  pool: Pool,
  accountId: string,
  input: { mint: string; mode: 'standard' | 'deep'; idempotencyKey: string },
  config = tokenProviderConfig(),
): Promise<{ quote: TokenQuote }> {
  let mint: string;
  try {
    mint = address(input.mint);
  } catch {
    throw new ServiceError(
      400,
      'TOKEN_INPUT_INVALID',
      'Enter a canonical Solana mint address.',
    );
  }
  requireCondition(
    ['standard', 'deep'].includes(input.mode) &&
      /^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey),
    400,
    'TOKEN_REQUEST_INVALID',
    'The token-check request is invalid.',
  );
  // Replay resolves immutable accepted terms before configuration changes.
  const prior = await one<QuoteRow>(
    pool,
    'SELECT * FROM secondlook_token_quotes WHERE account_id=$1 AND idempotency_key=$2',
    [accountId, input.idempotencyKey],
  );
  if (prior) {
    requireCondition(
      prior.mint === mint && prior.mode === input.mode,
      409,
      'IDEMPOTENCY_CONFLICT',
      'This request key belongs to different token-check terms.',
    );
    return { quote: quoteView(prior, 0) };
  }
  const capability = tokenCapability(config);
  requireCondition(
    capability.configured,
    503,
    'TOKEN_CHECK_UNAVAILABLE',
    'Token checking requires an enabled mainnet data source.',
  );
  requireCondition(
    input.mode !== 'deep' || capability.deepConfigured,
    503,
    'TOKEN_DEEP_UNAVAILABLE',
    'Deep checking requires reviewed launch and claim evidence.',
  );
  const ref =
    config.evidence || config.simulation
      ? await latestEvidence(pool, mint)
      : null;
  const reviewed = ref ? await evidence(pool, ref.id, mint) : null;
  requireCondition(
    input.mode !== 'deep' ||
      (reviewed?.deep &&
        (reviewed.deep.status === 'complete' || deepProducerConfig())),
    503,
    'TOKEN_DEEP_UNAVAILABLE',
    'No fresh reviewed launch and claim evidence exists for this mint.',
  );
  return transaction(pool, async (db) => {
    await lockAccount(db, accountId);
    const repeated = await one<QuoteRow>(
      db,
      'SELECT * FROM secondlook_token_quotes WHERE account_id=$1 AND idempotency_key=$2',
      [accountId, input.idempotencyKey],
    );
    if (repeated) {
      requireCondition(
        repeated.mint === mint && repeated.mode === input.mode,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This request key belongs to different terms.',
      );
      return { quote: quoteView(repeated, 0) };
    }
    const time = await now(db),
      usage = await one<{ used: number }>(
        db,
        'SELECT used FROM secondlook_token_usage WHERE account_id=$1 AND day=$2',
        [accountId, time.day],
      );
    const remaining = Math.max(0, 10 - (usage?.used ?? 0));
    const maximum =
      input.mode === 'deep' ? '100000' : remaining ? '0' : '20000';
    const expiry = Math.min(
      time.now.getTime() + 90000,
      reviewed && input.mode === 'deep'
        ? Date.parse(reviewed.expiresAt)
        : Infinity,
    );
    requireCondition(
      expiry > time.now.getTime() + 1000,
      409,
      'TOKEN_EVIDENCE_EXPIRED',
      'Reviewed evidence expired. Request a fresh quote.',
    );
    const row = await one<QuoteRow>(
      db,
      'INSERT INTO secondlook_token_quotes(id,account_id,mint,mode,idempotency_key,maximum_usd6,evidence_id,quota_day,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [
        crypto.randomUUID(),
        accountId,
        mint,
        input.mode,
        input.idempotencyKey,
        maximum,
        reviewed ? ref?.id : null,
        time.day,
        time.now,
        new Date(expiry),
      ],
    );
    return { quote: quoteView(row!, remaining) };
  });
}
async function settle(db: PoolClient, row: ReportRow, capture: boolean) {
  if (row.billing_state !== 'held') return;
  const reserved = await ledgerAccount(db, row.account_id, 'reserved'),
    destination = await ledgerAccount(
      db,
      capture ? null : row.account_id,
      capture ? 'revenue' : 'available',
    );
  await post(
    db,
    `secondlook:${row.id}:${capture ? 'capture' : 'release'}`,
    capture ? 'capture' : 'release',
    [
      { id: reserved.id, amount: -BigInt(row.maximum_usd6) },
      { id: destination.id, amount: BigInt(row.maximum_usd6) },
    ],
  );
}
function present(row: ReportRow): TokenReport {
  const doc = structuredClone(row.document);
  const pendingProducer = !!doc._producer && row.state === 'pending';
  delete doc._producer;
  doc.billing = {
    state: row.billing_state,
    maximumUsd6: row.maximum_usd6,
    actualUsd6: row.actual_usd6,
    ...(pendingProducer ? { reconciliationPending: true } : {}),
  };
  if (pendingProducer)
    doc.limitations = [
      ...doc.limitations,
      'A claim producer may have incurred cost. The reservation remains held until its original request is reconciled; recovery only reads status.',
    ];
  if (Date.parse(doc.expiresAt) <= Date.now()) {
    doc.verdict = 'checking';
    doc.limitations = [
      ...doc.limitations,
      'This saved report has expired; obtain a fresh observation before relying on its facts.',
    ];
  }
  return doc;
}
export async function readTokenReport(
  pool: Pool,
  accountId: string,
  id: string,
  options: {
    producer?: DeepProducerConfig | null;
    recoverProducer?: boolean;
  } = {},
): Promise<TokenReport> {
  const stored = await transaction(pool, async (db) => {
    await lockAccount(db, accountId);
    let row = await one<ReportRow>(
      db,
      'SELECT * FROM secondlook_token_reports WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [id, accountId],
    );
    requireCondition(
      row,
      404,
      'TOKEN_REPORT_NOT_FOUND',
      'This token report is unavailable.',
    );
    const time = await now(db);
    if (
      row.state === 'pending' &&
      !row.document._producer &&
      row.lease_expires_at <= time.now
    ) {
      await settle(db, row, false);
      const doc = {
        ...row.document,
        state: 'failed',
        updatedAt: time.now.toISOString(),
        limitations: [
          'The read-only check was interrupted. Any reserved card payment has been released.',
        ],
        verdict: 'checking',
      };
      row = (await one<ReportRow>(
        db,
        "UPDATE secondlook_token_reports SET state='failed',billing_state=CASE WHEN billing_state='held' THEN 'released' ELSE billing_state END,actual_usd6=0,document=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [id, JSON.stringify(doc)],
      ))!;
    }
    return row;
  });
  if (
    stored.state === 'pending' &&
    stored.document._producer &&
    options.recoverProducer !== false
  ) {
    await recoverDeepReport(
      pool,
      accountId,
      stored,
      options.producer === undefined ? deepProducerConfig() : options.producer,
    );
    return readTokenReport(pool, accountId, id, { recoverProducer: false });
  }
  return present(stored);
}
export async function approveTokenCheck(
  pool: Pool,
  accountId: string,
  input: { quoteId: string; approvedMaximumUsd6: string },
  options: {
    config?: TokenProviderConfig;
    providers?: TokenProviders;
    signal?: AbortSignal;
    producer?: DeepProducerConfig | null;
    forkProbe?: ForkProbeConfig | null;
    beforeRead?: (db: PoolClient) => Promise<void>;
  } = {},
): Promise<{ report: TokenReport; replayed: boolean }> {
  const config = options.config ?? tokenProviderConfig();
  const setup = await transaction(pool, async (db) => {
    await lockAccount(db, accountId);
    const quote = await one<QuoteRow>(
      db,
      'SELECT * FROM secondlook_token_quotes WHERE id=$1 AND account_id=$2',
      [input.quoteId, accountId],
    );
    requireCondition(
      quote,
      404,
      'TOKEN_QUOTE_NOT_FOUND',
      'This token quote is unavailable.',
    );
    requireCondition(
      input.approvedMaximumUsd6 === quote.maximum_usd6,
      409,
      'TOKEN_PRICE_MISMATCH',
      'Approve the exact quoted maximum.',
    );
    const prior = await one<ReportRow>(
      db,
      'SELECT * FROM secondlook_token_reports WHERE quote_id=$1 AND account_id=$2',
      [quote.id, accountId],
    );
    if (prior) return { row: prior, quote, replayed: true, cached: null };
    const time = await now(db);
    requireCondition(
      quote.expires_at > time.now,
      409,
      'TOKEN_QUOTE_EXPIRED',
      'This quote expired. Request a new quote.',
    );
    const capability = tokenCapability(config);
    requireCondition(
      capability.configured &&
        (quote.mode !== 'deep' || capability.deepConfigured),
      503,
      'TOKEN_CHECK_UNAVAILABLE',
      'Token checking is not configured.',
    );
    let cached =
      quote.mode === 'standard'
        ? await one<{ facts: TokenFacts }>(
            db,
            'SELECT facts FROM secondlook_token_cache WHERE mint=$1 AND expires_at>clock_timestamp()',
            [quote.mint],
          )
        : null;
    if (
      cached?.facts.checks.some((c) =>
        c.sources.some(
          (s) => !['solana', 'dexscreener', 'rugcheck'].includes(s.provider),
        ),
      )
    )
      cached = null;
    if (quote.maximum_usd6 === '0') {
      requireCondition(
        (quote.quota_day instanceof Date
          ? [
              quote.quota_day.getFullYear(),
              String(quote.quota_day.getMonth() + 1).padStart(2, '0'),
              String(quote.quota_day.getDate()).padStart(2, '0'),
            ].join('-')
          : quote.quota_day) === time.day,
        409,
        'TOKEN_QUOTE_EXPIRED',
        'Daily quota changed. Request a new quote.',
      );
      await consumeFreeTokenQuota(
        db,
        accountId,
        time.day,
        config.freeDailyGlobalLimit,
        !!cached,
      );
    }
    if (!cached) await options.beforeRead?.(db);
    const id = crypto.randomUUID(),
      lease = crypto.randomUUID(),
      at = time.now.toISOString();
    const doc: TokenReport = {
      id,
      mint: quote.mint,
      cluster: 'mainnet-beta',
      ruleset: 'bfb-1',
      mode: quote.mode,
      createdAt: at,
      updatedAt: at,
      expiresAt: new Date(time.now.getTime() + 30000).toISOString(),
      state: 'pending',
      checks: blankChecks(),
      verdict: 'checking',
      reasons: [],
      limitations: ['Checks are pending. Missing evidence is not a pass.'],
      calibration: {
        status: 'missing',
        version: null,
        evidenceUrl: null,
        ageBand: 'unknown',
        baseRate: null,
      },
      deep:
        quote.mode === 'deep'
          ? { status: 'pending', launch: null, claims: [], limitations: [] }
          : null,
      cached: !!cached,
      billing: {
        maximumUsd6: quote.maximum_usd6,
        actualUsd6: quote.maximum_usd6 === '0' ? '0' : null,
        state: quote.maximum_usd6 === '0' ? 'free' : 'held',
      },
    };
    if (quote.maximum_usd6 !== '0') {
      const available = await ledgerAccount(db, accountId, 'available'),
        reserved = await ledgerAccount(db, accountId, 'reserved');
      requireCondition(
        BigInt(available.balance_usd6) >= BigInt(quote.maximum_usd6),
        402,
        'INSUFFICIENT_BALANCE',
        'The available balance does not cover this quote.',
      );
      await post(db, `secondlook:${id}:hold`, 'hold', [
        { id: available.id, amount: -BigInt(quote.maximum_usd6) },
        { id: reserved.id, amount: BigInt(quote.maximum_usd6) },
      ]);
    }
    const row = (await one<ReportRow>(
      db,
      "INSERT INTO secondlook_token_reports(id,account_id,quote_id,state,billing_state,maximum_usd6,actual_usd6,document,lease_id,lease_expires_at) VALUES($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        id,
        accountId,
        quote.id,
        doc.billing.state,
        quote.maximum_usd6,
        doc.billing.actualUsd6,
        JSON.stringify(doc),
        lease,
        new Date(time.now.getTime() + 45000),
      ],
    ))!;
    return { row, quote, replayed: false, cached: cached?.facts ?? null };
  });
  if (setup.replayed)
    return {
      report: await readTokenReport(pool, accountId, setup.row.id, {
        producer: options.producer,
      }),
      replayed: true,
    };
  const { row, quote } = setup;
  let producerResult: unknown = null;
  let producerWork: Promise<unknown> | null = null;
  let final = structuredClone(row.document),
    facts: TokenFacts | null = null,
    cacheFacts: TokenFacts | null = null,
    usable = false;
  try {
    const artifact = await evidence(pool, quote.evidence_id, quote.mint);
    requireCondition(
      quote.mode !== 'deep' ||
        (artifact?.deep &&
          (artifact.deep.status === 'complete' ||
            (options.producer === undefined
              ? deepProducerConfig()
              : options.producer))),
      503,
      'TOKEN_DEEP_UNAVAILABLE',
      'Reviewed deep evidence expired before execution.',
    );
    const producer =
      options.producer === undefined ? deepProducerConfig() : options.producer;
    if (quote.mode === 'deep' && producer && quote.evidence_id) {
      const marker: DeepProducerMarker = {
        endpoint: producer.endpoint,
        requestId: row.id,
        mint: quote.mint,
        startedAt: new Date().toISOString(),
        evidenceId: quote.evidence_id,
        maximumUsd6: '100000',
      };
      const marked = { ...final, _producer: marker };
      await transaction(pool, async (db) => {
        await lockAccount(db, accountId);
        const changed = await db.query(
          "UPDATE secondlook_token_reports SET document=$3,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND state='pending' AND lease_expires_at>clock_timestamp()",
          [row.id, row.lease_id, JSON.stringify(marked)],
        );
        requireCondition(
          changed.rowCount === 1,
          409,
          'TOKEN_CHECK_EXPIRED',
          'This check expired before claim dispatch.',
        );
      });
      final = marked;
      producerWork = requestDeepProducer(
        marker,
        'POST',
        producer,
        options.signal,
      ).catch(() => null);
    }
    const cal = await calibration(pool);
    const progress = async (current: TokenFacts) => {
      const evaluated = evaluateTokenFacts(current, cal);
      await pool.query(
        "UPDATE secondlook_token_reports SET document=$3,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND state='pending' AND lease_expires_at>clock_timestamp()",
        [
          row.id,
          row.lease_id,
          JSON.stringify({
            ...final,
            ...evaluated,
            updatedAt: new Date().toISOString(),
          }),
        ],
      );
    };
    facts =
      setup.cached ??
      (await collectTokenFacts(quote.mint, {
        providers: options.providers ?? createTokenProviders(config),
        signal: options.signal,
        onProgress: progress,
        forkProbe:
          options.forkProbe === undefined
            ? forkProbeConfig()
            : options.forkProbe,
      }));
    if (producerWork) producerResult = await producerWork;
    cacheFacts = structuredClone(facts);
    if (artifact)
      facts = applyReviewedEvidence(facts, artifact, {
        index: config.evidence,
        simulation: config.simulation,
      });
    const evaluated = evaluateTokenFacts(facts, cal);
    usable =
      facts.checks[0].status === 'complete' &&
      (quote.mode !== 'deep' ||
        (!!artifact?.deep && Date.parse(artifact.expiresAt) > Date.now()));
    const expiry = Math.min(
      Date.parse(facts.observedAt) + cacheSeconds(facts.ageSeconds) * 1000,
      ...facts.checks.flatMap((c) =>
        c.sources.map((s) => Date.parse(s.expiresAt)),
      ),
    );
    final = {
      ...final,
      ...evaluated,
      checks: evaluated.checks,
      state: usable
        ? evaluated.checks.every((c) => c.status === 'complete')
          ? 'complete'
          : 'partial'
        : 'failed',
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(expiry).toISOString(),
      deep: quote.mode === 'deep' ? artifact!.deep : null,
    };
  } catch {
    final = {
      ...final,
      state: 'failed',
      updatedAt: new Date().toISOString(),
      limitations: [
        final._producer
          ? 'Some token facts could not finish. A dispatched claim review must be reconciled before its reservation can be released.'
          : 'The token check could not finish. Any reserved card payment will be released.',
      ],
      verdict: 'checking',
    };
  }
  if (producerWork && !producerResult) producerResult = await producerWork;
  if (final._producer) {
    final.state = 'pending';
    final.deep = {
      status: 'pending',
      launch: null,
      claims: [],
      limitations: [
        'The bounded fresh-claim request is awaiting its original outcome.',
      ],
    };
    await pool.query(
      "UPDATE secondlook_token_reports SET document=$3,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND state='pending'",
      [row.id, row.lease_id, JSON.stringify(final)],
    );
    if (producerResult)
      await recoverDeepReport(
        pool,
        accountId,
        { ...row, document: final },
        options.producer === undefined
          ? deepProducerConfig()
          : options.producer,
        producerResult,
      );
    return {
      report: await readTokenReport(pool, accountId, row.id, {
        recoverProducer: false,
      }),
      replayed: false,
    };
  }
  await transaction(pool, async (db) => {
    await lockAccount(db, accountId, false);
    const current = await one<ReportRow>(
      db,
      'SELECT * FROM secondlook_token_reports WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [row.id, accountId],
    );
    if (
      !current ||
      current.state !== 'pending' ||
      current.lease_id !== row.lease_id
    )
      return;
    const time = await now(db);
    if (current.lease_expires_at <= time.now) {
      usable = false;
      final = {
        ...final,
        state: 'failed',
        verdict: 'checking',
        limitations: [
          'The read-only check expired. Any reserved payment was released.',
        ],
      };
    }
    await settle(db, current, usable);
    final.billing = {
      maximumUsd6: row.maximum_usd6,
      actualUsd6: usable ? row.maximum_usd6 : '0',
      state:
        row.maximum_usd6 === '0' ? 'free' : usable ? 'captured' : 'released',
    };
    await db.query(
      'UPDATE secondlook_token_reports SET state=$2,billing_state=$3,actual_usd6=$4,document=$5,updated_at=clock_timestamp() WHERE id=$1',
      [
        row.id,
        final.state,
        final.billing.state,
        final.billing.actualUsd6,
        JSON.stringify(final),
      ],
    );
    if (
      usable &&
      cacheFacts &&
      Date.parse(final.expiresAt) > time.now.getTime()
    )
      await db.query(
        'INSERT INTO secondlook_token_cache(mint,facts,observed_at,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(mint) DO UPDATE SET facts=EXCLUDED.facts,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at WHERE secondlook_token_cache.observed_at<EXCLUDED.observed_at',
        [
          quote.mint,
          JSON.stringify(cacheFacts),
          cacheFacts.observedAt,
          final.expiresAt,
        ],
      );
  });
  return {
    report: await readTokenReport(pool, accountId, row.id),
    replayed: false,
  };
}

export async function listTokenReports(
  pool: Pool,
  accountId: string,
  cursor: string | null = null,
) {
  let before: { createdAt: string; id: string } | null = null;
  if (cursor) {
    try {
      requireCondition(
        cursor.length <= 512,
        400,
        'TOKEN_CURSOR_INVALID',
        'The report cursor is invalid.',
      );
      const parsed = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      requireCondition(
        parsed &&
          typeof parsed === 'object' &&
          typeof parsed.createdAt === 'string' &&
          new Date(parsed.createdAt).toISOString() === parsed.createdAt &&
          typeof parsed.id === 'string' &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            parsed.id,
          ),
        400,
        'TOKEN_CURSOR_INVALID',
        'The report cursor is invalid.',
      );
      before = parsed;
    } catch {
      requireCondition(
        false,
        400,
        'TOKEN_CURSOR_INVALID',
        'The report cursor is invalid.',
      );
    }
  }
  const rows = await pool.query<ReportRow & { created_at: Date }>(
    'SELECT * FROM secondlook_token_reports WHERE account_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 11',
    [accountId, before?.createdAt ?? null, before?.id ?? null],
  );
  const shown = rows.rows.slice(0, 10),
    reports: TokenReport[] = [];
  let bytes = 64;
  for (const row of shown) {
    const report = await readTokenReport(pool, accountId, row.id, {
      recoverProducer: false,
    });
    const size = new TextEncoder().encode(JSON.stringify(report)).length;
    if (reports.length && bytes + size > 900000) break;
    reports.push(report);
    bytes += size;
  }
  const last = shown[reports.length - 1];
  return {
    reports,
    nextCursor:
      rows.rows.length > reports.length && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.created_at.toISOString(),
              id: last.id,
            }),
          ).toString('base64url')
        : null,
  };
}

async function recoverDeepReport(
  pool: Pool,
  accountId: string,
  row: ReportRow,
  producer: DeepProducerConfig | null,
  provided?: unknown,
) {
  const marker = row.document._producer;
  if (!marker || !producer || producer.endpoint !== marker.endpoint) return;
  let result;
  try {
    const artifact = await one<{ artifact: unknown; artifact_hash: string }>(
      pool,
      'SELECT artifact,artifact_hash FROM secondlook_token_evidence WHERE id=$1 AND mint=$2',
      [marker.evidenceId, marker.mint],
    );
    if (!artifact || (await hash(artifact.artifact)) !== artifact.artifact_hash)
      return;
    const raw =
      provided ?? (await requestDeepProducer(marker, 'GET', producer));
    result = await parseDeepProducerResult(raw, marker, artifact.artifact);
  } catch {
    return;
  }
  if (result.state === 'pending') return;
  await transaction(pool, async (db) => {
    await lockAccount(db, accountId, false);
    const current = await one<ReportRow>(
      db,
      'SELECT * FROM secondlook_token_reports WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [row.id, accountId],
    );
    if (
      !current ||
      current.state !== 'pending' ||
      current.document._producer?.requestId !== marker.requestId
    )
      return;
    const capture = result.state === 'completed';
    await settle(db, current, capture);
    const document = {
      ...current.document,
      state: capture ? 'partial' : 'failed',
      deep:
        result.state === 'completed'
          ? result.deep
          : {
              status: 'unavailable',
              launch: null,
              claims: [],
              limitations: [
                'The producer definitively rejected the request without charge.',
              ],
            },
      updatedAt: new Date().toISOString(),
      billing: {
        maximumUsd6: current.maximum_usd6,
        actualUsd6: capture ? current.maximum_usd6 : '0',
        state: capture ? 'captured' : 'released',
      },
      limitations: capture
        ? current.document.limitations
        : [
            'The producer definitively rejected the request without charge. The reservation was released.',
          ],
    };
    delete document._producer;
    await db.query(
      'UPDATE secondlook_token_reports SET state=$2,billing_state=$3,actual_usd6=$4,document=$5,updated_at=clock_timestamp() WHERE id=$1',
      [
        row.id,
        document.state,
        document.billing.state,
        document.billing.actualUsd6,
        JSON.stringify(document),
      ],
    );
  });
}
