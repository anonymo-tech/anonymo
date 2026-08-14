export const PROGRAM_READER_VERSION = '1' as const;
export const PROGRAM_LOADER_IDS = Object.freeze({
  v1: 'BPFLoader1111111111111111111111111111111111',
  v2: 'BPFLoader2111111111111111111111111111111111',
  v3: 'BPFLoaderUpgradeab1e11111111111111111111111',
  v4: 'LoaderV411111111111111111111111111111111111',
  native: 'NativeLoader1111111111111111111111111111111',
});
export const PROGRAM_READER_LIMITS = Object.freeze({
  historySignatures: 8,
  historyEvents: 16,
  rpcCalls: 14,
  totalTimeoutMs: 25_000,
  accountHeaderBytes: 48,
});
export const PROGRAM_WARNING_SEVERITY = Object.freeze({
  BUILD_UNVERIFIED: 'warning',
  ACCOUNT_NOT_FOUND: 'warning',
  NOT_PROGRAM: 'warning',
  UNSUPPORTED_LOADER: 'warning',
  UNSUPPORTED_STATE: 'warning',
  UPGRADE_AUTHORITY: 'warning',
  PROGRAM_RETRACTED: 'warning',
  NEXT_VERSION_UNINSPECTED: 'warning',
  LOADER_VERSION_UNVERIFIED: 'warning',
  HISTORY_BOUNDED: 'info',
  HISTORY_INCOMPLETE: 'warning',
  HISTORY_UNAVAILABLE: 'warning',
} as const);
export type ProgramWarningCode = keyof typeof PROGRAM_WARNING_SEVERITY;
export type ProgramWarning = {
  code: ProgramWarningCode;
  severity: 'info' | 'warning';
  message: string;
};
export type ProgramLoader =
  | 'v1'
  | 'v2'
  | 'v3'
  | 'v4'
  | 'native'
  | 'unknown'
  | null;
export type ProgramHistoryEvent = {
  signature: string;
  slot: number;
  blockTime: number | null;
  kind: 'deploy' | 'upgrade' | 'deploy-or-redeploy';
  instruction: string;
  loader: 'v1' | 'v2' | 'v3' | 'v4';
};
export type ProgramInspection = {
  readerVersion: typeof PROGRAM_READER_VERSION;
  cluster: 'devnet' | 'mainnet-beta';
  genesisHash: string;
  address: string;
  contextSlot: number;
  finality: 'finalized';
  exists: boolean;
  owner: string | null;
  executable: boolean | null;
  loader: ProgramLoader;
  status:
    | 'not-found'
    | 'not-program'
    | 'unsupported'
    | 'deployed'
    | 'retracted'
    | 'finalized';
  programDataAddress: string | null;
  authority: { status: 'present' | 'none' | 'unknown'; address: string | null };
  mutability: 'upgradeable' | 'immutable' | 'unknown';
  lastDeploymentSlot: number | null;
  loaderStateSlot: number | null;
  nextVersionAddress: string | null;
  verifiedBuild: 'not-checked';
  history: {
    status: 'not-scanned' | 'bounded' | 'unavailable';
    address: string | null;
    limit: 8;
    scannedSignatures: number;
    verifiedTransactions: number;
    unavailableTransactions: number;
    complete: false;
    events: ProgramHistoryEvent[];
  };
  warnings: ProgramWarning[];
};
