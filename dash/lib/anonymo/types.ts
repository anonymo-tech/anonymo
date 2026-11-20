// Shapes of the Anonymo gateway API the dashboard uses. The gateway is the source of truth: every type here mirrors a
// route in gateway/src (named next to each type), field for field. Where the gateway leaves a field optional or a
// workstream is still adding it, the type says so.
//
// The gateway sends money as a USD number (`*_usd`, e.g. 10 or 0.0000154; receipts use decimal strings). The
// dashboard formats and does arithmetic in integer micro-USD (`*_musd`, 1 USD = 1_000_000) via lib/anonymo/money.ts.

export type MicroUsd = number;
/** A USD amount as the gateway sends it: a JSON number on balances and lists, a decimal string on receipts. */
export type Usd = number;
export type UsdString = string;
export type Hex = `0x${string}`;

/** The four Anonymo model IDs. Direct IDs for non-Venice routes may also appear in `/v1/models`. */
export const ANONYMO_MODEL_IDS = ['anonymo-1', 'anonymo-rp', 'anonymo-council', 'anonymo-sealed'] as const;
export type AnonymoModelId = (typeof ANONYMO_MODEL_IDS)[number];

// ---- keys (gateway/src/anonymo/keys/routes.ts, keys/caps.ts) ----------------------------------------------------

/** Caps as `POST /keys` accepts them (`capsInput`): USD as a number or decimal string, null clears. */
export type KeyCapsInput = {
  daily_usd?: number | string | null;
  monthly_usd?: number | string | null;
  lifetime_usd?: number | string | null;
  models?: string[] | null; // allowlist; null = every model
  ip_allow?: string[] | null;
  sealed_only?: boolean;
  expires_at?: string | null; // ISO 8601
};

/** Caps as the gateway returns them (`capsJson`). */
export type KeyCaps = {
  daily_usd: Usd | null;
  monthly_usd: Usd | null;
  lifetime_usd: Usd | null;
  models: string[] | null;
  ip_allow: string[] | null;
  sealed_only: boolean;
  expires_at: string | null;
  wallet?: string | null;
};

export type CreateKeyRequest = { caps?: KeyCapsInput };

/** `POST /keys` (201). `key` is returned exactly once; the gateway stores only sha256(key) as `key_hash`. */
export type CreateKeyResponse = {
  key: string; // anm_live_…
  key_hash: string;
  wallet: string | null;
  caps: KeyCaps;
  deposit: DepositInstructions;
};

/** `GET /keys/me`. */
export type KeyInfo = { key_hash: string; label: string | null; caps: KeyCaps; deposit: DepositInstructions };

// ---- deposits (gateway/src/anonymo/deposits/instructions.ts, routes.ts) ------------------------------------------

export type EvmChain = 'base' | 'arbitrum' | 'rhc';
export type StableSymbol = 'USDC' | 'USDT' | 'USDG';
/** Every chain a deposit row or withdrawal can name. `coin` rows are ANMO payments (usage-only credit). */
export type DepositChain = EvmChain | 'solana' | 'tron' | 'btc' | 'ln' | 'coin';
/** Chains a withdrawal can go to (`PAYOUT_CHAINS` in deposits/withdraw.ts). */
export type PayoutChain = Exclude<DepositChain, 'coin'>;

export type EvmTokenInfo = { symbol: StableSymbol; address: Hex; decimals: number };

/**
 * EVM rail: one `key_commit` per key (not an address per key). The payer calls
 * `DepositRouter.deposit(token, amount, keyCommit)` (or `depositWithPermit`) on `router` for the chain; the watcher
 * credits the Deposited log once it is `confirmations` deep, and the transaction sender becomes the refund address.
 */
export type EvmInstructions = {
  key_commit: Hex;
  method: string;
  chains: {
    chain: EvmChain;
    router: Hex;
    confirmations: number;
    tokens: EvmTokenInfo[];
    /** Not sent by the gateway today; the dashboard falls back to lib/anonymo/chains.ts. */
    chain_id?: number;
    rpc_url?: string;
  }[];
};

export type SolanaInstructions = {
  reference: string;
  cluster: 'mainnet-beta' | 'devnet';
  recipient_wallet: string;
  tokens: { symbol: 'USDC' | 'USDT'; mint: string; token_account: string }[];
  how: string;
};

export type TronInstructions = { address: string; confirmations: number; tokens: { symbol: 'USDT'; contract: string }[] };

export type BtcInstructions = { invoice: string; credited_at: string };

/**
 * Pay with ANMO on Robinhood Chain: `CoinPay.pay(amount, keyCommit)` burns the coins and the key is credited the USD
 * value at the time of crediting, as usage-only credit (never withdrawable). `price_usd: null` = unavailable now.
 */
export type CoinInstructions = {
  chain: 'rhc';
  chain_id: number;
  coin_pay: Hex;
  token: { symbol: 'ANMO'; address: Hex; decimals: number };
  price_usd: string | null;
  max_usd_per_payment: string;
  confirmations: number;
  key_commit: Hex;
  method?: string;
  credited_at?: string;
};

export type DepositInstructions =
  | { paused: true }
  | {
      paused: false;
      evm: EvmInstructions | null;
      solana: SolanaInstructions | null;
      tron: TronInstructions | null;
      btc: BtcInstructions | null;
      coin?: CoinInstructions | null;
      stablecoins_credit: string;
    };

export type DepositStatus = 'credited' | 'held';

/** One row of `GET /deposits` `data`. `ref` for EVM is `<chain>:<txhash>:<logIndex>`. */
export type DepositRow = {
  ref: string;
  chain: DepositChain;
  token: string;
  amount_usd: Usd;
  from: string;
  status: DepositStatus;
  created_at: string;
  reason?: string | null; // `over_cap` on a held coin payment
};

/** `GET /deposits`. */
export type Deposits = { instructions: DepositInstructions; data: DepositRow[] };

/** `POST /deposits/btcpay`: BTC on-chain or Lightning through BTCPay, credited at the BTCPay quote. */
export type BtcpayInvoiceRequest = { amount_usd: string; refund_address: string };
export type BtcpayInvoice = { invoice_id: string; checkout_link: string | null; amount_usd: string; refund: { chain: 'btc' | 'ln'; address: string } };

// ---- balance and withdrawals (deposits/routes.ts, deposits/withdraw.ts) -------------------------------------------

/** `GET /balance`. Withdrawals go only to `withdraw_to` (a source address of this key's deposits, or its SIWE wallet). */
export type Balance = {
  balance_usd: Usd;
  held_usd: Usd;
  available_usd: Usd;
  /** Credit paid in ANMO: spendable on usage, never withdrawable. Absent on gateways without the coin rail. */
  usage_only_usd?: Usd;
  withdraw_to: { chain: PayoutChain; address: string; max_usd: Usd }[];
};

/** `POST /withdraw`. Needs an `Idempotency-Key` header; `to` must be one of `Balance.withdraw_to`. */
export type WithdrawRequest = { chain: PayoutChain; to: string; token?: string; amount_usd?: string }; // a decimal USD amount, or "all"

export type Withdrawal = {
  id: string;
  status: 'pending' | 'sent' | 'reverted';
  chain: PayoutChain;
  token: string;
  to: string;
  amount_usd: Usd;
  tx: string | null;
  created_at: string;
  sent_at: string | null;
};
export type WithdrawResponse = { withdrawal: Withdrawal; replay: boolean };

// ---- models (gateway/src/api/models.ts + trust/stats.ts anonymoModelFields) ---------------------------------------

/** One entry of `GET /v1/models`. Only the fields the dashboard reads are listed. */
export type ModelInfo = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  family: string | null;
  quant: string | null;
  weights_hash: string | null;
  attested: boolean;
  refusal_rate_30d: number | null; // 0..1, null = unknown
};
export type ModelList = { data: ModelInfo[] };

// ---- chat (gateway/src/api/chat.ts, api/council.ts) ----------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string; name?: string };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
};

export type CouncilMode = 'merge' | 'select';

export type ChatHeaders = {
  refusalCatch?: 'on' | 'off'; // x-anonymo-refusal-catch
  councilMode?: CouncilMode; // sent as `council.mode` in the body (the header is not in the gateway's CORS allow-list)
  sealed?: boolean; // x-anonymo-sealed: required
};

/** The council summary on an `anonymo-council` reply (council.ts). Proposer text is not returned, only who answered. */
export type CouncilSeat = { model: string; provider: string | null; status: string; cost: UsdString; receipt_id: string | null };
export type CouncilResult = {
  mode: CouncilMode;
  outcome: 'merged' | 'selected' | 'aggregator_refused' | 'invalid_verdict';
  selected: string | null;
  reason?: string;
  sealed: boolean;
  proposers: (CouncilSeat & { label: string; family: string })[];
  aggregator?: CouncilSeat;
  judge?: CouncilSeat;
  premium: UsdString;
  total_cost: UsdString;
};

/** The signed Anonymo receipt as it rides on a chat reply (`anonymo_receipt`). */
export type SignedAnonymoReceipt = { payload: Receipt; sig: string; key_id: string; alg: 'Ed25519'; leaf: Hex; header?: string };

/** One parsed SSE chunk of `/v1/chat/completions` with `stream: true`. The last one carries `anonymo_receipt`. */
export type ChatChunk = {
  id: string;
  object: 'chat.completion.chunk';
  model: string;
  choices: { index: number; delta: { role?: ChatRole; content?: string }; finish_reason?: string | null }[];
  anonymo_receipt?: SignedAnonymoReceipt;
  /** A failure after the stream started: a reply the floor withheld (451, stage "reply"), or a provider error. */
  error?: ApiErrorBody['error'];
};

/** A non-streamed reply (the council answers this way). */
export type ChatCompletion = {
  id: string;
  object: 'chat.completion';
  model: string;
  choices: { index: number; message: { role: ChatRole; content: string | null }; finish_reason: string | null }[];
  anonymo_receipt?: SignedAnonymoReceipt;
  council?: CouncilResult;
};

export type ChatResult = {
  content: string;
  model: string;
  receiptId: string | null; // the Anonymo receipt's request_id (GET /v1/receipts/{id})
  receipt: Receipt | null;
  councilMode: string | null; // x-anonymo-council-mode
  council: CouncilResult | null;
  finishReason: string | null;
};

// ---- receipts (gateway/src/receipts/anonymo.ts, receipts/roots.ts, anonymo/trust/routes.ts) ----------------------

export type ReceiptRoute = {
  route: string; // `<provider>:<model>`
  role: 'single' | 'retry' | 'proposer' | 'aggregator' | 'judge';
  provider: string | null;
  model: string;
  family: string;
  quant: string | null;
  attested: boolean;
  weights_hash: string | null;
  attestation_quote_hash?: string;
  tokens: { in: number; out: number };
  cost: UsdString;
  refused: boolean;
  status: 'ok' | 'refused' | 'late' | 'failed';
  call_receipt_id?: string | null;
};

/** `anonymo-receipt/1`. Holds ids, route names, hashes, counts and amounts; never prompt or output text. */
export type Receipt = {
  v: string;
  request_id: string;
  model_id: string;
  routes: ReceiptRoute[];
  weights_hash: (string | null)[];
  attestation_quote_hash?: string;
  tokens: { in: number; out: number };
  cost: UsdString;
  cost_details?: Record<string, string>;
  refused: boolean;
  sealed: boolean;
  council?: Record<string, unknown>;
  ts: string;
};

/** A rooted inclusion proof: OpenZeppelin-compatible (sorted-pair keccak256) path from the leaf to the hourly root. */
export type RootedProof = {
  hour: number;
  root: Hex;
  leaf: Hex;
  leaf_index: number;
  leaf_count: number;
  proof: Hex[];
  status: string; // "local" until posted to ReceiptRoots, then "posted"
  tx_hash: string | null;
};

/** `GET /v1/receipts/{id}` (`data`). */
export type ReceiptView = {
  id: string;
  receipt: Receipt;
  sig: string;
  key_id: string;
  alg: 'Ed25519';
  leaf: Hex;
  header: string;
  signature_valid: boolean;
  keys: string;
  anchor: (RootedProof & { valid: boolean }) | null;
};

/** `GET /v1/receipts/{id}/proof` (`data`): pending until the receipt's hour is rooted. */
export type ProofView =
  | { id: string; leaf: Hex; rooted: false; status: 'pending'; hint: string }
  | (RootedProof & { id: string; rooted: true; posted: boolean; valid: boolean; verify: Record<string, string> });

// ---- public trust pages (anonymo/trust/routes.ts) ------------------------------------------------------------------

export type ManifestRoute = {
  route: string;
  upstream: string;
  family: string;
  quant: string | null;
  weights_hash: string | null;
  attested: boolean;
  tee: string | null;
  attestation_hash: string | null;
  attested_at: string | null;
};

/** `GET /manifest`. */
export type Manifest = {
  generated_at: string;
  counts: { models: number; routes: number; attested_routes: number; families: number };
  notes: string[];
  models: { id: string; family: string | null; quant: string | null; weights_hash: string | null; attested: boolean; refusal_rate_30d: number | null; routes: ManifestRoute[] }[];
};

/** `GET /leaderboard`: refusal counts per route and family over 30 days (counts only, no text). */
export type Leaderboard = {
  generated_at: string;
  window_days: number;
  available: boolean;
  routes: { route: string; model: string; family: string; total_30d: number; refused_30d: number; refusal_rate_30d: number | null }[];
  families: { family: string; total_30d: number; refused_30d: number; refusal_rate_30d: number | null }[];
};

// ---- characters (gateway/src/api/characters.ts) --------------------------------------------------------------------

/** `POST /api/v1/characters` for a private card: only the sealed card and its hash leave the device. */
export type CharacterImportRequest = { visibility: 'private'; sealed_card: string; card_hash: string };
export type CharacterImportResponse = { data: { id: string; model: string; visibility: 'private'; card_hash: string } };

// ---- errors (gateway/src/lib/errors.ts) ----------------------------------------------------------------------------

/**
 * Error body. `code` is the HTTP status as a number and `type` the machine code: floor_blocked (451),
 * sealed_unavailable (409), insufficient_balance (402), not_source_address (403), idempotency_key_required (400), …
 */
export type ApiErrorBody = {
  error: { message: string; type?: string; code?: number | string; metadata?: { category?: string } & Record<string, unknown> };
};

// ---- Media (gateway src/anonymo/media/routes.ts) ---------------------------------------------------------------------
/** GET /v1/media/models: one image model as listed (only upstreams the gateway has configured). */
export type MediaImageModel = {
  id: string;
  object: 'model';
  kind: 'image';
  name: string;
  family: string;
  license: string;
  upstream: string;
  pricing: { usd_per_image: string };
  edit: boolean;
  sizes: string[];
};
export type MediaModelList = { object: 'list'; data: ({ kind: string } & Partial<MediaImageModel>)[] };

/** POST /v1/images/generations (OpenAI-compatible, with Anonymo's provenance and receipt). */
export type ImageRequest = { model: string; prompt: string; n?: number; size?: string; response_format?: 'b64_json' | 'url'; seed?: number };
export type ImageGeneration = {
  created: number;
  data: { b64_json?: string; url?: string; expires_at?: number }[];
  anonymo: { request_id: string; model: string; cost_usd: string; provenance: { c2pa: boolean; watermark: boolean } };
};

