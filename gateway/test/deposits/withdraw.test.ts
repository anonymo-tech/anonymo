// WS05 withdrawals: only to a source address of the same key, never above the available balance or what came from that
// source, never between keys, never paused, idempotent, and a payout rail that is down only delays them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { holds, keys } from "../../src/db/schema.ts";
import { reserve, verifyInvariants } from "../../src/ledger/ledger.ts";
import { usdToPico } from "../../src/lib/money.ts";
import { anonymoKeys, anonymoWithdrawals } from "../../src/anonymo/deposits/schema.ts";
import { processPendingWithdrawals, revertWithdrawal } from "../../src/anonymo/deposits/withdraw.ts";
import { moneyHarness, type MoneyHarness } from "./harness.ts";

let m: MoneyHarness;
let paused: MoneyHarness;
beforeAll(async () => {
  m = await moneyHarness();
  paused = await moneyHarness({ router: m.h, config: { depositsPaused: true } });
});
afterAll(async () => m?.close());

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
let idem = 0;
const withdraw = (h: MoneyHarness, k: { auth: Record<string, string> }, body: Record<string, unknown>, key = `idem-${++idem}-xxxxxxxx`) =>
  h.req("/withdraw", { headers: { ...k.auth, "idempotency-key": key }, json: body });

describe("POST /withdraw", () => {
  test("pays back to the source address, debits the ledger, and reports it", async () => {
    const k = await m.newKey();
    await m.deposit(k.keyHash, "10", A);
    const r = await withdraw(m, k, { chain: "base", to: A.toUpperCase().replace("0X", "0x"), amount_usd: "4" });
    expect(r.status).toBe(202);
    const w = (await r.json()).withdrawal;
    expect(w.status).toBe("sent");
    expect(w.to).toBe(A);
    expect(w.token).toBe("USDC");
    expect(m.payout.sent.get(w.id)?.amountPico).toBe(usdToPico("4"));
    const bal = await (await m.req("/balance", { headers: k.auth })).json();
    expect(bal.available_usd).toBe(6);
    expect(bal.withdraw_to).toEqual([{ chain: "base", address: A, max_usd: 6 }]);
    expect((await verifyInvariants(m.h.ctx.db)).ok).toBe(true);
  });

  test("refuses any address the key's deposits did not come from, including another key's source", async () => {
    const k1 = await m.newKey();
    const k2 = await m.newKey();
    await m.deposit(k1.keyHash, "10", A);
    await m.deposit(k2.keyHash, "10", B);
    const r = await withdraw(m, k1, { chain: "base", to: B });
    expect(r.status).toBe(403);
    expect((await r.json()).error.type).toBe("not_source_address");
    expect((await withdraw(m, k1, { chain: "arbitrum", to: A })).status).toBe(403); // same address, other chain: not a source
    expect(m.payout.sent.size).toBeGreaterThan(0);
    expect([...m.payout.sent.values()].some((p) => p.to === B)).toBe(false);
  });

  test("never more than the balance, nor more than came from that source", async () => {
    const k = await m.newKey();
    await m.deposit(k.keyHash, "3", A);
    await m.deposit(k.keyHash, "5", B);
    const over = await withdraw(m, k, { chain: "base", to: A, amount_usd: "4" });
    expect(over.status).toBe(403);
    expect((await over.json()).error.type).toBe("exceeds_source");
    expect((await withdraw(m, k, { chain: "base", to: B, amount_usd: "9" })).status).toBe(402);
    // "all" takes the most this source may receive.
    const all = await (await withdraw(m, k, { chain: "base", to: A, amount_usd: "all" })).json();
    expect(all.withdrawal.amount_usd).toBe(3);
    expect((await withdraw(m, k, { chain: "base", to: A, amount_usd: "all" })).status).toBe(402); // nothing left for A
  });

  test("open holds are not withdrawable", async () => {
    const k = await m.newKey();
    await m.deposit(k.keyHash, "10", A);
    const [row] = await m.h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
    await reserve(m.h.ctx.db, { id: `hold-${k.keyHash.slice(0, 8)}`, accountId: row.accountId, keyHash: k.keyHash, amount: usdToPico("8") });
    expect((await withdraw(m, k, { chain: "base", to: A, amount_usd: "3" })).status).toBe(402);
    expect((await (await withdraw(m, k, { chain: "base", to: A, amount_usd: "all" })).json()).withdrawal.amount_usd).toBe(2);
    await m.h.ctx.db.update(holds).set({ status: "released" }).where(eq(holds.id, `hold-${k.keyHash.slice(0, 8)}`));
  });

  test("idempotent: a retry returns the first withdrawal; other terms under the same key are a 409", async () => {
    const k = await m.newKey();
    await m.deposit(k.keyHash, "10", A);
    const first = await (await withdraw(m, k, { chain: "base", to: A, amount_usd: "2" }, "same-key-123456")).json();
    const again = await withdraw(m, k, { chain: "base", to: A, amount_usd: "2" }, "same-key-123456");
    expect(again.status).toBe(200);
    const j = await again.json();
    expect(j.replay).toBe(true);
    expect(j.withdrawal.id).toBe(first.withdrawal.id);
    expect((await withdraw(m, k, { chain: "base", to: A, amount_usd: "3" }, "same-key-123456")).status).toBe(409);
    expect((await m.req("/withdraw", { headers: k.auth, json: { chain: "base", to: A } })).status).toBe(400); // no key at all
    const rows = await m.h.ctx.db.select().from(anonymoWithdrawals).where(eq(anonymoWithdrawals.keyHash, k.keyHash));
    expect(rows.length).toBe(1);
  });

  test("never paused: works with deposits paused, and a down payout rail only delays it", async () => {
    const k = await paused.newKey();
    expect(k.deposit).toEqual({ paused: true });
    expect((await paused.req("/deposits/btcpay", { headers: k.auth, json: { amount_usd: "10", refund_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" } })).status).toBe(503);
    await paused.deposit(k.keyHash, "10", A); // a deposit already on chain is still credited
    paused.payout.failing = true;
    const r = await withdraw(paused, k, { chain: "base", to: A, amount_usd: "5" });
    expect(r.status).toBe(202);
    const w = (await r.json()).withdrawal;
    expect(w.status).toBe("pending");
    expect((await (await paused.req("/balance", { headers: k.auth })).json()).available_usd).toBe(5);
    paused.payout.failing = false;
    expect((await processPendingWithdrawals(paused.h.ctx.db, paused.payout)).sent).toBeGreaterThanOrEqual(1);
    const [row] = await paused.h.ctx.db.select().from(anonymoWithdrawals).where(eq(anonymoWithdrawals.id, w.id));
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(2);
    expect(paused.payout.sent.get(w.id)?.to).toBe(A);
  });

  test("an operator revert returns the amount exactly once", async () => {
    const k = await m.newKey();
    await m.deposit(k.keyHash, "10", A);
    m.payout.failing = true;
    const w = (await (await withdraw(m, k, { chain: "base", to: A, amount_usd: "6" })).json()).withdrawal;
    m.payout.failing = false;
    expect(await revertWithdrawal(m.h.ctx.db, w.id)).toBe(true);
    expect(await revertWithdrawal(m.h.ctx.db, w.id)).toBe(false);
    expect((await (await m.req("/balance", { headers: k.auth })).json()).available_usd).toBe(10);
    expect((await (await withdraw(m, k, { chain: "base", to: A, amount_usd: "all" })).json()).withdrawal.amount_usd).toBe(10); // the source allowance is back too
  });

  test("a wallet-minted key may also withdraw to its SIWE wallet on an EVM chain", async () => {
    const k = await m.newKey();
    const wallet = "0x00000000000000000000000000000000000000c7";
    await m.h.ctx.db.update(anonymoKeys).set({ wallet }).where(eq(anonymoKeys.keyHash, k.keyHash));
    await m.deposit(k.keyHash, "10", "So1ana1111111111111111111111111111111111111", "solana");
    expect((await withdraw(m, k, { chain: "arbitrum", to: wallet, amount_usd: "7" })).status).toBe(202);
    expect((await withdraw(m, k, { chain: "solana", to: "So1ana1111111111111111111111111111111111111", amount_usd: "all" })).status).toBe(202);
    expect((await (await m.req("/balance", { headers: k.auth })).json()).available_usd).toBe(0);
  });

  test("bad input", async () => {
    const k = await m.newKey();
    await m.deposit(k.keyHash, "10", A);
    expect((await withdraw(m, k, { chain: "dogecoin", to: A })).status).toBe(400);
    expect((await withdraw(m, k, { chain: "base", to: A, token: "BTC" })).status).toBe(400);
    expect((await withdraw(m, k, { chain: "base", to: A, amount_usd: "0.5" })).status).toBe(400); // below the $1 minimum
    expect((await m.req("/withdraw", { json: { chain: "base", to: A } })).status).toBe(401);
  });
});
