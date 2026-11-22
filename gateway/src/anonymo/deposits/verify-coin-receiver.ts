import type { Ctx } from "../../context.ts";
import type { CoinReader } from "./coin.ts";
import { NYMO_TOKEN, RHC_USDG, type CoinConfig } from "./config.ts";

/** The state comes from the configured RPC. The destination comes only from trusted service configuration. */
export async function verifyCoinReceiver(ctx: Pick<Ctx, "cfg">, c: CoinConfig, reader: CoinReader): Promise<boolean> {
  const token = c.token.address.toLowerCase();
  if (ctx.cfg.production || c.chainId === 4663) {
    if (c.chainId !== 4663 || token !== NYMO_TOKEN || c.token.symbol !== "NYMO" || c.token.decimals !== 18) return false;
    if (c.quote.address.toLowerCase() !== RHC_USDG || c.quote.symbol !== "USDG" || c.quote.decimals !== 6) return false;
  }
  if (/^0x0{40}$/i.test(c.coinPay) || [token, c.quote.address.toLowerCase()].includes(c.coinPay.toLowerCase())) return false;
  const binding = await reader.paymentBinding(c.coinPay, c.token.address);
  if (binding.chainId !== c.chainId || binding.coin.toLowerCase() !== token || binding.symbol !== c.token.symbol || binding.decimals !== c.token.decimals ||
      binding.dead.toLowerCase() !== "0x000000000000000000000000000000000000dead") return false;
  return true;
}
