import type { Catalog } from "./catalog/catalog.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { RateLimiter } from "./lib/ratelimit.ts";
import type { ReceiptSigner } from "./receipts/signer.ts";
import type { HealthTracker } from "./services/health.ts";
import type { ChainService } from "./chain/service.ts";
import type { ResponseCache } from "./gateway/cache.ts";
import type { Telemetry } from "./gateway/otel.ts";
import type { TracingExporter } from "./services/tracing.ts";
import type { Jobs } from "./services/jobs.ts";
import type { AnonymoServices } from "./anonymo/services.ts";

export type Ctx = {
  cfg: Config;
  db: Db;
  dbKind: "pglite" | "postgres";
  catalog: Catalog;
  health: HealthTracker;
  signer: ReceiptSigner;
  limiter: RateLimiter;
  chain: ChainService;
  cache: ResponseCache;
  telemetry: Telemetry;
  /** Customer trace export: spans of public-lane calls sent to the destination a key's owner configured. */
  tracing: TracingExporter;
  jobs: Jobs;
  /** The fetch used for Hugging Face API calls (day-zero discovery, creator claims); the global fetch when unset. Tests inject one. */
  hfFetch?: typeof fetch;
  /** Anonymo's floor gate and refusal classifier (src/anonymo/services.ts). */
  anonymo: AnonymoServices;
  /** Test hook: deterministic provider shuffle. */
  rand?: () => number;
};
