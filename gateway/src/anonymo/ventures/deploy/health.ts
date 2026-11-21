// WS11 · Ventures deploy (Ventures Backend spec, PART 7 "health checks + rollback"): is the deployed site actually
// served?
//
// Fetch `<cid>/index.html` through one or more public IPFS HTTP gateways (path style `https://<gw>/ipfs/<cid>/` or
// subdomain style `https://<cid>.ipfs.<gw>/`), compare its sha256 with the file we deployed, retry with backoff while a
// fresh CID propagates. A gateway that serves different bytes for the CID fails the whole check.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { baseString, type Fetch } from "./http.ts";

export type GatewaySpec = { base: string; style: "path" | "subdomain" };

/**
 * Parse one gateway setting: `https://ipfs.example.com` is path style, `https://{cid}.ipfs.example.com` (or a bare
 * host either way) is subdomain style.
 */
export function parseGateway(raw: string): GatewaySpec {
  let s = raw.trim();
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  const style = s.includes("{cid}.ipfs.") ? "subdomain" : "path";
  const base = baseString(style === "subdomain" ? s.replace("{cid}.ipfs.", "") : s);
  if (style === "subdomain" && new URL(base).pathname !== "/") throw new Error("a subdomain gateway takes no path");
  return { base, style };
}

export function parseGateways(list: string): GatewaySpec[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseGateway);
}

/** The URL a gateway serves a CID's root directory at. */
export function gatewayUrl(g: GatewaySpec, cid: string): string {
  if (g.style === "path") return `${g.base}/ipfs/${cid}/`;
  const u = new URL(g.base);
  return `${u.protocol}//${cid}.ipfs.${u.host}/`;
}

export const sha256Hex = (b: Uint8Array): string => bytesToHex(sha256(b));

export type GatewayCheck = { gateway: string; url: string; ok: boolean; attempts: number; status?: number; sha256?: string; error?: string };
export type Health = { ok: boolean; checkedAt: string; details: GatewayCheck[] };

export type HealthOptions = {
  cid: string;
  /** sha256 (hex) of the deployed index.html. */
  expectedSha256: string;
  gateways: GatewaySpec[];
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => Date;
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
};

async function checkOne(g: GatewaySpec, o: HealthOptions): Promise<GatewayCheck> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? Bun.sleep;
  const attempts = Math.max(1, o.attempts ?? 4);
  const url = gatewayUrl(g, o.cid) + "index.html";
  let last: GatewayCheck = { gateway: g.base, url, ok: false, attempts: 0 };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep((o.baseDelayMs ?? 500) * 2 ** (i - 1));
    last = { gateway: g.base, url, ok: false, attempts: i + 1 };
    try {
      const res = await f(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 10_000), redirect: "follow" });
      last.status = res.status;
      if (!res.ok) {
        last.error = `HTTP ${res.status}`;
        continue;
      }
      last.sha256 = sha256Hex(new Uint8Array(await res.arrayBuffer()));
      if (last.sha256 === o.expectedSha256) return { ...last, ok: true };
      // A CID-addressed gateway that serves other bytes is wrong, not slow: retrying will not help.
      return { ...last, error: "served content does not match the deployed index.html" };
    } catch (err) {
      last.error = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timed out" : err instanceof Error ? err.message : String(err);
    }
  }
  return last;
}

/** Healthy when at least one gateway serves the deployed index.html and none serves something else for the CID. */
export async function checkHealth(o: HealthOptions): Promise<Health> {
  const now = o.now ?? (() => new Date());
  if (!o.gateways.length) return { ok: false, checkedAt: now().toISOString(), details: [] };
  const details = await Promise.all(o.gateways.map((g) => checkOne(g, o)));
  const mismatch = details.some((d) => d.sha256 !== undefined && !d.ok);
  return { ok: !mismatch && details.some((d) => d.ok), checkedAt: now().toISOString(), details };
}
