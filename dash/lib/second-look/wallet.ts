/** Public read-only wallet contract. Amounts are exact integers, never JS money floats. */
export type WalletCapability = {
  configured: boolean;
  pricingConfigured: boolean;
  cluster: 'mainnet-beta';
  reason:
    | 'WALLET_INGEST_DISABLED'
    | 'WALLET_RPC_REQUIRED'
    | 'WALLET_STORAGE_REQUIRED'
    | null;
};
export type WalletSync = {
  state: 'queued' | 'running' | 'idle' | 'blocked';
  pages: number;
  signatures: number;
  finalized: number;
  pending: number;
  unavailable: number;
  dropped: number;
  providerHistoryExhausted: boolean;
  coverage: 'partial' | 'verified';
  lastSyncAt: string | null;
  errorCode: string | null;
};
export type LinkedWallet = {
  id: string;
  address: string;
  label: string;
  cluster: 'mainnet-beta';
  proof: 'unverified';
  createdAt: string;
  sync: WalletSync;
};
export type WalletPosition = {
  mint: string;
  decimals: number;
  amount: string;
  basisUsd6: string | null;
  valueUsd6: string | null;
  unrealizedUsd6: string | null;
  market: 'priced' | 'no_market' | 'unavailable';
  missingBasis: boolean;
  airdrop: boolean;
  estimated: boolean;
};
export type WalletPnl = {
  walletId: string;
  accounting: 'fifo';
  periodStart: string;
  asOf: string;
  coverage: 'partial' | 'verified';
  complete: boolean;
  /** Incomplete-history totals deliberately remain null. Observed subtotals are separate. */
  netUsd6: string | null;
  realizedUsd6: string | null;
  unrealizedChangeUsd6: string | null;
  observed: {
    realizedUsd6: string | null;
    unrealizedChangeUsd6: string | null;
    netUsd6: string | null;
    feesUsd6: string | null;
  };
  fees: {
    networkUsd6: string | null;
    priorityUsd6: string | null;
    networkAndPriorityUsd6: string | null;
    jitoTipUsd6: string | null;
    platformUsd6: string | null;
  };
  rentExcludedLamports: string;
  positions: WalletPosition[];
  exceptions: string[];
  finalizedTransactions: number;
  activity: WalletActivity[];
  activityTruncated: boolean;
};
export type WalletActivity = {
  signature: string;
  slot: string;
  timestamp: string | null;
  kind: 'swap' | 'transfer' | 'airdrop' | 'fee' | 'unknown';
  finalized: true;
  warnings: string[];
};
export type WalletListResponse = {
  wallets: LinkedWallet[];
  capability: WalletCapability;
};
export type WalletResponse = {
  wallet: LinkedWallet;
  capability: WalletCapability;
};
