import type {
  TokenQuote,
  TokenReport,
  TokenResolution,
  TokenCapability,
} from '../second-look/token.ts';
import type {
  LinkedWallet,
  WalletCapability,
  WalletPnl,
} from '../second-look/wallet.ts';
import type {
  SignatureReport,
  SignatureCapability,
} from '../second-look/signature.ts';
import { object } from './second-look.ts';

const enumValue = (value: unknown) =>
  typeof value === 'string' ? value : '\0';
const evidence = (value: unknown) =>
  list(value) &&
  value.every(
    (s) =>
      object(s) &&
      text(s.label, 300) &&
      text(s.url, 2048) &&
      time(s.observedAt) &&
      (s.expiresAt === null || time(s.expiresAt)),
  );
const text = (x: unknown, max = 10000): x is string =>
  typeof x === 'string' && x.length <= max;
const list = (x: unknown): x is unknown[] =>
  Array.isArray(x) && x.length <= 1000;
const decimal = (x: unknown) =>
  x === null || (text(x, 90) && /^-?\d+$/.test(x));
const unsigned = (x: unknown): x is string => text(x, 90) && /^\d+$/.test(x);
const strings = (x: unknown) => list(x) && x.every((v) => text(v));
const time = (x: unknown) => text(x, 40) && Number.isFinite(Date.parse(x));
const mint = (x: unknown) =>
  text(x, 44) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const id = (x: unknown) =>
  text(x, 36) &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(x);

export function signatureCapabilitiesResponse(
  x: unknown,
): x is SignatureCapability {
  return (
    object(x) &&
    x.available === true &&
    x.domainLookalikes === true &&
    x.signsOrSubmits === false &&
    Array.isArray(x.transactionEncodings) &&
    x.transactionEncodings.length === 2 &&
    x.transactionEncodings[0] === 'base64' &&
    x.transactionEncodings[1] === 'base58' &&
    [
      'transactionSimulation',
      'rdap',
      'blocklists',
      'appCertificateRegistry',
      'actionUrlResolution',
    ].every((key) => typeof x[key] === 'boolean') &&
    (!x.actionUrlResolution || x.transactionSimulation === true)
  );
}

export function tokenCapabilitiesResponse(
  x: unknown,
): x is { token: TokenCapability } {
  if (!object(x) || !object(x.token) || !object(x.token.providers))
    return false;
  const token = x.token;
  return (
    ['configured', 'deepConfigured', 'calibrationConfigured'].every(
      (key) => typeof token[key] === 'boolean',
    ) &&
    (token.reason === null || text(token.reason, 200)) &&
    token.dailyFreeChecks === 10 &&
    token.standardUsd6 === '20000' &&
    token.deepUsd6 === '100000' &&
    [
      'rpc',
      'market',
      'externalRisk',
      'indexedEvidence',
      'simulation',
      'claims',
    ].every(
      (key) =>
        typeof (token.providers as Record<string, unknown>)[key] === 'boolean',
    ) &&
    (!token.deepConfigured || token.configured === true)
  );
}

export function resolutionResponse(x: unknown): x is TokenResolution {
  return (
    object(x) &&
    ['resolved', 'choose', 'not_found', 'unavailable'].includes(
      enumValue(x.status),
    ) &&
    (x.mint === null || mint(x.mint)) &&
    (x.status !== 'resolved' || mint(x.mint)) &&
    list(x.candidates) &&
    x.candidates.every(
      (c) =>
        object(c) &&
        mint(c.mint) &&
        text(c.name, 200) &&
        text(c.symbol, 80) &&
        typeof c.lookalike === 'boolean' &&
        (c.liquidityUsd === null ||
          (typeof c.liquidityUsd === 'number' &&
            Number.isFinite(c.liquidityUsd) &&
            c.liquidityUsd >= 0)) &&
        (c.pairCreatedAt === null || time(c.pairCreatedAt)),
    )
  );
}
export function quoteResponse(x: unknown): x is { quote: TokenQuote } {
  if (!object(x) || !object(x.quote)) return false;
  const q = x.quote;
  return (
    id(q.id) &&
    mint(q.mint) &&
    typeof q.mode === 'string' &&
    ['standard', 'deep'].includes(q.mode) &&
    text(q.maximumUsd6, 20) &&
    /^\d+$/.test(q.maximumUsd6) &&
    time(q.expiresAt) &&
    Number.isInteger(q.freeRemaining) &&
    Number(q.freeRemaining) >= 0 &&
    Number(q.freeRemaining) <= 10 &&
    list(q.limitations) &&
    q.limitations.every((s) => text(s))
  );
}
export function reportResponse(
  x: unknown,
): x is { report: TokenReport; replayed?: boolean } {
  if (!object(x) || !object(x.report)) return false;
  const r = x.report;
  return (
    id(r.id) &&
    mint(r.mint) &&
    r.cluster === 'mainnet-beta' &&
    r.ruleset === 'bfb-1' &&
    typeof r.mode === 'string' &&
    ['standard', 'deep'].includes(r.mode) &&
    typeof r.state === 'string' &&
    ['pending', 'complete', 'partial', 'failed'].includes(r.state) &&
    typeof r.cached === 'boolean' &&
    time(r.createdAt) &&
    time(r.updatedAt) &&
    time(r.expiresAt) &&
    ['checking', 'withheld', 'red_flags', 'caution', 'no_red_flags'].includes(
      enumValue(r.verdict),
    ) &&
    list(r.reasons) &&
    r.reasons.every((s) => text(s)) &&
    list(r.limitations) &&
    r.limitations.every((s) => text(s)) &&
    list(r.checks) &&
    r.checks.length === 13 &&
    new Set(r.checks.map((c) => (object(c) ? c.id : null))).size === 13 &&
    r.checks.every(
      (c) =>
        object(c) &&
        Number.isInteger(c.id) &&
        Number(c.id) >= 1 &&
        Number(c.id) <= 13 &&
        text(c.label, 200) &&
        ['complete', 'pending', 'partial', 'unavailable'].includes(
          enumValue(c.status),
        ) &&
        [null, 'red', 'caution', 'none'].includes(c.risk as string | null) &&
        list(c.facts) &&
        c.facts.every(
          (f) =>
            object(f) &&
            text(f.key, 100) &&
            text(f.label, 300) &&
            (f.value === null ||
              typeof f.value === 'boolean' ||
              text(f.value) ||
              (typeof f.value === 'number' && Number.isFinite(f.value))),
        ) &&
        list(c.sources) &&
        c.sources.every(
          (s) =>
            object(s) &&
            text(s.provider, 80) &&
            time(s.observedAt) &&
            time(s.expiresAt) &&
            (s.slot === null || unsigned(s.slot)) &&
            (s.reference === null || text(s.reference, 2048)),
        ) &&
        list(c.limitations) &&
        c.limitations.every((s) => text(s)),
    ) &&
    object(r.calibration) &&
    typeof r.calibration.status === 'string' &&
    ['missing', 'failed', 'valid'].includes(r.calibration.status) &&
    ['under-1h', '1h-24h', 'over-24h', 'unknown'].includes(
      enumValue(r.calibration.ageBand),
    ) &&
    (r.calibration.baseRate === null ||
      (typeof r.calibration.baseRate === 'number' &&
        Number.isFinite(r.calibration.baseRate) &&
        r.calibration.baseRate >= 0 &&
        r.calibration.baseRate <= 1)) &&
    object(r.billing) &&
    ['free', 'held', 'captured', 'released'].includes(
      enumValue(r.billing.state),
    ) &&
    unsigned(r.billing.maximumUsd6) &&
    decimal(r.billing.actualUsd6) &&
    (r.billing.reconciliationPending === undefined ||
      typeof r.billing.reconciliationPending === 'boolean') &&
    (r.deep === null ||
      (object(r.deep) &&
        ['pending', 'complete', 'partial', 'unavailable'].includes(
          enumValue(r.deep.status),
        ) &&
        (r.deep.launch === null || launchResponse(r.deep.launch)) &&
        list(r.deep.claims) &&
        r.deep.claims.every(
          (c) =>
            object(c) &&
            text(c.claim) &&
            ['HOLDS', 'DOES_NOT_HOLD', 'NO_CONSENSUS'].includes(
              enumValue(c.outcome),
            ) &&
            list(c.evidence) &&
            c.evidence.every(
              (e) => object(e) && text(e.url, 2048) && text(e.quote),
            ),
        ) &&
        strings(r.deep.limitations)))
  );
}

function launchResponse(x: unknown): boolean {
  if (!object(x) || !unsigned(x.createSlot) || !unsigned(x.throughSlot))
    return false;
  const first = BigInt(x.createSlot),
    last = BigInt(x.throughSlot);
  return (
    last === first + 99n &&
    typeof x.truncated === 'boolean' &&
    list(x.events) &&
    x.events.length <= 200 &&
    x.events.every(
      (e) =>
        object(e) &&
        unsigned(e.slot) &&
        BigInt(e.slot) >= first &&
        BigInt(e.slot) <= last &&
        text(e.signature, 90) &&
        text(e.kind, 100) &&
        (e.amount === null || unsigned(e.amount)) &&
        (e.wallet === undefined || e.wallet === null || mint(e.wallet)) &&
        (e.clusterId === undefined ||
          e.clusterId === null ||
          text(e.clusterId, 200)) &&
        (e.stillHoldingRaw === undefined ||
          e.stillHoldingRaw === null ||
          unsigned(e.stillHoldingRaw)),
    )
  );
}

export function linkedWallet(x: unknown): x is LinkedWallet {
  return (
    object(x) &&
    id(x.id) &&
    mint(x.address) &&
    text(x.label, 120) &&
    x.proof === 'unverified' &&
    x.cluster === 'mainnet-beta' &&
    time(x.createdAt) &&
    object(x.sync) &&
    typeof x.sync.state === 'string' &&
    ['queued', 'running', 'idle', 'blocked'].includes(x.sync.state) &&
    typeof x.sync.coverage === 'string' &&
    ['partial', 'verified'].includes(x.sync.coverage) &&
    typeof x.sync.providerHistoryExhausted === 'boolean' &&
    (x.sync.lastSyncAt === null || time(x.sync.lastSyncAt)) &&
    (x.sync.errorCode === null || text(x.sync.errorCode, 200)) &&
    [
      'pages',
      'signatures',
      'finalized',
      'pending',
      'unavailable',
      'dropped',
    ].every(
      (k) =>
        Number.isSafeInteger(
          x.sync && (x.sync as Record<string, unknown>)[k],
        ) && Number((x.sync as Record<string, unknown>)[k]) >= 0,
    )
  );
}
const walletCapability = (x: unknown): x is WalletCapability =>
  object(x) &&
  typeof x.configured === 'boolean' &&
  typeof x.pricingConfigured === 'boolean' &&
  x.cluster === 'mainnet-beta';
export function walletsResponse(
  x: unknown,
): x is { wallets: LinkedWallet[]; capability: WalletCapability } {
  return (
    object(x) &&
    list(x.wallets) &&
    x.wallets.length <= 16 &&
    x.wallets.every(linkedWallet) &&
    walletCapability(x.capability)
  );
}
export function walletResponse(
  x: unknown,
): x is { wallet: LinkedWallet; capability: WalletCapability } {
  return object(x) && linkedWallet(x.wallet) && walletCapability(x.capability);
}
export function pnlResponse(x: unknown): x is { pnl: WalletPnl } {
  if (!object(x) || !object(x.pnl)) return false;
  const p = x.pnl;
  return (
    id(p.walletId) &&
    p.accounting === 'fifo' &&
    time(p.asOf) &&
    time(p.periodStart) &&
    typeof p.complete === 'boolean' &&
    typeof p.coverage === 'string' &&
    ['partial', 'verified'].includes(p.coverage) &&
    (p.complete
      ? p.coverage === 'verified' &&
        p.netUsd6 !== null &&
        p.realizedUsd6 !== null &&
        p.unrealizedChangeUsd6 !== null
      : p.netUsd6 === null &&
        p.realizedUsd6 === null &&
        p.unrealizedChangeUsd6 === null) &&
    text(p.rentExcludedLamports, 90) &&
    decimal(p.rentExcludedLamports) &&
    Number.isSafeInteger(p.finalizedTransactions) &&
    Number(p.finalizedTransactions) >= 0 &&
    typeof p.activityTruncated === 'boolean' &&
    decimal(p.netUsd6) &&
    decimal(p.realizedUsd6) &&
    decimal(p.unrealizedChangeUsd6) &&
    object(p.observed) &&
    (!p.complete ||
      (p.netUsd6 === p.observed.netUsd6 &&
        p.realizedUsd6 === p.observed.realizedUsd6 &&
        p.unrealizedChangeUsd6 === p.observed.unrealizedChangeUsd6)) &&
    ['realizedUsd6', 'unrealizedChangeUsd6', 'netUsd6', 'feesUsd6'].every(
      (k) => object(p.observed) && decimal(p.observed[k]),
    ) &&
    object(p.fees) &&
    [
      'networkUsd6',
      'priorityUsd6',
      'networkAndPriorityUsd6',
      'jitoTipUsd6',
      'platformUsd6',
    ].every(
      (k) => object(p.fees) && (p.fees[k] === null || unsigned(p.fees[k])),
    ) &&
    list(p.positions) &&
    p.positions.length <= 512 &&
    p.positions.every(
      (q) =>
        object(q) &&
        mint(q.mint) &&
        Number.isInteger(q.decimals) &&
        Number(q.decimals) >= 0 &&
        Number(q.decimals) <= 18 &&
        unsigned(q.amount) &&
        typeof q.missingBasis === 'boolean' &&
        typeof q.airdrop === 'boolean' &&
        typeof q.estimated === 'boolean' &&
        decimal(q.basisUsd6) &&
        decimal(q.valueUsd6) &&
        decimal(q.unrealizedUsd6) &&
        typeof q.market === 'string' &&
        ['priced', 'no_market', 'unavailable'].includes(q.market) &&
        (q.market !== 'no_market' || q.valueUsd6 === '0') &&
        (q.basisUsd6 !== null || q.missingBasis === true),
    ) &&
    list(p.exceptions) &&
    p.exceptions.every((e) => text(e)) &&
    list(p.activity) &&
    p.activity.length <= 100 &&
    p.activity.every(
      (a) =>
        object(a) &&
        text(a.signature, 90) &&
        text(a.slot, 30) &&
        (a.timestamp === null || time(a.timestamp)) &&
        ['swap', 'transfer', 'airdrop', 'fee', 'unknown'].includes(
          enumValue(a.kind),
        ) &&
        a.finalized === true &&
        list(a.warnings) &&
        a.warnings.every((w) => text(w)),
    )
  );
}
export function signatureResponse(
  x: unknown,
): x is { report: SignatureReport } {
  if (!object(x) || !object(x.report)) return false;
  const r = x.report;
  if (
    r.domain !== null &&
    (!object(r.domain) ||
      !evidence(r.domain.sources) ||
      !text(r.domain.asciiHost, 253) ||
      !text(r.domain.unicodeHost, 253) ||
      typeof r.domain.lookalike !== 'boolean' ||
      !['listed', 'not-listed', 'unknown'].includes(
        enumValue(r.domain.blocklist),
      ) ||
      !(
        r.domain.ageDays === null ||
        (Number.isSafeInteger(r.domain.ageDays) &&
          Number(r.domain.ageDays) >= 0)
      ))
  )
    return false;
  if (
    r.app !== null &&
    (!object(r.app) ||
      !evidence(r.app.sources) ||
      !text(r.app.packageName, 256) ||
      !(r.app.listing === null || text(r.app.listing, 2048)) ||
      typeof r.app.packageMatch !== 'boolean' ||
      !(
        typeof r.app.certificate === 'string' &&
        ['match', 'mismatch', 'unknown'].includes(r.app.certificate)
      ))
  )
    return false;
  if (
    r.action !== null &&
    (!object(r.action) ||
      !text(r.action.endpoint, 2048) ||
      !text(r.action.transactionEndpoint, 2048) ||
      !mint(r.action.account) ||
      !time(r.action.reviewedAt) ||
      !time(r.action.expiresAt) ||
      !text(r.action.source, 2048) ||
      r.action.chainSubmission !== false)
  )
    return false;
  return (
    r.version === 1 &&
    time(r.inspectedAt) &&
    typeof r.kind === 'string' &&
    ['transaction', 'message', 'domain', 'app', 'action'].includes(r.kind) &&
    ['looks_like_a_drainer', 'caution', 'no_known_patterns'].includes(
      enumValue(r.verdict),
    ) &&
    text(r.verdictLabel, 100) &&
    list(r.findings) &&
    r.findings.every(
      (f) =>
        object(f) &&
        text(f.code, 100) &&
        typeof f.severity === 'string' &&
        ['info', 'warning', 'critical'].includes(f.severity) &&
        text(f.message),
    ) &&
    list(r.permissions) &&
    r.permissions.every(
      (p) =>
        object(p) &&
        text(p.instruction, 200) &&
        text(p.kind, 200) &&
        object(p.fields) &&
        Object.values(p.fields).every((v) => text(v)),
    ) &&
    object(r.balances) &&
    ['complete', 'partial', 'unavailable', 'not-applicable'].includes(
      enumValue(r.balances.status),
    ) &&
    list(r.balances.signers) &&
    r.balances.signers.every(
      (s) =>
        object(s) &&
        mint(s.signer) &&
        (s.sol === null ||
          (object(s.sol) &&
            unsigned(s.sol.beforeLamports) &&
            unsigned(s.sol.afterLamports) &&
            decimal(s.sol.deltaLamports))) &&
        list(s.tokens) &&
        s.tokens.every(
          (t) =>
            object(t) &&
            mint(t.mint) &&
            mint(t.account) &&
            decimal(t.beforeAmount) &&
            decimal(t.afterAmount) &&
            decimal(t.deltaAmount) &&
            Number.isInteger(t.decimals) &&
            Number(t.decimals) >= 0 &&
            Number(t.decimals) <= 255,
        ),
    ) &&
    object(r.coverage) &&
    r.coverage.signsOrSubmits === false &&
    list(r.coverage.unknowns) &&
    r.coverage.unknowns.every((u) => text(u))
  );
}

export function safeEvidenceUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}

export function reportsResponse(
  x: unknown,
): x is { reports: TokenReport[]; nextCursor: string | null } {
  return (
    object(x) &&
    list(x.reports) &&
    x.reports.length <= 10 &&
    x.reports.every((report) => reportResponse({ report })) &&
    (x.nextCursor === null ||
      (text(x.nextCursor, 2048) && /^[A-Za-z0-9_=.-]+$/.test(x.nextCursor)))
  );
}
