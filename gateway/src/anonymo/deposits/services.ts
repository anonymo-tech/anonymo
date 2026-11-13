// Everything the WS05 routes and jobs need, built once from the environment. Tests build their own with mocks.

import type { Ctx } from "../../context.ts";
import { log } from "../../lib/util.ts";
import type { SanctionsScreen } from "../seams.ts";
import { greenfieldClient, type BtcpayClient } from "./btcpay.ts";
import { loadDepositsConfig, type DepositsConfig, type EvmChain } from "./config.ts";
import { rpcEvmReader, scanEvmChain, type EvmReader } from "./evm.ts";
import { rpcCoinReader, scanCoinPayments, type CoinReader } from "./coin.ts";
import { dbSanctionsScreen, refreshAnonymoSanctions } from "./sanctions.ts";
import { createDepositSink, rescreenHeld, type AnonymoDepositSink } from "./sink.ts";
import { rpcSolanaReader, scanSolana, type SolanaReader } from "./solana.ts";
import { scanTron, tronGridReader, type TronReader } from "./tron.ts";
import { pendingPayout, processPendingWithdrawals, type Payout } from "./withdraw.ts";
import { payoutFromEnv } from "./payout-evm.ts";

export type MoneyDeps = {
  config: DepositsConfig;
  screen: SanctionsScreen;
  sink: AnonymoDepositSink;
  payout: Payout;
  btcpay?: BtcpayClient;
  readers: { evm: Map<EvmChain, EvmReader>; solana?: SolanaReader; tron?: TronReader; coin?: CoinReader };
};

export function moneyDeps(ctx: Pick<Ctx, "db">, config: DepositsConfig, o: Partial<Omit<MoneyDeps, "config" | "sink">> = {}, env: Record<string, unknown> = {}): MoneyDeps {
  const screen = o.screen ?? dbSanctionsScreen(ctx.db, { requireList: config.sanctions.enabled });
  return {
    config,
    screen,
    sink: createDepositSink(ctx.db, screen),
    // The hot wallet pays automatically when its key is set (worker only); otherwise withdrawals wait for an operator.
    payout: o.payout ?? payoutFromEnv(ctx.db, config.evm, env) ?? pendingPayout,
    btcpay: o.btcpay ?? (config.btcpay ? greenfieldClient(config.btcpay) : undefined),
    readers: o.readers ?? {
      evm: new Map(config.evm.map((c) => [c.chain, rpcEvmReader(c.rpcUrl)])),
      solana: config.solana ? rpcSolanaReader(config.solana.rpcUrl) : undefined,
      tron: config.tron ? tronGridReader(config.tron) : undefined,
      coin: config.coin ? rpcCoinReader(config.coin.rpcUrl) : undefined,
    },
  };
}

export const defaultMoneyDeps = (ctx: Ctx, env: Record<string, unknown> = process.env) => moneyDeps(ctx, loadDepositsConfig(env), {}, env);

/** One pass of every configured rail, then pending payouts and held re-screens. A failing rail does not stop the others. */
export async function runMoneyJobs(ctx: Pick<Ctx, "db">, deps: MoneyDeps) {
  const results: Record<string, unknown> = {};
  const failed: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      results[name] = await fn();
    } catch (e) {
      failed.push(name);
      log.warn("anonymo money job step failed", { step: name, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  };
  for (const c of deps.config.evm) {
    const reader = deps.readers.evm.get(c.chain);
    if (reader) await step(`evm:${c.chain}`, () => scanEvmChain(ctx.db, c, reader, deps.sink));
  }
  if (deps.config.solana && deps.readers.solana) await step("solana", () => scanSolana(ctx.db, deps.config.solana!, deps.readers.solana!, deps.sink));
  if (deps.config.tron && deps.readers.tron) await step("tron", () => scanTron(ctx.db, deps.config.tron!, deps.readers.tron!, deps.sink));
  if (deps.config.coin && deps.readers.coin) await step("coin", () => scanCoinPayments(ctx.db, deps.config.coin!, deps.readers.coin!, deps.sink));
  await step("withdrawals", () => processPendingWithdrawals(ctx.db, deps.payout));
  await step("rescreen", () => rescreenHeld(ctx.db, deps.screen));
  if (failed.length) throw new Error(`anonymo money steps failed: ${failed.join(", ")}`);
  return results;
}

export function registerMoneyJobs(ctx: Ctx, deps: MoneyDeps) {
  ctx.jobs.register("anonymo-deposits", deps.config.watchEveryMs, () => runMoneyJobs(ctx, deps));
  if (deps.config.sanctions.enabled)
    ctx.jobs.register("anonymo-sanctions", 24 * 3_600_000, () => refreshAnonymoSanctions(ctx.db, { listUrl: deps.config.sanctions.listUrl, production: ctx.cfg.production }), { atStart: true });
}
