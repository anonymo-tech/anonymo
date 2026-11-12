// Shapes of the Anonymo gateway API the dashboard uses (docs/spec/anonymo-backend.pdf §3, §7, §8 and §11).
// Several endpoints are still being built in parallel workstreams (WS05 money, WS09 receipts and trust pages). Where
// the spec names a field it is used verbatim; where it leaves a shape open, the choice here is written down in
// dash/README.md ("API shapes the dashboard assumes") so the gateway side can match it or ask for a change.
//
// Money is always an integer number of micro-USD (1 USD = 1_000_000), named `*_musd`.

export type MicroUsd = number;

/** The four Anonymo model IDs. Direct IDs for non-Venice routes may also appear in `/v1/models`. */
export const ANONYMO_MODEL_IDS = ['anonymo-1', 'anonymo-rp', 'anonymo-council', 'anonymo-sealed'] as const;
export type AnonymoModelId = (typeof ANONYMO_MODEL_IDS)[number];

// ---- keys (§3) --------------------------------------------------------------------------------------------------

export type KeyCaps = {
  daily_musd?: MicroUsd | null;
  monthly_musd?: MicroUsd | null;
  lifetime_musd?: MicroUsd | null;
  models?: string[] | null; // allowlist; null = every model
  ip_allow?: string[] | null;
  sealed_only?: boolean;
  expires_at?: string | null; // ISO 8601
};

export type CreateKeyRequest = { caps?: KeyCaps };

/** `POST /keys`. `key` is returned exactly once; the gateway stores only sha256(key). */
export type CreateKeyResponse = {
  key: string; // anm_live_…
  key_prefix: string; // first characters, safe to show again later
  caps: KeyCaps;
  created_at: string;
  deposit_addresses: DepositAddress[];
};

// ---- deposits, balance, withdrawals (§3, §7) ---------------------------------------------------------------------

export type DepositChain = 'base' | 'arbitrum' | 'rhc' | 'solana' | 'tron' | 'btc' | 'ln';
export type DepositToken = 'USDC' | 'USDT' | 'USDG' | 'BTC';

/** `GET /deposit-addresses` (also returned by `POST /keys`): one unique address per key and chain. */
export type DepositAddress = {
  chain: DepositChain;
  tokens: DepositToken[];
  address: string; // for `ln`, empty: Lightning uses a per-amount invoice (see LightningInvoice)
  confirmations: number; // confirmations before credit
  min_musd: MicroUsd;
};

export type LightningInvoiceRequest = { amount_musd: MicroUsd };
/** `POST /deposits/lightning`: a BTCPay Lightning invoice, credited at the BTCPay quote on receipt. */
export type LightningInvoice = {
  invoice_id: string;
  bolt11: string;
  amount_sats: number;
  quote_musd: MicroUsd;
  expires_at: string;
};

export type LedgerKind = 'deposit' | 'hold' | 'settle' | 'release' | 'refusal_refund' | 'withdraw' | 'council' | 'media';

/** Where credit came from. Withdrawals can go only back here (§7). */
export type DepositSource = {
  chain: DepositChain;
  token: DepositToken;
  address: string;
  deposited_musd: MicroUsd;
  withdrawable_musd: MicroUsd;
};

/** `GET /balance`. */
export type Balance = {
  available_musd: MicroUsd;
  held_musd: MicroUsd;
  refused_refunded_musd: MicroUsd; // total refunded for refused attempts
  sources: DepositSource[];
  recent: { kind: LedgerKind; amount_musd: MicroUsd; ref: string | null; at: string }[];
};

/** `POST /withdraw`. No destination field on purpose: funds only ever go back to the source address. */
export type WithdrawRequest = {
  chain: DepositChain;
  source_address: string; // which source to refund, one of Balance.sources
  amount_musd: MicroUsd | 'all';
};
export type Withdrawal = {
  id: string;
  chain: DepositChain;
  token: DepositToken;
  to: string; // always the source address
  amount_musd: MicroUsd;
  status: 'queued' | 'sent';
  tx_hash: string | null;
};

// ---- models (§11) -------------------------------------------------------------------------------------------------

/** One entry of `GET /v1/models` (OpenAI list shape plus Anonymo fields). */
export type ModelInfo = {
  id: string;
  object: 'model';
  owned_by: string;
  family: string | null; // null for router presets that span families
  quant: string | null;
  weights_hash: string | null;
  attested: boolean;
  refusal_rate_30d: number | null; // 0..1
  context_length?: number;
  description?: string;
};
export type ModelList = { object: 'list'; data: ModelInfo[] };

// ---- chat (§11, OpenAI shape) -------------------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string; name?: string };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
};

export type ChatHeaders = {
  refusalCatch?: 'on' | 'off'; // x-anonymo-refusal-catch
  councilMode?: 'merge' | 'select'; // x-anonymo-council-mode
  sealed?: boolean; // x-anonymo-sealed: required
};

/** A council proposer's reply, sent on the final stream chunk as `anonymo_council` (shape proposed for WS09). */
export type CouncilProposer = {
  route_id: string;
  family: string;
  content: string;
  cost_musd: MicroUsd;
  used: boolean; // false when it missed the first-2-of-3 window
};
export type CouncilResult = {
  mode: 'merge' | 'select';
  aggregator: { route_id: string; family: string; cost_musd: MicroUsd } | null;
  proposers: CouncilProposer[];
};

/** One parsed SSE chunk of `/v1/chat/completions` with `stream: true`. */
export type ChatChunk = {
  id: string;
  object: 'chat.completion.chunk';
  model: string;
  choices: { index: number; delta: { role?: ChatRole; content?: string }; finish_reason: string | null }[];
  anonymo_council?: CouncilResult;
};

export type ChatResult = {
  content: string;
  model: string;
  receiptId: string | null; // x-anonymo-receipt
  councilMode: string | null; // x-anonymo-council-mode
  council: CouncilResult | null;
  finishReason: string | null;
};

// ---- receipts (§8) ------------------------------------------------------------------------------------------------

export type Receipt = {
  request_id: string;
  model_id: string;
  routes: string[]; // every route touched, refused ones included
  weights_hash: (string | null)[]; // null where the upstream does not publish its weights (Venice)
  attestation_quote_hash: string | null; // anonymo-sealed only
  tokens: { in: number; out: number };
  cost_musd: MicroUsd;
  refused: boolean; // the first attempt refused and was rerouted (or a double refusal)
  refused_routes: string[];
  refund_musd: MicroUsd;
  ts: string;
};

/** `GET /v1/receipts/{id}`. */
export type SignedReceipt = {
  receipt: Receipt;
  signer: string; // gateway receipt key (address)
  signature: string;
  leaf: string; // 0x… keccak256 leaf
};

/** `GET /v1/receipts/{id}/proof`: an OpenZeppelin-compatible (sorted-pair keccak256) Merkle path. */
export type InclusionProof = {
  request_id: string;
  leaf: string;
  proof: string[];
  root: string;
  hour: number; // unix hour the root covers
  anchor: {
    chain: 'rhc';
    contract: string; // ReceiptRoots
    tx_hash: string | null;
    status: 'pending' | 'anchored';
  };
};

// ---- public trust pages (§11) ------------------------------------------------------------------------------------

/** `GET /manifest`: every route that can serve an Anonymo model ID, with what it runs. */
export type Manifest = {
  generated_at: string;
  routes: {
    id: string;
    upstream: 'venice' | 'selfhost' | 'phala' | 'chutes' | 'nanogpt' | 'featherless';
    tier: 'T0' | 'T1' | 'T2' | 'T3';
    family: string;
    model: string;
    quant: string;
    weights_hash: string | null;
    attested: boolean;
    serves: string[]; // model IDs this route can answer
    enabled: boolean;
  }[];
};

/** `GET /leaderboard`: refusal counts per route over a window, from refusal_stats (counts only, no text). */
export type Leaderboard = {
  generated_at: string;
  window_days: number;
  rows: {
    route_id: string;
    family: string;
    upstream: string;
    total: number;
    refused: number;
    refusal_rate: number; // refused / total
  }[];
};

// ---- characters -----------------------------------------------------------------------------------------------------

/** `POST /v1/characters` for a private card: only the sealed card and its hash leave the device. */
export type CharacterImportRequest = {
  visibility: 'private';
  sealed_card: string;
  card_hash: string;
};
export type CharacterImportResponse = { data: { id: string; visibility: 'private'; card_hash: string } };

// ---- errors -------------------------------------------------------------------------------------------------------

/** OpenAI error shape. Notable codes: floor_blocked (451), sealed_unavailable (409), insufficient_balance (402). */
export type ApiErrorBody = {
  error: { message: string; type?: string; code?: string; metadata?: { category?: string } };
};
