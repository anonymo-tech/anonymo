/** Source-attributed observations, never a promise that a token is safe. */
export const TOKEN_CHECK_LABELS = [
  'Mint and freeze authorities',
  'Token-2022 extensions',
  'Metadata control',
  'Buy and sell simulation',
  'Holder concentration',
  'Possibly linked holders',
  'Launch allocation still held',
  'Deployer history',
  'Liquidity and depth',
  'Lookalike tokens',
  'Paid promotion',
  'Trading activity',
  'External risk report',
] as const;
export type TokenCheckId =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13;
export type TokenSource = {
  provider:
    | 'solana'
    | 'dexscreener'
    | 'rugcheck'
    | 'reviewed-index'
    | 'reviewed-simulation'
    | 'reviewed-claims';
  observedAt: string;
  expiresAt: string;
  slot: string | null;
  reference: string | null;
};
export type TokenFact = {
  key: string;
  label: string;
  value: string | number | boolean | null;
};
export type TokenCheck = {
  id: TokenCheckId;
  label: string;
  status: 'pending' | 'complete' | 'partial' | 'unavailable';
  risk: 'red' | 'caution' | 'none' | null;
  facts: TokenFact[];
  sources: TokenSource[];
  limitations: string[];
};
export type TokenCalibration = {
  status: 'missing' | 'failed' | 'valid';
  version: string | null;
  evidenceUrl: string | null;
  ageBand: 'under-1h' | '1h-24h' | 'over-24h' | 'unknown';
  baseRate: number | null;
};
export type TokenDeep = {
  status: 'pending' | 'complete' | 'partial' | 'unavailable';
  launch: {
    createSlot: string;
    throughSlot: string;
    events: {
      slot: string;
      signature: string;
      kind: string;
      amount: string | null;
      wallet?: string | null;
      clusterId?: string | null;
      stillHoldingRaw?: string | null;
    }[];
    truncated: boolean;
  } | null;
  claims: {
    claim: string;
    outcome: 'HOLDS' | 'DOES_NOT_HOLD' | 'NO_CONSENSUS';
    evidence: { url: string; quote: string }[];
  }[];
  limitations: string[];
};
export type TokenReport = {
  id: string;
  mint: string;
  cluster: 'mainnet-beta';
  ruleset: 'bfb-1';
  mode: 'standard' | 'deep';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  state: 'pending' | 'complete' | 'partial' | 'failed';
  checks: TokenCheck[];
  verdict: 'checking' | 'withheld' | 'red_flags' | 'caution' | 'no_red_flags';
  reasons: string[];
  limitations: string[];
  calibration: TokenCalibration;
  deep: TokenDeep | null;
  cached: boolean;
  billing: {
    maximumUsd6: string;
    actualUsd6: string | null;
    state: 'free' | 'held' | 'captured' | 'released';
    reconciliationPending?: boolean;
  };
};
export type TokenQuote = {
  id: string;
  mint: string;
  mode: 'standard' | 'deep';
  maximumUsd6: string;
  expiresAt: string;
  freeRemaining: number;
  limitations: string[];
};
export type TokenCandidate = {
  mint: string;
  name: string;
  symbol: string;
  liquidityUsd: number | null;
  pairCreatedAt: string | null;
  source: 'dexscreener';
  lookalike: boolean;
};
export type TokenResolution = {
  status: 'resolved' | 'choose' | 'not_found' | 'unavailable';
  mint: string | null;
  candidates: TokenCandidate[];
  reason: string | null;
};
export type TokenCapability = {
  configured: boolean;
  deepConfigured: boolean;
  calibrationConfigured: boolean;
  reason: string | null;
  dailyFreeChecks: 10;
  standardUsd6: '20000';
  deepUsd6: '100000';
  providers: {
    rpc: boolean;
    market: boolean;
    externalRisk: boolean;
    indexedEvidence: boolean;
    simulation: boolean;
    claims: boolean;
  };
};

export type TokenReportList = {
  reports: TokenReport[];
  nextCursor: string | null;
};
