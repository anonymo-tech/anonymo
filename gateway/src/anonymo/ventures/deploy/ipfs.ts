// WS11 · Ventures deploy (Ventures Backend spec, PART 7 "static: IPFS pinned on 2 independent pinning services"): the
// two kinds of pinner a venture can deploy to.
//
// "No-ID hosting is fragile ... IPFS needs pinning. The crew deploys to two places by default." A Kubo-RPC endpoint
// (a node, or a pinning service that exposes /api/v0/add) takes the files and returns the root CID; an IPFS Pinning
// Service API endpoint pins a CID that is already on the network. deployStatic (index.ts) wires them together.

import { authHeader, endpointBase, errorText, httpError, joinUrl, type Endpoint, type Fetch } from "./http.ts";

export type KuboEndpoint = Endpoint & { kind: "kubo" };
export type PinningServiceEndpoint = Endpoint & { kind: "psa" };
export type PinnerEndpoint = KuboEndpoint | PinningServiceEndpoint;

export type SiteFiles = Record<string, Uint8Array | string>;
export type AddEntry = { name: string; cid: string; size: number | null };
export type AddResult = { cid: string; entries: AddEntry[] };

const enc = new TextEncoder();

export const toBytes = (v: Uint8Array | string): Uint8Array => (typeof v === "string" ? enc.encode(v) : v);

/** A site path is relative, `/`-separated, with no empty, `.` or `..` segments. Returns it unchanged or throws. */
export function checkSitePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw new Error(`bad site path: ${JSON.stringify(path)}`);
  for (const seg of path.split("/")) if (!seg || seg === "." || seg === "..") throw new Error(`bad site path: ${JSON.stringify(path)}`);
  return path;
}

/** Every directory a set of file paths implies, parents before children ("a", "a/b", ...). */
export function impliedDirectories(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The multipart body Kubo's /api/v0/add reads as a directory tree: one part per directory (application/x-directory)
 * and per file, each named "file" with the URL-encoded path as its filename, as the Kubo RPC clients send it.
 */
export function kuboMultipart(files: SiteFiles, boundary = `anonymo-${crypto.randomUUID()}`): { body: Uint8Array; contentType: string } {
  const paths = Object.keys(files).map(checkSitePath).sort();
  if (!paths.length) throw new Error("no files to add");
  const chunks: Uint8Array[] = [];
  const head = (filename: string, type: string) =>
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(filename)}"\r\nContent-Type: ${type}\r\n\r\n`);
  for (const dir of impliedDirectories(paths)) chunks.push(head(dir, "application/x-directory"), enc.encode("\r\n"));
  for (const p of paths) chunks.push(head(p, "application/octet-stream"), toBytes(files[p]), enc.encode("\r\n"));
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Kubo's add response: one JSON object per line. The wrapping directory is the entry with an empty Name. */
export function parseAddResponse(text: string): AddResult {
  const entries: AddEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as { Name?: string; Hash?: string; Size?: string | number; Message?: string; Type?: string };
    if (o.Type === "error" || (o.Message && !o.Hash)) throw new Error(`add failed: ${String(o.Message).slice(0, 200)}`);
    if (typeof o.Hash !== "string") continue;
    entries.push({ name: o.Name ?? "", cid: o.Hash, size: o.Size == null ? null : Number(o.Size) });
  }
  if (!entries.length) throw new Error("add returned no entries");
  const root = entries.find((e) => e.name === "") ?? entries[entries.length - 1];
  return { cid: root.cid, entries };
}

/** Add a directory to a Kubo-RPC endpoint, pinned, as CIDv1, wrapped in a directory; returns the wrapper's CID. */
export async function addDirectory(endpoint: Endpoint, files: SiteFiles, opts: { fetch?: Fetch; auth?: string | null } = {}): Promise<AddResult> {
  const f = opts.fetch ?? fetch;
  const token = opts.auth ?? endpoint.token;
  const { body, contentType } = kuboMultipart(files);
  const url = joinUrl(endpoint.url, "/api/v0/add?wrap-with-directory=true&cid-version=1&pin=true&quieter=false");
  const res = await f(url, { method: "POST", headers: { "content-type": contentType, ...authHeader(token) }, body });
  if (!res.ok) throw new Error(await httpError(endpoint.name, res, token));
  return parseAddResponse(await res.text());
}

// ---- IPFS Pinning Service API (https://ipfs.github.io/pinning-services-api-spec/) --------------------------------

export type PinState = "queued" | "pinning" | "pinned" | "failed";
export type PinStatus = { requestid: string; status: PinState; created?: string; pin: { cid: string; name?: string }; delegates?: string[]; info?: Record<string, unknown> };

const PIN_STATES = new Set<PinState>(["queued", "pinning", "pinned", "failed"]);

function readPinStatus(o: unknown): PinStatus {
  const s = o as PinStatus;
  if (!s || typeof s.requestid !== "string" || !PIN_STATES.has(s.status) || typeof s.pin?.cid !== "string") throw new Error("pinning service returned an unexpected pin status");
  return s;
}

/** POST /pins: ask the service to pin a CID that is already on the network. */
export async function pinByCid(endpoint: Endpoint, pin: { cid: string; name?: string; origins?: string[] }, opts: { fetch?: Fetch } = {}): Promise<PinStatus> {
  const f = opts.fetch ?? fetch;
  const res = await f(joinUrl(endpoint.url, "/pins"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(endpoint.token) },
    body: JSON.stringify(pin),
  });
  if (!res.ok) throw new Error(await httpError(endpoint.name, res, endpoint.token));
  return readPinStatus(await res.json());
}

/** GET /pins?cid=: the service's pins for one CID (newest first, per the spec). */
export async function pinsForCid(endpoint: Endpoint, cid: string, opts: { fetch?: Fetch } = {}): Promise<PinStatus[]> {
  const f = opts.fetch ?? fetch;
  const res = await f(joinUrl(endpoint.url, `/pins?cid=${encodeURIComponent(cid)}`), { headers: authHeader(endpoint.token) });
  if (!res.ok) throw new Error(await httpError(endpoint.name, res, endpoint.token));
  const body = (await res.json()) as { count?: number; results?: unknown[] };
  return (body.results ?? []).map(readPinStatus);
}

export type PinOutcome = { service: string; ok: boolean; cid?: string; error?: string };

/**
 * Pin a CID by reference and wait (bounded) until the service says "pinned". Still queued after `attempts` checks is
 * reported as not ok, so the deploy shows degraded instead of claiming two copies it does not have yet.
 */
export async function pinAndWait(
  endpoint: Endpoint,
  cid: string,
  opts: { name?: string; fetch?: Fetch; sleep?: (ms: number) => Promise<unknown>; attempts?: number; delayMs?: number } = {},
): Promise<PinOutcome> {
  const sleep = opts.sleep ?? Bun.sleep;
  const attempts = opts.attempts ?? 5;
  try {
    let st = await pinByCid(endpoint, { cid, name: opts.name }, opts);
    for (let i = 0; st.status !== "pinned" && st.status !== "failed" && i < attempts; i++) {
      await sleep((opts.delayMs ?? 1000) * 2 ** i);
      st = (await pinsForCid(endpoint, cid, opts)).find((p) => p.requestid === st.requestid) ?? st;
    }
    if (st.pin.cid !== cid) return { service: endpoint.name, ok: false, cid: st.pin.cid, error: `${endpoint.name}: reported CID ${st.pin.cid}, expected ${cid}` };
    if (st.status !== "pinned") return { service: endpoint.name, ok: false, cid, error: `${endpoint.name}: pin is ${st.status}` };
    return { service: endpoint.name, ok: true, cid };
  } catch (err) {
    return { service: endpoint.name, ok: false, error: errorText(endpoint.name, err, endpoint.token) };
  }
}

/** Two pinners count as independent only when they live on different hosts. Throws otherwise. */
export function checkIndependent(pinners: PinnerEndpoint[]): void {
  if (pinners.length < 2) throw new Error("a static deploy needs two pinning services");
  const hosts = pinners.map((p) => endpointBase(p.url).hostname.toLowerCase());
  if (new Set(hosts).size !== hosts.length) throw new Error("the pinning services must be on different hosts");
  if (!pinners.some((p) => p.kind === "kubo")) throw new Error("at least one pinner must accept files (Kubo RPC /api/v0/add)");
}
