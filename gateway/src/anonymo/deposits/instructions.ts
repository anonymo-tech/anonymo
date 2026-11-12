// How a key deposits on each configured rail. Withheld while deposits are paused (withdrawals are never affected).

import type { Ctx } from "../../context.ts";
import { ensureDepositAddress } from "./addresses.ts";
import type { MoneyDeps } from "./services.ts";

export async function depositInstructions(ctx: Pick<Ctx, "db">, deps: MoneyDeps, keyHash: string) {
  const c = deps.config;
  if (c.depositsPaused) return { paused: true };
  const evm = c.evm.length
    ? {
        key_commit: await ensureDepositAddress(ctx.db, keyHash, "evm"),
        method: "deposit(address token, uint256 amount, bytes32 keyCommit)",
        chains: c.evm.map((x) => ({ chain: x.chain, router: x.router, confirmations: x.confirmations, tokens: x.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals })) })),
      }
    : null;
  const solana = c.solana
    ? {
        reference: await ensureDepositAddress(ctx.db, keyHash, "solana"),
        cluster: c.solana.cluster,
        recipient_wallet: c.solana.treasuryWallet,
        tokens: c.solana.tokens.map((t) => ({ symbol: t.symbol, mint: t.mint, token_account: t.account })),
        how: "One SPL TransferChecked to token_account with `reference` added as a read-only account (Solana Pay).",
      }
    : null;
  const tron = c.tron ? { address: await ensureDepositAddress(ctx.db, keyHash, "tron", c.tron.xpub), confirmations: c.tron.confirmations, tokens: c.tron.tokens.map((t) => ({ symbol: t.symbol, contract: t.contract })) } : null;
  const btc = c.btcpay ? { invoice: "POST /deposits/btcpay {amount_usd, refund_address}", credited_at: "the BTCPay quote" } : null;
  return { paused: false, evm, solana, tron, btc, stablecoins_credit: "1:1 USD" };
}
