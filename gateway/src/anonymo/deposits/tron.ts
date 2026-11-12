// Tron deposit watcher: USDT (TRC-20) to each key's own address (derived from the operator's xpub, addresses.ts).
// Reads go through the TronReader interface: a TronGrid HTTP client in production, a mock in tests. A transfer is
// credited once its block is `confirmations` deep (TronGrid's only_confirmed already means solidified).

import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { anonymoDepositAddresses } from "./schema.ts";
import { kv } from "../../db/schema.ts";
import { log } from "../../lib/util.ts";
import { isTronAddress } from "./addresses.ts";
import type { TronConfig } from "./config.ts";
import type { AnonymoDepositSink } from "./sink.ts";
import { stableRawToPico } from "./units.ts";

export type Trc20Transfer = { txid: string; from: string; to: string; contract: string; value: string; blockTimestamp: number };

export type TronReader = {
  nowBlock(): Promise<number>;
  /** Confirmed TRC-20 transfers into `address` of `contract` since `minTimestamp` (ms), oldest first. */
  transfersTo(address: string, contract: string, minTimestamp: number): Promise<Trc20Transfer[]>;
  /** Block number and success of a transaction, or null if not found. */
  txInfo(txid: string): Promise<{ blockNumber: number; success: boolean } | null>;
};

export function tronGridReader(cfg: Pick<TronConfig, "apiUrl" | "apiKey">, fetcher: typeof fetch = fetch): TronReader {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json", ...(cfg.apiKey ? { "TRON-PRO-API-KEY": cfg.apiKey } : {}) };
  const base = cfg.apiUrl.replace(/\/$/, "");
  const get = async (path: string, init?: RequestInit) => {
    const res = await fetcher(base + path, { ...init, headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`tron api ${path.split("?")[0]} failed (${res.status})`);
    return res.json() as Promise<any>;
  };
  return {
    nowBlock: async () => Number((await get("/wallet/getnowblock", { method: "POST", body: "{}" })).block_header.raw_data.number),
    async transfersTo(address, contract, minTimestamp) {
      const out: Trc20Transfer[] = [];
      let fingerprint: string | undefined;
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({ only_confirmed: "true", only_to: "true", contract_address: contract, min_timestamp: String(minTimestamp), order_by: "block_timestamp,asc", limit: "200", ...(fingerprint ? { fingerprint } : {}) });
        const j = await get(`/v1/accounts/${address}/transactions/trc20?${q}`);
        for (const d of j.data ?? []) out.push({ txid: d.transaction_id, from: d.from, to: d.to, contract: d.token_info?.address, value: String(d.value), blockTimestamp: Number(d.block_timestamp) });
        fingerprint = j.meta?.fingerprint;
        if (!fingerprint) break;
      }
      return out;
    },
    async txInfo(txid) {
      const j = await get("/wallet/gettransactioninfobyid", { method: "POST", body: JSON.stringify({ value: txid }) });
      if (!j || j.blockNumber === undefined) return null;
      return { blockNumber: Number(j.blockNumber), success: !j.receipt?.result || j.receipt.result === "SUCCESS" };
    },
  };
}

const CURSOR = "anonymo:cursor:tron";
const OVERLAP_MS = 10 * 60_000; // re-read a window on every run; credits are idempotent

export async function scanTron(db: Db, cfg: TronConfig, reader: TronReader, sink: AnonymoDepositSink, now = Date.now()) {
  const out = { credited: 0, held: 0, skipped: 0 };
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, CURSOR));
  const since = Math.max(0, Number((row?.value as { ts?: number } | undefined)?.ts ?? 0) - OVERLAP_MS);
  const head = await reader.nowBlock();
  const addresses = await db.select({ keyHash: anonymoDepositAddresses.keyHash, address: anonymoDepositAddresses.address }).from(anonymoDepositAddresses).where(eq(anonymoDepositAddresses.chain, "tron"));
  let complete = true;
  for (const a of addresses) {
    for (const token of cfg.tokens) {
      for (const t of await reader.transfersTo(a.address, token.contract, since)) {
        if (t.to !== a.address || t.contract !== token.contract || !/^\d{1,30}$/.test(t.value) || BigInt(t.value) <= 0n || !isTronAddress(t.from)) {
          out.skipped++;
          continue;
        }
        const info = await reader.txInfo(t.txid);
        if (!info || head - info.blockNumber < cfg.confirmations) {
          complete = false; // not deep enough yet: keep the cursor so the next run sees it again
          continue;
        }
        if (!info.success) {
          out.skipped++;
          continue;
        }
        const raw = BigInt(t.value);
        const r = await sink.creditWith({ keyHash: a.keyHash, chain: "tron", amount: stableRawToPico(raw, token.decimals), ref: `tron:${t.txid}:${token.contract}:${a.address}`, sourceAddr: t.from }, { token: token.symbol, amountRaw: raw });
        if (r.credited) out.credited++;
        else if (r.held) out.held++;
      }
    }
  }
  if (complete) {
    const value = { ts: now };
    await db.insert(kv).values({ key: CURSOR, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  } else log.info("anonymo tron scan left shallow transfers for the next run");
  return out;
}
