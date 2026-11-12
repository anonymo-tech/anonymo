// WS05 test harness: a real router (database, migrations, keys, ledger) plus the WS05 routes mounted on their own Hono
// app with injected config, a static sanctions screen and a mock payout, so no test needs a chain, BTCPay or real keys.

import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { ZodError } from "zod";
import { ApiError } from "../../src/lib/errors.ts";
import { usdToPico } from "../../src/lib/money.ts";
import { loadDepositsConfig, type DepositsConfig } from "../../src/anonymo/deposits/config.ts";
import { moneyRoutes } from "../../src/anonymo/deposits/routes.ts";
import { moneyDeps, type MoneyDeps } from "../../src/anonymo/deposits/services.ts";
import { staticSanctionsScreen } from "../../src/anonymo/deposits/sanctions.ts";
import { MockPayout } from "../../src/anonymo/deposits/withdraw.ts";
import type { DepositChain, SanctionsScreen } from "../../src/anonymo/seams.ts";
import { startRouter, type Harness } from "../helpers.ts";

export const SANCTIONED_EVM = "0x00000000000000000000000000000000000bad01";

export type MoneyHarness = Awaited<ReturnType<typeof moneyHarness>>;

export async function moneyHarness(o: { env?: Record<string, string>; config?: Partial<DepositsConfig>; screen?: SanctionsScreen; deps?: Partial<MoneyDeps>; router?: Harness } = {}) {
  const h = o.router ?? (await startRouter());
  const payout = new MockPayout();
  const config = { ...loadDepositsConfig(o.env ?? {}), ...o.config };
  const deps: MoneyDeps = { ...moneyDeps(h.ctx, config, { screen: o.screen ?? staticSanctionsScreen([SANCTIONED_EVM]), payout, readers: { evm: new Map() } }), ...o.deps };
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toJSON(), err.status as never);
    if (err instanceof ZodError) return c.json({ error: { code: 400, type: "invalid_request", message: err.issues.map((i) => i.message).join("; ") } }, 400);
    throw err;
  });
  moneyRoutes(app, h.ctx, deps);
  const req = (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string>; body?: string } = {}) =>
    app.request(path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers: { ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...init.headers }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  const newKey = async (caps?: Record<string, unknown>) => {
    const r = await req("/keys", { json: caps ? { caps } : {} });
    if (r.status !== 201) throw new Error(`POST /keys ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { key: string; key_hash: string; deposit: Record<string, any> };
    return { secret: j.key, keyHash: j.key_hash, deposit: j.deposit, auth: { authorization: `Bearer ${j.key}` } };
  };
  /** Report a confirmed deposit through the sink, as a watcher would. */
  const deposit = (keyHash: string, usd: string, from: string, chain: DepositChain = "base", ref = `${chain}:0x${randomBytes(32).toString("hex")}:0`) =>
    deps.sink.credit({ keyHash, chain, amount: usdToPico(usd), ref, sourceAddr: from });
  return { h, deps, payout, app, req, newKey, deposit, close: () => (o.router ? Promise.resolve() : h.close()) };
}
