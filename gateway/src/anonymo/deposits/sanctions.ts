// OFAC screening of deposit senders, for every chain we accept (also used for facilitator listings and provider payouts).
// Copied from Anonymo's network sanctions code (removed in WS01) and widened: the SDN list publishes Tron, Solana and Bitcoin addresses too, not only EVM ones.
// A deposit from a listed address is held, never credited (sink.ts). Screening that cannot run also holds.

import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { kv } from "../../db/schema.ts";
import { log, sha256 } from "../../lib/util.ts";
import type { DepositChain, SanctionsScreen } from "../seams.ts";
import { anonymoSanctions } from "./schema.ts";
import { isBase58Of } from "./base58.ts";
import { isTronAddress } from "./addresses.ts";

export type AddressFamily = "evm" | "tron" | "solana" | "btc" | "other";

export const familyOfChain = (chain: DepositChain): AddressFamily =>
  chain === "base" || chain === "arbitrum" || chain === "rhc" || chain === "x402" || chain === "coin" ? "evm" : chain === "solana" ? "solana" : chain === "tron" ? "tron" : chain === "btc" ? "btc" : "other";

/** One spelling per address: EVM and bech32 are case-insensitive (lowercased); base58 is case-sensitive (kept). */
export function normalizeAddress(value: string): { address: string; family: AddressFamily } | null {
  const a = value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return { address: a.toLowerCase(), family: "evm" };
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) && isTronAddress(a)) return { address: a, family: "tron" };
  if (/^(bc1|tb1)[02-9ac-hj-np-z]{8,87}$/i.test(a)) return { address: a.toLowerCase(), family: "btc" };
  if (/^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return { address: a, family: "btc" };
  if (isBase58Of(a, 32)) return { address: a, family: "solana" };
  return null;
}

function decode(value: string): string {
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity in named) return named[entity];
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) {
      const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
    }
    throw new Error("Invalid SDN XML entity");
  });
}

/** Narrow reader for OFAC's classic SDN XML: digital-currency addresses of every family, nothing else (no names). */
export function parseSdnXmlAll(xml: string) {
  const addresses = new Map<string, AddressFamily>();
  const stack: string[] = [];
  let listDate: Date | null = null, expected = -1, entries = 0, ignoredCount = 0, digitalCount = 0, roots = 0;
  let idType = "", idNumber = "", capture = "";
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  let end = 0;
  for (const m of xml.matchAll(tokens)) {
    if (m.index !== end) throw new Error("Malformed SDN XML");
    const token = m[0];
    end = m.index + token.length;
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (!token.startsWith("<") || token.startsWith("<![CDATA[")) {
      if (!stack.length && token.trim()) throw new Error("Unexpected SDN XML text");
      if (["idType", "idNumber", "Publish_Date", "Record_Count"].includes(stack.at(-1) ?? "")) capture += token.startsWith("<![CDATA[") ? token.slice(9, -3) : decode(token);
      continue;
    }
    const close = /^<\/([\w:.-]+)\s*>$/.exec(token);
    if (close) {
      const name = close[1].split(":").at(-1)!;
      if (stack.pop() !== name) throw new Error("Unbalanced SDN XML");
      const path = stack.join("/");
      if (name === "idType" && path === "sdnList/sdnEntry/idList/id") idType = capture.trim();
      if (name === "idNumber" && path === "sdnList/sdnEntry/idList/id") idNumber = capture.trim();
      if (name === "id" && path === "sdnList/sdnEntry/idList" && /^Digital Currency Address\s*-\s*\S+/i.test(idType)) {
        digitalCount++;
        const n = normalizeAddress(idNumber);
        if (n) addresses.set(n.address, n.family);
        else ignoredCount++;
      }
      if (name === "Publish_Date" && path === "sdnList/publshInformation") {
        const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(capture.trim());
        if (!date || listDate) throw new Error("Invalid SDN publication date");
        const iso = `${date[3]}-${date[1]}-${date[2]}`;
        listDate = new Date(`${iso}T00:00:00.000Z`);
        if (!Number.isFinite(listDate.getTime()) || listDate.toISOString().slice(0, 10) !== iso) throw new Error("Invalid SDN publication date");
      }
      if (name === "Record_Count" && path === "sdnList/publshInformation") {
        if (expected !== -1 || !/^\d+$/.test(capture.trim())) throw new Error("Invalid SDN record count");
        expected = Number(capture.trim());
      }
      capture = "";
      continue;
    }
    const open = /^<([\w:.-]+)(?:\s+[^<>]*)?\s*\/?>$/.exec(token);
    if (!open) throw new Error("Unsupported SDN XML declaration");
    const name = open[1].split(":").at(-1)!;
    if (!stack.length && (name !== "sdnList" || ++roots !== 1)) throw new Error("Expected one SDN list");
    if (["idType", "idNumber", "Publish_Date", "Record_Count"].includes(stack.at(-1) ?? "")) throw new Error("Nested SDN value");
    if (name === "sdnEntry" && stack.join("/") === "sdnList") entries++;
    if (name === "id" && stack.join("/") === "sdnList/sdnEntry/idList") {
      idType = "";
      idNumber = "";
    }
    capture = "";
    if (!token.endsWith("/>")) stack.push(name);
  }
  if (end !== xml.length || stack.length || roots !== 1 || !listDate || !entries || expected !== entries || !addresses.size) throw new Error("Incomplete SDN list");
  return { addresses: [...addresses].map(([address, family]) => ({ address, family })), listDate, ignoredCount, digitalCount };
}

const OFAC_HOSTS = new Set(["sanctionslistservice.ofac.treas.gov", "www.treasury.gov", "treasury.gov", "ofac.treasury.gov"]);
const allowedHost = (h: string) => OFAC_HOSTS.has(h) || h.endsWith(".s3.us-gov-west-1.amazonaws.com");
function assertDownloadUrl(url: URL, allowLocal: boolean) {
  if (url.username || url.password || url.hash) throw new Error("SDN URL contains credentials or a fragment");
  if (allowLocal && url.hostname === "localhost" && url.protocol === "http:") return;
  if (url.protocol !== "https:" || !allowedHost(url.hostname)) throw new Error("SDN URL must use HTTPS and an allowed host");
}
const MAX_BYTES = 64 * 1024 * 1024;

/** Download, parse and atomically replace the list. Any failure keeps the previous list. */
export async function refreshAnonymoSanctions(db: Db, o: { listUrl: string; production: boolean; fetcher?: typeof fetch; now?: Date }) {
  const fetcher = o.fetcher ?? fetch;
  const now = o.now ?? new Date();
  let url = new URL(o.listUrl);
  assertDownloadUrl(url, !o.production);
  const signal = AbortSignal.timeout(60_000);
  let response: Response;
  for (let hops = 0; ; hops++) {
    response = await fetcher(url.toString(), { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (hops >= 3 || !location) throw new Error("SDN redirect limit or missing location");
    url = new URL(location, url);
    assertDownloadUrl(url, false);
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (!response.ok || raw.byteLength > MAX_BYTES) throw new Error("SDN download rejected");
  const parsed = parseSdnXmlAll(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (parsed.listDate.getTime() > now.getTime()) throw new Error("Future publication date");
  await db.transaction(async (tx) => {
    await tx.delete(anonymoSanctions);
    for (let i = 0; i < parsed.addresses.length; i += 1000)
      await tx.insert(anonymoSanctions).values(parsed.addresses.slice(i, i + 1000).map((a) => ({ ...a, listDate: parsed.listDate })));
    const value = { list_date: parsed.listDate.toISOString().slice(0, 10), entry_count: parsed.addresses.length, source_hash: sha256(raw), refreshed_at: now.toISOString() };
    await tx.insert(kv).values({ key: "anonymo:sanctions:meta", value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
  });
  log.info("anonymo sanctions list refreshed", { entries: parsed.addresses.length });
  return { entry_count: parsed.addresses.length, ignored_count: parsed.ignoredCount, list_date: parsed.listDate.toISOString().slice(0, 10) };
}

/** Screen against the stored list. With `requireList`, a missing list is an error (so the sink holds the deposit). */
export function dbSanctionsScreen(db: Db, o: { requireList: boolean }): SanctionsScreen {
  return {
    async isBlocked(_chain, address) {
      if (o.requireList) {
        const [meta] = await db.select({ key: kv.key }).from(kv).where(eq(kv.key, "anonymo:sanctions:meta"));
        if (!meta) throw new Error("sanctions list not loaded");
      }
      const n = normalizeAddress(address);
      if (!n) return false; // Lightning and other rails carry no screenable sender
      const [hit] = await db.select({ n: sql<number>`1` }).from(anonymoSanctions).where(eq(anonymoSanctions.address, n.address)).limit(1);
      return !!hit;
    },
  };
}

/** Screen from a fixed set (tests and an operator's extra blocklist). */
export function staticSanctionsScreen(addresses: Iterable<string>): SanctionsScreen {
  const set = new Set([...addresses].map((a) => normalizeAddress(a)?.address ?? a));
  return { isBlocked: async (_chain, address) => set.has(normalizeAddress(address)?.address ?? address) };
}
