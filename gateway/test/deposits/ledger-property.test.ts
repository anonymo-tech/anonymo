// WS05 property test (AGENTS.md: money rules need property tests). Random sequences of deposits (some from sanctioned
// senders, some replayed), spends (hold → settle), withdrawals (to sources, to strangers, to other keys' sources, with
// replays and a flaky payout) across several keys. After every step:
//   - the ledger invariants hold (balance = Σ ledger, held = Σ open holds);
//   - no balance is negative, and each key's balance = credited deposits − spend − live withdrawals;
//   - every withdrawal went to one of that key's own sources, and never more to a source than came from it;
//   - a sanctioned sender is never credited.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, ne, sql } from "drizzle-orm";
import { accounts, keys } from "../../src/db/schema.ts";
import { reserve, settle, verifyInvariants } from "../../src/ledger/ledger.ts";
import { usdToPico, type Pico } from "../../src/lib/money.ts";
import { anonymoDeposits, anonymoWithdrawals } from "../../src/anonymo/deposits/schema.ts";
import { processPendingWithdrawals, requestWithdrawal } from "../../src/anonymo/deposits/withdraw.ts";
import { isApiError } from "../../src/lib/errors.ts";
import { moneyHarness, SANCTIONED_EVM, type MoneyHarness } from "./harness.ts";

// Small seeded PRNG (mulberry32), so a failure prints a seed that reproduces it.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let m: MoneyHarness;
beforeAll(async () => {
  m = await moneyHarness();
});
afterAll(async () => m?.close());

const SOURCES = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3", "0x00000000000000000000000000000000000000a4"];

async function runSeed(seed: number, steps: number) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const cents = (max: number) => usdToPico((Math.floor(r() * max * 100) / 100 + 0.01).toFixed(2));
  const ks: { keyHash: string; accountId: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const k = await m.newKey();
    const [row] = await m.h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.keyHash));
    ks.push({ keyHash: k.keyHash, accountId: row.accountId });
  }
  const refs: string[] = [];
  const idems: { key: string; keyHash: string; body: Parameters<typeof requestWithdrawal>[2] }[] = [];
  let n = 0;
  for (let step = 0; step < steps; step++) {
    const k = pick(ks);
    const op = r();
    if (op < 0.35) {
      // deposit: new, replayed, or from a sanctioned sender
      const replay = refs.length && r() < 0.15;
      const ref = replay ? pick(refs) : `base:${seed}:${++n}:0`;
      const from = r() < 0.08 ? SANCTIONED_EVM : pick(SOURCES);
      if (!replay) refs.push(ref);
      const owner = replay ? (await m.h.ctx.db.select({ keyHash: anonymoDeposits.keyHash }).from(anonymoDeposits).where(eq(anonymoDeposits.ref, ref)))[0]?.keyHash ?? k.keyHash : k.keyHash;
      await m.deps.sink.credit({ keyHash: owner, chain: "base", amount: cents(20), ref, sourceAddr: from });
    } else if (op < 0.6) {
      // spend: hold then settle at or below the hold (refused when the balance is short — that is fine)
      const id = `p${seed}-${++n}`;
      try {
        const amount = cents(5);
        await reserve(m.h.ctx.db, { id, accountId: k.accountId, keyHash: k.keyHash, amount });
        await settle(m.h.ctx.db, id, (amount * BigInt(Math.floor(r() * 101))) / 100n);
      } catch (e) {
        if (!isApiError(e)) throw e;
      }
    } else if (op < 0.95) {
      // withdraw: to a source (any key's), a stranger, or a replay of an earlier request
      m.payout.failing = r() < 0.2;
      const replay = idems.length && r() < 0.15 ? pick(idems) : null;
      const body = replay?.body ?? { keyHash: k.keyHash, accountId: k.accountId, chain: "base", to: r() < 0.15 ? "0x00000000000000000000000000000000000000ff" : pick(SOURCES), amountUsd: r() < 0.3 ? "all" : (Math.floor(r() * 1500) / 100 + 1).toFixed(2), idempotencyKey: `prop-${seed}-${++n}` };
      try {
        const out = await requestWithdrawal(m.h.ctx.db, { minPico: usdToPico("1") }, body);
        if (!out.replay) idems.push({ key: body.idempotencyKey, keyHash: body.keyHash, body });
      } catch (e) {
        if (!isApiError(e)) throw e;
      }
    } else {
      m.payout.failing = r() < 0.3;
      await processPendingWithdrawals(m.h.ctx.db, m.payout);
    }
    await check(ks, seed, step);
  }
  // The run must have exercised the interesting paths, not refused everything.
  const made = await m.h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(anonymoWithdrawals).where(sql`${anonymoWithdrawals.keyHash} in ${ks.map((k) => k.keyHash)}`);
  const credited = await m.h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(anonymoDeposits).where(sql`${anonymoDeposits.keyHash} in ${ks.map((k) => k.keyHash)} and ${anonymoDeposits.status} = 'credited'`);
  expect(made[0].n, `seed ${seed}: no withdrawal was made`).toBeGreaterThan(0);
  expect(credited[0].n, `seed ${seed}: nothing was credited`).toBeGreaterThan(0);
}

async function check(ks: { keyHash: string; accountId: string }[], seed: number, step: number) {
  const where = `seed ${seed} step ${step}`;
  const inv = await verifyInvariants(m.h.ctx.db);
  expect(inv.ok, where).toBe(true);
  for (const k of ks) {
    const [a] = await m.h.ctx.db.select().from(accounts).where(eq(accounts.id, k.accountId));
    const balance = a?.balance ?? 0n;
    expect(balance >= 0n, `${where}: negative balance`).toBe(true);
    const [dep] = await m.h.ctx.db.select({ s: sql<string>`coalesce(sum(${anonymoDeposits.amountPico}), 0)` }).from(anonymoDeposits).where(and(eq(anonymoDeposits.keyHash, k.keyHash), eq(anonymoDeposits.status, "credited")));
    const [wd] = await m.h.ctx.db.select({ s: sql<string>`coalesce(sum(${anonymoWithdrawals.amountPico}), 0)` }).from(anonymoWithdrawals).where(and(eq(anonymoWithdrawals.keyHash, k.keyHash), ne(anonymoWithdrawals.status, "reverted")));
    const [spent] = await m.h.ctx.db.execute(sql`select coalesce(sum(-amount), 0) as s from ledger where account_id = ${k.accountId} and kind not in ('deposit', 'withdraw')`).then((x) => ((x as { rows?: { s: string }[] }).rows ?? (x as unknown as { s: string }[])));
    expect(balance, `${where}: balance = deposits − spend − withdrawals`).toBe(BigInt(dep.s) - BigInt(spent.s) - BigInt(wd.s));
    // Withdrawals: only to this key's credited sources, and never more to one than came from it.
    const sources = await m.h.ctx.db.select({ to: anonymoDeposits.sourceAddr, s: sql<string>`sum(${anonymoDeposits.amountPico})` }).from(anonymoDeposits).where(and(eq(anonymoDeposits.keyHash, k.keyHash), eq(anonymoDeposits.status, "credited"))).groupBy(anonymoDeposits.sourceAddr);
    const cap = new Map<string, Pico>(sources.map((s) => [s.to, BigInt(s.s)]));
    const outs = await m.h.ctx.db.select({ to: anonymoWithdrawals.toAddr, s: sql<string>`sum(${anonymoWithdrawals.amountPico})` }).from(anonymoWithdrawals).where(and(eq(anonymoWithdrawals.keyHash, k.keyHash), ne(anonymoWithdrawals.status, "reverted"))).groupBy(anonymoWithdrawals.toAddr);
    for (const o of outs) {
      expect(cap.has(o.to), `${where}: withdrawal to a non-source ${o.to}`).toBe(true);
      expect(BigInt(o.s) <= cap.get(o.to)!, `${where}: more to ${o.to} than came from it`).toBe(true);
      expect(o.to).not.toBe(SANCTIONED_EVM);
    }
    expect(cap.has(SANCTIONED_EVM), `${where}: sanctioned sender credited`).toBe(false);
  }
  // Every payout the rail made matches a recorded withdrawal, to the same address, for the same amount.
  for (const [id, p] of m.payout.sent) {
    const [w] = await m.h.ctx.db.select().from(anonymoWithdrawals).where(eq(anonymoWithdrawals.id, id));
    expect(w?.toAddr, `${where}: payout without a withdrawal`).toBe(p.to);
    expect(w.amountPico).toBe(p.amountPico);
  }
}

describe("ledger invariants under random deposit, spend and withdraw sequences", () => {
  const seeds = (process.env.WS05_PROPERTY_SEEDS ?? "1,2,3,4,5,6").split(",").map(Number);
  for (const seed of seeds) test(`seed ${seed}`, () => runSeed(seed, 60), 60_000);
});
