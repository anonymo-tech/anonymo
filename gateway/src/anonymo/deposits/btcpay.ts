// BTC and Lightning through a BTCPay Server store (Greenfield API). A key asks for an invoice in USD and names its refund
// address (a BTC address or a Lightning address); BTCPay quotes the BTC price. When BTCPay calls the webhook, we check the
// BTCPay-Sig HMAC over the raw body, then read the invoice back from BTCPay (never trusting the webhook body for amounts)
// and credit each settled payment once, keyed by its BTCPay payment id, at its payment method's quoted rate. Any
// webhook for one of our invoices (InvoicePaymentSettled included) reconciles all of its settled payments, so a
// partial payment that settles after the invoice expired is credited automatically and nothing is credited twice.
// The quoted rate holds only until the invoice expires, so only payments BTCPay received by then are credited, and
// never more than the invoice amount in total: a payment received late, and any excess, is held for an operator
// (otherwise a late payment would be a free option on the BTC price over BTCPay's monitoring window).

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { log } from "../../lib/util.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import type { BtcpayConfig } from "./config.ts";
import { anonymoBtcpayInvoices, anonymoDeposits } from "./schema.ts";
import type { AnonymoDepositSink } from "./sink.ts";
import { decimalProductToPico, decimalSumProductToPico } from "./units.ts";

export type BtcpayInvoice = {
  id: string; status: string; additionalStatus?: string; checkoutLink?: string; metadata?: Record<string, unknown>;
  /** The invoice amount in `currency` (we create every invoice in USD) and its expiry, in unix seconds. */
  amount?: string; currency?: string; expirationTime?: number;
};
export type BtcpayPaymentMethod = {
  paymentMethodId?: string;
  paymentMethod?: string;
  rate: string;
  paymentMethodPaid?: string;
  totalPaid?: string;
  /** `receivedDate`: when BTCPay first saw the payment, in unix seconds. */
  payments?: { id?: string; value: string; status: string; receivedDate?: number }[];
};

export type BtcpayClient = {
  createInvoice(o: { amountUsd: string; orderId: string }): Promise<BtcpayInvoice>;
  getInvoice(id: string): Promise<BtcpayInvoice>;
  getPaymentMethods(id: string): Promise<BtcpayPaymentMethod[]>;
};

export function greenfieldClient(cfg: BtcpayConfig, fetcher: typeof fetch = fetch): BtcpayClient {
  const base = `${cfg.url.replace(/\/$/, "")}/api/v1/stores/${encodeURIComponent(cfg.storeId)}/invoices`;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetcher(base + path, { ...init, headers: { authorization: `token ${cfg.apiKey}`, "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`btcpay ${init.method ?? "GET"} invoice failed (${res.status})`);
    return res.json() as Promise<any>;
  };
  return {
    createInvoice: ({ amountUsd, orderId }) => call("", { method: "POST", body: JSON.stringify({ amount: amountUsd, currency: "USD", metadata: { orderId } }) }),
    getInvoice: (id) => call(`/${encodeURIComponent(id)}`),
    getPaymentMethods: (id) => call(`/${encodeURIComponent(id)}/payment-methods`),
  };
}

/** BTCPay-Sig: "sha256=<hex HMAC-SHA256 of the raw body with the webhook secret>". Constant-time compare. */
export function verifyBtcpaySignature(secret: string, rawBody: string | Uint8Array, header: string | null | undefined): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header?.trim() ?? "");
  if (!m) return false;
  const want = createHmac("sha256", secret).update(rawBody).digest();
  const got = Buffer.from(m[1], "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Greenfield's aggregate paid fields include processing payments. Credit only settled payment values. */
export function settledUsdPico(methods: BtcpayPaymentMethod[]) {
  let total = 0n;
  for (const method of methods) {
    const amounts = method.payments?.filter((payment) => payment.status === "Settled").map((payment) => payment.value) ?? [];
    if (amounts.length) total += decimalSumProductToPico(amounts, method.rate);
  }
  return total;
}

/** Every settled payment on an invoice with a payment id, valued at its payment method's quoted rate. Unsettled
 *  payments (BTCPay counts mempool payments as paid) and payments without an id are never credited. */
export function settledPayments(methods: BtcpayPaymentMethod[]): { id: string; amount: Pico; receivedDate: number | null }[] {
  const out: { id: string; amount: Pico; receivedDate: number | null }[] = [];
  for (const method of methods)
    for (const payment of method.payments ?? []) {
      if (payment.status !== "Settled" || typeof payment.id !== "string" || !payment.id) continue;
      const amount = decimalProductToPico(payment.value, method.rate);
      const receivedDate = typeof payment.receivedDate === "number" && Number.isFinite(payment.receivedDate) ? payment.receivedDate : null;
      if (amount > 0n) out.push({ id: payment.id, amount, receivedDate });
    }
  // Earliest first, so the payments made in time take the invoice amount before any later one.
  return out.sort((a, b) => (a.receivedDate ?? Infinity) - (b.receivedDate ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The invoice amount in pico-USD, or null when BTCPay does not report a USD amount (then nothing is auto-credited). */
export function invoiceUsdPico(inv: BtcpayInvoice): Pico | null {
  if (inv.currency?.toUpperCase() !== "USD" || typeof inv.amount !== "string") return null;
  try {
    const v = usdToPico(inv.amount, "floor");
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Why a settled payment is held rather than credited: received after the invoice expired, or not datable. */
export function latePaymentReason(inv: BtcpayInvoice, receivedDate: number | null): string | undefined {
  if (typeof inv.expirationTime !== "number" || !Number.isFinite(inv.expirationTime) || receivedDate === null) return "btcpay_undated";
  return receivedDate > inv.expirationTime ? "btcpay_late" : undefined;
}

/** The deposit ref of one BTCPay payment: one credit per settled payment, ever. */
export const btcpayPaymentRef = (invoiceId: string, paymentId: string) => `btcpay:${invoiceId}:${paymentId}`;
/** Before per-payment credit, an invoice was credited once under this ref. Such an invoice is never credited again. */
export const btcpayLegacyRef = (invoiceId: string) => `btcpay:${invoiceId}`;

/** Handle one verified webhook body: credit every settled payment of a known invoice that is not credited yet. */
export async function handleBtcpayEvent(db: Db, client: BtcpayClient, sink: AnonymoDepositSink, body: { type?: string; invoiceId?: string }) {
  if (!body.invoiceId || typeof body.invoiceId !== "string") return { status: "ignored" as const };
  const [inv] = await db.select().from(anonymoBtcpayInvoices).where(eq(anonymoBtcpayInvoices.invoiceId, body.invoiceId));
  if (!inv) return { status: "ignored" as const };
  const fresh = await client.getInvoice(inv.invoiceId);
  const payments = settledPayments(await client.getPaymentMethods(inv.invoiceId));
  if (!payments.length) {
    if (fresh.status === "Expired" || fresh.status === "Invalid") await db.update(anonymoBtcpayInvoices).set({ status: "expired" }).where(eq(anonymoBtcpayInvoices.invoiceId, inv.invoiceId));
    return { status: "pending" as const, invoice: fresh.status };
  }
  const [legacy] = await db.select({ ref: anonymoDeposits.ref }).from(anonymoDeposits).where(eq(anonymoDeposits.ref, btcpayLegacyRef(inv.invoiceId)));
  if (legacy) return { status: "duplicate" as const, amount: 0n };
  const maxPico = invoiceUsdPico(fresh);
  let credited = 0n;
  let held: string | undefined;
  for (const p of payments) {
    const holdReason = maxPico === null ? "btcpay_amount_unknown" : latePaymentReason(fresh, p.receivedDate);
    const r = await sink.creditWith(
      { keyHash: inv.keyHash, chain: inv.refundChain as "btc" | "ln", amount: p.amount, ref: btcpayPaymentRef(inv.invoiceId, p.id), sourceAddr: inv.refundAddr },
      { token: "BTC", ...(holdReason ? { holdReason } : {}), ...(maxPico !== null ? { cap: { scope: `btcpay:${inv.invoiceId}:`, maxPico } } : {}) },
    );
    if (r.credited) credited += p.amount;
    if (r.held) held ??= r.held;
  }
  await db.update(anonymoBtcpayInvoices).set({ status: held ? "held" : "credited" }).where(eq(anonymoBtcpayInvoices.invoiceId, inv.invoiceId));
  if (held) log.warn("anonymo btcpay credit held", { invoice: inv.invoiceId, reason: held });
  return { status: credited > 0n ? ("credited" as const) : held ? ("held" as const) : ("duplicate" as const), amount: credited };
}

/** A refund destination for BTC (a mainnet or testnet address) or Lightning (a Lightning address, user@host). */
export function refundTarget(addr: string): { chain: "btc" | "ln"; address: string } | null {
  const a = addr.trim();
  if (/^(bc1|tb1)[02-9ac-hj-np-z]{8,87}$/i.test(a)) return { chain: "btc", address: a.toLowerCase() };
  if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return { chain: "btc", address: a };
  if (/^[a-z0-9._-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i.test(a)) return { chain: "ln", address: a.toLowerCase() };
  return null;
}
