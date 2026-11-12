// WS05: x402 per call on Base and Solana USDC, settled through a (mock) x402 facilitator, beside the RHC flow.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { balanceOf, verifyInvariants } from "../../src/ledger/ledger.ts";
import { configureRemoteX402, remoteX402Settings, REMOTE_NETWORKS } from "../../src/pay/x402-networks.ts";
import { quotes } from "../../src/db/schema.ts";
import { base58Encode } from "../../src/anonymo/deposits/base58.ts";
import { startRouter, type Harness, MODELS } from "../helpers.ts";

const CHAT = "/v1/chat/completions";
const BASE_PAY_TO = "0x00000000000000000000000000000000000ba5e1";
const SOL_PAY_TO = base58Encode(randomBytes(32));
const FEE_PAYER = base58Encode(randomBytes(32));
const EVM_PAYER = "0x00000000000000000000000000000000000Fa1e5";
const SOL_PAYER = base58Encode(randomBytes(32));
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const body = () => ({ model: MODELS.llama.slug, max_tokens: 50, messages: [{ role: "user", content: "pay " + randomBytes(4).toString("hex") }] });

let h: Harness;
const seen: { path: string; body: any }[] = [];
const facilitator = { valid: true, settle: true, down: false };
const fetcher = (async (url: string, init: RequestInit) => {
  if (facilitator.down) throw new Error("connect refused");
  const path = new URL(url).pathname;
  const b = JSON.parse(String(init.body));
  seen.push({ path, body: b });
  const solana = String(b.paymentRequirements.network).startsWith("solana");
  const payer = solana ? SOL_PAYER : EVM_PAYER;
  if (path === "/verify") return Response.json(facilitator.valid ? { isValid: true, payer } : { isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer });
  if (path === "/settle") return Response.json(facilitator.settle ? { success: true, transaction: solana ? base58Encode(randomBytes(64)) : `0x${randomBytes(32).toString("hex")}`, network: b.paymentRequirements.network, payer } : { success: false, errorReason: "insufficient_funds" });
  return new Response("no", { status: 404 });
}) as unknown as typeof fetch;

beforeAll(async () => {
  h = await startRouter();
  h.chain.noCallPay = true; // no CallPay, no RHC x402: only the Base and Solana rails
  const s = remoteX402Settings({ ANONYMO_X402_FACILITATOR_URL: "https://facilitator.test", ANONYMO_X402_BASE_PAY_TO: BASE_PAY_TO, ANONYMO_X402_SOLANA_PAY_TO: SOL_PAY_TO, ANONYMO_X402_SOLANA_FEE_PAYER: FEE_PAYER })!;
  configureRemoteX402(h.ctx, { ...s, fetcher });
});
afterAll(async () => h?.close());

const unpaid = async () => {
  const json = body();
  const r = await h.request(CHAT, { method: "POST", json });
  expect(r.status).toBe(402);
  return { json, res: r, body: await r.json() };
};

describe("x402 on Base and Solana", () => {
  test("settings: off without a facilitator, and Solana needs the fee payer", () => {
    expect(remoteX402Settings({})).toBeNull();
    expect(remoteX402Settings({ ANONYMO_X402_FACILITATOR_URL: "https://f.test" })).toBeNull();
    expect(() => remoteX402Settings({ ANONYMO_X402_FACILITATOR_URL: "https://f.test", ANONYMO_X402_SOLANA_PAY_TO: SOL_PAY_TO })).toThrow(/FEE_PAYER/);
  });

  test("the 402 offers USDC on Base and Solana with our payTo, in v1 and v2 shape", async () => {
    const { body: b, res } = await unpaid();
    const base = b.accepts.find((a: any) => a.network === "base");
    const sol = b.accepts.find((a: any) => a.network === "solana");
    expect(base).toMatchObject({ scheme: "exact", payTo: BASE_PAY_TO, asset: REMOTE_NETWORKS.base.asset, extra: { name: "USD Coin", version: "2" } });
    expect(sol).toMatchObject({ scheme: "exact", payTo: SOL_PAY_TO, asset: REMOTE_NETWORKS.solana.asset, extra: { feePayer: FEE_PAYER } });
    expect(BigInt(base.maxAmountRequired)).toBeGreaterThan(0n);
    const v2 = unb64(res.headers.get("payment-required")!);
    expect(v2.accepts.map((a: any) => a.network).sort()).toEqual(["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  });

  test("a Base payment is verified and settled against our own requirement, credited to the payer, and served", async () => {
    const { json, body: b } = await unpaid();
    const req = b.accepts.find((a: any) => a.network === "base");
    const payment = { x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x" + "ab".repeat(65), authorization: { from: EVM_PAYER, to: BASE_PAY_TO, value: req.maxAmountRequired, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } } };
    seen.length = 0;
    const r = await h.request(CHAT, { method: "POST", headers: { "x-payment": b64(payment) }, json });
    expect(r.status).toBe(200);
    expect(seen.map((s) => s.path)).toEqual(["/verify", "/settle"]);
    // The requirement the facilitator checked is ours, not the client's.
    expect(seen[0].body.paymentRequirements).toMatchObject({ payTo: BASE_PAY_TO, maxAmountRequired: req.maxAmountRequired, asset: REMOTE_NETWORKS.base.asset });
    const settled = unb64(r.headers.get("x-payment-response")!);
    expect(settled).toMatchObject({ success: true, network: "base", payer: EVM_PAYER.toLowerCase() });
    const bal = await balanceOf(h.ctx.db, `w_${EVM_PAYER.slice(2).toLowerCase()}`);
    expect(bal.balance).toBeGreaterThanOrEqual(0n); // paid in full, the call drew its cost, change stays
    expect((await verifyInvariants(h.ctx.db)).ok).toBe(true);
    // The same signed payload cannot pay twice.
    const again = await h.request(CHAT, { method: "POST", headers: { "x-payment": b64(payment) }, json });
    expect(again.status).toBe(402);
    expect((await again.json()).error).toBe("payment_already_used");
  });

  test("a Solana v2 payment (PAYMENT-SIGNATURE, CAIP-2 network) settles and credits a Solana wallet account", async () => {
    const { json, body: b } = await unpaid();
    const req = b.accepts.find((a: any) => a.network === "solana");
    const payment = { x402Version: 2, accepted: { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: req.maxAmountRequired, payTo: SOL_PAY_TO }, payload: { transaction: randomBytes(200).toString("base64") } };
    seen.length = 0;
    const r = await h.request(CHAT, { method: "POST", headers: { "payment-signature": b64(payment) }, json });
    expect(r.status).toBe(200);
    expect(seen[0].body.paymentRequirements).toMatchObject({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: SOL_PAY_TO, amount: req.maxAmountRequired });
    const [q] = await h.ctx.db.select().from(quotes).where(eq(quotes.accountId, `ws_${SOL_PAYER}`));
    expect(q.status).toBe("used");
    expect(unb64(r.headers.get("payment-response")!).network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  });

  test("an invalid payment, a failed settlement and a down facilitator are refused without serving", async () => {
    const reqs = () => h.mocks.alpha.stats.requests;
    const pay = async (json: unknown, b: any) => {
      const req = b.accepts.find((a: any) => a.network === "base");
      const payment = { x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x" + "cd".repeat(65), authorization: { from: EVM_PAYER, to: BASE_PAY_TO, value: req.maxAmountRequired, validAfter: "0", validBefore: "9999999999", nonce: "0x" + randomBytes(32).toString("hex") } } };
      return h.request(CHAT, { method: "POST", headers: { "x-payment": b64(payment) }, json });
    };
    const before = reqs();
    facilitator.valid = false;
    let u = await unpaid();
    let r = await pay(u.json, u.body);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("invalid_exact_evm_payload_signature");
    facilitator.valid = true;
    facilitator.settle = false;
    u = await unpaid();
    r = await pay(u.json, u.body);
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("insufficient_funds");
    facilitator.settle = true;
    facilitator.down = true;
    u = await unpaid();
    expect((await pay(u.json, u.body)).status).toBe(503);
    facilitator.down = false;
    expect(reqs()).toBe(before);
  });
});
