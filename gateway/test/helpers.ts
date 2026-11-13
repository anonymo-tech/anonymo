import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createPublicClient, custom, encodePacked, keccak256, recoverTypedDataAddress, toBytes, toHex, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApp } from "../src/app.ts";
import { ChainService } from "../src/chain/service.ts";
import { loadConfig } from "../src/config.ts";
import { providers } from "../src/db/schema.ts";
import { runRegistry } from "../src/services/registry.ts";
import { serveMockProvider, type MockConfig } from "../src/providers/mock.ts";
import { recordEvents, processEvents } from "../src/chain/indexer.ts";
import { encrypt } from "../src/lib/util.ts";
import { RedisRateLimiter } from "../src/lib/ratelimit.ts";
import type { Ctx } from "../src/context.ts";

export const ADMIN = "test-admin-token-0123456789abcdef";
export const ADDR = {
  credits: "0x00000000000000000000000000000000000c0001",
  callPay: "0x00000000000000000000000000000000000c0002",
  providerBond: "0x00000000000000000000000000000000000c0004",
  receiptAnchor: "0x00000000000000000000000000000000000c0005",
} as const;

let logCounter = 0;
export const fakeTx = () => ("0x" + (++logCounter).toString(16).padStart(64, "0")) as Hex;

/** In-memory stand-in for the deployed contracts, driven through ChainService's public surface. */
export class FakeChain extends ChainService {
  payments = new Map<string, { nonce: Hex; payer: Hex; amount: bigint; pending?: boolean }>();
  anchors: { root: Hex; fromTs: number; toTs: number; count: number }[] = [];
  spentRoots: { root: Hex; asOf: number; total: bigint }[] = [];
  keys = new Map<string, string>();
  slashProposals: unknown[] = [];

  constructor(env: Record<string, unknown>) {
    const cfg = loadConfig(env);
    super(cfg);
    // Code that reads the chain client directly (not through an overridden method) must not reach the real RPC:
    // that made results depend on the network and stalled tests on a slow link. None of the fixture contracts
    // exist, so answer as a chain without them would: the configured chain id, no code and empty call data.
    (this as { client: PublicClient }).client = createPublicClient({
      chain: this.chain,
      cacheTime: 0,
      transport: custom({
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return toHex(cfg.chain.id);
          if (method === "eth_call" || method === "eth_getCode") return "0x";
          if (method === "eth_getTransactionReceipt" || method === "eth_getTransactionByHash") return null;
          throw new Error(`FakeChain has no RPC for ${method}; override the ChainService method or stub ctx.chain.client.`);
        },
      }, { retryCount: 0 }),
    });
  }
  /** Run without the CallPay contract, as an x402-only router does. */
  noCallPay = false;
  override address(name: string) {
    if (name === "callPay" && this.noCallPay) return undefined;
    return (ADDR as Record<string, Hex>)[name];
  }
  override roleAddress() {
    return "0x0000000000000000000000000000000000000001" as Hex;
  }
  /** The chain head the indexer and readiness see. */
  head = 100n;
  override async blockNumber() {
    return this.head;
  }
  override async blockTimestamp() {
    return Math.floor(Date.now() / 1000);
  }
  override async readCallPayments(txHash: Hex) {
    const p = this.payments.get(txHash);
    if (!p) throw Object.assign(new Error("not found"), {});
    if (p.pending) return { pending: true as const, confirmations: 0 };
    return [{ nonce: p.nonce, payer: p.payer, amount: p.amount, blockNumber: 1n, confirmations: 5, logIndex: 0 }];
  }
  /** x402: USDG balances, used EIP-3009 nonces and the authorizations relayed by transferWithAuthorization. */
  usdgBalances = new Map<string, bigint>();
  usedAuthorizations = new Set<string>();
  x402Relays: { from: Hex; to: Hex; value: bigint; nonce: Hex; hash: Hex; role: "router" | "facilitator" }[] = [];
  failX402Relay = false;
  /** Native gas of every relaying key (the facilitator's balance floor reads it), and the gas a relay reports. */
  relayBalanceWei = 10n ** 18n;
  relayGas = { gasUsed: 80_000n, effectiveGasPrice: 10_000_000n }; // 0.01 gwei
  override async nativeBalance() {
    return this.relayBalanceWei;
  }
  override async gasPrice() {
    return this.relayGas.effectiveGasPrice;
  }
  override async usdgDomain() {
    return { name: "Global Dollar", version: "1" };
  }
  override async usdgBalance(of: Hex) {
    return this.usdgBalances.get(of.toLowerCase()) ?? 10n ** 12n;
  }
  override async authorizationUsed(authorizer: Hex, nonce: Hex) {
    return this.usedAuthorizations.has(`${authorizer}:${nonce}`.toLowerCase());
  }
  override async transferWithAuthorization(a: { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; signature: Hex }, role: "router" | "facilitator" = "router") {
    if (this.failX402Relay) throw new Error("execution reverted: transfer amount exceeds balance");
    const id = `${a.from}:${a.nonce}`.toLowerCase();
    if (this.usedAuthorizations.has(id)) throw new Error("AuthorizationUsed()");
    this.usedAuthorizations.add(id);
    const hash = fakeTx();
    this.usdgBalances.set(a.from.toLowerCase(), (await this.usdgBalance(a.from)) - a.value);
    this.x402Relays.push({ from: a.from, to: a.to, value: a.value, nonce: a.nonce, hash, role });
    return { hash, blockNumber: 1n, ...this.relayGas };
  }
  // EOA signatures only (no RPC in unit tests).
  override async verifyWalletSignature(wallet: Hex, typedData: Parameters<ChainService["verifyWalletSignature"]>[1], signature: Hex) {
    try {
      return (await recoverTypedDataAddress({ ...typedData, signature } as never)).toLowerCase() === wallet.toLowerCase();
    } catch {
      return false;
    }
  }
  override async anchor(root: Hex, fromTs: number, toTs: number, count: number) {
    this.anchors.push({ root, fromTs, toTs, count });
    return { hash: fakeTx(), index: BigInt(this.anchors.length - 1) };
  }
  override async anchorOnChain(index: number) {
    const a = this.anchors[index];
    return a ? { root: a.root, fromTs: BigInt(a.fromTs), toTs: BigInt(a.toTs), count: a.count } : null;
  }
  override async registerSigningKey(keyId: string, pub: string) {
    this.keys.set(keyId, pub);
    return { hash: fakeTx(), receipt: {} as never };
  }
  override async signingKeyOnChain(keyId: string) {
    const pub = this.keys.get(keyId);
    return pub ? { publicKey: ("0x" + pub) as Hex, validFrom: 0n, revokedAt: 0n } : null;
  }
  /** Chain clock offset from wall time in seconds (negative = the chain trails); failNextSpentRoot simulates a dropped tx. */
  clockOffsetSec = 0;
  failNextSpentRoot = false;
  override async latestBlockTime() {
    return Math.floor(Date.now() / 1000) + this.clockOffsetSec;
  }
  override async latestSpentRoot() {
    const r = this.spentRoots.at(-1);
    return { epoch: BigInt(this.spentRoots.length), root: (r?.root ?? "0x" + "00".repeat(32)) as Hex, asOf: r?.asOf ?? 0, totalSpent: r?.total ?? 0n };
  }
  controlsReady = true;
  override async custodyControlsReady() { return this.controlsReady; }
  approveSpentRoots = true;
  override async isSpentRootApproved() { return this.approveSpentRoots; }
  override async postSpentRoot(root: Hex, asOf: number, total: bigint) {
    // Same checks as Credits.postSpentRoot.
    if (this.failNextSpentRoot) {
      this.failNextSpentRoot = false;
      throw new Error("transaction dropped");
    }
    if (asOf > (await this.latestBlockTime())) throw new Error("RootInFuture()");
    if (asOf <= (this.spentRoots.at(-1)?.asOf ?? 0)) throw new Error("StaleRoot()");
    this.spentRoots.push({ root, asOf, total });
    return { hash: fakeTx(), receipt: {} as never };
  }
  override async bondOf() {
    return 20_000n * 10n ** 6n;
  }
  override async proposeSlash(...args: unknown[]) {
    this.slashProposals.push(args);
    return { submitted: true as const, hash: fakeTx(), slashId: BigInt(this.slashProposals.length) };
  }
  executeSlashSubmitted = true;
  override async executeSlash() {
    if (!this.executeSlashSubmitted) return { submitted: false as const, safeTx: { to: this.address("providerBond")!, value: "0", data: "0x" as Hex } };
    return { submitted: true as const, hash: fakeTx() };
  }

  /** Simulate a Credits.Deposited event for a chain key hash. */
  async deposit(ctx: Ctx, chainKeyHash: string, usdgUnits: bigint) {
    const tx = fakeTx();
    await recordEvents(ctx, [{ contract: "credits", event: "Deposited", args: { keyHash: chainKeyHash, from: "0x0000000000000000000000000000000000000abc", amount: usdgUnits }, txHash: tx, logIndex: 0, blockNumber: 50n }]);
    await processEvents(ctx);
    return tx;
  }
}

export const MODELS = {
  llama: { id: "llama-3.3-70b", slug: "meta-llama/llama-3.3-70b-instruct", prompt: "0.0000001", completion: "0.00000032" },
  llamaPricey: { id: "llama-3.3-70b", slug: "meta-llama/llama-3.3-70b-instruct", prompt: "0.0000004", completion: "0.0000008" },
  qwen: { id: "qwen3-32b", slug: "qwen/qwen3-32b", prompt: "0.0000002", completion: "0.0000006" },
  embed: { id: "embed-small", slug: "acme/embed-small", prompt: "0.00000002", completion: "0", output: ["embeddings"] },
};

export function fixtureEdgeInit(h: { ctx: Ctx }, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (h.ctx.cfg.hardening.originLockEnabled && !headers.has("x-origin-lock")) headers.set("x-origin-lock", h.ctx.cfg.hardening.originLockSecret!);
  return { ...init, headers };
}

export type Harness = Awaited<ReturnType<typeof startRouter>>;

type ApiTypedData = { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, string> };

/** Sign typed data as the API returns it for eth_signTypedData_v4 (integers as decimal strings). */
export async function signApiTypedData(account: PrivateKeyAccount, td: ApiTypedData) {
  const message = Object.fromEntries(td.types[td.primaryType].map((f) => [f.name, f.type.startsWith("uint") ? BigInt(td.message[f.name]) : td.message[f.name]]));
  const { EIP712Domain: _, ...types } = td.types;
  return account.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message } as never);
}

/** With TEST_PG_URL set, every harness gets its own fresh database on a real Postgres server. */
async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = process.env.TEST_PG_URL;
  if (!base) return { url: "pglite://memory", drop: async () => {} };
  const postgres = (await import("postgres")).default;
  const name = "ar_test_" + Math.random().toString(36).slice(2, 10);
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(base);
  u.pathname = "/" + name;
  return {
    url: u.toString(),
    drop: async () => {
      const a = postgres(base, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function startRouter(opts: { providers?: (MockConfig & { id: string; live?: boolean; attested?: boolean; policy?: Record<string, unknown> })[]; env?: Record<string, string>; fakeChain?: boolean; rand?: () => number } = {}) {
  const mocks = (opts.providers ?? [
    { id: "alpha", name: "Alpha", models: [MODELS.llama, MODELS.qwen, MODELS.embed] },
    { id: "beta", name: "Beta", models: [MODELS.llamaPricey] },
  ]).map((p) => ({ spec: p, server: serveMockProvider(p) }));
  const database = await freshDatabase();
  const env: Record<string, string> = {
    ANONYMO_ENV: "test",
    DATABASE_URL: database.url,
    ...(process.env.TEST_REDIS_URL ? { REDIS_URL: process.env.TEST_REDIS_URL } : {}),
    PAYMENT_WAIT_MS: "500",
    WORKERS: "false",
    HEALTH_PROBES: "false",
    CANARIES: "false",
    APP_SECRET: "test-secret-test-secret-test-secret-1234",
    ADMIN_TOKEN: ADMIN,
    LOG_LEVEL: "error",
    ALLOW_DEV_ATTESTATION: "true",
    NEW_KEYS_PER_HOUR: "100000",
    UNAUTH_RPM: "100000",
    ANON_RATE_PER_MIN: "100000", // Dedicated hardening cases override this workload allowance.
    ...opts.env,
  };
  const chain = opts.fakeChain === false ? undefined : new FakeChain(env);
  const { app, ctx, close } = await createApp({ env, chain, rand: opts.rand, startJobs: false });
  // The in-memory limiter belongs to one router, and the tests are written against that. A Redis limiter's counters
  // outlive the router and are shared by every harness and every run within the same window (fixed hour, minute), so a
  // limit reached by one test file, or by an earlier run, would fail another. Give each router its own key namespace.
  if (ctx.limiter instanceof RedisRateLimiter) {
    const shared = ctx.limiter;
    const namespace = `t${randomBytes(6).toString("hex")}:`;
    ctx.limiter = { take: (key, amount, limit, windowMs) => shared.take(namespace + key, amount, limit, windowMs), close: () => shared.close() };
  }
  for (const { spec, server } of mocks) {
    await ctx.db.insert(providers).values({
      id: spec.id,
      name: spec.name,
      baseUrl: server.url,
      apiKeyEnc: encrypt(ctx.cfg.appSecret, `upstream-key-${spec.id}`),
      status: spec.live === false ? "applied" : "live",
      dataPolicy: spec.policy ?? { training: false, retains_prompts: false, zdr: true },
      teeKind: spec.tee ?? null,
      attestationUrl: spec.tee ? server.url + "/attestation" : null,
    });
  }
  await runRegistry(ctx);
  const request = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (ctx.cfg.hardening.originLockEnabled && !headers.has("x-origin-lock")) headers.set("x-origin-lock", ctx.cfg.hardening.originLockSecret!); // Emulate the configured public edge.
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return app.request(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  const newKey = async () => {
    const r = await request("/api/v1/keys", { method: "POST", json: { name: "test" } });
    const j = (await r.json()) as { key: string; data: { hash: string; chain_key_hash: string } };
    return { secret: j.key, hash: j.data.hash, chainKeyHash: j.data.chain_key_hash, auth: { authorization: `Bearer ${j.key}` } };
  };
  const fundedKey = async (usdg = 10n) => {
    const k = await newKey();
    await (chain as FakeChain).deposit(ctx, k.chainKeyHash, usdg * 1_000_000n);
    return k;
  };
  return {
    app,
    ctx,
    chain: chain as FakeChain,
    mocks: Object.fromEntries(mocks.map((m) => [m.spec.id, m.server])),
    request,
    newKey,
    fundedKey,
    close: async () => {
      await close();
      for (const m of mocks) m.server.stop();
      await database.drop();
    },
  };
}

export async function sse(res: Response) {
  const text = await res.text();
  const events = text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => b.slice(5).trim());
  return { raw: text, done: events.includes("[DONE]"), events: events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e)) };
}

export const providerIdHash = (id: string) => keccak256(toBytes(id));
export { encodePacked, eq };
