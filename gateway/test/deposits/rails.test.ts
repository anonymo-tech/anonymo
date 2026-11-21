// WS05 deposit rails against mock chains: the sink (idempotent, OFAC hold), EVM (confirmations, allowlist, sender as
// source), Solana (Conclave-style transfer verification), Tron (mock TronGrid) and BTCPay (signed webhook, BTCPay quote).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { HDKey } from "viem/accounts";
import type { Hex } from "viem";
import { accounts, keys, ledger } from "../../src/db/schema.ts";
import { verifyInvariants } from "../../src/ledger/ledger.ts";
import { usdToPico } from "../../src/lib/money.ts";
import { anonymoDeposits } from "../../src/anonymo/deposits/schema.ts";
import { ensureDepositAddress, evmKeyCommit, tronAddressOfPublicKey } from "../../src/anonymo/deposits/addresses.ts";
import { base58Encode } from "../../src/anonymo/deposits/base58.ts";
import { scanEvmChain, type DepositedLog, type EvmReader } from "../../src/anonymo/deposits/evm.ts";
import { scanSolana, TOKEN_PROGRAM, type SolanaReader } from "../../src/anonymo/deposits/solana.ts";
import { scanTron, type Trc20Transfer, type TronReader } from "../../src/anonymo/deposits/tron.ts";
import { createDepositSink, rescreenHeld } from "../../src/anonymo/deposits/sink.ts";
import { dbSanctionsScreen, staticSanctionsScreen } from "../../src/anonymo/deposits/sanctions.ts";
import type { BtcpayClient, BtcpayPaymentMethod } from "../../src/anonymo/deposits/btcpay.ts";
import type { EvmChainConfig, SolanaConfig, TronConfig } from "../../src/anonymo/deposits/config.ts";
import { moneyHarness, SANCTIONED_EVM, type MoneyHarness } from "./harness.ts";

let m: MoneyHarness;
const balanceOfKey = async (keyHash: string) => {
  const [k] = await m.h.ctx.db.select().from(keys).where(eq(keys.keyHash, keyHash));
  const [a] = await m.h.ctx.db.select().from(accounts).where(eq(accounts.id, k.accountId));
  return a?.balance ?? 0n;
};
const b58 = () => base58Encode(randomBytes(32));

const btcInvoices = new Map<string, { status: string; additionalStatus?: string; methods: BtcpayPaymentMethod[] }>();
const btcpay: BtcpayClient = {
  createInvoice: async () => {
    const id = `inv_${btcInvoices.size + 1}`;
    btcInvoices.set(id, { status: "New", methods: [] });
    return { id, status: "New", checkoutLink: `https://btcpay.test/i/${id}` };
  },
  getInvoice: async (id) => ({ id, ...btcInvoices.get(id)! }),
  getPaymentMethods: async (id) => btcInvoices.get(id)!.methods,
};
const WEBHOOK_SECRET = "btcpay-webhook-secret-01234";

beforeAll(async () => {
  m = await moneyHarness({ deps: { btcpay }, config: { btcpay: { url: "https://btcpay.test", storeId: "store", apiKey: "k", webhookSecret: WEBHOOK_SECRET } } });
});
afterAll(async () => m?.close());

describe("deposit sink", () => {
  test("credits once per ref, 1:1, and keeps the ledger invariants", async () => {
    const k = await m.newKey();
    const d = { keyHash: k.keyHash, chain: "base" as const, amount: usdToPico("12.5"), ref: "base:0xaaa:0", sourceAddr: "0x00000000000000000000000000000000000000a1" };
    expect(await m.deps.sink.credit(d)).toEqual({ credited: true });
    expect(await m.deps.sink.credit(d)).toEqual({ credited: false });
    expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("12.5"));
    const rows = await m.h.ctx.db.select().from(ledger).where(eq(ledger.ref, "dep:base:0xaaa:0"));
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("deposit");
    expect((await verifyInvariants(m.h.ctx.db)).ok).toBe(true);
  });

  test("a sanctioned sender is held, never credited, and stays held", async () => {
    const k = await m.newKey();
    const r = await m.deposit(k.keyHash, "50", SANCTIONED_EVM.toUpperCase().replace("0X", "0x"));
    expect(r.credited).toBe(false);
    expect(await balanceOfKey(k.keyHash)).toBe(0n);
    const [row] = await m.h.ctx.db.select().from(anonymoDeposits).where(eq(anonymoDeposits.keyHash, k.keyHash));
    expect(row.status).toBe("held");
    expect(row.reason).toBe("sanctioned");
    expect((await rescreenHeld(m.h.ctx.db, staticSanctionsScreen([]))).credited).toBe(0);
    expect(await balanceOfKey(k.keyHash)).toBe(0n);
  });

  test("screening that cannot run holds the deposit; a later clean re-screen credits it once", async () => {
    const k = await m.newKey();
    const down = createDepositSink(m.h.ctx.db, { isBlocked: async () => { throw new Error("list down"); } });
    const r = await down.credit({ keyHash: k.keyHash, chain: "tron", amount: usdToPico("7"), ref: "tron:tx1:c:a", sourceAddr: "T" + "1".repeat(33) });
    expect(r.credited).toBe(false);
    expect(await balanceOfKey(k.keyHash)).toBe(0n);
    expect((await rescreenHeld(m.h.ctx.db, staticSanctionsScreen([]))).credited).toBe(1);
    expect((await rescreenHeld(m.h.ctx.db, staticSanctionsScreen([]))).credited).toBe(0);
    expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("7"));
  });

  test("the database screen holds when the list is required but missing, and matches listed addresses", async () => {
    const k = await m.newKey();
    const strict = createDepositSink(m.h.ctx.db, dbSanctionsScreen(m.h.ctx.db, { requireList: true }));
    expect((await strict.credit({ keyHash: k.keyHash, chain: "base", amount: 1n, ref: "base:strict:0", sourceAddr: "0x00000000000000000000000000000000000000a9" })).credited).toBe(false);
  });

  test("an unknown key or a non-positive amount is a programming error, not a credit", async () => {
    await expect(m.deps.sink.credit({ keyHash: "f".repeat(64), chain: "base", amount: 1n, ref: "x:1", sourceAddr: "0x00000000000000000000000000000000000000a1" })).rejects.toThrow();
    const k = await m.newKey();
    await expect(m.deps.sink.credit({ keyHash: k.keyHash, chain: "base", amount: 0n, ref: "x:2", sourceAddr: "0x00000000000000000000000000000000000000a1" })).rejects.toThrow();
  });
});

describe("EVM watcher", () => {
  const USDC = "0x00000000000000000000000000000000000000c1" as Hex;
  const USDG = "0x00000000000000000000000000000000000000c3" as Hex;
  const cfg: EvmChainConfig = { chain: "arbitrum", rpcUrl: "http://127.0.0.1:9", router: "0x00000000000000000000000000000000000000d1", confirmations: 5, startBlock: 100, maxRange: 10, tokens: [{ symbol: "USDC", address: USDC, decimals: 6 }, { symbol: "USDG", address: USDG, decimals: 6 }] };
  const chain = { head: 100n, logs: [] as (DepositedLog & { blockNumber: bigint })[], senders: new Map<string, Hex>(), ranges: [] as [bigint, bigint][] };
  const reader: EvmReader = {
    getBlockNumber: async () => chain.head,
    getDepositLogs: async ({ fromBlock, toBlock }) => {
      chain.ranges.push([fromBlock, toBlock]);
      return chain.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  let tx = 0;
  const emit = (block: bigint, keyCommit: Hex, token: Hex, amount: bigint, sender: Hex) => {
    const hash = `0x${(++tx).toString(16).padStart(64, "e")}` as Hex;
    chain.senders.set(hash, sender);
    chain.logs.push({ args: { keyCommit, token, payer: sender, amount }, transactionHash: hash, logIndex: 0, blockNumber: block });
    return hash;
  };

  test("credits allowlisted deposits once they are deep enough, from the sender, idempotently", async () => {
    const k = await m.newKey();
    const commit = await ensureDepositAddress(m.h.ctx.db, k.keyHash, "evm");
    expect(commit).toBe(evmKeyCommit(k.keyHash));
    const sender = "0x00000000000000000000000000000000000000Ab" as Hex;
    emit(101n, commit as Hex, USDC, 3_000_000n, sender);
    emit(103n, commit as Hex, USDG, 1_500_000n, sender);
    emit(104n, commit as Hex, "0x00000000000000000000000000000000000000ee", 9_000_000n, sender); // not allowlisted
    emit(104n, evmKeyCommit("0".repeat(64)), USDC, 9_000_000n, sender); // nobody's key
    chain.head = 105n; // safe = 100: nothing yet
    expect((await scanEvmChain(m.h.ctx.db, cfg, reader, m.deps.sink)).credited).toBe(0);
    chain.head = 120n; // safe = 115
    const r = await scanEvmChain(m.h.ctx.db, cfg, reader, m.deps.sink);
    expect(r.credited).toBe(2);
    expect(r.skipped).toBe(2);
    expect(chain.ranges.every(([a, b]) => b - a < 10n)).toBe(true); // maxRange respected
    expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("4.5"));
    const rows = await m.h.ctx.db.select().from(anonymoDeposits).where(eq(anonymoDeposits.keyHash, k.keyHash));
    expect(new Set(rows.map((x) => x.sourceAddr))).toEqual(new Set([sender.toLowerCase()]));
    expect(new Set(rows.map((x) => x.token))).toEqual(new Set(["USDC", "USDG"]));
    // Re-scan from scratch (cursor lost): nothing is credited twice.
    await m.h.ctx.db.execute(`delete from kv where key = 'anonymo:cursor:evm:arbitrum'` as never);
    expect((await scanEvmChain(m.h.ctx.db, cfg, reader, m.deps.sink)).credited).toBe(0);
    expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("4.5"));
  });

  test("a sanctioned sender's EVM deposit is held", async () => {
    const k = await m.newKey();
    const commit = (await ensureDepositAddress(m.h.ctx.db, k.keyHash, "evm")) as Hex;
    emit(121n, commit, USDC, 1_000_000n, SANCTIONED_EVM as Hex);
    chain.head = 200n;
    const r = await scanEvmChain(m.h.ctx.db, cfg, reader, m.deps.sink);
    expect(r.held).toBe(1);
    expect(await balanceOfKey(k.keyHash)).toBe(0n);
  });
});

describe("Solana watcher (ported from Conclave)", () => {
  const treasuryWallet = b58();
  const usdcMint = b58();
  const usdcAccount = b58();
  const cfg: SolanaConfig = { rpcUrl: "http://127.0.0.1:9", cluster: "devnet", treasuryWallet, tokens: [{ symbol: "USDC", mint: usdcMint, account: usdcAccount }], pageSize: 2 };
  const txs = new Map<string, unknown>();
  const order: string[] = []; // oldest first
  const reader: SolanaReader = {
    getSignatures: async (_account, o) => {
      let list = [...order].reverse(); // newest first
      if (o.until) list = list.slice(0, list.indexOf(o.until) === -1 ? list.length : list.indexOf(o.until));
      if (o.before) list = list.slice(list.indexOf(o.before) + 1);
      return list.slice(0, o.limit).map((signature) => ({ signature, err: null, confirmationStatus: "finalized" }));
    },
    getTransaction: async (s) => txs.get(s) ?? null,
  };
  const transfer = (o: { owner: string; reference: string; amount: bigint; extraProgram?: string; delta?: bigint; decimals?: number }) => {
    const source = b58();
    const sig = base58Encode(randomBytes(64));
    const keys = [o.owner, source, usdcAccount, usdcMint, o.reference, TOKEN_PROGRAM, ...(o.extraProgram ? [o.extraProgram] : [])];
    const data = new Uint8Array(10);
    data[0] = 12;
    new DataView(data.buffer).setBigUint64(1, o.amount, true);
    data[9] = o.decimals ?? 6;
    const instructions = [{ programIdIndex: 5, accounts: [1, 3, 2, 0, 4], data: base58Encode(data) }];
    if (o.extraProgram) instructions.unshift({ programIdIndex: 6, accounts: [], data: "" });
    const bal = (index: number, owner: string, amount: bigint) => ({ accountIndex: index, mint: usdcMint, owner, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: amount.toString(), decimals: 6 } });
    const delta = o.delta ?? o.amount;
    txs.set(sig, {
      slot: 1000 + order.length,
      version: "legacy",
      meta: { err: null, innerInstructions: [], preTokenBalances: [bal(1, o.owner, 10n ** 9n), bal(2, treasuryWallet, 5n)], postTokenBalances: [bal(1, o.owner, 10n ** 9n - delta), bal(2, treasuryWallet, 5n + delta)] },
      transaction: { signatures: [sig], message: { accountKeys: keys, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: keys.length - 3 }, instructions } },
    });
    order.push(sig);
    return sig;
  };

  test("credits verified transfers carrying the key's reference, oldest first, across pages, once", async () => {
    const k = await m.newKey();
    const reference = await ensureDepositAddress(m.h.ctx.db, k.keyHash, "solana");
    const payer = b58();
    transfer({ owner: payer, reference, amount: 2_000_000n });
    transfer({ owner: payer, reference, amount: 500_000n });
    transfer({ owner: payer, reference, amount: 1_000_000n, extraProgram: b58() }); // an unknown program: fails closed
    transfer({ owner: payer, reference, amount: 1_000_000n, delta: 999_999n }); // balances disagree: fails closed
    transfer({ owner: payer, reference: b58(), amount: 1_000_000n }); // someone else's reference
    const r = await scanSolana(m.h.ctx.db, cfg, reader, m.deps.sink);
    expect(r.credited).toBe(2);
    expect(r.skipped).toBe(3);
    expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("2.5"));
    const rows = await m.h.ctx.db.select().from(anonymoDeposits).where(eq(anonymoDeposits.keyHash, k.keyHash));
    expect(rows.every((x) => x.sourceAddr === payer && x.chain === "solana")).toBe(true);
    transfer({ owner: payer, reference, amount: 250_000n });
    expect((await scanSolana(m.h.ctx.db, cfg, reader, m.deps.sink)).credited).toBe(1); // only the new one
    expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("2.75"));
  });
});

describe("Tron watcher (mock TronGrid)", () => {
  const xpub = HDKey.fromMasterSeed(Buffer.from("0f0e0d0c0b0a09080706050403020100", "hex")).derive("m/44'/195'/0'").publicExtendedKey;
  const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const cfg: TronConfig = { apiUrl: "http://127.0.0.1:9", xpub, confirmations: 20, tokens: [{ symbol: "USDT", contract: USDT, decimals: 6 }] };
  const sender = tronAddressOfPublicKey(Buffer.from("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex"));
  const state = { head: 1000, transfers: [] as (Trc20Transfer & { block: number; ok?: boolean })[] };
  const reader: TronReader = {
    nowBlock: async () => state.head,
    transfersTo: async (address, contract, min) => state.transfers.filter((t) => t.to === address && t.contract === contract && t.blockTimestamp >= min),
    txInfo: async (txid) => {
      const t = state.transfers.find((x) => x.txid === txid);
      return t ? { blockNumber: t.block, success: t.ok !== false } : null;
    },
  };

  test("each key gets its own address; deep transfers are credited once; shallow ones wait", async () => {
    const a = await m.newKey();
    const b = await m.newKey();
    const addrA = await ensureDepositAddress(m.h.ctx.db, a.keyHash, "tron", xpub);
    const addrB = await ensureDepositAddress(m.h.ctx.db, b.keyHash, "tron", xpub);
    expect(addrA).not.toBe(addrB);
    expect(await ensureDepositAddress(m.h.ctx.db, a.keyHash, "tron", xpub)).toBe(addrA);
    const now = Date.now();
    state.transfers.push({ txid: "t1", from: sender, to: addrA, contract: USDT, value: "4000000", blockTimestamp: now, block: 900 });
    state.transfers.push({ txid: "t2", from: sender, to: addrB, contract: USDT, value: "1000000", blockTimestamp: now, block: 995 }); // 5 deep
    state.transfers.push({ txid: "t3", from: sender, to: addrA, contract: USDT, value: "1000000", blockTimestamp: now, block: 900, ok: false }); // reverted
    const r = await scanTron(m.h.ctx.db, cfg, reader, m.deps.sink, now);
    expect(r.credited).toBe(1);
    expect(await balanceOfKey(a.keyHash)).toBe(usdToPico("4"));
    expect(await balanceOfKey(b.keyHash)).toBe(0n);
    state.head = 1100;
    expect((await scanTron(m.h.ctx.db, cfg, reader, m.deps.sink, now + 1000)).credited).toBe(1);
    expect(await balanceOfKey(b.keyHash)).toBe(usdToPico("1"));
    expect((await scanTron(m.h.ctx.db, cfg, reader, m.deps.sink, now + 2000)).credited).toBe(0);
  });
});

describe("BTCPay", () => {
  const sign = (body: string) => "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const hook = (body: unknown, sig?: string) => {
    const raw = JSON.stringify(body);
    return m.req("/webhooks/btcpay", { method: "POST", headers: { "content-type": "application/json", "btcpay-sig": sig ?? sign(raw) }, body: raw });
  };

  test("invoice → signed webhook → credit at the BTCPay quote, once; refunds go to the named address", async () => {
    const k = await m.newKey();
    const r = await m.req("/deposits/btcpay", { headers: k.auth, json: { amount_usd: "100", refund_address: "sample-user@wallet.example" } });
    expect(r.status).toBe(201);
    const inv = await r.json();
    expect(inv.refund).toEqual({ chain: "ln", address: "sample-user@wallet.example" });
    // Not paid yet: nothing credited.
    expect((await (await hook({ type: "InvoiceReceivedPayment", invoiceId: inv.invoice_id })).json()).status).toBe("pending");
    btcInvoices.set(inv.invoice_id, { status: "Settled", methods: [
      { paymentMethodId: "BTC-LN", rate: "62500.5", paymentMethodPaid: "0.0016", payments: [{ status: "Settled", value: "0.0016" }] },
      { paymentMethodId: "BTC-CHAIN", rate: "62500.5", paymentMethodPaid: "0.0001", payments: [{ status: "Processing", value: "0.0001" }] },
    ] });
    expect((await hook({ type: "InvoiceSettled", invoiceId: inv.invoice_id }, "sha256=" + "0".repeat(64))).status).toBe(401);
    expect(await balanceOfKey(k.keyHash)).toBe(0n);
    const ok = await hook({ type: "InvoiceSettled", invoiceId: inv.invoice_id });
    expect((await ok.json()).status).toBe("credited");
    expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("100.0008"));
    expect((await (await hook({ type: "InvoiceSettled", invoiceId: inv.invoice_id })).json()).status).toBe("duplicate");
    expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("100.0008"));
    const [row] = await m.h.ctx.db.select().from(anonymoDeposits).where(eq(anonymoDeposits.ref, `btcpay:${inv.invoice_id}`));
    expect(row.chain).toBe("ln");
    expect(row.sourceAddr).toBe("sample-user@wallet.example");
  });

  for (const status of ["Expired", "Invalid"]) {
    test(`a partially paid invoice marked ${status} is credited only for settled payments`, async () => {
      const k = await m.newKey();
      const inv = await (await m.req("/deposits/btcpay", { headers: k.auth, json: { amount_usd: 50, refund_address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" } })).json();
      const payments = ["0.00025", "0.00025", "0.0002"].map((value) => ({ status: "Processing", value }));
      btcInvoices.set(inv.invoice_id, { status, additionalStatus: "PaidPartial", methods: [{ paymentMethodId: "BTC-CHAIN", rate: "60000", paymentMethodPaid: "0.0007", payments }] });
      expect((await (await hook({ type: `Invoice${status}`, invoiceId: inv.invoice_id })).json()).status).toBe("pending");
      expect(await balanceOfKey(k.keyHash)).toBe(0n);

      payments[0].status = payments[1].status = "Settled";
      expect((await (await hook({ type: "InvoicePaymentSettled", invoiceId: inv.invoice_id })).json()).status).toBe("credited");
      expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("30"));

      payments[2].status = "Settled";
      expect((await (await hook({ type: "InvoicePaymentSettled", invoiceId: inv.invoice_id })).json()).status).toBe("duplicate");
      expect(await balanceOfKey(k.keyHash)).toBe(usdToPico("30"));
    });
  }

  test("bad refund addresses and unknown invoices", async () => {
    const k = await m.newKey();
    expect((await m.req("/deposits/btcpay", { headers: k.auth, json: { amount_usd: "10", refund_address: "0x00000000000000000000000000000000000000a1" } })).status).toBe(400);
    expect((await (await hook({ type: "InvoiceSettled", invoiceId: "nope" })).json()).status).toBe("ignored");
  });
});
