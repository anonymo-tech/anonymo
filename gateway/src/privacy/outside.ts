import { freeAddressReader } from "../anonymo/freetier/inventory.ts";
import { mediaBodyReader, transcriptionBodyReader } from "../anonymo/media/inventory.ts"; // WS06 media
import { ventureBodyReader, ventureStores } from "../anonymo/ventures/inventory.ts"; // WS11 Ventures
import { keySafeAddressReader, keySafeBodyReader } from "../anonymo/keysafe/inventory.ts";
import { codesAddressReader, codesBodyReader } from "../anonymo/codes/inventory.ts";
import { anonymoMoneyAddressReader, anonymoMoneyBodyReaders } from "./anonymo-money.ts"; // WS05
import { modelAlternativesReader } from "./model-alternatives.ts"; // B121
import { abuseBodyReader } from "../anonymo/abuse/privacy.ts"; // Anonymo WS02
import { refusalSettingReader } from "./refusal.ts"; // Anonymo WS03
import { anonymousRateFamily, hardeningAddresses, hardeningBodies } from "./hardening.ts"; // HD1
import { rushStores } from "./rush.ts"; // ON3
import { provisioningBodyReader, inferenceModelReader } from "./provisioning.ts"; // ZK6
import { structuredOutputReader } from "./structured-output.ts"; // V83
import { statementStores } from "./statements.ts"; // V87
import { laneReportLimit, laneReportStores } from "./lane-report.ts"; // Lane report
import { insightsStores } from "./insights.ts"; // V88: read-only aggregates.
import { webhookBodyReader, webhookStores } from "./webhooks.ts"; // V86: event delivery.
import { activityStores } from "./activity.ts";
import type { Evidence, ExternalDoc, RedisFamily, Touchpoint } from "./types.ts";
import { x402RecoveryFamily, x402RecoveryReader } from "./x402-recovery.ts";
import { facilitatorAddressReader, facilitatorBodyReader, facilitatorRedisFamilies } from "./facilitator.ts"; // v6 F

// Everything the router keeps, or touches, outside Postgres: Redis keys (with their lifetimes and whether they contain a network
// address), the application log, telemetry, backups and the places in the code that read a request's body or a caller's address.
//
// Every statement carries evidence: a file and a line of code that shows it. test/data-inventory.test.ts checks that the file
// exists and still contains that text, and scans the source so a new limiter key, a new log field that reads a request, a new
// reader of a caller's address or a new route that reads a body fails until it is described here.

const ev = (file: string, contains: string, note?: string): Evidence => ({ file, contains, ...(note ? { note } : {}) });

/** Redis key lifetime for a rate-limit window: the window plus one second (RedisRateLimiter.take). */
export const windowTtl = (seconds: number) => `${(seconds + 1).toLocaleString("en-US")} seconds (the ${seconds.toLocaleString("en-US")}-second window plus one second)`;

const RL_KEY = ev("src/lib/ratelimit.ts", "const k = `rl:${key}:${start}`;", "The stored key is rl:<limiter key>:<window start in ms>.");
const RL_TTL = ev("src/lib/ratelimit.ts", "await this.redis.pexpire(k, windowMs + 1000);", "The key expires one second after its window ends.");

function limit(o: { prefix: string; shape: string; purpose: string; holds: RedisFamily["holds"]; seconds: number; evidence: Evidence[] }): RedisFamily {
  return {
    key: `rl:${o.shape}:<window start>`,
    purpose: o.purpose,
    holds: o.holds,
    limiterPrefix: o.prefix,
    windowSeconds: o.seconds,
    ttl: windowTtl(o.seconds),
    evidence: [...o.evidence, RL_KEY, RL_TTL],
  };
}

export const freeRateLimit = limit({
  prefix: "free:",
  shape: "free:<counter>[:<daily address digest>]",
  purpose: "Limits free chat challenges and proofs. Recent challenge volume and invalid proofs raise puzzle difficulty.",
  holds: "digest",
  seconds: 60,
  evidence: [ev("src/anonymo/freetier/routes.ts", "ctx.limiter.take(`free:${bucket}`, amount, max, WINDOW)")],
});

export const telegramRateLimit = limit({
  prefix: "telegram:",
  shape: "telegram:<operation>[:<key hash or server-salted Telegram user digest>]",
  purpose: "Limits Telegram chat challenges, proofs, bot commands and handoff or link actions.",
  holds: "digest",
  seconds: 60,
  evidence: [ev("src/anonymo/telegram/trial.ts", "ctx.limiter.take(`telegram:${bucket}`, amount, max, WINDOW)")],
});

export const telegramBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/telegram/routes.ts",
  carries: "prompt-or-answer",
  reads: "Authenticated webhook messages and Stars payment events, or Mini App authorization, free-tier proof and optional chat message. The handoff exchange reads a one-time token.",
  then: "Verifies the webhook secret or signed Mini App data, uses only the Telegram user ID, and sends trial text through moderated gateway chat. Telegram keeps messages in its bot chat.",
  kept: "Salted Telegram user digests, key and token hashes, short-lived free-tier proofs, and Stars payment and refund metadata. No chat text, account names or signed Mini App data.",
  evidence: [
    ev("src/anonymo/telegram/routes.ts", "miniRequest.safeParse(await readJson(c))"),
    ev("src/anonymo/telegram/routes.ts", "validWebhookSecret(settings.webhookSecret"),
    ev("src/anonymo/telegram/routes.ts", "return c.json(await trialReply(ctx, verified, data.text, c.req.raw.signal));"),
  ],
};

export const creatorRedisFamilies: RedisFamily[] = [
  {
    key: "creators:salt:<UTC day or cohort>", purpose: "Rotating random HMAC salts for spend caps and audience estimates.",
    holds: "nothing-personal", ttl: "24 hours for a day salt and 15 days for a cohort salt.",
    evidence: [ev("src/anonymo/creators/counters.ts", 'set(name, value, "EX", seconds, "NX")')],
  },
  {
    key: "creators:cap:<daily HMAC>", purpose: "Maximum eligible spend per key per creator wallet in one UTC day.",
    holds: "digest", ttl: "24 hours from the first counted charge.",
    evidence: [ev("src/anonymo/creators/counters.ts", "const digest = hash(salt, keyHash + creatorId)"),
      ev("src/anonymo/creators/counters.ts", "redis.call('EXPIRE', KEYS[1], 86400)")],
  },
  {
    key: "creators:audience:<character>:<day or cohort>", purpose: "Approximate distinct daily visitors, recently funded visitors and cohort overlap using HyperLogLog registers.",
    holds: "nothing-personal", ttl: "24 hours for daily estimates and at most 22 days for cohort estimates.",
    evidence: [ev("src/anonymo/creators/counters.ts", "redis.call('PFADD', KEYS[i], ARGV[i])"),
      ev("src/anonymo/creators/counters.ts", "22 * 86_400")],
  },
];
export const creatorBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/creators/routes.ts",
  reads: "An intentionally published profile, creator wallet signature, stats nonce, review decision or referral code.",
  then: "Runs the floor against publication fields, authorizes wallet actions and accepts referral codes before funding.",
  kept: "Public listing metadata, aggregate review decisions and opaque referral records. No chat text or raw signature.",
  carries: "public-data",
  evidence: [ev("src/anonymo/creators/routes.ts", "publication.parse(await readJson(c))"),
    ev("src/anonymo/creators/routes.ts", "sha256(await c.req.text())")],
};

export const partyRateLimit = limit({
  prefix: "party:",
  shape: "party:<host key hash or random room ID>",
  purpose: "Limits room creation by the host and activity within each Party room.",
  holds: "digest",
  seconds: 60,
  evidence: [ev("src/anonymo/party/engine.ts", 'ctx.limiter.take(`party:${id}`, 1, max, 60_000)')],
});

export const partyRedis: RedisFamily[] = [
  {
    key: "party:room:<room ID>", purpose: "Shares encrypted live Party state across gateway replicas.",
    holds: "nothing-personal", requestText: "request-and-answer-text",
    ttl: "Two hours from the last successful state change, or immediate deletion on close.",
    evidence: [
      ev("src/anonymo/party/store.ts", 'encrypt(`${this.secret}:party:${id}`, JSON.stringify(room))'),
      ev("src/anonymo/party/store.ts", 'append !== "no"'),
      ev("src/anonymo/party/rules.ts", "ROOM_TTL_MS = 2 * 60 * 60 * 1000"),
    ],
  },
  {
    key: "party:lock:<room ID>", purpose: "Serializes changes and paid turns within a room.", holds: "nothing-personal",
    ttl: "Until the action completes, or three minutes if the replica exits.",
    evidence: [ev("src/anonymo/party/store.ts", 'redis.set(lock, lease, "PX", LEASE_MS, "NX")')],
  },
  {
    key: "party:discord:<interaction digest>", purpose: "Prevents a repeated delivery of a Discord command from running twice.",
    holds: "digest", ttl: "Six minutes, covering the Discord signature acceptance window.",
    evidence: [ev("src/anonymo/party/store.ts", 'redis.set(`party:discord:${digest}`, "1", "EX", REPLAY_SECONDS, "NX")')],
  },
];

export const partyBodyReaders: ExternalDoc["bodyReaders"] = [
  {
    file: "src/anonymo/party/routes.ts", carries: "prompt-or-answer",
    reads: "Party room settings, a host checkpoint when resuming, invite or seat credentials, actions and dice inputs.",
    then: "Authenticates the seat and forwards game turns through normal gateway chat. WebSocket frames carry only the seat token in and change notifications out.",
    kept: "Live state is erased on close or expiry. Only room metadata and dice proofs are durable.",
    evidence: [ev("src/anonymo/party/routes.ts", "parse(actionInput, await readJson(c))"), ev("src/anonymo/party/routes.ts", 'ws.send("changed")')],
  },
  {
    file: "src/anonymo/party/discord.ts", carries: "prompt-or-answer",
    reads: "Signed Discord interactions, including Discord identifiers, a participant region declaration and slash command arguments.",
    then: "Verifies the signature before processing commands. Discord receives the reply and keeps its own messages.",
    kept: "Keyed digests of Discord members and the bound channel live with the room. A replay digest expires after six minutes.",
    evidence: [ev("src/anonymo/party/discord.ts", "new Uint8Array(await c.req.arrayBuffer())"), ev("src/anonymo/party/discord.ts", "claimInteraction(sha256(input.id))")],
  },
];

export const partyMemory: ExternalDoc["otherStores"][number] = {
  id: "party-memory", name: "Live Party rooms",
  purpose: "Gateway memory hosts Party rooms when no Redis instance is configured. A dedicated Redis instance shares state and publishes room-ID change notifications across replicas.",
  holds: "Scene, recent turns, campaign summary, seat digests, dice and current turn art. Host campaign saves live on the device and may sync through encrypted Vault Memory.",
  ttl: "Until the host closes the room or two hours pass without changes. A restart clears the gateway memory store.",
  requestText: "request-and-answer-text",
  evidence: [ev("src/anonymo/party/store.ts", "this.rooms.set(id, { value: structuredClone(room), timer })")],
};

const ADDRESS_NOTE = "The caller's network address is part of the key.";

const everydayRoutesFile = "src/anonymo/everyday/routes.ts";
export const passOrderReader: ExternalDoc["bodyReaders"][number] = {
  file: everydayRoutesFile, carries: "payment-or-signature",
  reads: "Pass product code and the intended wallet address.",
  then: "Creates a random Checkout order reference bound to the authenticated key, product and wallet.",
  kept: "Only the derived order digest, SHA-256 key hash and product.",
  evidence: [ev(everydayRoutesFile, "orderBody.parse(await readJson(c))")],
};
export const stakeLinkReader: ExternalDoc["bodyReaders"][number] = {
  file: everydayRoutesFile, carries: "payment-or-signature",
  reads: "Wallet address and, on confirmation, a signature and expiry.",
  then: "Verifies the wallet signature over a time-limited challenge bound to the authenticated key.",
  kept: "Only the wallet address and SHA-256 key hash. No signature or message is stored.",
  evidence: [ev(everydayRoutesFile, "linkBody.parse(await readJson(c))")],
};
export const memoryCapacityReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/memory-sync/routes.ts", carries: "settings",
  reads: "Blinded daily capacity requests, anonymous capacity proofs on sync writes and item UUID pagination cursors.",
  then: "Issues a day-scoped blind signature based on key eligibility. Verifies the unblinded proof against an anonymous vault credential.",
  kept: "No signatures, blinded requests, pagination state or link between a key and a vault. Daily issuer keys are stored encrypted and replaced in place.",
  evidence: [ev("src/anonymo/memory-sync/routes.ts", "const { after } = z.object({ after: cursor.optional() }).strict().parse(await readJson(c));"),
    ev("src/anonymo/memory-sync/routes.ts", "const token = proof as z.infer<typeof capacity> | undefined;")],
};

const redisFamilies: RedisFamily[] = [
  ...creatorRedisFamilies,
  limit({
    prefix: "creators:write:",
    shape: "creators:write:<operation>:<keyed digest>",
    purpose: "Limits publication, wallet stats and referral writes per workspace key.",
    holds: "digest",
    seconds: 60,
    evidence: [ev("src/anonymo/creators/routes.ts", 'ctx.limiter.take(`creators:write:${operation}:${digest}`, 1, max, 60_000)')],
  }),
  anonymousRateFamily, // HD1
  limit({
    prefix: "pass-order:", shape: "pass-order:<key hash>", holds: "key-hash", seconds: 60,
    purpose: "Limits new pass order references per key.",
    evidence: [ev(everydayRoutesFile, 'ctx.limiter.take(`pass-order:${key.keyHash}`, 1, 12, 60_000)')],
  }),
  limit({
    prefix: "stake-link:", shape: "stake-link:<key hash>", holds: "key-hash", seconds: 60,
    purpose: "Limits wallet linking attempts per key.",
    evidence: [ev(everydayRoutesFile, 'ctx.limiter.take(`stake-link:${key.keyHash}`, 1, 12, 60_000)')],
  }),
  limit({
    prefix: "memory-sync:capacity:", shape: "memory-sync:capacity:<account ID>", holds: "account", seconds: 86_400,
    purpose: "Limits blind Vault Memory capacity grant requests per account.",
    evidence: [ev("src/anonymo/memory-sync/routes.ts", 'ctx.limiter.take(`memory-sync:capacity:${key.accountId}`, 1, 30, 86_400_000)')],
  }),
  limit({
    prefix: "key-safe:",
    shape: "key-safe:<operation>:<minute-scoped address HMAC>",
    purpose: "Limits passkey backup saves, lookups and deletions per caller.",
    holds: "digest",
    seconds: 60,
    evidence: [ev("src/anonymo/keysafe/routes.ts", "await ctx.limiter.take(`key-safe:${operation}:${bucket}`")],
  }),
  limit({
    prefix: "codes:",
    shape: "codes:<redeem or list>:<keyed digest>",
    purpose: "Voucher redemption and reseller batch-list attempts per minute.",
    holds: "digest",
    seconds: 60,
    evidence: [ev("src/anonymo/codes/routes.ts", 'ctx.limiter.take(`codes:${action}:${digest}`, 1, 15, 60_000)')],
  }),
  limit({
    prefix: "lifeboat:check:",
    shape: "lifeboat:check:<minute-scoped address HMAC>",
    purpose: "Limits Lifeboat card checks per caller, so the floor can't be used as a free classifier.",
    holds: "digest",
    seconds: 60,
    evidence: [ev("src/anonymo/lifeboat/routes.ts", "await ctx.limiter.take(`lifeboat:check:${bucket}`")],
  }),
  freeRateLimit,
  telegramRateLimit,
  partyRateLimit,
  ...partyRedis,
  limit({
    prefix: "age-proof:",
    shape: "age-proof:<key hash>",
    purpose: "Age proof submissions per minute for each key.",
    holds: "key-hash",
    seconds: 60,
    evidence: [ev("src/anonymo/region/compliance.ts", "ctx.limiter.take(`age-proof:${key.keyHash}`, 1, 5, 60_000)")],
  }),

  laneReportLimit, // Lane report
  ...facilitatorRedisFamilies, // v6 F
  limit({
    prefix: "memory-sync:grant:",
    shape: "memory-sync:grant:<account ID>",
    purpose: "Limits blinded grant issuance to funded accounts. The counter has no vault ID or grant.",
    holds: "account",
    seconds: 86_400,
    evidence: [ev("src/anonymo/memory-sync/routes.ts", "memory-sync:grant:")],
  }),
  limit({
    prefix: "memory-sync:vault:",
    shape: "memory-sync:vault:<vault ID>",
    purpose: "Limits operations on an enabled memory vault. The counter has no funding key or account.",
    holds: "digest",
    seconds: 60,
    evidence: [ev("src/anonymo/memory-sync/routes.ts", "memory-sync:vault:")],
  }),

  limit({
    prefix: "ip:",
    shape: "ip:<caller address>",
    purpose: `Requests per minute for a call that carries no API key. ${ADDRESS_NOTE}`,
    holds: "address",
    seconds: 60,
    evidence: [ev("src/api/chat.ts", "await limitOrThrow(ctx, `ip:${from.id}`")],
  }),
  limit({
    prefix: "newkey:",
    shape: "newkey:<caller address>",
    purpose: `New API keys per hour. ${ADDRESS_NOTE}`,
    holds: "address",
    seconds: 3600,
    evidence: [ev("src/api/keys.ts", "await ctx.limiter.take(`newkey:${from.id}`")],
  }),
  limit({
    prefix: "dashboard-signup:",
    shape: "dashboard-signup:<hourly caller-address digest>",
    purpose: "Limits new dashboard key signups per hour. The counter uses a SHA-256 digest of the caller address and UTC hour.",
    holds: "digest",
    seconds: 3600,
    evidence: [ev("src/anonymo/keys/routes.ts", "const bucket = sha256("), ev("src/anonymo/keys/routes.ts", "await ctx.limiter.take(`dashboard-signup:${bucket}`")],
  }),
  limit({
    prefix: "first-image:",
    shape: "first-image:<hourly caller-address digest>",
    purpose: "Limits sponsored image attempts per caller address per hour. The counter uses a keyed digest of the address bucket and UTC hour.",
    holds: "digest",
    seconds: 3600,
    evidence: [ev("src/anonymo/keys/routes.ts", "const digest = hmac(ctx.cfg.appSecret, `anonymo:first-image:"), ev("src/anonymo/keys/routes.ts", "await ctx.limiter.take(`first-image:${digest}`")],
  }),
  limit({
    prefix: "wallet-login:",
    shape: "wallet-login:<caller address>",
    purpose: `Wallet sign-in challenges per minute. ${ADDRESS_NOTE}`,
    holds: "address",
    seconds: 60,
    evidence: [ev("src/api/keys.ts", "await ctx.limiter.take(`wallet-login:${from.id}`")],
  }),
  limit({
    prefix: "claim-issue-ip:",
    shape: "claim-issue-ip:<caller address>",
    purpose: `Creator claim challenges per hour. ${ADDRESS_NOTE}`,
    holds: "address",
    seconds: 3600,
    evidence: [ev("src/services/creators.ts", "await ctx.limiter.take(`claim-issue-ip:${from.id}`")],
  }),
  limit({
    prefix: "claim-verify-ip:",
    shape: "claim-verify-ip:<caller address>",
    purpose: `Creator claim verifications per hour. ${ADDRESS_NOTE}`,
    holds: "address",
    seconds: 3600,
    evidence: [ev("src/services/creators.ts", "await ctx.limiter.take(`claim-verify-ip:${from.id}`")],
  }),
  limit({
    prefix: "k:",
    shape: "k:<key hash>",
    purpose: "Requests per minute for one API key. Keyed by the SHA-256 of the key; no address is read for a call that carries a key.",
    holds: "key-hash",
    seconds: 60,
    evidence: [ev("src/api/chat.ts", "await limitOrThrow(ctx, `k:${key.keyHash}`")],
  }),
  limit({
    prefix: "kc:",
    shape: "kc:<key hash>",
    purpose: "Requests per minute for one API key on the Anthropic-compatible endpoint.",
    holds: "key-hash",
    seconds: 60,
    evidence: [ev("src/api/anthropic.ts", "await ctx.limiter.take(`kc:${key.keyHash}`")],
  }),
  limit({
    prefix: "kt:",
    shape: "kt:<key hash>",
    purpose: "Tokens per minute for one API key: a running count of prompt tokens, not their text.",
    holds: "key-hash",
    seconds: 60,
    evidence: [ev("src/api/chat.ts", "await limitOrThrow(ctx, `kt:${billing.key.keyHash}`"), ev("src/api/council.ts", "tk.limitOrThrow(ctx, `kt:${billing.key.keyHash}`")],
  }),
  limit({
    prefix: "provider-applications",
    shape: "provider-applications",
    purpose: "Provider applications per minute, counted across all callers in one key. There is no per-caller part.",
    holds: "nothing-personal",
    seconds: 60,
    evidence: [ev("src/providers/application.ts", 'await ctx.limiter.take("provider-applications"')],
  }),
  limit({
    prefix: "claim:",
    shape: "claim:<model id>",
    purpose: "Creator claims per hour for one model.",
    holds: "model",
    seconds: 3600,
    evidence: [ev("src/api/public.ts", "await ctx.limiter.take(`claim:${v.model}`")],
  }),
  limit({
    prefix: "claim-issue:",
    shape: "claim-issue:<model id>",
    purpose: "Claim challenges per hour for one model.",
    holds: "model",
    seconds: 3600,
    evidence: [ev("src/services/creators.ts", "await ctx.limiter.take(`claim-issue:${modelId}`")],
  }),
  limit({
    prefix: "claim-verify:",
    shape: "claim-verify:<claim id>",
    purpose: "Claim verifications per hour for one claim.",
    holds: "nothing-personal",
    seconds: 3600,
    evidence: [ev("src/services/creators.ts", "await ctx.limiter.take(`claim-verify:${id}`")],
  }),
  limit({
    prefix: "readiness",
    shape: "readiness",
    purpose: "The readiness probe checks the limiter works by taking zero from a fixed key.",
    holds: "nothing-personal",
    seconds: 60,
    evidence: [ev("src/services/readiness.ts", 'ctx.limiter.take("readiness", 0, 1, 60_000)')],
  }),
  {
    key: "cache:<sha256>",
    purpose:
      "The opt-in response cache (a request that sends cache.mode or the X-Anonymo-Cache header). It holds the answer to a request, so for as long as it lives this is a place answer text is kept: sealed with AES-256-GCM under a key derived from the router's APP_SECRET and the caller's own scope, so only that caller's identical request can read it back. The Redis key is a SHA-256 of the scope and the request, not the request.",
    holds: "digest",
    requestText: "answer-text",
    ttl: "It is kept for the time-to-live the request asked for in cache.ttl: at most CACHE_TTL_S, which is 3,600 seconds unless the operator changed it, and also the default when the request names none.",
    evidence: [
      ev("src/gateway/cache.ts", "await this.redis.set(`cache:${key}`, JSON.stringify({ payload, upstream: upstream.toString() }), \"PX\", ttlS * 1000);"),
      ev("src/gateway/cache.ts", "const payload = this.seal(scope, response);"),
      ev("src/api/chat.ts", "validateCacheTtl(body, ctx.cfg.gateway.cacheTtlS);"),
      ev("src/api/chat.ts", "!moderatedOnly && !strict && !resolved", "Never used for a call with a disclosure ceiling, a restricted model variant or a stream."),
      ev("src/api/chat.ts", "const cacheMode: CacheMode | null = !publication && !ctx.cfg.features.compliance && !ctx.cfg.features.passes && !ctx.cfg.features.stake && !telegramSession && !moderatedOnly", "Disabled for published-character chats, with region compliance, passes or staking on, in Telegram chat sessions, and with a disclosure ceiling, a restricted model variant or a stream."),
    ],
  },
  {
    key: "walletauth:<sha256>",
    purpose: "Replay protection for wallet-signed requests: a marker that a signature was already used. The key is a SHA-256 of the wallet address, the timestamp and the request's hash.",
    holds: "wallet",
    ttl: "600 seconds",
    evidence: [ev("src/api/auth.ts", "`walletauth:${id}`, \"1\", \"PX\", 600_000, \"NX\"")],
  },
  {
    key: "batch:<batch id>:in and batch:<batch id>:out",
    purpose:
      "The Batch API (POST /api/v1/batches). The input hash holds one field per request and, only for a key with an IP allowlist, the submitting address for that check. The output hash holds one field per result. Each value is sealed with AES-256-GCM under a key derived from the router's APP_SECRET, the batch id and the hash of the key that sent it. The worker reads them from this store.",
    holds: "address",
    requestText: "request-and-answer-text",
    ttl: "The sealed requests are deleted when the batch finishes; the sealed answers BATCH_RESULTS_TTL after that (86,400 seconds, 24 hours, unless the operator changed it). A batch that never finishes ends when its 24-hour completion window closes, so nothing outlives the window plus that time.",
    evidence: [
      ev("src/services/batches.ts", "await this.hset(`batch:${b.id}:in`, entries, ttlMs);"),
      ev("src/services/batches.ts", "private seal = (b: Pick<BatchRow, \"id\" | \"keyHash\">, v: unknown) => encrypt(this.scope(b), JSON.stringify(v));"),
      ev("src/services/batches.ts", "await this.del(`batch:${b.id}:in`);"),
      ev("src/services/batches.ts", "await batchStore(ctx).purge(b);"),
    ],
  },
  {
    key: "bull:anonymo-jobs-<group>:*",
    purpose: "The background job queue (BullMQ) that makes exactly one replica run each recurring job. The job data is empty ({}), so no request or user data is in it; a finished job's result or failure message is kept for the last 100 completed and 100 failed jobs.",
    holds: "nothing-personal",
    ttl: "Recurring job schedules stay while the router runs; only the most recent 100 completed and 100 failed jobs are kept.",
    evidence: [ev("src/services/jobs.ts", "removeOnComplete: 100, removeOnFail: 100"), ev("src/services/jobs.ts", "upsertJobScheduler(j.name, { every: j.everyMs }, { name: j.name")],
  },
  x402RecoveryFamily,
];

export const lifeboatAddressReader: Touchpoint = {
  file: "src/anonymo/lifeboat/routes.ts",
  reads: "The caller's address for the card check rate limit.",
  then: "Counts card checks using a short-lived, keyed digest of the address.",
  kept: "Only a minute-scoped HMAC digest in the rate limiter.",
  evidence: [{ file: "src/anonymo/lifeboat/routes.ts", contains: "const bucket = createHmac" }],
};

export const voiceAddressReaders: ExternalDoc["addressReaders"] = [
  {
    file: "src/anonymo/voice/routes.ts",
    reads: "The caller's address when the key has a network allowlist.",
    then: "Checked before inference and passed in process to the ordinary chat and media policy checks.",
    kept: "Only in transient request and call state for that allowlist check.",
    evidence: [ev("src/anonymo/voice/routes.ts", "row?.ipAllow?.length ? clientIp(c, ctx.cfg.trustProxy)"), ev("src/anonymo/voice/routes.ts", "requestIP: () => address ? { address } : null")],
  },
  {
    file: "src/anonymo/voice/socket.ts",
    reads: "The Bun socket address as needed by the existing ingress and network policy checks during upgrade.",
    then: "Supplied to middleware through the original upgrade request.",
    kept: "Subject to the same ingress and anonymous read limits as the other gateway routes.",
    evidence: [ev("src/anonymo/voice/socket.ts", "requestIP: () => server.requestIP(request)")],
  },
];

export const voiceBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/voice/routes.ts",
  carries: "prompt-or-answer",
  reads: "Text voice traits and a save label, or a live WebSocket control and 20 ms PCM microphone frames.",
  then: "Text traits go to the design worker for an embedding. The voice reference check compares that vector with stock embeddings. During calls, speech segments go only to transcription. Transcripts and eligible replies go through the regular chat floor and refusal pipeline. Only checked text is sent for synthesis.",
  kept: "Only live call state, settlement metadata and hashes, and the name and embedding of a voice the caller elects to save. The gateway skips customer trace export for Mo Voice turns.",
  evidence: [
    ev("src/anonymo/voice/routes.ts", "schema.safeParse(await readJson(c))"),
    ev("src/anonymo/voice/routes.ts", "session.mic(data);"),
    ev("src/anonymo/voice/session.ts", "this.upstreams.transcribe(micWav(frames), samples, signal)"),
    ev("src/api/chat.ts", "privateRoute }) && !isVoiceDispatch(p.c)"),
    ev("src/anonymo/voice/routes.ts", "values({ id, keyHash, name, embedding: preview.embedding })"),
  ],
};

export const voiceStore: ExternalDoc["otherStores"][number] = {
  id: "mo-voice-live",
  name: "Mo Voice call state",
  purpose: "Short-lived connection tickets, live audio and conversation context, and the candidate embedding until the caller saves or replaces it.",
  holds: "Process memory only. Audio and conversation text are discarded when the call ends. Hangup sends signed counts and route metadata to the caller.",
  ttl: "Unused tickets expire after 30 seconds. A call lasts up to 15 minutes. An unsaved candidate embedding expires after 5 minutes.",
  requestText: "request-and-answer-text",
  evidence: [ev("src/anonymo/voice/socket.ts", "const TTL_MS = 30_000;"), ev("src/anonymo/voice/routes.ts", "const PREVIEW_TTL = 5 * 60_000;"), ev("src/anonymo/voice/routes.ts", "const CALL_TTL = 15 * 60_000;")],
};

const addressReaders: Touchpoint[] = [
  ...voiceAddressReaders,
  keySafeAddressReader,
  codesAddressReader,
  lifeboatAddressReader, // Everyday 23
  freeAddressReader,
  {
    file: "src/anonymo/askmo/routes.ts",
    reads: "When Ask Mo is enabled, the caller address from the shared ingress helper for keys with an IP allowlist.",
    then: "Compared in memory with that key's allowlist before an Ask Mo or Second Opinion call.",
    kept: "The check retains no address and sends none to the search provider.",
    evidence: [ev("src/anonymo/askmo/routes.ts", "policy?.ipAllow?.length ? clientIp")],
  },
  anonymoMoneyAddressReader, // WS05: an Anonymo key's IP allowlist
  ...hardeningAddresses, // HD1
  facilitatorAddressReader, // v6 F
  {
    file: "src/api/batches.ts",
    reads: "The submitting caller's address from the shared ingress helper; kept only when the key has an IP allowlist.",
    then: "Checked against the key's allowlist at submission and again when each line runs.",
    kept: "Encrypted with the batch inputs in Redis or worker memory until the inputs are deleted.",
    evidence: [ev("src/api/batches.ts", "clientIp(c, ctx.cfg.trustProxy)"), ev("src/services/batches.ts", 'entries.push(["submitter_ip", this.seal(b, submitterIp)]);')],
  },
  {
    file: "src/anonymo/keys/routes.ts",
    reads: "The caller address selected by the ingress helper for dashboard signups, sponsored image requests and key IP-allowlist checks.",
    then: "Each limiter uses its own hourly address digest. The image limiter uses HMAC. The key policy check compares the address in memory with the current IP allowlist.",
    kept: "Each limiter retains its digest and counter for one hour plus one second. The allowlist check retains no caller address.",
    evidence: [ev("src/anonymo/keys/routes.ts", "const from = addressBucket(c, ctx.cfg);"), ev("src/anonymo/keys/routes.ts", "const callerIp = clientIp(c, ctx.cfg.trustProxy);")],
  },

  {
    file: "src/api/common.ts",
    reads: "The selected client address from the shared ingress helper: socket by default, the trusted hop counted from the right when TRUST_PROXY is on, or CF-Connecting-IP when the enabled origin lock secret is valid.",
    then: "Returned to a caller as the key of a per-address rate limit (addressBucket).",
    kept: "The rate-limit keys expire within an hour. With region compliance enabled they use a keyed digest of the address.",
    evidence: [ev("src/api/common.ts", "export function clientIp(c: Context, trustProxy = false)"), ev("src/api/common.ts", "cfg.features.compliance ? hmac(cfg.appSecret, `address-limit:${ip}`) : ip")],
  },
  {
    file: "src/api/chat.ts",
    reads: "The caller's address, only for a call that carries no API key.",
    then: "Counted against ip:<address>.",
    kept: "Only as the Redis rate-limit key.",
    evidence: [ev("src/api/chat.ts", "const from = addressBucket(c, ctx.cfg);")],
  },
  {
    file: "src/api/keys.ts",
    reads: "The caller's address when a key is created and when a wallet sign-in challenge is requested.",
    then: "Counted against newkey:<address> and wallet-login:<address>.",
    kept: "Only as the Redis rate-limit keys.",
    evidence: [ev("src/api/keys.ts", "await ctx.limiter.take(`newkey:${from.id}`"), ev("src/api/keys.ts", "await ctx.limiter.take(`wallet-login:${from.id}`")],
  },
  {
    file: "src/api/creator-claims.ts",
    reads: "The caller's address when a creator claim is issued or verified.",
    then: "Handed to services/creators.ts as an address bucket.",
    kept: "Only as the Redis rate-limit keys.",
    evidence: [ev("src/api/creator-claims.ts", "addressBucket(c, ctx.cfg)")],
  },
  {
    file: "src/services/creators.ts",
    reads: "The address bucket it was given.",
    then: "Counted against claim-issue-ip:<address> and claim-verify-ip:<address>.",
    kept: "Only as the Redis rate-limit keys.",
    evidence: [ev("src/services/creators.ts", "await ctx.limiter.take(`claim-issue-ip:${from.id}`")],
  },
  {
    file: "src/api/responses.ts",
    reads: "The caller's address, so the internal chat call it makes on the caller's behalf is limited exactly as the caller's own call would be.",
    then: "Passed to the chat route as an in-process value (requestIP) and then handled as in src/api/chat.ts.",
    kept: "Nothing beyond what src/api/chat.ts keeps.",
    evidence: [ev("src/api/responses.ts", "const from = clientIp(c, ctx.cfg.trustProxy);"), ev("src/api/responses.ts", "{ requestIP: () => ({ address: from }) }")],
  },

  {
    file: "sidecar/src/headers.ts",
    reads: "The model-server sidecar inside a provider's enclave forwards only allow-listed headers, so a proxy header cannot carry a client address to the model server.",
    then: "Forwarded by allow-list, not deny-list; a header that names a network address is refused even in configuration.",
    kept: "Not applicable.",
    evidence: [ev("sidecar/src/headers.ts", "Requests are forwarded by allow-list, not by deny-list")],
  },
];

export const lifeboatBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/lifeboat/routes.ts",
  carries: "prompt-or-answer",
  reads: "Card text, including greetings and lorebook entries, for a pre-import safety check.",
  then: "Checks the text with the configured floor classifiers and returns a verdict. The check needs no key and creates no charge.",
  kept: "No card text. A blocked card leaves the same minimal floor hit record as chat (hash, length, category, in memory unless reported). Each configured guard provider's own retention applies.",
  evidence: [ev("src/anonymo/lifeboat/routes.ts", "await c.req.json()"), ev("src/anonymo/lifeboat/routes.ts", "ctx.anonymo.floor.check(")],
};


export const studioBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/media/routes.ts",
  carries: "prompt-or-answer",
  reads: "Studio uses the existing visual media requests, including the prompt and the image supplied for an edit.",
  then: "After the text floor passes, the Studio person classifier sees edit uploads. ShieldGemma 2 and LlavaGuard see visual outputs before they can be delivered or billed. Classifier requests carry media bytes only.",
  kept: "Classifier verdicts are returned in signed receipts. A blocked or unscored video job keeps fixed verdict codes in its existing error field. Successful video verdicts expire with the video in memory.",
  evidence: [
    ev("src/anonymo/media/routes.ts", "s.studio.upload(input.upload, c.req.raw.signal)"),
    ev("src/anonymo/media/routes.ts", "s.studio.output({ bytes: stripped(out), mime: out.mime }, o.signal)"),
    ev("src/anonymo/media/studio.ts", "body: media.bytes,"),
    ev("src/anonymo/media/routes.ts", "[type, e.reason, verdicts.shieldgemma2, verdicts.llavaguard]"),
  ],
};

const bodyReaders: ExternalDoc["bodyReaders"] = [
  voiceBodyReader,
  ...partyBodyReaders,
  keySafeBodyReader,
  codesBodyReader,
  telegramBodyReader,
  passOrderReader,
  stakeLinkReader,
  memoryCapacityReader,
  {
    file: "src/anonymo/askmo/routes.ts",
    carries: "prompt-or-answer",
    reads: "When Ask Mo is enabled, the question and optional topic in the request body.",
    then: "The floor checks the prompt before search or model dispatch. Ask Mo supplies a bounded search query with recognizable identifiers stripped. No caller headers or key are sent to the search service. Search results go to the chat model as numbered sources. Second Opinion sends the question through the council, where the judge compares the proposals that answered.",
    kept: "The question, results, answer and comparison stay in gateway memory for the call. The gateway records receipt metadata and exchange hashes. Ask Mo skips the response cache and customer trace export. Search services receive the query under their own data policies.",
    evidence: [
      ev("src/anonymo/askmo/routes.ts", "const { question, topic = null } = await readJson(c);"),
      ev("src/api/chat.ts", "webSearch.query = askMoQuery(askMoAnswer.question);"),
      ev("src/api/chat.ts", "if (!p.meta.askMo && !publication && !p.meta.party && billing.key?.tracing"),
      ev("src/api/chat.ts", "if (!p.meta.askMo && !publication && !p.meta.party && billing.key?.tracing"),
      ev("src/api/council.ts", "comparison = choice?.comparison;"),
    ],
  },
  {
    file: "src/anonymo/region/compliance.ts",
    carries: "payment-or-signature",
    reads: "An opaque proof of age submitted to POST /v1/compliance/age-proof.",
    then: "Verifies the over-18 claim against the authenticated key.",
    kept: "A 32-byte proof nullifier, the key hash and the verification time.",
    evidence: [ev("src/anonymo/region/compliance.ts", "verifier.verify(proof, key.keyHash)")],
  },
  ...anonymoMoneyBodyReaders, // WS05
  mediaBodyReader, // WS06 media
  studioBodyReader,
  transcriptionBodyReader,
  ventureBodyReader, // WS11 Ventures
  lifeboatBodyReader,
  creatorBodyReader,
  {
    file: "src/anonymo/memory-sync/routes.ts",
    carries: "settings",
    reads: "A blinded grant request, an unblinded grant, or bounded encrypted Vault Memory records.",
    then: "A funded-key request signs a blinded grant. A separate request validates the grant and enables an anonymous vault credential. Sync accepts that credential.",
    kept: "The vault's credential verifier, item UUIDs, versions, ciphertext and tombstones. Grants and funding key associations are never stored.",
    evidence: [ev("src/anonymo/memory-sync/routes.ts", "parse(await readJson(c))")],
  },
  modelAlternativesReader, // B121
  abuseBodyReader, // Anonymo WS02: takedown inbox
  refusalSettingReader, // Anonymo WS03
  {
    // GHSA-rch8-pxr3-p8gc: the floor's guards are hosted outside any enclave, so they read public-lane text only.
    file: "src/anonymo/floor/gate.ts",
    carries: "prompt-or-answer",
    reads: "On the public lane only: the request's text, and the reply's text, sent to the floor's guard model (ANONYMO_FLOOR_URL, its fallback) and the optional Llama Guard / OpenAI moderation checks. Sealed, attested-lane and `:private` requests are refused before this check while no in-enclave floor exists, so their text is never sent.",
    then: "The guard answers a category or nothing; a blocked request or reply is refused (451) and never served, charged or rerouted.",
    kept: "Nothing: the text is not written to Postgres, Redis or a log. Each guard provider's own retention applies to what it is sent.",
    evidence: [ev("src/anonymo/floor/gate.ts", "c.classify(input.text, signal)"), ev("src/anonymo/floor/confidential.ts", "refuseConfidentialOutsideEnclave")],
  },
  ...hardeningBodies, // HD1
 // V98
  provisioningBodyReader, inferenceModelReader, // ZK6
  structuredOutputReader, // V83
  webhookBodyReader, // V86.
  facilitatorBodyReader, // v6 F
  x402RecoveryReader, // U115

  {
    file: "src/api/chat.ts",
    carries: "prompt-or-answer",
    reads: "The whole JSON body of a chat or text completion: the messages, the model and the parameters (readJson).",
    then: "Read in memory to route the call on every lane: validated, checked against guardrails, priced, then sent to the provider chosen. The request is hashed (request_sha256) and the answer is hashed (response_sha256). Streaming answers are passed through chunk by chunk. Unless the refusal catch is off, the last user turn and the first ~160 tokens of the answer are read by the refusal classifier: in process on the attested and private lanes, otherwise also by the operator's classifier endpoint (ANONYMO_REFUSAL_URL) when one is configured; the classifier keeps nothing.",
    kept: "Not stored. Kept in memory for the length of the call. The opt-in response cache and batch content are kept sealed outside the database (see the Redis section), and a failed provider attempt can keep up to 200 characters of that provider's own error message.",
    evidence: [ev("src/api/chat.ts", "} : await readJson(c);"), ev("src/api/chat.ts", "const bodySha = requestHash(body);"), ev("src/api/chat.ts", "response_sha256: sha256(p.responseText),"), ev("src/api/chat.ts", "const local = disc.lane !== \"public\" || requiresAttestedUpstream(body, disc as DisclosureRequest);")],
  },
  {
    file: "src/api/batches.ts",
    carries: "prompt-or-answer",
    reads: "The JSON body of a batch: up to BATCH_MAX_LINES chat or embeddings requests (requests or input_jsonl).",
    then: "Checked line by line, then sealed at once and kept in Redis (or memory) for the worker, which runs each line through the chat or embeddings handler as the key that sent the batch.",
    kept: "Not in the database: the database gets counts, statuses, costs and generation ids. The sealed requests are deleted when the batch finishes and the sealed answers when its results expire (see the Redis section).",
    evidence: [ev("src/api/batches.ts", "const body = await readJson(c);"), ev("src/services/batches.ts", "await batchStore(ctx).saveInputs(row, lines, storeTtl(ctx, row), Array.isArray(ipAllow) && ipAllow.length ? submitterIp : null);")],
  },
  {
    file: "src/api/anthropic.ts",
    carries: "prompt-or-answer",
    reads: "The JSON body of an Anthropic-format messages or count_tokens call. The router reads code, prompts and tools in memory.",
    then: "Converted to a chat request and sent through the router's own chat route, so it is handled and kept exactly as a chat call is.",
    kept: "Nothing beyond what src/api/chat.ts keeps; token counts alone create no payment or request record.",
    evidence: [ev("src/api/anthropic.ts", "const raw = await readJson(c);")],
  },
  {
    file: "src/api/responses.ts",
    carries: "prompt-or-answer",
    reads: "The JSON body of a Responses-format call.",
    then: "Converted to a chat request and sent through the router's own chat route.",
    kept: "Nothing beyond what src/api/chat.ts keeps.",
    evidence: [ev("src/api/responses.ts", "chatRequestFrom(await readJson(c))")],
  },
  {
    file: "src/api/mcp.ts",
    carries: "prompt-or-answer",
    reads: "The JSON-RPC body of a tool call for the MCP endpoint, which can include a prompt.",
    then: "Chat is forwarded to the router's own chat route; the other tools read the model list and receipts.",
    kept: "Nothing beyond what src/api/chat.ts keeps.",
    evidence: [ev("src/api/mcp.ts", "msg = JSON.parse(await c.req.text())")],
  },
  {
    file: "src/gateway/cache.ts",
    carries: "prompt-or-answer",
    reads: "The request and the answer, only when the caller opted in.",
    then: "Encrypted and stored with a time-to-live (memory and, when configured, Redis). A hit is served without asking a provider.",
    kept: "The sealed answer, for the time-to-live the caller asked for (at most CACHE_TTL_S). A semantic cache also keeps, in memory only, a 1,024-number hashed word vector of the prompt so near-duplicates can match.",
    evidence: [ev("src/gateway/cache.ts", "Never written to Postgres: entries live in memory (or Redis with a TTL)"), ev("src/gateway/cache.ts", "vector: mode === \"semantic\" ? lexicalVector(textOf(body)) : undefined,")],
  },
  {
    file: "src/api/common.ts",
    carries: "settings",
    reads: "The shared JSON body reader used by the routes below: it reads the text, checks its size (16 MB at most) and parses it.",
    then: "Returned to the route.",
    kept: "Nothing.",
    evidence: [ev("src/api/common.ts", "const text = await c.req.text();")],
  },
  {
    file: "src/api/keys.ts",
    carries: "settings",
    reads: "Key settings (name, budget, limits, allowed models, tracing destination, scope, include_byok_in_limit and the auto top-up amounts), amounts, BYOK provider keys, team roles and wallet sign-in challenges.",
    then: "Validated and written to the keys, byok_keys, teams and kv tables as described above.",
    kept: "The settings and, for a BYOK key or a tracing destination, the key or the destination URL and credentials encrypted under APP_SECRET.",
    evidence: [ev("src/api/keys.ts", "const spec = keySpec.parse(await readJson(c));")],
  },
  {
    file: "src/api/saved-routes.ts",
    carries: "settings",
    reads: "A saved route: fallback models, provider preferences and sampling controls.",
    then: "Validated against a strict schema with no field for message text, then stored.",
    kept: "The route in saved_routes.",
    evidence: [ev("src/api/saved-routes.ts", "routeCreateSchema.parse(await readJson(c))")],
  },
  {
    file: "src/api/presets.ts",
    carries: "settings",
    reads: "A preset: fallback models, provider preferences, sampling controls and the owner's own system prompt, response_format and tool definitions.",
    then: "Validated against a strict schema with size caps, then stored as a new version.",
    kept: "The preset's versions in preset_versions.",
    evidence: [ev("src/api/presets.ts", "presetDocSchema.parse(await readJson(c))")],
  },
  {
    file: "src/api/characters.ts",
    carries: "prompt-or-answer",
    reads:
      "A character card (JSON or PNG) or, for a private card, only its ciphertext and hash; and on POST /api/v1/characters/:id/chat a chat request with the conversation, the memory the client decrypted and, for a private card, the decrypted card.",
    then: "A public or unlisted card is normalized and stored. A chat is assembled into a prompt in memory and sent through the chat route (src/api/chat.ts), like any other call; a private card sent with it is checked against its stored hash and used for that call only.",
    kept: "Public and unlisted cards in characters; for a private card only the ciphertext and hash. Nothing of a chat, its memory or a decrypted private card; public characters add one to a daily call and cost counter (character_usage).",
    evidence: [ev("src/api/characters.ts", "const v = bodySchema.parse(await readJson(c));"), ev("src/characters/registry.ts", "for (const k of EXTRA_FIELDS) delete body[k]; // never forwarded to a provider")],
  },
  {
    file: "src/api/memory.ts",
    carries: "settings",
    reads: "A memory blob the client sealed (ciphertext), its opaque scope, kind and key fingerprint, and an embedding vector only when the client opts in.",
    then: "Checked to be in sealed form (plaintext is refused), then stored.",
    kept: "The ciphertext and its labels in character_memory, and the vector when the client opted in.",
    evidence: [ev("src/api/memory.ts", "plaintext is refused")],
  },
  {
    file: "src/api/spend.ts",
    carries: "settings",
    reads: "A spend alert rule.",
    then: "Validated and stored.",
    kept: "The rule in spend_alerts.",
    evidence: [ev("src/api/spend.ts", "createBody.parse(await readJson(c))")],
  },
  {
    file: "src/api/agent-sessions.ts",
    carries: "settings",
    reads: "An agent session: name, budget, lifetime and labels.",
    then: "Validated and stored.",
    kept: "The session in agent_sessions.",
    evidence: [ev("src/api/agent-sessions.ts", "createSession(ctx, caller, await readJson(c))")],
  },
  {
    file: "src/api/lane.ts",
    carries: "settings",
    reads: "An operator's description of a model for the model lane: variant, status, licence and weights source.",
    then: "Checked for an operator token, validated and stored.",
    kept: "models_lane.",
    evidence: [ev("src/api/lane.ts", "laneInput.parse(await readJson(c))")],
  },
  {
    file: "src/api/status.ts",
    carries: "settings",
    reads: "An operator's incident notice for the status page: title, affected lanes and surfaces, impact, status and update text.",
    then: "Checked for an operator token, validated against a strict schema with size caps and stored.",
    kept: "status_incidents.",
    evidence: [ev("src/api/status.ts", "createSchema.parse(await readJson(c))"), ev("src/api/status.ts", "updateSchema.parse(await readJson(c))")],
  },
  {
    file: "src/api/disclosure.ts",
    carries: "settings",
    reads: "A provider disclosure profile written by an operator.",
    then: "Validated and stored.",
    kept: "provider_disclosure.",
    evidence: [ev("src/api/disclosure.ts", "disclosureInput.parse(await readJson(c))")],
  },
  {
    file: "src/api/dayzero.ts",
    carries: "settings",
    reads: "An operator's request to evaluate or approve a day-zero candidate.",
    then: "Validated and stored.",
    kept: "The lane tables.",
    evidence: [ev("src/api/dayzero.ts", "parse(await readJson(c))")],
  },
  {
    file: "src/api/creator-claims.ts",
    carries: "settings",
    reads: "A creator claim: model, wallet address and Hugging Face handle.",
    then: "Validated and stored.",
    kept: "lane_claims.",
    evidence: [ev("src/api/creator-claims.ts", "parse(await readJson(c))")],
  },
  {
    file: "src/api/public.ts",
    carries: "payment-or-signature",
    reads: "Receipt verification requests, provider applications and creator claim challenges.",
    then: "Verified and, for a provider application, stored.",
    kept: "The provider tables described above.",
    evidence: [ev("src/api/public.ts", "const raw = await readJson(c);")],
  },
];

const noLog = (item: string, file: string, contains: string): { item: string; evidence: Evidence[] } => ({ item, evidence: [ev(file, contains)] });

export const EXTERNAL: ExternalDoc = {
  redis: {
    summary:
      "Redis holds rate-limit counters, the opt-in response cache, the sealed answers of x402 calls kept 24 hours for payment recovery, replay markers and the job queue. It is optional in development and required in production. Every key expires; the rate-limit keys below are the only place a caller's network address is used, and only for calls without an API key.",
    families: redisFamilies,
    memoryFallback: {
      purpose: "Without Redis (development) the same rate-limit counters live in the router process's memory and are removed once their window started more than five minutes ago (checked every minute). Nothing is written to disk.",
      ttl: "About five minutes after the window started.",
      evidence: [ev("src/lib/ratelimit.ts", "const cutoff = Date.now() - 5 * 60_000;"), ev("src/config.ts", "Production requires authenticated Redis.")],
    },
  },
  logs: {
    summary:
      "The router writes one JSON line per event to standard output (standard error for warnings and errors). A line is a time, a level, a fixed message and a few fields chosen at each call site. No call site writes a request or response body, a header, a client address, a query string or a prompt.",
    format: "JSON lines: { t, level, msg, ...fields }.",
    records: [
      "The time, the level and a message written in the code.",
      "Anonymous limiter failure: fixed warning that a request was allowed; no exception, address, header, key or body.",
      "Host slash dry-run intent: provider id, evidence commitment root, proposeSlash function name, whole-bond USDG amount, numeric contract reason, contract and chain id, bytes32 host id and delist flag. Logged once per evidence root; no signed bytes, key, raw quote or receipt envelope.",
      "Sanctions refresh counts (distinct EVM entries, ignored formats and digital currency entries), publication date and source hash; screening skip/refusal reasons and provider ids. Freshness exceptions for previously paid addresses and refresh failures use fixed reason codes. No payout wallet or identity fields are added to these logs.",
      "Identifiers and counts: provider ids, model ids, job names, hold and generation ids, epochs, block numbers, transaction hashes, hashed key ids and, on rare settlement and escrow events, an account id.",
      "Wallet addresses of payers on pay-per-call events (public on chain).",
      "For an unhandled error: the path of the request without its query string, the error message and the first five lines of the stack.",
      "Error messages from libraries and upstream services, each cut to 200 characters where a call site truncates them. Configured private chain RPC URLs, including paths and queries on the same host, are redacted before log emission; chain transport failures are redacted before callers truncate them.",
    ],
    neverRecords: [
      noLog("Client network addresses. No log call passes one; addresses are used for rate limits and direct private-network ingress checks.", "src/api/common.ts", "const ip = clientIp(c, cfg.trustProxy);"),
      noLog("Request or response bodies and prompts. The unhandled-error line takes the path and the error, not the body.", "src/app.ts", "log.error(\"unhandled error\", { path: new URL(c.req.url).pathname"),
      noLog("Request headers, cookies and API keys. The unhandled-error line takes the path and the error only.", "src/app.ts", "log.error(\"unhandled error\", { path: new URL(c.req.url).pathname"),
      noLog("Query strings: only the pathname of a failing request is logged.", "src/app.ts", "new URL(c.req.url).pathname"),
    ],
    caveats: [
      "The text of an unexpected exception is logged as the library wrote it (src/app.ts unhandled error, src/lib/process-guard.ts uncaught exception, job failures). No code path puts request text into an error message on purpose, but only configured private chain RPC URLs are filtered, and a library error could quote a fragment of what it was parsing.",
      "The hosting platform's own network layer sees connection addresses and may keep its own access logs. This inventory covers what the router's code records; it cannot describe the platform's logs.",
    ],
    retention: "The router does not rotate or store its logs: it writes them to standard output and the hosting platform keeps them under its own retention. No log retention is set in this repository.",
    evidence: [ev("src/lib/util.ts", "(level === \"error\" || level === \"warn\" ? console.error : console.log)(line);"), ev("src/lib/util.ts", "const line = JSON.stringify(redactRpcFields({ t: new Date().toISOString(), level, msg, ...fields })")],
  },
  otherStores: [
    voiceStore,
    partyMemory,
    ...rushStores, // ON3
    ...webhookStores, // V86.
    ...activityStores,
    ...statementStores, // V87
    ...laneReportStores, // Lane report
    ...insightsStores, // V88: spend insights.
    ...ventureStores, // WS11 Ventures artifact store

    {
      id: "batch-memory",
      name: "Batch requests and answers in the router's memory, without Redis",
      purpose: "Without Redis (a single router in development), the Batch API keeps the same sealed requests and answers in the router process's memory instead.",
      holds: "The same sealed address, requests and answers as the Redis keys batch:<batch id>:in and :out.",
      ttl: "The sealed requests are deleted when the batch finishes; the sealed answers BATCH_RESULTS_TTL after that (86,400 seconds, 24 hours, unless the operator changed it). A batch that never finishes ends when its 24-hour completion window closes, so nothing outlives the window plus that time. A restart loses them.",
      requestText: "request-and-answer-text",
      evidence: [ev("src/services/batches.ts", "private mem = new Map<string, { fields: Map<string, string>; expires: number }>();")],
    },
    {
      id: "response-cache-memory",
      name: "Response cache in the router's memory",
      purpose: "The opt-in response cache also keeps each entry in the router process's memory (up to 5,000 entries), whether or not Redis is configured.",
      holds: "The same sealed answer as the Redis entry, and for the semantic mode a hashed word vector of the prompt.",
      ttl: "An entry is not served after its time-to-live, but it stays in memory until newer entries push it out (oldest first, at 5,000) or the process restarts.",
      requestText: "answer-text",
      evidence: [ev("src/gateway/cache.ts", "constructor(private secret: string, private maxEntries = 5_000"), ev("src/app.ts", "cache: new ResponseCache(cfg.appSecret, 5_000, redis)")],
    },
    {
      id: "replay-memory",
      name: "Replay guards in memory",
      purpose: "A small in-memory set stops replays of a used wallet signature when Redis is not configured.",
      holds: "SHA-256 digests of a wallet address, timestamp and request hash. Not the request.",
      ttl: "Ten minutes (old entries are swept once the set passes 50,000).",
      requestText: "hashes",
      evidence: [ev("src/api/auth.ts", "const seen = new Map<string, number>();")],
    },
    {
      id: "private-lane-counters",
      name: "Private-lane counters in memory",
      purpose: "Differentially private hourly counters for the attested and unlinkable lanes: how many requests, how many were refused and why, latency and token buckets. They contain no request, no address, no key and no timestamp finer than an hour.",
      holds: "Four families of counts for the current hour, released once with noise when the hour ends; the raw counts are then discarded.",
      ttl: "Released hours are kept for 48 hours; the privacy-budget ledger for 30 days.",
      requestText: "none",
      evidence: [ev("src/lib/dpstats.ts", "What it keeps: four families of counters for the current hour, and nothing else."), ev("src/services/private-stats.ts", "The router still keeps its per-request rows for billing", "The private lanes still leave the per-request rows described under Postgres; only the published aggregates are noisy.")],
    },
    {
      id: "telemetry",
      name: "Trace export (OpenTelemetry), off unless an endpoint is set",
      purpose: "When OTEL_EXPORTER_OTLP_ENDPOINT is set, one span per chat or text-completion call is sent to that endpoint: model, provider, token counts, cost, generation id, mode, attempt count, whether it streamed, and the trace id from a traceparent header if the caller sent one. Calls on the attested and unlinkable lanes send no span. Spans carry no prompt or completion.",
      holds: "The attributes listed, buffered in memory for up to five seconds before export.",
      ttl: "In memory for seconds; kept by whatever receives it, which the operator chooses.",
      requestText: "none",
      evidence: [
        ev("src/api/chat.ts", "if (!privateLane) ctx.telemetry.span(\"chat \" + r.model.id"),
        ev("src/api/chat.ts", "p.c.req.header(\"traceparent\")?.split(\"-\")[1]"),
        ev("src/gateway/otel.ts", "Spans never carry prompt or completion content."),
      ],
    },
    {
      id: "customer-tracing",
      name: "Trace export to a key owner's own destination, off unless the owner sets one",
      purpose: "A key's owner can set a tracing destination on the key (their OpenTelemetry collector, Langfuse or Helicone). Each public-lane call made with that key is then sent there: model, provider, token counts, sampling settings, finish reason, latency, cost, receipt id and lane. Prompt and completion text is included only if the owner set include_content. Calls on the attested and unlinkable lanes are never sent.",
      holds: "The listed fields of recent calls, in a bounded in-memory queue (2,000 calls at most across all keys; more are dropped and counted) until they are delivered or given up.",
      ttl: "In memory for seconds, or until retries end; kept by the destination the key's owner chose.",
      requestText: "answer-text",
      evidence: [
        ev("src/api/chat.ts", "if (!p.meta.askMo && !publication && !p.meta.party && billing.key?.tracing"),
        ev("src/api/chat.ts", "if (!p.meta.askMo && !publication && !p.meta.party && billing.key?.tracing"),
        ev("src/services/tracing.ts", "export function shouldExportTrace(o: { lane: string; privateLaneRequest: boolean; privateRoute: boolean }) {"),
        ev("src/services/tracing.ts", "if (!stored.include_content) {"),
      ],
    },
    {
      id: "backups",
      name: "Encrypted database backups",
      purpose: "A scheduled pg_dump (daily in the reference deployment) of the whole database, encrypted to public age recipients and uploaded to S3-compatible storage. Every table listed on this page is in it. The private key that opens it is never on the host that makes the backup.",
      holds: "The database as it was when the backup ran.",
      ttl: "The code writes each archive under a new key and never deletes one; how long archives last is set by the storage bucket's own rules, which are not in this repository.",
      requestText: "none",
      evidence: [ev("scripts/backup-offsite.ts", "The private age identity never belongs on this host"), ev("scripts/backup-offsite.ts", "pg_dump custom-format archive encrypted to public age recipients")],
    },
  ],
  addressReaders,
  bodyReaders,
  browser: {
    summary: "The router serves no website: the workspace (dash/) is a separate app and documents what it keeps in your browser.",
    items: [],
  },
};
