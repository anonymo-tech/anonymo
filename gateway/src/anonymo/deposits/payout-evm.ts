// Automatic withdrawals on the EVM chains (Robinhood Chain, Base, Arbitrum) from a small hot wallet.
// The treasury Safe tops the hot wallet up with a float; a stolen hot key can lose only that float.
//
// Configuration (worker only; src/config.ts refuses the key on the public API):
//   ANONYMO_PAYOUT_PRIVATE_KEY     the hot wallet's key. Without it withdrawals stay pending for an operator.
//   ANONYMO_PAYOUT_MAX_USD         largest single withdrawal paid automatically (default 500); larger ones wait.
//   ANONYMO_PAYOUT_DAILY_MAX_USD   most paid automatically in any 24 hours (default 2000); the rest waits.
// Chains, RPCs and token addresses come from ANONYMO_EVM_CHAINS.
//
// Never twice: before broadcasting, the signed transaction is stored under the withdrawal id. A retry (after a crash, a
// timeout or a dropped connection) re-sends exactly those bytes, so it can only ever land once (same nonce).

import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import type { EvmChainConfig } from "./config.ts";
import { anonymoWithdrawals } from "./schema.ts";
import type { Payout, PayoutRequest } from "./withdraw.ts";

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** The chain operations a payout needs; tests pass a mock. */
export type PayoutChainClient = {
  address: Hex;
  /** Sign a token transfer at the account's next pending nonce. Returns the raw transaction and its hash. */
  signTransfer(token: Hex, to: Hex, amount: bigint): Promise<{ raw: Hex; hash: Hex }>;
  /** Broadcast; "already known" and "nonce too low" (it already landed) are not errors. */
  broadcast(raw: Hex): Promise<void>;
  /** Wait for the receipt: "success", "reverted", or null if it is not mined within the timeout. */
  waitFor(hash: Hex): Promise<"success" | "reverted" | null>;
};

export function rpcPayoutClient(rpcUrl: string, key: Hex): PayoutChainClient {
  const account = privateKeyToAccount(key);
  const transport = http(rpcUrl, { retryCount: 1, timeout: 20_000 });
  const pub = createPublicClient({ transport });
  return {
    address: account.address,
    async signTransfer(token, to, amount) {
      const chainId = await pub.getChainId();
      const wallet = createWalletClient({ account, transport, chain: { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } });
      const request = await wallet.prepareTransactionRequest({ to: token, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] }), nonce: await pub.getTransactionCount({ address: account.address, blockTag: "pending" }) });
      const raw = await wallet.signTransaction(request as never);
      const { keccak256 } = await import("viem");
      return { raw, hash: keccak256(raw) };
    },
    async broadcast(raw) {
      try {
        await pub.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        const m = (e as Error).message.toLowerCase();
        if (m.includes("already known") || m.includes("nonce too low") || m.includes("already imported")) return;
        throw e;
      }
    },
    async waitFor(hash) {
      try {
        const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
        return r.status;
      } catch {
        return null;
      }
    },
  };
}

export type EvmPayoutOptions = {
  db: Db;
  chains: EvmChainConfig[];
  clients: Map<string, PayoutChainClient>;
  maxPico: Pico;
  dailyMaxPico: Pico;
  now?: () => number;
};

const stashKey = (id: string) => `anonymo:payout:${id}`;

export function evmHotWalletPayout(o: EvmPayoutOptions): Payout {
  const now = o.now ?? Date.now;
  return {
    async send(p: PayoutRequest) {
      const cfg = o.chains.find((c) => c.chain === p.chain);
      const client = o.clients.get(p.chain);
      if (!cfg || !client) throw new Error(`no automatic payout rail for ${p.chain}`);
      const token = cfg.tokens.find((t) => t.symbol === p.token);
      if (!token) throw new Error(`${p.chain} has no ${p.token} configured for payouts`);
      if (!/^0x[0-9a-fA-F]{40}$/.test(p.to)) throw new Error("payout address is not an EVM address");

      // A transaction already signed for this withdrawal: re-send those exact bytes, never a new one.
      const [stashed] = await o.db.select({ value: kv.value }).from(kv).where(eq(kv.key, stashKey(p.id)));
      let tx = stashed?.value as { raw: Hex; hash: Hex } | undefined;
      if (!tx) {
        if (p.amountPico > o.maxPico) throw new Error("over the automatic payout limit; waiting for an operator");
        const since = new Date(now() - 24 * 3_600_000);
        const [day] = await o.db
          .select({ total: sql<string | null>`sum(${anonymoWithdrawals.amountPico})` })
          .from(anonymoWithdrawals)
          .where(and(eq(anonymoWithdrawals.status, "sent"), gt(anonymoWithdrawals.sentAt, since)));
        if (BigInt(day?.total ?? 0) + p.amountPico > o.dailyMaxPico) throw new Error("daily automatic payout limit reached; waiting");
        const amount = (p.amountPico * 10n ** BigInt(token.decimals)) / 1_000_000_000_000n; // pico → token units, down
        if (amount <= 0n) throw new Error("payout amount rounds to zero");
        tx = await client.signTransfer(token.address, p.to as Hex, amount);
        await o.db.insert(kv).values({ key: stashKey(p.id), value: tx }).onConflictDoNothing();
        // If another worker stashed first, use its transaction instead of ours.
        const [winner] = await o.db.select({ value: kv.value }).from(kv).where(eq(kv.key, stashKey(p.id)));
        tx = winner.value as { raw: Hex; hash: Hex };
      }
      await client.broadcast(tx.raw);
      const status = await client.waitFor(tx.hash);
      if (status === "success") return { txRef: tx.hash };
      if (status === "reverted") throw new Error(`payout transaction reverted (${tx.hash}); check the hot wallet's balance`);
      throw new Error(`payout transaction not mined yet (${tx.hash})`);
    },
  };
}

/** The hot-wallet payout from the environment, or null when no key is set (withdrawals then wait for an operator). */
export function payoutFromEnv(db: Db, chains: EvmChainConfig[], env: Record<string, unknown>): Payout | null {
  const key = typeof env.ANONYMO_PAYOUT_PRIVATE_KEY === "string" ? env.ANONYMO_PAYOUT_PRIVATE_KEY.trim() : "";
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("ANONYMO_PAYOUT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const usd = (name: string, d: string) => usdToPico(typeof env[name] === "string" && env[name] ? (env[name] as string) : d, "floor");
  return evmHotWalletPayout({
    db,
    chains,
    clients: new Map(chains.map((c) => [c.chain, rpcPayoutClient(c.rpcUrl, key as Hex)])),
    maxPico: usd("ANONYMO_PAYOUT_MAX_USD", "500"),
    dailyMaxPico: usd("ANONYMO_PAYOUT_DAILY_MAX_USD", "2000"),
  });
}
