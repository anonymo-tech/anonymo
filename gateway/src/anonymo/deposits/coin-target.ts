import type { Hono } from "hono";
import type { Ctx } from "../../context.ts";
import { picoToUsdString, usdToPico } from "../../lib/money.ts";
import type { CoinReader } from "./coin.ts";
import type { CoinConfig } from "./config.ts";
import type { MoneyDeps } from "./services.ts";
import { verifyCoinReceiver } from "./verify-coin-receiver.ts";

type Prepared = {
  maxRaw: bigint;
  maxPico: bigint;
  valueForRaw(amountRaw: bigint): { valuePico: bigint; withinLimit: boolean } | null;
};

type TargetQuote = { amountRaw: bigint; valuePico: bigint; effectiveUnitPico: bigint };

/** Find the first integer raw amount that reaches the target under one confirmed, monotone valuation window. */
export function coinAmountForTarget(window: Prepared, targetPico: bigint, decimals: number): TargetQuote | "limit" | "unavailable" {
  if (targetPico <= 0n || window.maxRaw < 0n || window.maxRaw >= (1n << 256n)) return "unavailable";
  if (window.maxRaw === 0n || targetPico > window.maxPico) return "limit";
  const highest = window.valueForRaw(window.maxRaw);
  if (!highest || !highest.withinLimit) return "unavailable";
  if (highest.valuePico < targetPico) return "limit";
  let lo = 1n;
  let hi = window.maxRaw;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    const quote = window.valueForRaw(mid);
    if (!quote || !quote.withinLimit) return "unavailable";
    if (quote.valuePico >= targetPico) hi = mid;
    else lo = mid + 1n;
  }
  const final = window.valueForRaw(lo);
  if (!final || !final.withinLimit || final.valuePico < targetPico) return "unavailable";
  return { amountRaw: lo, valuePico: final.valuePico, effectiveUnitPico: final.valuePico * 10n ** BigInt(decimals) / lo };
}

type PrepareWindow = (cfg: CoinConfig, reader: CoinReader) => Promise<Prepared | null>;

export function coinTargetRoute(app: Hono, ctx: Pick<Ctx, "cfg">, deps: MoneyDeps, prepareWindow: PrepareWindow) {
  // Different dollar targets invert the same in-flight window. A completed quote is never reused.
  let pending: Promise<Prepared | null> | undefined;
  app.get("/deposits/coin/quote", async (c) => {
    c.header("Cache-Control", "no-store");
    const raw = c.req.queries("amount_usd");
    if (raw?.length !== 1 || !/^\d{1,9}(?:\.\d{1,12})?$/.test(raw[0]) || usdToPico(raw[0]) <= 0n) {
      return c.json({ error: { type: "invalid_amount_usd", message: "Enter a positive USD amount with up to 12 decimal places." } }, 400);
    }
    const unavailable = (message: string) => c.json({ error: { type: "coin_quote_unavailable", message } }, 503);
    const limited = () => c.json({ error: { type: "coin_quote_limit", message: "This amount exceeds the current NYMO payment limit." } }, 422);
    if (deps.config.depositsPaused) return unavailable("New deposits are paused.");
    const cfg = deps.config.coin;
    const reader = deps.readers.coin;
    if (!cfg || !reader || cfg.chainId !== 4663) return unavailable("NYMO payments are unavailable.");
    const target = usdToPico(raw[0]);
    if (target > usdToPico(cfg.maxUsdPerPayment)) return limited();
    if (!pending) {
      pending = verifyCoinReceiver(ctx, cfg, reader)
        .then((verified) => verified ? prepareWindow(cfg, reader) : null)
        .catch(() => null)
        .finally(() => { pending = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let window: Prepared | null;
    try {
      window = await Promise.race([pending, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 4_000); })]);
    } finally {
      clearTimeout(timer);
    }
    if (!window) return unavailable("A confirmed NYMO quote is unavailable. Please try again later.");
    const quote = coinAmountForTarget(window, target, cfg.token.decimals);
    if (quote === "limit") return limited();
    if (quote === "unavailable") return unavailable("The NYMO quote expired. Request a new quote.");
    return c.json({
      amount_raw: quote.amountRaw.toString(),
      estimated_credit_usd: picoToUsdString(quote.valuePico),
      price_usd: picoToUsdString(quote.effectiveUnitPico),
      token: { address: cfg.token.address, symbol: cfg.token.symbol, decimals: cfg.token.decimals },
      coin_pay: cfg.coinPay,
      chain_id: cfg.chainId,
      confirmations: cfg.confirmations,
    });
  });
}
