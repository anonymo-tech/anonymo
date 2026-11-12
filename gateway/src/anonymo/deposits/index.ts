// WS05 entry point: keys, deposits, withdrawals and the x402 Base/Solana rails, mounted from src/anonymo/routes.ts.

import type { Hono } from "hono";
import type { Ctx } from "../../context.ts";
import { configureRemoteX402, remoteX402Settings } from "../../pay/x402-networks.ts";
import { moneyRoutes } from "./routes.ts";
import { defaultMoneyDeps, type MoneyDeps } from "./services.ts";

export { keyPolicyMiddleware } from "../keys/caps.ts";
export type { MoneyDeps } from "./services.ts";

/** Mount every WS05 route and job. Configuration comes from the environment unless `deps` is given (tests). */
export function anonymoMoneyRoutes(app: Hono, ctx: Ctx, deps: MoneyDeps = defaultMoneyDeps(ctx), env: Record<string, unknown> = process.env) {
  configureRemoteX402(ctx, remoteX402Settings(env));
  moneyRoutes(app, ctx, deps, { jobs: true });
}
