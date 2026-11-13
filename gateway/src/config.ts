import { withLegacyEnv } from "./lib/legacy-names.ts";
import { hardeningEnv, hardeningSettings } from "./hardening/config.ts"; // HD1
import { rpcEnv, rpcSettings } from "./chain/rpc-config.ts"; // RPC1: private transport settings.
import { rushEnv, rushSettings } from "./rush/config.ts"; // ON3
import { structuredOutputEnv } from "./structured-output/options.ts"; // V83: opt-in JSON checking.
import { insightsEnv } from "./insights/config.ts"; // V88: off by default.
import { facilitatorEnv, facilitatorSettings } from "./facilitator/config.ts"; // v6 F: hosted x402 facilitator
import { createHash, createHmac, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { usdToPico } from "./lib/money.ts";
import { parseModelMap } from "./anthropic/models.ts";

// Every setting comes from the environment. Missing optional services produce
// an explicit "unavailable" state at runtime; they never fake success.

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const int = (d: number) => z.coerce.number().int().default(d);
const num = (d: number) => z.coerce.number().default(d);
const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address")
  .optional()
  .or(z.literal("").transform(() => undefined));
const pk = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key")
  .optional()
  .or(z.literal("").transform(() => undefined));
const opt = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

/** The measurement public key, normalised to a PEM string; throws on anything that is not an ECDSA P-256 public key. */
function measurementPublicKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = raw.replace(/\\n/g, "\n").trim();
  if (/PRIVATE KEY/.test(text)) throw new Error("MEASUREMENT_PUBLIC_KEY must be the public key; a private key was given.");
  try {
    const key = text.includes("BEGIN") ? createPublicKey(text) : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("not P-256");
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    throw new Error("MEASUREMENT_PUBLIC_KEY must be an ECDSA P-256 public key (PEM or base64 SPKI).");
  }
}

const schema = z.object({
  ...hardeningEnv, // HD1
  ...rushEnv, // ON3
  DEVELOPER_FIRST_CALL_ENABLED: bool.default(false), // ON2: guidance for GETs to model endpoints.
  ...structuredOutputEnv, // V83
  ...insightsEnv, // V88: spend insights.
  ...facilitatorEnv, // v6 F
  ANONYMO_SANCTIONS_ENABLED: bool.default(false), // OFAC list (anonymo/deposits/sanctions.ts); also screens facilitator listings
  INFERENCE_KEYS_ENABLED: bool.default(false), // ZK6: minting restricted keys; stored scopes are always enforced.
  WEBHOOK_SIGNING_ENABLED: bool.default(false), // V86: signed account webhooks.
  RUNTIME_ROLE: z.enum(["all", "api", "worker"]).default("all"),
  WORKER_JOBS: z.string().default(""),
  AUTO_MIGRATE: bool.default(true),
  ANONYMO_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8787),
  PUBLIC_BASE_URL: z.string().default("http://127.0.0.1:8787"),
  // B116: address shown in links people open; default: PUBLIC_BASE_URL. Signed receipt issuers stay unchanged.
  SITE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().default("pglite://.data/pglite"),
  REDIS_URL: opt,
  APP_SECRET: opt,
  ADMIN_TOKEN: opt,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TRUST_PROXY: bool.default(false), // true behind exactly one trusted reverse proxy that appends X-Forwarded-For

  ROUTE_EXPLAIN_ENABLED: bool.default(false), // V84: route explanations.
  STATEMENTS_ENABLED: bool.default(false), // V87: read-only signed monthly statements.
  // Receipts
  RECEIPT_SIGNING_KEY: opt,
  RECEIPT_KEY_ROTATION_DAYS: num(7),
  ANCHOR_INTERVAL_MS: int(3_600_000),

  ...rpcEnv, // RPC1
  // Chain (Robinhood Chain mainnet by default)
  CHAIN_ID: int(4663),
  RHC_RPC_URL: z.string().default("https://rpc.mainnet.chain.robinhood.com"),
  PUBLIC_RPC_URL: z.string().default("https://rpc.mainnet.chain.robinhood.com"), // shown to wallets (never the private node URL)
  EXPLORER_URL: z.string().default("https://robinhoodchain.blockscout.com"),
  CHAIN_CONFIRMATIONS: int(2),
  CHAIN_START_BLOCK: z.coerce.bigint().optional(),
  USDG_ADDRESS: addr.default("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  USDG_EIP712_NAME: z.string().default("Global Dollar"),
  USDG_EIP712_VERSION: z.string().default("1"),
  CREDITS_ADDRESS: addr,
  CALLPAY_ADDRESS: addr,
  PROVIDER_BOND_ADDRESS: addr,
  RECEIPT_ANCHOR_ADDRESS: addr,
  // Anonymo ReceiptRoots on Robinhood Chain (WS08, rollout A3). With ANCHORER_PRIVATE_KEY on the receipts-anchor worker,
  // hourly receipt roots are posted there; without it they stay "local" (proofs still verify off-chain).
  ANONYMO_RECEIPT_ROOTS_ADDRESS: addr,
  ROYALTY_ADDRESS: addr,
  CALLPAY_TREASURY: addr,
  ROUTER_PRIVATE_KEY: pk,
  SETTLEMENT_PRIVATE_KEY: pk,
  ANCHORER_PRIVATE_KEY: pk,
  SLASHER_PRIVATE_KEY: pk,
  // Local development only: POST /api/v1/dev/faucet mints mock USDG and deposits it to the caller's key,
  // so the site can be tried without a wallet. Refused in production and against a non-loopback RPC.
  DEV_FAUCET: bool.default(false),
  DEV_FAUCET_PRIVATE_KEY: pk,
  HF_BASE_URL: z.string().default("https://huggingface.co"),

  // Economics (basis points)
  PER_CALL_MARGIN_BPS: int(100),
  PROVIDER_FEE_BPS: int(200),
  BYOK_FEE_BPS: int(0),
  DEFAULT_ROYALTY_BPS: int(500),
  PER_CALL_QUOTE_TTL_S: int(300),
  PER_CALL_MAX_USD: num(25),
  // x402 (exact scheme): agents sign a USDG EIP-3009 transferWithAuthorization to X402_PAY_TO and send it as
  // X-PAYMENT; the router relays it (ROUTER_PRIVATE_KEY pays the gas). Enabled when X402_PAY_TO is set.
  X402_PAY_TO: addr,
  X402_NETWORK: z.string().min(1).default("robinhood-chain"),
  PAYMENT_WAIT_MS: int(8_000),

  // Routing / health
  OUTAGE_WINDOW_MS: int(30_000),
  HEALTH_PROBE_INTERVAL_MS: int(15_000),
  HEALTH_PROBES: bool.default(true),
  PROVIDER_TIMEOUT_MS: int(120_000),
  FIRST_TOKEN_TIMEOUT_MS: int(45_000),
  MAX_PROVIDER_ATTEMPTS: int(4),
  EMPTY200_SLASH_THRESHOLD: num(0.02),
  UPTIME_SLASH_THRESHOLD: num(0.95),
  // Selection weight multiplier for an endpoint served under the attested class (declared attested retention and a
  // fresh, verified attestation), per lane. On lanes attested and unlinkable every eligible endpoint is attested, so
  // their bonus only matters if set differently from 1. Must be at least 1: attestation never lowers a weight.
  ATTESTED_BONUS_PUBLIC: z.coerce.number().min(1).max(10).default(1.25),
  ATTESTED_BONUS_ATTESTED: z.coerce.number().min(1).max(10).default(1),

  // Canaries
  CANARY_INTERVAL_MS: int(3_600_000),
  CANARIES: bool.default(true),
  SHADOW_DAYS: num(7),

  // Attestation
  ATTESTATION_INTERVAL_MS: int(600_000),
  // Days of attestor, canary and probe events kept for the public proof-time record (GET /api/v1/attestation/summary).
  // 0 records nothing and switches the two history endpoints off; rows already stored are left alone.
  ATTESTATION_HISTORY_DAYS: z.coerce.number().int().min(0).max(366).default(30),
  ALLOW_DEV_ATTESTATION: bool.default(false),
  // Public status page (GET /api/v1/status/slo): availability targets per lane, as fractions, and how many requests a window
  // needs before a dip below target is recorded as an incident suggestion for an operator to confirm.
  STATUS_SLO_PUBLIC: z.coerce.number().min(0.5).max(1).default(0.995),
  STATUS_SLO_ATTESTED: z.coerce.number().min(0.5).max(1).default(0.99),
  STATUS_SUGGEST_MIN_REQUESTS: z.coerce.number().int().min(1).default(20),
  NVIDIA_NRAS_URL: z.string().default("https://nras.attestation.nvidia.com/v3/attest/gpu"),
  TDX_VERIFIER_URL: opt,
  TDX_VERIFIER_KEY: opt,
  // Which services confirm a TEE quote: a comma list of dcap (TDX_VERIFIER_URL, the default), intel-ta, dstack,
  // phala (Phala Cloud's public quote verifier, PHALA_VERIFIER_URL).
  // Every listed verifier must accept the quote.
  ATTESTATION_VERIFIERS: z.string().default("dcap"),
  INTEL_TA_URL: z.string().default("https://api.trustauthority.intel.com/appraisal/v2/attest"),
  INTEL_TA_JWKS_URL: z.string().default("https://portal.trustauthority.intel.com/certs"),
  INTEL_TA_API_KEY: opt,
  DSTACK_VERIFIER_URL: opt,
  DSTACK_VERIFIER_KEY: opt,
  PHALA_VERIFIER_URL: z.string().default("https://cloud-api.phala.com/api/v1/attestations/verify"),

  // Measurements: record the image/compose/model digests bound into verified quotes, look them up in the
  // Rekor transparency log and prepare MeasurementRegistry.register() calldata. Off by default; nothing is submitted.
  MEASUREMENTS_ENABLED: bool.default(false),
  MEASUREMENTS_INTERVAL_MS: int(300_000),
  REKOR_URL: z.string().default("https://rekor.sigstore.dev"),
  REKOR_PUBLIC_KEY: opt, // PEM (ECDSA P-256) that signs Rekor checkpoints; without it checkpoints are not verified
  MEASUREMENT_REGISTRY_ADDRESS: addr,
  // PEM (or base64 SPKI) of the ECDSA P-256 key that signs measurement bundles. Setting it turns on bundle checking: the router
  // then accepts signed bundles (POST /trpc/measurements.submitBundle), verifies their transparency-log entries, and publishes
  // the key at GET /api/v1/measurements/key. Only the public key belongs here; the private key stays with whoever publishes.
  MEASUREMENT_PUBLIC_KEY: opt,

  // The Lane. Day-zero pipeline (off by default): watch Hugging Face for new fine-tunes of the listed permissive
  // base models, check their license, and create candidates for evaluation. Nothing is served without an
  // operator approval and an attested provider.
  DAYZERO_ENABLED: bool.default(false),
  DAYZERO_INTERVAL_MS: int(900_000),
  DAYZERO_BASE_MODELS: z.string().default(""), // comma list of Hugging Face repo ids (owner/name) whose derivatives are watched
  DAYZERO_LICENSES: z.string().default("mit,apache-2.0"), // license ids (model card metadata) a base model and a derivative may carry
  DAYZERO_KEYWORDS: z.string().default("abliterated,uncensored,decensored,unfiltered"), // a repository is a candidate only if its id or tags contain one
  DAYZERO_MAX_PER_RUN: int(25), // most repositories examined in one run
  DAYZERO_MAX_REFUSAL_RATE: num(0.25), // largest share of the benign probe set a candidate may refuse
  DAYZERO_MIN_CAPABILITY: num(0.8), // smallest share of the exact-check set a candidate must answer correctly
  DAYZERO_MIN_CANARY: num(0.75), // smallest share of the canary exact-match set
  // Creator claims: how long an issued challenge stays valid, and the file the uploader publishes it in.
  LANE_CLAIM_TTL_S: int(86_400),
  LANE_CLAIM_FILE: z.string().default("anonymo-claim.txt"),

  // Workers
  WORKERS: bool.default(true),
  SETTLEMENT_INTERVAL_MS: int(3_600_000),
  PROVIDER_REGISTRY_INTERVAL_MS: int(600_000),
  PROVIDERS_FILE: opt,

  // Gateway features
  OTEL_EXPORTER_OTLP_ENDPOINT: opt,
  OTEL_SERVICE_NAME: z.string().default("anonymo"),
  CACHE_TTL_S: z.coerce.number().int().min(1).default(3600),
  SEMANTIC_CACHE_THRESHOLD: num(0.97),
  SEMANTIC_CACHE_EMBEDDING_MODEL: opt,

  // Anthropic Messages endpoint (POST /v1/messages): JSON object mapping the model names an Anthropic client sends to catalog model ids.
  ANTHROPIC_MODEL_MAP: opt,

  // Council mode (model "anonymo/council") and dual verification (verify: "dual"). Off unless enabled.
  ANONYMO_FEATURE_COUNCIL: bool.default(true),
  ANONYMO_COUNCIL_MODELS: opt, // comma list of 2-5 model ids used when a council request names none
  ANONYMO_COUNCIL_JUDGE: opt, // model id of the judge used when a council request names none
  ANONYMO_COUNCIL_MODE: z.enum(["judge", "fuse"]).default("judge"),


  // Batch API (POST /api/v1/batches): lines run on the worker, in spare capacity, at a discount. Requests and answers are kept
  // sealed in Redis (or memory), never in Postgres, until BATCH_RESULTS_TTL seconds after the batch finishes.
  BATCH_DISCOUNT_BPS: z.coerce.number().int().min(0).max(10_000).default(5000), // 5000 = batch lines cost half the normal price
  BATCH_MAX_LINES: int(1000), // lines in one batch
  BATCH_MAX_BYTES: int(8 * 1024 * 1024), // bytes of input in one batch
  BATCH_MAX_ACTIVE: int(2), // unfinished batches one key may have at a time
  BATCH_RESULTS_TTL: z.coerce.number().int().min(60).default(86_400), // seconds results are kept after a batch finishes
  BATCH_INTERVAL_MS: int(2_000), // how often the worker drains queued lines
  BATCH_LINES_PER_TICK: int(20), // most lines started per drain
  BATCH_CONCURRENCY: int(4), // lines run at once
  BATCH_LINE_MAX_ATTEMPTS: int(3), // tries for a line whose providers were all unavailable

  // Default per-key limits (0 = unlimited)
  DEFAULT_RPM: int(600),
  DEFAULT_TPM: int(0),
  UNAUTH_RPM: int(60),
  NEW_KEYS_PER_HOUR: int(10),

  // Release identity and contract-path launch guards (see contractPathGuards below)
  RELEASE_COMMIT: opt, // git commit of the running build, shown at GET /api/v1/status
  DEPLOYMENT_MANIFEST: opt, // the anonymo.deployments/v1 manifest of the configured contracts: a file path or inline JSON
  DEPLOYMENT_VERIFICATION: opt, // the passing scripts/verify-deployment.ts report for that manifest: a file path or inline JSON

  // Operations: optional alert webhook (a secret URL) and off-host backup freshness.
  ALERT_WEBHOOK_URL: opt,
  ALERT_WEBHOOK_FORMAT: z.enum(["ntfy", "slack", "discord", "json"]).optional().or(z.literal("").transform(() => undefined)),
  BACKUP_REQUIRED: bool.default(false),
  BACKUP_MAX_AGE_HOURS: num(26),


});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Record<string, unknown> = {}) {
  const raw = { ...process.env, ...overrides } as Record<string, unknown>;
  const parsed = schema.safeParse(withLegacyEnv(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const production = e.ANONYMO_ENV === "production";
  const rpc = rpcSettings(e, production || process.env.NODE_ENV === "production"); // RPC1
  // Contract mode: the Anonymo Credits / CallPay / ReceiptAnchor / ProviderBond contracts are configured. Anonymo runs
  // without them by default (deposits are WS05's, hourly roots WS09's), so a router with none of them is contract-free:
  // no chain indexer, settlement or slashing runs and no signing key belongs anywhere.
  const contractAddresses = { CREDITS_ADDRESS: e.CREDITS_ADDRESS, CALLPAY_ADDRESS: e.CALLPAY_ADDRESS, RECEIPT_ANCHOR_ADDRESS: e.RECEIPT_ANCHOR_ADDRESS, PROVIDER_BOND_ADDRESS: e.PROVIDER_BOND_ADDRESS };
  const contractsMode = Object.values(contractAddresses).some((v) => v && !/^0x0{40}$/.test(v));
  const anonymoRoots = !!e.ANONYMO_RECEIPT_ROOTS_ADDRESS && !/^0x0{40}$/.test(e.ANONYMO_RECEIPT_ROOTS_ADDRESS);
  if (production) {
    if (!e.APP_SECRET || e.APP_SECRET.length < 32) throw new Error("APP_SECRET (>= 32 chars) is required in production.");
    if (!e.ADMIN_TOKEN || e.ADMIN_TOKEN.length < 24) throw new Error("ADMIN_TOKEN (>= 24 chars) is required in production.");
    if (e.ALLOW_DEV_ATTESTATION) throw new Error("ALLOW_DEV_ATTESTATION must be false in production.");
    if (!e.PUBLIC_BASE_URL.startsWith("https://")) throw new Error("PUBLIC_BASE_URL must be https in production.");
    if (!/^postgres(?:ql)?:/.test(e.DATABASE_URL)) throw new Error("PostgreSQL is required in production.");
    const database = new URL(e.DATABASE_URL);
    if (!database.password || ["anonymo", "anonymo", "postgres", "password"].includes(decodeURIComponent(database.password))) throw new Error("Nondefault database credential is required in production.");
    if (!e.REDIS_URL || !/^rediss?:/.test(e.REDIS_URL) || !new URL(e.REDIS_URL).password) throw new Error("Production requires authenticated Redis.");
    if (e.RUNTIME_ROLE === "all") throw new Error("Production requires separate api and worker roles.");
    if (e.AUTO_MIGRATE) throw new Error("Production requires AUTO_MIGRATE=false and a completed migration job.");
    if (e.HOST === "127.0.0.1" || e.HOST === "localhost" || e.HOST === "::1") throw new Error("Production HOST must be externally reachable.");
    if (contractsMode)
      for (const [name, value] of Object.entries(contractAddresses))
        if (!value || /^0x0{40}$/.test(value)) throw new Error(`${name} is required in production contract mode (set all four or none).`);
    if (contractsMode && e.RUNTIME_ROLE === "api" && !e.ROUTER_PRIVATE_KEY) throw new Error("Public API requires the restricted router signing role for enabled per-call payments.");
    const roleKeys = { settlement: e.SETTLEMENT_PRIVATE_KEY, anchoring: e.ANCHORER_PRIVATE_KEY, slashing: e.SLASHER_PRIVATE_KEY };
    if (e.RUNTIME_ROLE === "api" && Object.values(roleKeys).some(Boolean)) throw new Error("Public API must not receive settlement, anchoring or slashing signing keys.");
    // The withdrawal hot wallet signs only on the worker that runs anonymo-deposits (it processes pending withdrawals).
    const payoutKey = typeof raw.ANONYMO_PAYOUT_PRIVATE_KEY === "string" && raw.ANONYMO_PAYOUT_PRIVATE_KEY.trim();
    if (payoutKey && e.RUNTIME_ROLE === "api") throw new Error("Public API must not receive the withdrawal hot wallet key (ANONYMO_PAYOUT_PRIVATE_KEY).");
    // Contract-free: no job signs anything (receipts stay signed locally, settlement and slashing are inert).
    // ReceiptRoots (A3) is the one contract a contract-free router signs for: the anchoring key alone, on its worker.
    if (!contractsMode && (roleKeys.settlement || roleKeys.slashing || (roleKeys.anchoring && !anonymoRoots))) throw new Error("A contract-free router must not receive settlement, anchoring or slashing signing keys.");
    if (e.RUNTIME_ROLE === "worker") {
      const names = e.WORKER_JOBS.split(",").map((v) => v.trim()).filter(Boolean);
      const allowed = ["health-flush", "holds-expire", "catalog-refresh", "provider-registry", "health-probes", "canaries", "attestor", "receipts-anchor", "receipt-key-rotation", "settlement", "slasher", "chain-indexer", "spend-watch", "alert-notifier", "measurements", "dayzero", "batches"];
      allowed.push("webhooks"); // V86: bounded event delivery.
      allowed.push("upstream-monitor"); // ON3
      allowed.push("x402-recovery-expire"); // x402 payment recovery retention
      allowed.push("anonymo-canaries", "anonymo-balances", "anonymo-deposits", "anonymo-sanctions"); // Anonymo WS04 and WS05 jobs
      if (!names.length || names.some((n) => !allowed.includes(n))) throw new Error("Worker requires an explicit valid WORKER_JOBS list.");
      const keyJobs = { settlement: "settlement", anchoring: "receipts-anchor", slashing: "slasher" };
      if (Object.values(roleKeys).filter(Boolean).length > 1) throw new Error("Privileged worker signing roles must be isolated.");
      if (!contractsMode && anonymoRoots && !!roleKeys.anchoring !== names.includes("receipts-anchor")) throw new Error("Worker anchoring job and signing-key configuration must match.");
      if (contractsMode)
        for (const [role, key] of Object.entries(roleKeys)) {
          const enabled = names.includes(keyJobs[role as keyof typeof keyJobs]);
          if (enabled !== !!key) throw new Error(`Worker ${role} job and signing-key configuration must match.`);
        }
    }
  }
  const verifierNames = e.ATTESTATION_VERIFIERS.split(",").map((v) => v.trim()).filter(Boolean);
  if (!verifierNames.length || verifierNames.some((v) => !["dcap", "intel-ta", "dstack", "phala"].includes(v))) throw new Error("ATTESTATION_VERIFIERS must list dcap, intel-ta, dstack and/or phala.");
  if (new Set(verifierNames).size !== verifierNames.length) throw new Error("ATTESTATION_VERIFIERS lists a verifier twice.");
  if (verifierNames.includes("intel-ta") && !e.INTEL_TA_API_KEY) throw new Error("ATTESTATION_VERIFIERS includes intel-ta, which needs INTEL_TA_API_KEY.");
  if (verifierNames.includes("dstack") && !e.DSTACK_VERIFIER_URL) throw new Error("ATTESTATION_VERIFIERS includes dstack, which needs DSTACK_VERIFIER_URL.");
  if (production) {
    if (verifierNames.includes("intel-ta") && !(e.INTEL_TA_URL.startsWith("https://") && e.INTEL_TA_JWKS_URL.startsWith("https://"))) throw new Error("INTEL_TA_URL and INTEL_TA_JWKS_URL must be https in production.");
    if (e.MEASUREMENTS_ENABLED && !e.REKOR_URL.startsWith("https://")) throw new Error("REKOR_URL must be https in production.");
    if (verifierNames.includes("phala") && !e.PHALA_VERIFIER_URL.startsWith("https://")) throw new Error("PHALA_VERIFIER_URL must be https in production.");
  }
  // Contract-path guard: verified deployment (H-02).
  const contractPath = contractPathGuards(e, production);
  if (e.DEV_FAUCET) {
    if (production) throw new Error("DEV_FAUCET must be false in production.");
    let host = "";
    try {
      host = new URL(e.RHC_RPC_URL).hostname;
    } catch {
      /* reported below */
    }
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) throw new Error("DEV_FAUCET only works against a local chain (RHC_RPC_URL on 127.0.0.1/localhost).");
    if (!e.DEV_FAUCET_PRIVATE_KEY) throw new Error("DEV_FAUCET needs DEV_FAUCET_PRIVATE_KEY (a funded local development account).");
  }
  // The webhook is optional: without it the alert-notifier job only records state. Never echo the URL.
  if (e.ALERT_WEBHOOK_URL) {
    let protocol = "";
    try { protocol = new URL(e.ALERT_WEBHOOK_URL).protocol; } catch { /* reported below */ }
    if (protocol !== "https:" && (production || protocol !== "http:")) throw new Error("ALERT_WEBHOOK_URL must be an https URL.");
  }
  if (!(e.BACKUP_MAX_AGE_HOURS > 0)) throw new Error("BACKUP_MAX_AGE_HOURS must be positive.");
  if (e.PER_CALL_MARGIN_BPS > 100) throw new Error("PER_CALL_MARGIN_BPS must be <= 100 (1%).");
  if (e.X402_PAY_TO && /^0x0{40}$/.test(e.X402_PAY_TO)) throw new Error("X402_PAY_TO must not be the zero address.");
  if (production && e.X402_PAY_TO && e.RUNTIME_ROLE === "api" && !e.ROUTER_PRIVATE_KEY) throw new Error("X402_PAY_TO requires the router signing role (ROUTER_PRIVATE_KEY) to relay x402 settlements.");
  const councilModels = (e.ANONYMO_COUNCIL_MODELS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (councilModels.length && (councilModels.length < 2 || councilModels.length > 5 || new Set(councilModels).size !== councilModels.length))
    throw new Error("ANONYMO_COUNCIL_MODELS must list 2 to 5 distinct model ids.");
  return {
    env: e.ANONYMO_ENV,
    production,
    developerFirstCallEnabled: e.DEVELOPER_FIRST_CALL_ENABLED, // ON2
    routeExplain: e.ROUTE_EXPLAIN_ENABLED, // V84
    facilitator: facilitatorSettings(e, production), // v6 F
    sanctions: { enabled: e.ANONYMO_SANCTIONS_ENABLED },
    inferenceKeysEnabled: e.INFERENCE_KEYS_ENABLED, // ZK6
    statementsEnabled: e.STATEMENTS_ENABLED, // V87
    rush: rushSettings(e), // ON3
    spendInsightsEnabled: e.SPEND_INSIGHTS_ENABLED, // V88: read-only spend insights.
    webhookSigningEnabled: e.WEBHOOK_SIGNING_ENABLED, // V86: off preserves existing delivery.
    runtimeRole: e.RUNTIME_ROLE,
    autoMigrate: e.AUTO_MIGRATE,
    workerJobs: e.WORKER_JOBS.split(",").map((n) => n.trim()).filter(Boolean),
    test: e.ANONYMO_ENV === "test",
    host: e.HOST,
    port: e.PORT,
    publicUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
    siteUrl: (e.SITE_URL ?? e.PUBLIC_BASE_URL).replace(/\/$/, ""),
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appSecret: e.APP_SECRET ?? "dev-insecure-secret-change-me-dev-insecure",
    adminToken: e.ADMIN_TOKEN,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    hardening: hardeningSettings(e), // HD1
    release: { commit: contractPath.releaseCommit, deployment: contractPath.deployment },
    receipts: {
      signingKey: e.RECEIPT_SIGNING_KEY,
      rotationDays: e.RECEIPT_KEY_ROTATION_DAYS,
      anchorIntervalMs: e.ANCHOR_INTERVAL_MS,
    },
    chain: {
      id: e.CHAIN_ID,
      rpcUrl: e.RHC_RPC_URL,
      ...rpc, // RPC1
      publicRpcUrl: e.PUBLIC_RPC_URL,
      explorerUrl: e.EXPLORER_URL,
      confirmations: e.CHAIN_CONFIRMATIONS,
      startBlock: e.CHAIN_START_BLOCK,
      usdg: e.USDG_ADDRESS as `0x${string}`,
      usdgDomain: { name: e.USDG_EIP712_NAME, version: e.USDG_EIP712_VERSION },
      credits: e.CREDITS_ADDRESS as `0x${string}` | undefined,
      callPay: e.CALLPAY_ADDRESS as `0x${string}` | undefined,
      providerBond: e.PROVIDER_BOND_ADDRESS as `0x${string}` | undefined,
      receiptAnchor: e.RECEIPT_ANCHOR_ADDRESS as `0x${string}` | undefined,
      anonymoReceiptRoots: e.ANONYMO_RECEIPT_ROOTS_ADDRESS as `0x${string}` | undefined,
      royalty: e.ROYALTY_ADDRESS as `0x${string}` | undefined,
      callPayTreasury: e.CALLPAY_TREASURY as `0x${string}` | undefined,
      routerKey: e.ROUTER_PRIVATE_KEY as `0x${string}` | undefined,
      settlementKey: e.SETTLEMENT_PRIVATE_KEY as `0x${string}` | undefined,
      anchorerKey: e.ANCHORER_PRIVATE_KEY as `0x${string}` | undefined,
      slasherKey: e.SLASHER_PRIVATE_KEY as `0x${string}` | undefined,
      faucetKey: (e.DEV_FAUCET ? e.DEV_FAUCET_PRIVATE_KEY : undefined) as `0x${string}` | undefined,
    },
    fees: {
      perCallMarginBps: e.PER_CALL_MARGIN_BPS,
      providerFeeBps: e.PROVIDER_FEE_BPS,
      byokFeeBps: e.BYOK_FEE_BPS,
      defaultRoyaltyBps: e.DEFAULT_ROYALTY_BPS,
      quoteTtlS: e.PER_CALL_QUOTE_TTL_S,
      perCallMaxUsd: e.PER_CALL_MAX_USD,
      paymentWaitMs: e.PAYMENT_WAIT_MS,
    },
    x402: { payTo: e.X402_PAY_TO?.toLowerCase() as `0x${string}` | undefined, network: e.X402_NETWORK },
    routing: {
      outageWindowMs: e.OUTAGE_WINDOW_MS,
      probeIntervalMs: e.HEALTH_PROBE_INTERVAL_MS,
      probes: e.HEALTH_PROBES,
      providerTimeoutMs: e.PROVIDER_TIMEOUT_MS,
      firstTokenTimeoutMs: e.FIRST_TOKEN_TIMEOUT_MS,
      maxAttempts: e.MAX_PROVIDER_ATTEMPTS,
      empty200SlashThreshold: e.EMPTY200_SLASH_THRESHOLD,
      uptimeSlashThreshold: e.UPTIME_SLASH_THRESHOLD,
      attestedBonus: { public: e.ATTESTED_BONUS_PUBLIC, attested: e.ATTESTED_BONUS_ATTESTED },
    },
    canaries: { intervalMs: e.CANARY_INTERVAL_MS, enabled: e.CANARIES, shadowDays: e.SHADOW_DAYS },
    hfBaseUrl: e.HF_BASE_URL.replace(/\/$/, ""),
    status: {
      targets: { public: e.STATUS_SLO_PUBLIC, attested: e.STATUS_SLO_ATTESTED },
      suggestMinRequests: e.STATUS_SUGGEST_MIN_REQUESTS,
    },
    attestation: {
      intervalMs: e.ATTESTATION_INTERVAL_MS,
      historyDays: e.ATTESTATION_HISTORY_DAYS,
      allowDev: e.ALLOW_DEV_ATTESTATION && !production,
      nrasUrl: e.NVIDIA_NRAS_URL,
      tdxVerifierUrl: e.TDX_VERIFIER_URL,
      tdxVerifierKey: e.TDX_VERIFIER_KEY,
      verifiers: verifierNames as ("dcap" | "intel-ta" | "dstack" | "phala")[],
      intelTa: { url: e.INTEL_TA_URL, jwksUrl: e.INTEL_TA_JWKS_URL, apiKey: e.INTEL_TA_API_KEY },
      dstackVerifierUrl: e.DSTACK_VERIFIER_URL,
      dstackVerifierKey: e.DSTACK_VERIFIER_KEY,
      phalaVerifierUrl: e.PHALA_VERIFIER_URL,
    },
    measurements: {
      enabled: e.MEASUREMENTS_ENABLED,
      intervalMs: e.MEASUREMENTS_INTERVAL_MS,
      rekorUrl: e.REKOR_URL.replace(/\/$/, ""),
      rekorPublicKey: e.REKOR_PUBLIC_KEY?.replace(/\\n/g, "\n").trim(),
      publicKey: measurementPublicKey(e.MEASUREMENT_PUBLIC_KEY),
      registry: e.MEASUREMENT_REGISTRY_ADDRESS && !/^0x0{40}$/.test(e.MEASUREMENT_REGISTRY_ADDRESS) ? (e.MEASUREMENT_REGISTRY_ADDRESS.toLowerCase() as `0x${string}`) : null,
    },
    lane: laneSettings(e),
    workers: {
      enabled: e.WORKERS && e.RUNTIME_ROLE !== "api",
      settlementIntervalMs: e.SETTLEMENT_INTERVAL_MS,
      registryIntervalMs: e.PROVIDER_REGISTRY_INTERVAL_MS,
      providersFile: e.PROVIDERS_FILE,
    },
    gateway: {
      otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
      otelServiceName: e.OTEL_SERVICE_NAME,
      cacheTtlS: e.CACHE_TTL_S,
      semanticThreshold: e.SEMANTIC_CACHE_THRESHOLD,
      semanticEmbeddingModel: e.SEMANTIC_CACHE_EMBEDDING_MODEL,
    },
    anthropic: { modelMap: parseModelMap(e.ANTHROPIC_MODEL_MAP) },
    // Off unless enabled. Council members and the judge are billed and receipted like any other call.
    structuredOutputCheckEnabled: e.STRUCTURED_OUTPUT_CHECK_ENABLED, // V83
    features: { council: e.ANONYMO_FEATURE_COUNCIL },
    council: { models: councilModels, judge: e.ANONYMO_COUNCIL_JUDGE ?? null, mode: e.ANONYMO_COUNCIL_MODE },
    batch: {
      discountBps: e.BATCH_DISCOUNT_BPS,
      maxLines: e.BATCH_MAX_LINES,
      maxBytes: e.BATCH_MAX_BYTES,
      maxActive: e.BATCH_MAX_ACTIVE,
      resultsTtlS: e.BATCH_RESULTS_TTL,
      intervalMs: e.BATCH_INTERVAL_MS,
      linesPerTick: e.BATCH_LINES_PER_TICK,
      concurrency: Math.max(1, e.BATCH_CONCURRENCY),
      maxAttempts: Math.max(1, e.BATCH_LINE_MAX_ATTEMPTS),
    },
    limits: { defaultRpm: e.DEFAULT_RPM, defaultTpm: e.DEFAULT_TPM, unauthRpm: e.UNAUTH_RPM, newKeysPerHour: e.NEW_KEYS_PER_HOUR },
    alerts: { webhookUrl: e.ALERT_WEBHOOK_URL, webhookFormat: e.ALERT_WEBHOOK_FORMAT },
    backup: { required: e.BACKUP_REQUIRED, maxAgeHours: e.BACKUP_MAX_AGE_HOURS },
  };
}

// ---- The Lane -------------------------------------------------------------------------------------------
const REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const csv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

function laneSettings(e: Env) {
  const baseModels = [...new Set(csv(e.DAYZERO_BASE_MODELS))];
  const bad = baseModels.find((b) => !REPO_ID.test(b));
  if (bad) throw new Error("DAYZERO_BASE_MODELS must be a comma list of Hugging Face repository ids (owner/name).");
  if (e.DAYZERO_ENABLED && !baseModels.length) throw new Error("DAYZERO_ENABLED needs DAYZERO_BASE_MODELS: the base models whose derivatives are watched.");
  const licenses = [...new Set(csv(e.DAYZERO_LICENSES).map((l) => l.toLowerCase()))];
  if (!licenses.length) throw new Error("DAYZERO_LICENSES must list at least one license.");
  const keywords = [...new Set(csv(e.DAYZERO_KEYWORDS).map((k) => k.toLowerCase()))];
  if (!keywords.length) throw new Error("DAYZERO_KEYWORDS must list at least one keyword.");
  for (const [name, v] of Object.entries({ DAYZERO_MAX_REFUSAL_RATE: e.DAYZERO_MAX_REFUSAL_RATE, DAYZERO_MIN_CAPABILITY: e.DAYZERO_MIN_CAPABILITY, DAYZERO_MIN_CANARY: e.DAYZERO_MIN_CANARY }))
    if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be between 0 and 1.`);
  if (e.DAYZERO_INTERVAL_MS < 60_000) throw new Error("DAYZERO_INTERVAL_MS must be at least 60000.");
  if (e.DAYZERO_MAX_PER_RUN < 1 || e.DAYZERO_MAX_PER_RUN > 200) throw new Error("DAYZERO_MAX_PER_RUN must be between 1 and 200.");
  if (e.LANE_CLAIM_TTL_S < 60) throw new Error("LANE_CLAIM_TTL_S must be at least 60.");
  if (!/^[\w.-][\w.-]{0,127}$/.test(e.LANE_CLAIM_FILE)) throw new Error("LANE_CLAIM_FILE must be a plain file name.");
  return {
    dayzero: {
      enabled: e.DAYZERO_ENABLED,
      intervalMs: e.DAYZERO_INTERVAL_MS,
      baseModels,
      licenses,
      keywords,
      maxPerRun: e.DAYZERO_MAX_PER_RUN,
      maxRefusalRate: e.DAYZERO_MAX_REFUSAL_RATE,
      minCapability: e.DAYZERO_MIN_CAPABILITY,
      minCanary: e.DAYZERO_MIN_CANARY,
    },
    claim: { ttlS: e.LANE_CLAIM_TTL_S, file: e.LANE_CLAIM_FILE },
  };
}

// ---- Contract-path launch guards ---------------------------------------------------------------
// H-02: production contract mode moves customer funds through the Anonymo contracts, so it starts
//   only against a deployment that was independently verified: DEPLOYMENT_MANIFEST (written by
//   contracts/script/Deploy.s.sol) must list exactly the configured addresses, and
//   DEPLOYMENT_VERIFICATION must be the passing report of `bun scripts/verify-deployment.ts
//   <manifest> --rpc-url <rpc>` for that manifest (same block, same chain, bytecode found at every
//   manifest address). The report is a point-in-time snapshot: re-run the verifier for every release
//   and whenever ownership or roles change. A disposable fixture whose public origin is on a reserved
//   TLD (.example, .invalid, .test, .localhost; RFC 2606/6761) cannot serve real users or wallet
//   sign-in; it may run without a manifest and reports deployment status "fixture".

type Env = z.infer<typeof schema>;
export type DeploymentStatus = {
  status: "none" | "unverified" | "fixture" | "verified";
  manifestSha256: string | null;
  manifestBlock: number | null;
  verifiedAtBlock: string | null;
  verifierRevision: string | null;
};
export const DEPLOYMENT_SCHEMA = "anonymo.deployments/v1";
const RESERVED_TLDS = new Set(["example", "invalid", "test", "localhost"]);
const MANIFEST_CONTRACTS = {
  CREDITS_ADDRESS: "credits",
  CALLPAY_ADDRESS: "callPay",
  PROVIDER_BOND_ADDRESS: "providerBond",
  RECEIPT_ANCHOR_ADDRESS: "receiptAnchor",
  ROYALTY_ADDRESS: "royalty",
} as const;
const sameAddress = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();

/** A file path or inline JSON; errors never echo the value. */
function readJsonSetting(name: string, value: string): { json: Record<string, any>; sha256: string } {
  let text: string;
  try {
    text = value.trim().startsWith("{") ? value : readFileSync(resolve(value), "utf8");
  } catch {
    throw new Error(`${name} could not be read.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${name} must be a JSON object.`);
  return { json: json as Record<string, any>, sha256: createHash("sha256").update(text).digest("hex") };
}

function contractPathGuards(e: Env, production: boolean) {
  if (e.RELEASE_COMMIT && !/^[0-9a-f]{7,40}$/i.test(e.RELEASE_COMMIT)) throw new Error("RELEASE_COMMIT must be a git commit id.");
  const releaseCommit = e.RELEASE_COMMIT?.toLowerCase() ?? null;
  const configured = (Object.keys(MANIFEST_CONTRACTS) as (keyof typeof MANIFEST_CONTRACTS)[]).filter((name) => e[name]);
  const deployment: DeploymentStatus = { status: !configured.length ? "none" : "unverified", manifestSha256: null, manifestBlock: null, verifiedAtBlock: null, verifierRevision: null };
  const result = { releaseCommit, deployment };
  if (!production) return result;

  // H-02: contract mode runs only against a verified deployment.
  if (!configured.length) return result;
  let host = "";
  try {
    host = new URL(e.PUBLIC_BASE_URL).hostname;
  } catch {
    /* PUBLIC_BASE_URL is validated above */
  }
  if (!e.DEPLOYMENT_MANIFEST) {
    if (RESERVED_TLDS.has(host.split(".").at(-1) ?? "")) {
      deployment.status = "fixture";
      return result;
    }
    throw new Error("Production contract mode requires DEPLOYMENT_MANIFEST (the anonymo.deployments/v1 manifest) and DEPLOYMENT_VERIFICATION (its passing scripts/verify-deployment.ts report).");
  }
  if (!releaseCommit || releaseCommit.length !== 40) throw new Error("Production contract mode requires RELEASE_COMMIT, the full git commit of this build.");

  const { json: manifest, sha256 } = readJsonSetting("DEPLOYMENT_MANIFEST", e.DEPLOYMENT_MANIFEST);
  const refuseManifest = (why: string): never => {
    throw new Error(`DEPLOYMENT_MANIFEST ${why}`);
  };
  const contracts: Record<string, unknown> = manifest.contracts && typeof manifest.contracts === "object" ? manifest.contracts : {};
  if (manifest.schema !== DEPLOYMENT_SCHEMA) refuseManifest(`must use schema ${DEPLOYMENT_SCHEMA}.`);
  if (manifest.mode !== "production") refuseManifest("must describe a production deployment.");
  if (Number(manifest.chainId) !== e.CHAIN_ID) refuseManifest(`is not for chain ${e.CHAIN_ID}.`);
  if (!/^\d+$/.test(String(manifest.blockNumber))) refuseManifest("has no deployment block.");
  for (const [name, key] of [...Object.entries(MANIFEST_CONTRACTS), ["USDG_ADDRESS", "usdg"]] as [keyof Env, string][]) {
    if (e[name] && !sameAddress(e[name], contracts[key])) refuseManifest(`does not list ${name} as its ${key} contract.`);
  }
  if (e.CALLPAY_TREASURY && !sameAddress(e.CALLPAY_TREASURY, manifest.roles?.callPayTreasury)) refuseManifest("does not list CALLPAY_TREASURY as the CallPay treasury.");

  if (!e.DEPLOYMENT_VERIFICATION) throw new Error("Production contract mode requires DEPLOYMENT_VERIFICATION, the passing scripts/verify-deployment.ts report for DEPLOYMENT_MANIFEST.");
  const { json: report } = readJsonSetting("DEPLOYMENT_VERIFICATION", e.DEPLOYMENT_VERIFICATION);
  const refuseReport = (why: string): never => {
    throw new Error(`DEPLOYMENT_VERIFICATION ${why}`);
  };
  const checks: { id?: unknown; status?: unknown; evidence?: any }[] = Array.isArray(report.checks) ? report.checks : [];
  if (report.ok !== true || !checks.length || checks.some((c) => !c || c.status === "fail")) refuseReport("is not a passing verifier report.");
  if (!/^[0-9a-f]{40}$/.test(String(report.verifierRevision))) refuseReport("does not name the verifier's git revision.");
  const certified = report.manifest ?? {};
  if (certified.schema !== DEPLOYMENT_SCHEMA || certified.mode !== "production" || Number(certified.chainId) !== e.CHAIN_ID || Number(certified.blockNumber) !== Number(manifest.blockNumber))
    refuseReport("was produced for a different manifest.");
  const observedBlock = String(report.observed?.blockNumber);
  if (Number(report.observed?.chainId) !== e.CHAIN_ID || !/^\d+$/.test(observedBlock) || BigInt(observedBlock) < BigInt(String(manifest.blockNumber)))
    refuseReport("was not read from this chain after the deployment block.");
  const proof = checks.find((c) => c.id === "contracts.source_equivalence");
  if (proof?.status !== "pass" || proof.evidence?.sourceRevision !== report.verifierRevision || !Array.isArray(proof.evidence?.mismatches) || proof.evidence.mismatches.length)
    refuseReport("does not prove the audited runtime build and immutable values.");
  // Bind the report to this manifest: the verifier found runtime bytecode at every manifest address.
  const bytecode = checks.find((c) => c.id === "contracts.bytecode_present");
  const found: Record<string, { address?: unknown; present?: unknown }> = bytecode?.status === "pass" && bytecode.evidence && typeof bytecode.evidence === "object" ? bytecode.evidence : {};
  for (const [key, address] of Object.entries(contracts)) {
    if (typeof address === "string" && /^0x0{40}$/.test(address)) continue;
    if (!sameAddress(found[key]?.address, address) || found[key]?.present !== true) refuseReport(`did not verify the manifest's ${key} contract.`);
  }
  Object.assign(deployment, { status: "verified", manifestSha256: sha256, manifestBlock: Number(manifest.blockNumber), verifiedAtBlock: observedBlock, verifierRevision: String(report.verifierRevision) });
  return result;
}
