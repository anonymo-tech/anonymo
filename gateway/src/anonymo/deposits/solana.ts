// Solana deposit watcher: USDC and USDT, ported from Conclave (dash/server/solana: transaction.ts, deposit.ts, validation.ts).
// The payer sends a Solana Pay transfer: one SPL TransferChecked into the treasury token account, with the key's reference
// account attached read-only. We poll each treasury token account's finalized signatures, verify each transaction from the
// RPC's own record (never a client body) the way Conclave does, and credit the reference's key. Anything else in the
// transaction (other programs, Token-2022, several transfers, inner calls) fails closed and is left for an operator.

import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { log } from "../../lib/util.ts";
import { keyForDepositAddress } from "./addresses.ts";
import { base58Decode, isBase58Of } from "./base58.ts";
import type { SolanaConfig } from "./config.ts";
import type { AnonymoDepositSink } from "./sink.ts";
import { stableRawToPico } from "./units.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export class SolanaDepositError extends Error {}
function need(cond: unknown, code: string): asserts cond {
  if (!cond) throw new SolanaDepositError(code);
}
const record = (v: unknown): Record<string, unknown> => {
  need(v !== null && typeof v === "object" && !Array.isArray(v), "invalid_response");
  return v as Record<string, unknown>;
};
const list = (v: unknown, max = 256): unknown[] => {
  need(Array.isArray(v) && v.length <= max, "invalid_response");
  return v;
};
const uint = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  need(typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max, "invalid_response");
  return v;
};
const address = (v: unknown): string => {
  need(isBase58Of(v, 32), "invalid_response");
  return v;
};
const signature = (v: unknown): string => {
  need(isBase58Of(v, 64), "invalid_response");
  return v;
};

type AccountKey = { address: string; signer: boolean; writable: boolean };

/** Resolve legacy and v0 compiled keys, including loaded writable then readonly keys (Conclave transaction.ts). */
export function compiledTransaction(value: unknown) {
  const root = record(value);
  need(root.version === "legacy" || root.version === 0 || root.version === undefined, "unsupported_transaction");
  const meta = record(root.meta);
  const transaction = record(root.transaction);
  const message = record(transaction.message);
  const staticKeys = list(message.accountKeys).map(address);
  need(staticKeys.length > 0, "invalid_response");
  const header = record(message.header);
  const signers = uint(header.numRequiredSignatures, staticKeys.length);
  const readonlySigned = uint(header.numReadonlySignedAccounts, signers);
  const readonlyUnsigned = uint(header.numReadonlyUnsignedAccounts, staticKeys.length - signers);
  need(signers > 0 && readonlySigned < signers, "invalid_response");
  const signatures = list(transaction.signatures).map(signature);
  need(signatures.length === signers, "invalid_response");
  const keys: AccountKey[] = staticKeys.map((key, index) => ({
    address: key,
    signer: index < signers,
    writable: index < signers ? index < signers - readonlySigned : index < staticKeys.length - readonlyUnsigned,
  }));
  const loaded = meta.loadedAddresses === undefined || meta.loadedAddresses === null ? { writable: [], readonly: [] } : record(meta.loadedAddresses);
  for (const key of list(loaded.writable).map(address)) keys.push({ address: key, signer: false, writable: true });
  for (const key of list(loaded.readonly).map(address)) keys.push({ address: key, signer: false, writable: false });
  need(keys.length <= 256 && new Set(keys.map((k) => k.address)).size === keys.length, "invalid_response");
  const instructions = list(message.instructions, 64).map((v, index) => {
    const ix = record(v);
    const program = keys[uint(ix.programIdIndex, keys.length - 1)];
    need(!program.signer && !program.writable, "invalid_response");
    const accounts = list(ix.accounts).map((k) => uint(k, keys.length - 1));
    need(typeof ix.data === "string" && ix.data.length <= 1700, "invalid_response");
    let data: Uint8Array;
    try {
      data = ix.data.length ? base58Decode(ix.data) : new Uint8Array();
    } catch {
      throw new SolanaDepositError("invalid_response");
    }
    return { programId: program.address, accounts, data, index };
  });
  return { root, meta, keys, signatures, instructions, slot: uint(root.slot) };
}

function tokenBalances(value: unknown, keyCount: number) {
  const out = new Map<number, { mint: string; owner: string; programId: string; decimals: number; amount: bigint }>();
  for (const raw of list(value)) {
    const b = record(raw);
    const index = uint(b.accountIndex, keyCount - 1);
    need(!out.has(index), "ambiguous_deposit");
    const t = record(b.uiTokenAmount);
    need(typeof t.amount === "string" && /^(0|[1-9]\d{0,19})$/.test(t.amount), "invalid_response");
    out.set(index, { mint: address(b.mint), owner: address(b.owner), programId: address(b.programId), decimals: uint(t.decimals, 255), amount: BigInt(t.amount) });
  }
  return out;
}

export type SolanaTransfer = { signature: string; instructionIndex: number; mint: string; sourceOwner: string; recipient: string; reference: string; amountRaw: bigint; decimals: number; slot: number };

/**
 * One top-level TransferChecked (5 accounts: source, mint, destination, owner, reference) into one of our treasury token
 * accounts, optionally after compute-budget and memo instructions. Balance deltas must match the instruction exactly.
 */
export function verifySolanaTransfer(tx: unknown, treasury: Map<string, { mint: string; decimals: number }>, treasuryWallet: string): SolanaTransfer {
  const c = compiledTransaction(tx);
  need(c.meta.err === null, "transaction_failed");
  const transfers = c.instructions.filter((i) => i.programId === TOKEN_PROGRAM);
  need(transfers.length === 1, transfers.length > 1 ? "ambiguous_deposit" : "unsupported_instruction");
  const transfer = transfers[0];
  for (const ix of c.instructions) {
    if (ix === transfer) continue;
    need(ix.programId === COMPUTE_BUDGET_PROGRAM || ix.programId === MEMO_PROGRAM, "unsupported_instruction");
  }
  const inner = c.meta.innerInstructions === undefined || c.meta.innerInstructions === null ? [] : list(c.meta.innerInstructions, 64);
  for (const raw of inner) need(list(record(raw).instructions, 16).length === 0, "unsupported_instruction");
  need(transfer.data.length === 10 && transfer.data[0] === 12, "unsupported_instruction");
  need(transfer.accounts.length === 5 && new Set(transfer.accounts).size === 5, "ambiguous_deposit");
  const [sourceIndex, , recipientIndex] = transfer.accounts;
  const [source, mint, recipient, owner, reference] = transfer.accounts.map((i) => c.keys[i]);
  const t = treasury.get(recipient.address);
  need(t && t.mint === mint.address, "deposit_mismatch");
  need(transfer.data[9] === t.decimals, "deposit_mismatch");
  need(source.writable && recipient.writable && owner.signer && !mint.writable && !reference.writable && !reference.signer, "deposit_mismatch");
  need(source.address !== recipient.address && owner.address !== treasuryWallet, "deposit_mismatch");
  const amountRaw = new DataView(transfer.data.buffer, transfer.data.byteOffset, transfer.data.byteLength).getBigUint64(1, true);
  need(amountRaw > 0n, "invalid_amount");
  const before = tokenBalances(c.meta.preTokenBalances, c.keys.length);
  const after = tokenBalances(c.meta.postTokenBalances, c.keys.length);
  for (const [index, ownerAddr] of [[sourceIndex, owner.address], [recipientIndex, treasuryWallet]] as const) {
    const pre = before.get(index);
    const post = after.get(index);
    need(pre && post, "incomplete_metadata");
    need(pre.mint === t.mint && post.mint === t.mint && pre.programId === TOKEN_PROGRAM && post.programId === TOKEN_PROGRAM && pre.owner === ownerAddr && post.owner === ownerAddr, "deposit_mismatch");
    const delta = index === sourceIndex ? pre.amount - post.amount : post.amount - pre.amount;
    need(delta === amountRaw, "deposit_mismatch");
  }
  return { signature: c.signatures[0], instructionIndex: transfer.index, mint: t.mint, sourceOwner: owner.address, recipient: recipient.address, reference: reference.address, amountRaw, decimals: t.decimals, slot: c.slot };
}

/** The two RPC reads the watcher needs; tests pass a mock. Signatures come newest first, as the RPC returns them. */
export type SolanaReader = {
  getSignatures(account: string, o: { before?: string; until?: string; limit: number }): Promise<{ signature: string; err: unknown; confirmationStatus?: string }[]>;
  getTransaction(signature: string): Promise<unknown | null>;
};

export function rpcSolanaReader(rpcUrl: string, fetcher: typeof fetch = fetch): SolanaReader {
  let id = 0;
  const call = async (method: string, params: unknown[]) => {
    const res = await fetcher(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`solana rpc ${method} failed (${res.status})`);
    const j = (await res.json()) as { result?: unknown; error?: unknown };
    if (j.error) throw new Error(`solana rpc ${method} error`);
    return j.result;
  };
  return {
    getSignatures: async (account, o) => (await call("getSignaturesForAddress", [account, { commitment: "finalized", limit: o.limit, ...(o.before ? { before: o.before } : {}), ...(o.until ? { until: o.until } : {}) }])) as never,
    getTransaction: (sig) => call("getTransaction", [sig, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }]),
  };
}

const cursorKey = (account: string) => `anonymo:cursor:solana:${account}`;

/** Scan every treasury token account for finalized transfers since its cursor (oldest first) and credit them. */
export async function scanSolana(db: Db, cfg: SolanaConfig, reader: SolanaReader, sink: AnonymoDepositSink) {
  const out = { credited: 0, held: 0, skipped: 0 };
  const treasury = new Map(cfg.tokens.map((t) => [t.account, { mint: t.mint, decimals: 6 }]));
  const symbols = new Map(cfg.tokens.map((t) => [t.mint, t.symbol]));
  for (const t of cfg.tokens) {
    const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, cursorKey(t.account)));
    const until = (row?.value as { signature?: string } | undefined)?.signature;
    // Page back to the cursor so a burst larger than one page is not skipped.
    const pending: { signature: string; err: unknown; confirmationStatus?: string }[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
      const sigs = await reader.getSignatures(t.account, { before, until, limit: cfg.pageSize });
      pending.push(...sigs);
      if (sigs.length < cfg.pageSize) break;
      before = sigs.at(-1)!.signature;
    }
    for (const s of pending.reverse()) {
      if (s.err === null && (s.confirmationStatus === undefined || s.confirmationStatus === "finalized")) {
        const tx = await reader.getTransaction(s.signature);
        if (tx === null) throw new Error("finalized transaction not available yet"); // retry the whole account next run
        let v: SolanaTransfer | null = null;
        try {
          v = verifySolanaTransfer(tx, treasury, cfg.treasuryWallet);
        } catch (e) {
          if (!(e instanceof SolanaDepositError)) throw e;
          log.warn("anonymo solana transfer not credited", { signature: s.signature, reason: e.message });
          out.skipped++;
        }
        const keyHash = v ? await keyForDepositAddress(db, "solana", v.reference) : null;
        if (v && !keyHash) {
          log.warn("anonymo solana transfer with an unknown reference; not credited", { signature: s.signature });
          out.skipped++;
        }
        if (v && keyHash) {
          const r = await sink.creditWith(
            { keyHash, chain: "solana", amount: stableRawToPico(v.amountRaw, v.decimals), ref: `solana:${v.signature}:${v.instructionIndex}`, sourceAddr: v.sourceOwner },
            { token: symbols.get(v.mint) ?? "", amountRaw: v.amountRaw },
          );
          if (r.credited) out.credited++;
          else if (r.held) out.held++;
        }
      }
      const value = { signature: s.signature };
      await db.insert(kv).values({ key: cursorKey(t.account), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
    }
  }
  return out;
}
