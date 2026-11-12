// x402 per call on Base and Solana USDC (WS05), beside the Robinhood Chain USDG flow in x402.ts.
// Robinhood Chain is verified and relayed by the router itself. Base and Solana go through a standard x402 facilitator
// (`POST /verify`, `POST /settle`, the shape every x402 facilitator serves): on Base the payer signs a USDC EIP-3009
// authorization, on Solana a partially signed USDC transfer that the facilitator's fee payer completes. Either way the
// requirement we send is built here, from our own price and payTo, never from the client. The whole payment is then
// credited to the payer's wallet account, exactly like the RHC flow, so unused value stays as change.

import { z } from "zod";
import type { Ctx } from "../context.ts";
import { quotes } from "../db/schema.ts";
import { ApiError, fail } from "../lib/errors.ts";
import { eq } from "drizzle-orm";
import { ensureAccount, post } from "../ledger/ledger.ts";
import { usdgToPico } from "../lib/money.ts";
import { log, sha256 } from "../lib/util.ts";
import { walletAccountId } from "../api/auth.ts";

export const REMOTE_NETWORKS = {
  base: { caip2: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", extra: { name: "USD Coin", version: "2" } },
  "base-sepolia": { caip2: "eip155:84532", asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", extra: { name: "USDC", version: "2" } },
  solana: { caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", extra: {} },
  "solana-devnet": { caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", extra: {} },
} as const;
export type RemoteNetwork = keyof typeof REMOTE_NETWORKS;

export type RemoteX402Requirement = {
  scheme: "exact";
  network: RemoteNetwork;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, string>;
};

const evm = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const sol = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const env = z.object({
  ANONYMO_X402_FACILITATOR_URL: z.string().url().optional(),
  ANONYMO_X402_FACILITATOR_AUTH: z.string().optional(), // sent as Authorization to the facilitator, if it needs one
  ANONYMO_X402_BASE_NETWORK: z.enum(["base", "base-sepolia"]).default("base"),
  ANONYMO_X402_BASE_PAY_TO: evm.optional(),
  ANONYMO_X402_SOLANA_NETWORK: z.enum(["solana", "solana-devnet"]).default("solana"),
  ANONYMO_X402_SOLANA_PAY_TO: sol.optional(),
  ANONYMO_X402_SOLANA_FEE_PAYER: sol.optional(),
});

export type RemoteX402Settings = {
  facilitatorUrl: string;
  facilitatorAuth?: string;
  networks: { network: RemoteNetwork; payTo: string; extra: Record<string, string> }[];
  fetcher?: typeof fetch;
};

export function remoteX402Settings(e: Record<string, unknown>): RemoteX402Settings | null {
  const p = env.parse(e);
  if (!p.ANONYMO_X402_FACILITATOR_URL) return null;
  const networks: RemoteX402Settings["networks"] = [];
  if (p.ANONYMO_X402_BASE_PAY_TO) networks.push({ network: p.ANONYMO_X402_BASE_NETWORK, payTo: p.ANONYMO_X402_BASE_PAY_TO.toLowerCase(), extra: { ...REMOTE_NETWORKS[p.ANONYMO_X402_BASE_NETWORK].extra } });
  if (p.ANONYMO_X402_SOLANA_PAY_TO) {
    if (!p.ANONYMO_X402_SOLANA_FEE_PAYER) throw new Error("ANONYMO_X402_SOLANA_PAY_TO needs ANONYMO_X402_SOLANA_FEE_PAYER (the facilitator's fee payer).");
    networks.push({ network: p.ANONYMO_X402_SOLANA_NETWORK, payTo: p.ANONYMO_X402_SOLANA_PAY_TO, extra: { feePayer: p.ANONYMO_X402_SOLANA_FEE_PAYER } });
  }
  return networks.length ? { facilitatorUrl: p.ANONYMO_X402_FACILITATOR_URL.replace(/\/$/, ""), facilitatorAuth: p.ANONYMO_X402_FACILITATOR_AUTH, networks } : null;
}

const settingsByCtx = new WeakMap<object, RemoteX402Settings | null>();
/** Set (or clear) the Base/Solana x402 rails for a router. Called once at mount; tests call it directly. */
export const configureRemoteX402 = (ctx: Ctx, s: RemoteX402Settings | null) => void settingsByCtx.set(ctx, s);
export const remoteX402Of = (ctx: Ctx) => settingsByCtx.get(ctx) ?? null;

export function remoteRequirements(ctx: Ctx, o: { priceUnits: bigint; resource: string; description: string }): RemoteX402Requirement[] {
  const s = remoteX402Of(ctx);
  if (!s) return [];
  return s.networks.map((n) => ({
    scheme: "exact",
    network: n.network,
    maxAmountRequired: o.priceUnits.toString(), // USDC has 6 decimals, like USDG
    resource: o.resource,
    description: o.description,
    mimeType: "application/json",
    payTo: n.payTo,
    maxTimeoutSeconds: ctx.cfg.fees.quoteTtlS,
    asset: REMOTE_NETWORKS[n.network].asset,
    extra: n.extra,
  }));
}

/** The CAIP-2 name x402 v2 uses for a remote network. */
export const caip2Of = (network: RemoteNetwork) => REMOTE_NETWORKS[network].caip2;

/** If the payment header is an x402 payment for Base or Solana, return its decoded JSON and network; else null. */
export function remotePaymentOf(ctx: Ctx, header: string): { json: Record<string, any>; network: RemoteNetwork } | null {
  const s = remoteX402Of(ctx);
  if (!s) return null;
  let j: any;
  try {
    const t = header.trim();
    j = JSON.parse(t.startsWith("{") ? t : Buffer.from(t, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (j?.x402Version === undefined) return null;
  const named = String((j.accepted && typeof j.accepted === "object" ? j.accepted : j).network ?? "");
  const hit = s.networks.find((n) => n.network === named || caip2Of(n.network) === named);
  return hit ? { json: j, network: hit.network } : null;
}

type FacilitatorAnswer = { isValid?: boolean; invalidReason?: string; success?: boolean; errorReason?: string; transaction?: string; payer?: string; network?: string };

async function facilitator(s: RemoteX402Settings, path: "/verify" | "/settle", body: unknown): Promise<FacilitatorAnswer> {
  const res = await (s.fetcher ?? fetch)(s.facilitatorUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(s.facilitatorAuth ? { authorization: s.facilitatorAuth } : {}) },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => ({}))) as FacilitatorAnswer;
  if (!res.ok && j.isValid === undefined && j.success === undefined) throw new Error(`facilitator ${path} failed (${res.status})`);
  return j;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/**
 * Verify and settle a Base or Solana x402 payment through the facilitator, then credit the payer's wallet account.
 * A rejected payment is a 402 carrying fresh requirements and the facilitator's reason.
 */
export async function redeemRemoteX402(ctx: Ctx, pay: { json: Record<string, any>; network: RemoteNetwork }, o: { priceUnits: bigint; resource: string; description: string; bodySha: string; modelId: string }) {
  const s = remoteX402Of(ctx)!;
  const requirement = remoteRequirements(ctx, o).find((r) => r.network === pay.network)!;
  const all = remoteRequirements(ctx, o);
  const refuse = (reason: string, payer?: string): never => {
    const v2 = { x402Version: 2, error: reason, resource: { url: o.resource, description: o.description, mimeType: "application/json" }, accepts: all.map((r) => ({ scheme: r.scheme, network: caip2Of(r.network), amount: r.maxAmountRequired, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, extra: r.extra })) };
    throw new ApiError(402, reason, "payment_rejected", undefined, { "payment-required": b64(v2) }, { x402Version: 1, error: reason, accepts: all, ...(payer ? { payer } : {}) });
  };
  const x402Version = Number(pay.json.x402Version);
  if (x402Version !== 1 && x402Version !== 2) refuse("invalid_x402_version");
  const scheme = String((pay.json.accepted && typeof pay.json.accepted === "object" ? pay.json.accepted : pay.json).scheme ?? "");
  if (scheme !== "exact") refuse("unsupported_scheme");
  const paymentRequirements = x402Version === 2 ? { ...requirement, network: caip2Of(pay.network), amount: requirement.maxAmountRequired } : requirement;
  let verified: FacilitatorAnswer;
  try {
    verified = await facilitator(s, "/verify", { x402Version, paymentPayload: pay.json, paymentRequirements });
  } catch {
    fail(503, "The x402 facilitator is unavailable; retry shortly or use a prepaid key.", "x402_facilitator_unavailable");
  }
  if (!verified.isValid) refuse(verified.invalidReason ?? "invalid_payment", verified.payer);
  // One settlement per signed payload, durable across replicas (the quotes primary key is the claim).
  const claim = `x402r:${pay.network}:${sha256(JSON.stringify(pay.json.payload ?? pay.json))}`;
  const claimed = await ctx.db
    .insert(quotes)
    .values({ nonce: claim, priceUsdg: o.priceUnits, pricePico: usdgToPico(o.priceUnits), requestSha256: o.bodySha, modelId: o.modelId, expiresAt: new Date(Date.now() + ctx.cfg.fees.quoteTtlS * 1000), status: "paid", payer: verified.payer ?? null })
    .onConflictDoNothing()
    .returning({ nonce: quotes.nonce });
  if (!claimed.length) refuse("payment_already_used", verified.payer);
  let settled: FacilitatorAnswer;
  try {
    settled = await facilitator(s, "/settle", { x402Version, paymentPayload: pay.json, paymentRequirements });
  } catch (e) {
    settled = { success: false, errorReason: "settle_exact_failed" };
    log.warn("x402 remote settle failed", { network: pay.network, error: (e as Error).message.slice(0, 200) });
  }
  if (!settled.success || !settled.transaction) {
    await ctx.db.update(quotes).set({ status: "failed" }).where(eq(quotes.nonce, claim));
    return refuse(settled.errorReason ?? "settle_exact_failed", verified.payer);
  }
  const isEvm = pay.network.startsWith("base");
  const payer = String(settled.payer ?? verified.payer ?? "");
  if (isEvm ? !/^0x[0-9a-fA-F]{40}$/.test(payer) : !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payer)) {
    log.error("x402 remote payment settled without a usable payer; credit by hand", { network: pay.network, tx: settled.transaction });
    fail(502, "The payment settled but the facilitator did not name the payer.", "x402_payer_unknown");
  }
  const who = isEvm ? payer.toLowerCase() : payer; // EVM addresses in one spelling, base58 as is
  const accountId = isEvm ? walletAccountId(payer) : `ws_${payer}`;
  const wallet = isEvm ? who : `solana:${payer}`;
  const txHash = settled.transaction;
  await ctx.db.transaction(async (tx) => {
    await ensureAccount(tx, accountId, "wallet", wallet);
    await post(tx, { accountId, amount: usdgToPico(o.priceUnits), kind: "per_call_payment", ref: `x402:${pay.network}:${txHash}`, description: `x402 payment on ${pay.network}` });
    await tx.update(quotes).set({ status: "used", txHash, accountId, payer: who }).where(eq(quotes.nonce, claim));
  });
  const network = x402Version === 2 ? caip2Of(pay.network) : pay.network;
  return { accountId, payer: who, txHash, paymentResponse: b64({ success: true, transaction: txHash, network, payer: who }) };
}
