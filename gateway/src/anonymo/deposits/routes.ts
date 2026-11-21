// Credits (spec: Backend §7, §11):
//   GET  /balance            → balance, open holds, available, and where it can be withdrawn to
//   POST /withdraw           → pay unused credit back to a source address (Idempotency-Key required; never paused)
//   GET  /withdrawals        → this key's withdrawals
//   GET  /deposits           → deposit instructions and this key's recent deposits
//   POST /deposits/btcpay    → a BTCPay invoice (BTC or Lightning) for an amount in USD
//   POST /webhooks/btcpay    → BTCPay's signed webhook

import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Ctx } from "../../context.ts";
import { requireKey } from "../../api/auth.ts";
import { readJson } from "../../api/common.ts";
import { balanceOf } from "../../ledger/ledger.ts";
import { ApiError, fail } from "../../lib/errors.ts";
import { picoToUsd, usdToPico } from "../../lib/money.ts";
import { uid } from "../../lib/util.ts";
import { keysRoutes } from "../keys/routes.ts";
import { handleBtcpayEvent, refundTarget, verifyBtcpaySignature } from "./btcpay.ts";
import { depositInstructions } from "./instructions.ts";
import { anonymoBtcpayInvoices, anonymoDeposits, anonymoWithdrawals } from "./schema.ts";
import { registerMoneyJobs, type MoneyDeps } from "./services.ts";
import { attemptPayout, coinCreditPico, recentBitcoinCreditPico, requestWithdrawal, withdrawalJson, withdrawDestinations } from "./withdraw.ts";

const withdrawBody = z
  .object({
    chain: z.string().max(16),
    to: z.string().min(1).max(128),
    token: z.string().max(8).optional(),
    amount_usd: z.union([z.literal("all"), z.string().regex(/^\d{1,12}(\.\d{1,12})?$/), z.number().positive()]).optional(),
    idempotency_key: z.string().max(128).optional(),
  })
  .strict();
const invoiceBody = z.object({ amount_usd: z.union([z.string().regex(/^\d{1,9}(\.\d{1,2})?$/), z.number().positive()]), refund_address: z.string().min(3).max(200) }).strict();

export function moneyRoutes(app: Hono, ctx: Ctx, deps: MoneyDeps, o: { jobs?: boolean } = {}) {
  const apiCors = cors({ origin: "*", allowHeaders: ["authorization", "content-type", "idempotency-key"], allowMethods: ["GET", "POST", "PATCH", "OPTIONS"] });
  for (const p of ["/keys", "/keys/*", "/balance", "/withdraw", "/withdrawals", "/deposits", "/deposits/*"]) app.use(p, apiCors);

  keysRoutes(app, ctx, deps);

  app.get("/balance", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const b = await balanceOf(ctx.db, key.accountId);
    const dests = await withdrawDestinations(ctx.db, key.keyHash);
    const available = b.available > 0n ? b.available : 0n;
    const coin = await coinCreditPico(ctx.db, key.keyHash);
    const settling = await recentBitcoinCreditPico(ctx.db, key.keyHash);
    const cashable = available > coin + settling ? available - coin - settling : 0n;
    return c.json({
      balance_usd: picoToUsd(b.balance),
      held_usd: picoToUsd(b.held),
      available_usd: picoToUsd(available),
      // Paid in the coin: spendable on usage, never withdrawn.
      usage_only_usd: picoToUsd(available < coin ? available : coin),
      // Credit from BTC or Lightning in the last 24 hours: spendable now, withdrawable a day after it arrived.
      ...(settling > 0n ? { bitcoin_hold_usd: picoToUsd(settling) } : {}),
      withdraw_to: [...dests.values()].map((d) => ({ chain: d.chain, address: d.address, max_usd: picoToUsd(d.remaining === null || d.remaining > cashable ? cashable : d.remaining) })),
    });
  });

  app.post("/withdraw", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const body = withdrawBody.parse(await readJson(c));
    const idempotencyKey = c.req.header("idempotency-key") ?? body.idempotency_key ?? "";
    const amountUsd = body.amount_usd === undefined ? undefined : typeof body.amount_usd === "number" ? String(body.amount_usd) : body.amount_usd;
    const { row, replay } = await requestWithdrawal(ctx.db, { minPico: usdToPico(deps.config.withdrawMinUsd) }, { keyHash: key.keyHash, accountId: key.accountId, chain: body.chain, to: body.to, token: body.token, amountUsd, idempotencyKey });
    const out = replay ? row : await attemptPayout(ctx.db, deps.payout, row.id);
    return c.json({ withdrawal: withdrawalJson(out), replay }, replay ? 200 : 202);
  });

  app.get("/withdrawals", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const rows = await ctx.db.select().from(anonymoWithdrawals).where(eq(anonymoWithdrawals.keyHash, key.keyHash)).orderBy(desc(anonymoWithdrawals.createdAt)).limit(100);
    return c.json({ data: rows.map(withdrawalJson) });
  });

  app.get("/deposits", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    const rows = await ctx.db.select().from(anonymoDeposits).where(eq(anonymoDeposits.keyHash, key.keyHash)).orderBy(desc(anonymoDeposits.createdAt)).limit(100);
    return c.json({
      instructions: await depositInstructions(ctx, deps, key.keyHash),
      data: rows.map((r) => ({ ref: r.ref, chain: r.chain, token: r.token, amount_usd: picoToUsd(r.amountPico), from: r.sourceAddr, status: r.status, created_at: r.createdAt.toISOString() })),
    });
  });

  app.post("/deposits/btcpay", async (c) => {
    const key = await requireKey(ctx, c.req.header("authorization"));
    if (deps.config.depositsPaused) fail(503, "New deposits are paused. Withdrawals are not affected.", "deposits_paused");
    if (!deps.btcpay) fail(404, "BTC and Lightning deposits are not configured on this router.", "btcpay_unavailable");
    const body = invoiceBody.parse(await readJson(c));
    const refund = refundTarget(body.refund_address);
    if (!refund) fail(400, "refund_address must be a Bitcoin address or a Lightning address (name@host). Withdrawals of this deposit go there.", "invalid_refund_address");
    const amountUsd = typeof body.amount_usd === "number" ? body.amount_usd.toFixed(2) : body.amount_usd;
    if (usdToPico(amountUsd) < usdToPico(deps.config.withdrawMinUsd)) fail(400, `The smallest deposit is $${deps.config.withdrawMinUsd}.`, "below_minimum");
    let inv;
    try {
      inv = await deps.btcpay.createInvoice({ amountUsd, orderId: uid("anm_") }); // the order id is random: nothing links it to the key at BTCPay
    } catch {
      fail(503, "BTCPay is unavailable; try again shortly.", "btcpay_unavailable");
    }
    await ctx.db.insert(anonymoBtcpayInvoices).values({ invoiceId: inv.id, keyHash: key.keyHash, refundChain: refund.chain, refundAddr: refund.address });
    return c.json({ invoice_id: inv.id, checkout_link: inv.checkoutLink ?? null, amount_usd: amountUsd, refund: refund }, 201);
  });

  app.post("/webhooks/btcpay", async (c) => {
    if (!deps.btcpay || !deps.config.btcpay) fail(404, "BTCPay is not configured.", "btcpay_unavailable");
    const raw = await c.req.text();
    if (raw.length > 64 * 1024) fail(413, "Webhook body too large.", "payload_too_large");
    if (!verifyBtcpaySignature(deps.config.btcpay.webhookSecret, raw, c.req.header("btcpay-sig"))) fail(401, "Bad BTCPay-Sig.", "invalid_signature");
    let body: { type?: string; invoiceId?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      fail(400, "Webhook body is not JSON.", "invalid_request");
    }
    try {
      const r = await handleBtcpayEvent(ctx.db, deps.btcpay, deps.sink, body);
      return c.json({ ok: true, status: r.status });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      fail(503, "Could not confirm the invoice with BTCPay; it will retry.", "btcpay_unavailable"); // BTCPay redelivers on non-2xx
    }
  });

  if (o.jobs) registerMoneyJobs(ctx, deps);
}
