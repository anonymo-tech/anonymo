// How a key deposits on each configured rail. Withheld while deposits are paused (withdrawals are never affected).

import type { Ctx } from "../../context.ts";
import { ensureDepositAddress } from "./addresses.ts";
import { verifyCoinReceiver } from "./verify-coin-receiver.ts";
import type { MoneyDeps } from "./services.ts";
import { coinPicoPerCoin, prepareNymoQuote, NYMO_MARKET, v4PoolId } from "./coin.ts";
import { picoToUsd, picoToUsdString } from "../../lib/money.ts";

/** The DepositRouter and stablecoins on each EVM chain. Public: the same for every key. */
export function evmContracts(deps: MoneyDeps) {
  return deps.config.evm.map((x) => ({
    chain: x.chain,
    router: x.router,
    confirmations: x.confirmations,
    tokens: x.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals })),
  }));
}

export async function depositInstructions(ctx: Pick<Ctx, "db" | "cfg">, deps: MoneyDeps, keyHash: string) {
  const c = deps.config;
  if (c.depositsPaused) return { paused: true };
  const evm = c.evm.length
    ? {
        key_commit: await ensureDepositAddress(ctx.db, keyHash, "evm"),
        method: "deposit(address token, uint256 amount, bytes32 keyCommit)",
        chains: evmContracts(deps),
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
  const contract = await publicCoinContract(ctx, deps);
  const coin = contract ? { ...contract, key_commit: await ensureDepositAddress(ctx.db, keyHash, "evm") } : null;
  return { paused: false, evm, solana, tron, btc, coin, stablecoins_credit: "1:1 USD" };
}

/** Paying with the coin: the live price (null while the pool cannot give one) and the CoinPay call. Coins are burned. */
async function readCoinContract(ctx: Pick<Ctx, "db" | "cfg">, deps: MoneyDeps) {
  const c = deps.config.coin;
  const reader = deps.readers.coin;
  if (!c || !reader) return null;
  if (!await verifyCoinReceiver(ctx, c, reader)) return null;
  const quote = c.market ? await prepareNymoQuote(ctx.db, c, reader).catch(() => null) : null;
  const price = c.market ? (quote && quote.maxPico >= 1_000_000n ? quote.unitPico : null) : await coinPicoPerCoin(c, reader, ctx.db as never).catch(() => null);
  return {
    chain: "rhc" as const,
    chain_id: c.chainId,
    coin_pay: c.coinPay,
    token: { symbol: c.token.symbol, address: c.token.address, decimals: c.token.decimals },
    price_usd: price ? (c.market ? picoToUsdString(price) : picoToUsd(price)) : null,
    max_usd_per_payment: quote ? picoToUsdString(quote.maxPico / 1_000_000n * 1_000_000n) : c.maxUsdPerPayment,
    ...(quote ? { max_amount_raw: String(quote.maxRaw), market_phase: quote.phase } : {}),
    confirmations: c.confirmations,
    method: "approve(coin_pay, amount) on the coin, then pay(uint256 amount, bytes32 keyCommit): the coins go to the dead address",
    credited_at: c.market ? "the conservative executable NYMO value over the confirmed market window, converted at Chainlink ETH/USD; usage only, never withdrawn" : "the lower of the pool's spot and average price when the payment is confirmed; usage only, never withdrawn",
    pool: c.market ? { kind: "pons-native-chainlink", curve: NYMO_MARKET.curve, graduated_pool_id: NYMO_MARKET.poolId, quote_currency: "ETH", eth_usd_feed: NYMO_MARKET.ethUsdFeed } : c.pool ? { kind: "uniswap-v3", address: c.pool } : { kind: "uniswap-v4", pool_id: v4PoolId(c.token.address, c.quote.address, c.v4.fee, c.v4.tickSpacing, c.v4.hooks) },
  };
}

// A slow coin RPC must not hold up the USDG rail. Share in-flight reads across callers and never reuse a finished quote.
type CoinLookup = ReturnType<typeof readCoinContract>;
const inFlight = new WeakMap<MoneyDeps, CoinLookup>();

export async function publicCoinContract(ctx: Pick<Ctx, "db" | "cfg">, deps: MoneyDeps) {
  if (!deps.config.coin || !deps.readers.coin) return null;
  let read = inFlight.get(deps);
  if (!read) {
    read = readCoinContract(ctx, deps).catch(() => null).finally(() => inFlight.delete(deps));
    inFlight.set(deps, read);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read, new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 2_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
