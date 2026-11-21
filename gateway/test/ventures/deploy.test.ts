import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  addDirectory,
  arweaveUploaderFor,
  buildPathManifest,
  checkHealth,
  deployConfigFromEnv,
  deployStatic,
  DeployConfigError,
  gatewayUrl,
  HttpBundlerUploader,
  kuboMultipart,
  NullUploader,
  parseGateway,
  parseAddResponse,
  type Deployment,
  type DnsProvider,
  type PinnerEndpoint,
} from "../../src/anonymo/ventures/deploy/index.ts";

// Ventures Backend PART 7, static deploy targets: two pinning services that must agree on the root CID, an Arweave
// copy, gateway health checks and rollback. Every remote is a Bun.serve mock on port 0; a routing fetch maps the
// sample hostnames (pin-a.example.com, ...) onto those mocks so the "different hosts" rule is exercised for real.

const CID_NEW = "bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm";
const CID_OTHER = "bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4";
const CID_PREV = "bafkreidnubrtkkg6viaujz5qlayv6c3vh3alsriwhjzl7fva2gayb6o6bu";

const SITE = { "index.html": "<!doctype html><h1>sample venture</h1>", "assets/app.js": "console.log('hi')", "assets/img/logo.svg": "<svg/>" };
const PREV_INDEX = "<!doctype html><h1>previous</h1>";

const noSleep = async () => {};
const fixedNow = () => new Date("2026-11-20T12:00:00.000Z");

type Seen = { url: string; auth: string | null; contentType: string | null; body: Uint8Array };

function kuboMock(cid: () => string | null) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = new Uint8Array(await req.arrayBuffer());
      seen.push({ url: req.url, auth: req.headers.get("authorization"), contentType: req.headers.get("content-type"), body });
      const root = cid();
      if (!root) return new Response("down", { status: 503 });
      const text = new TextDecoder().decode(body);
      const names = [...text.matchAll(/filename="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]));
      const lines = names.map((n) => JSON.stringify({ Name: n, Hash: "bafkqaaa", Size: "1" }));
      lines.push(JSON.stringify({ Name: "", Hash: root, Size: "100" }));
      return new Response(lines.join("\n") + "\n", { headers: { "content-type": "application/json" } });
    },
  });
  return { server, seen };
}

/** gateway mock: serves index.html per CID, path style or subdomain style (via the routed original host). */
function gatewayMock(content: Record<string, string>, opts: { failFirst?: number } = {}) {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      calls++;
      if (opts.failFirst && calls <= opts.failFirst) return new Response("warming", { status: 504 });
      const u = new URL(req.url);
      const host = req.headers.get("x-original-host") ?? "";
      let cid = /^\/ipfs\/([^/]+)\/index\.html$/.exec(u.pathname)?.[1];
      if (!cid && u.pathname === "/index.html") cid = /^([^.]+)\.ipfs\./.exec(host)?.[1];
      const body = cid ? content[cid] : undefined;
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
  return { server, calls: () => calls };
}

function routed(map: Record<string, Server>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const host = Object.keys(map).find((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    if (!host) throw new TypeError(`no route to ${u.hostname}`);
    const headers = { ...((init?.headers as Record<string, string>) ?? {}), "x-original-host": u.host };
    return fetch(`http://127.0.0.1:${map[host].port}${u.pathname}${u.search}`, { ...init, headers });
  }) as typeof fetch;
}

const A: PinnerEndpoint = { kind: "kubo", name: "pin-a", url: "https://pin-a.example.com", token: "tok-a-sample" };
const B: PinnerEndpoint = { kind: "kubo", name: "pin-b", url: "https://pin-b.example.net/rpc", token: "tok-b-sample" };
const GW = [parseGateway("https://gw.example.org"), parseGateway("https://{cid}.ipfs.gw.example.org")];

let cidA: string | null = CID_NEW;
let cidB: string | null = CID_NEW;
const kA = kuboMock(() => cidA);
const kB = kuboMock(() => cidB);
const live = gatewayMock({ [CID_NEW]: SITE["index.html"], [CID_PREV]: PREV_INDEX });
const wrong = gatewayMock({ [CID_NEW]: "tampered", [CID_PREV]: PREV_INDEX });
const fetchLive = routed({ "pin-a.example.com": kA.server, "pin-b.example.net": kB.server, "gw.example.org": live.server });
const fetchWrong = routed({ "pin-a.example.com": kA.server, "pin-b.example.net": kB.server, "gw.example.org": wrong.server });

afterAll(() => {
  for (const s of [kA.server, kB.server, live.server, wrong.server]) s.stop(true);
});

const deploy = (over: Partial<Parameters<typeof deployStatic>[0]> = {}) =>
  deployStatic({ ventureId: "v_sample", files: SITE, pinners: [A, B], gateways: GW, fetch: fetchLive, now: fixedNow, sleep: noSleep, ...over });

describe("Kubo add", () => {
  test("multipart names every directory and file with an encoded path, as Kubo reads a tree", () => {
    const { body, contentType } = kuboMultipart({ "index.html": "x", "a b/c.txt": "y" }, "BOUNDARY");
    const text = new TextDecoder().decode(body);
    expect(contentType).toBe("multipart/form-data; boundary=BOUNDARY");
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="a%20b"\r\nContent-Type: application/x-directory');
    expect(text).toContain('filename="a%20b%2Fc.txt"\r\nContent-Type: application/octet-stream\r\n\r\ny\r\n');
    expect(text.indexOf('filename="a%20b"')).toBeLessThan(text.indexOf('filename="a%20b%2Fc.txt"'));
    expect(text.endsWith("--BOUNDARY--\r\n")).toBe(true);
    expect(() => kuboMultipart({ "../x": "no" })).toThrow();
    expect(() => kuboMultipart({ "/abs": "no" })).toThrow();
  });

  test("the root is the wrapping entry with an empty Name; error lines throw", () => {
    const r = parseAddResponse(`{"Name":"index.html","Hash":"bafkqaaa","Size":"3"}\n{"Name":"","Hash":"${CID_NEW}","Size":"9"}\n`);
    expect(r.cid).toBe(CID_NEW);
    expect(r.entries).toHaveLength(2);
    expect(() => parseAddResponse(`{"Message":"blockstore full","Code":0,"Type":"error"}`)).toThrow("blockstore full");
  });

  test("POSTs to /api/v0/add with the wrap/CIDv1/pin flags and the token only in the Authorization header", async () => {
    kA.seen.length = 0;
    const r = await addDirectory(A, SITE, { fetch: fetchLive });
    expect(r.cid).toBe(CID_NEW);
    const s = kA.seen[0];
    const u = new URL(s.url);
    expect(u.pathname).toBe("/api/v0/add");
    expect(Object.fromEntries(u.searchParams)).toEqual({ "wrap-with-directory": "true", "cid-version": "1", pin: "true", quieter: "false" });
    expect(s.auth).toBe("Bearer tok-a-sample");
    expect(s.url).not.toContain("tok-a");
    expect(s.contentType).toStartWith("multipart/form-data; boundary=");
  });
});

describe("deployStatic", () => {
  test("two hosts agreeing on the CID, served by the gateways: live", async () => {
    cidA = cidB = CID_NEW;
    const d = await deploy();
    expect(d.status).toBe("live");
    expect(d.cid).toBe(CID_NEW);
    expect(d.pins).toEqual([
      { service: "pin-a", ok: true, cid: CID_NEW },
      { service: "pin-b", ok: true, cid: CID_NEW },
    ]);
    expect(d.urls).toEqual([`https://gw.example.org/ipfs/${CID_NEW}/`, `https://${CID_NEW}.ipfs.gw.example.org/`]);
    expect(d.health.ok).toBe(true);
    expect(d.health.details.map((x) => x.ok)).toEqual([true, true]);
    expect(d.arweave).toEqual({ skipped: "skipped: not configured" });
    expect(d.target).toBe("ipfs");
    expect(d.id).toMatch(/^dep_[0-9a-f]{20}$/);
  });

  test("one pinning service down: degraded, and the reason is recorded", async () => {
    cidA = CID_NEW;
    cidB = null;
    const d = await deploy();
    expect(d.status).toBe("degraded");
    expect(d.cid).toBe(CID_NEW);
    expect(d.pins[1].ok).toBe(false);
    expect(d.pins[1].error).toContain("HTTP 503");
    expect(d.problems.join(" ")).toContain("pin missing");
    expect(JSON.stringify(d)).not.toContain("tok-b-sample");
  });

  test("the two services disagree on the CID: failed, nothing is named", async () => {
    cidA = CID_NEW;
    cidB = CID_OTHER;
    const d = await deploy({ names: { dnslink: { domain: "example.com" } } });
    expect(d.status).toBe("failed");
    expect(d.problems[0]).toContain("disagree");
    expect(d.dnslink).toBeUndefined();
    expect(d.urls).toEqual([]);
  });

  test("two pinners on the same host are refused before anything is uploaded", async () => {
    cidA = cidB = CID_NEW;
    kA.seen.length = 0;
    const same: PinnerEndpoint = { ...B, name: "pin-a2", url: "https://pin-a.example.com/other" };
    await expect(deploy({ pinners: [A, same] })).rejects.toBeInstanceOf(DeployConfigError);
    await expect(deploy({ pinners: [A] })).rejects.toBeInstanceOf(DeployConfigError);
    await expect(deploy({ files: { "about.html": "x" } })).rejects.toThrow("index.html");
    expect(kA.seen).toHaveLength(0);
  });

  test("health fails with a previous deployment: rolled back, previous CID live, names point at it", async () => {
    cidA = cidB = CID_NEW;
    const previous = { cid: CID_PREV, arweave: { id: "p".repeat(43) } } as Deployment;
    const setTxt: [string, string][] = [];
    const dns: DnsProvider = { name: "sample-dns", setTxt: async (n, v) => void setTxt.push([n, v]) };
    const d = await deploy({
      fetch: fetchWrong,
      previous,
      names: { dnslink: { domain: "example.com", provider: dns }, ens: { name: "sample.eth", resolver: "0x" + "ab".repeat(20) }, arns: { name: "sample" } },
    });
    expect(d.status).toBe("rolled-back");
    expect(d.cid).toBe(CID_PREV);
    expect(d.rejectedCid).toBe(CID_NEW);
    expect(d.urls[0]).toBe(`https://gw.example.org/ipfs/${CID_PREV}/`);
    expect(setTxt).toEqual([["_dnslink.example.com", `dnslink=/ipfs/${CID_PREV}`]]);
    expect(d.dnslink?.set).toBe(true);
    expect(d.ens && "contenthash" in d.ens && d.ens.contenthash).toBe(`0xe301${bytesToHex(b32decode(CID_PREV.slice(1)))}`);
    expect(d.arns).toMatchObject({ name: "sample", transactionId: "p".repeat(43) });
    expect(d.health.details[0].error).toContain("does not match");
  });

  test("health fails with no previous deployment: failed, and no names are produced", async () => {
    cidA = cidB = CID_NEW;
    const d = await deploy({ fetch: fetchWrong, names: { dnslink: { domain: "example.com" } } });
    expect(d.status).toBe("failed");
    expect(d.dnslink).toBeUndefined();
    expect(d.health.ok).toBe(false);
  });

  test("a Pinning Service API pinner pins the CID the Kubo pinner produced", async () => {
    cidA = CID_NEW;
    const posted: unknown[] = [];
    let polls = 0;
    const psa = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (req.headers.get("authorization") !== "Bearer tok-psa-sample") return new Response("{}", { status: 401 });
        if (req.method === "POST" && u.pathname === "/v1/pins") {
          const body = (await req.json()) as { cid: string; name: string };
          posted.push(body);
          return Response.json({ requestid: "r1", status: "queued", created: "2026-11-20T12:00:00Z", pin: body, delegates: [] }, { status: 202 });
        }
        if (req.method === "GET" && u.pathname === "/v1/pins" && u.searchParams.get("cid") === CID_NEW) {
          polls++;
          return Response.json({ count: 1, results: [{ requestid: "r1", status: polls < 2 ? "pinning" : "pinned", pin: { cid: CID_NEW }, delegates: [] }] });
        }
        return new Response("no", { status: 404 });
      },
    });
    try {
      const P: PinnerEndpoint = { kind: "psa", name: "pin-psa", url: "https://psa.example.net/v1", token: "tok-psa-sample" };
      const f = routed({ "pin-a.example.com": kA.server, "psa.example.net": psa, "gw.example.org": live.server });
      const d = await deploy({ pinners: [A, P], fetch: f });
      expect(posted).toEqual([{ cid: CID_NEW, name: "venture-v_sample" }]);
      expect(polls).toBe(2);
      expect(d.status).toBe("live");
      expect(d.pins).toEqual([
        { service: "pin-a", ok: true, cid: CID_NEW },
        { service: "pin-psa", ok: true, cid: CID_NEW },
      ]);
    } finally {
      psa.stop(true);
    }
  });
});

describe("Arweave", () => {
  test("files then an arweave/paths v0.2.0 manifest go to the bundler with a bearer token", async () => {
    const uploads: { type: string | null; auth: string | null; body: string; path: string }[] = [];
    let n = 0;
    const bundler = Bun.serve({
      port: 0,
      async fetch(req) {
        uploads.push({ type: req.headers.get("content-type"), auth: req.headers.get("authorization"), body: await req.text(), path: new URL(req.url).pathname });
        return Response.json({ id: String(n++).padStart(43, "x") });
      },
    });
    try {
      const up = new HttpBundlerUploader({ name: "bundler", url: "https://bundler.example.com", token: "tok-ar-sample" }, { fetch: routed({ "bundler.example.com": bundler }) });
      const r = await up.upload({ files: SITE });
      expect(uploads.every((u) => u.auth === "Bearer tok-ar-sample" && u.path === "/tx")).toBe(true);
      expect(uploads).toHaveLength(4);
      const last = uploads[3];
      expect(last.type).toBe("application/x.arweave-manifest+json");
      const manifest = JSON.parse(last.body);
      expect(manifest).toEqual({
        manifest: "arweave/paths",
        version: "0.2.0",
        index: { path: "index.html" },
        paths: { "assets/app.js": { id: "x".repeat(42) + "0" }, "assets/img/logo.svg": { id: "x".repeat(42) + "1" }, "index.html": { id: "x".repeat(42) + "2" } },
      });
      expect("id" in r && r.id).toBe("x".repeat(42) + "3");
      expect(uploads[2].type).toBe("text/html; charset=utf-8");
    } finally {
      bundler.stop(true);
    }
  });

  test("the manifest index must be one of the paths; the null uploader says it skipped", async () => {
    expect(() => buildPathManifest("index.html", { "a.html": "y".repeat(43) })).toThrow();
    expect(await new NullUploader().upload()).toEqual({ skipped: "skipped: not configured" });
  });
});

describe("health", () => {
  test("path and subdomain gateway URLs", () => {
    expect(gatewayUrl(parseGateway("ipfs.example.org"), CID_NEW)).toBe(`https://ipfs.example.org/ipfs/${CID_NEW}/`);
    expect(gatewayUrl(parseGateway("https://{cid}.ipfs.example.org"), CID_NEW)).toBe(`https://${CID_NEW}.ipfs.example.org/`);
    expect(() => parseGateway("http://gw.example.org")).toThrow("https");
  });

  test("passes after retrying a warming gateway, with backoff", async () => {
    const warm = gatewayMock({ [CID_NEW]: SITE["index.html"] }, { failFirst: 2 });
    const slept: number[] = [];
    try {
      const h = await checkHealth({
        cid: CID_NEW,
        expectedSha256: bytesToHex(sha256(new TextEncoder().encode(SITE["index.html"]))),
        gateways: [GW[0]],
        fetch: routed({ "gw.example.org": warm.server }),
        sleep: async (ms) => void slept.push(ms),
        baseDelayMs: 100,
        now: fixedNow,
      });
      expect(h).toMatchObject({ ok: true, checkedAt: "2026-11-20T12:00:00.000Z" });
      expect(h.details[0].attempts).toBe(3);
      expect(slept).toEqual([100, 200]);
    } finally {
      warm.server.stop(true);
    }
  });

  test("fails on wrong bytes, on a gateway that never answers, and with no gateways", async () => {
    const expected = bytesToHex(sha256(new TextEncoder().encode(SITE["index.html"])));
    const bad = await checkHealth({ cid: CID_NEW, expectedSha256: expected, gateways: GW, fetch: fetchWrong, sleep: noSleep });
    expect(bad.ok).toBe(false);
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const slow = await checkHealth({ cid: CID_NEW, expectedSha256: expected, gateways: [GW[0]], fetch: routed({ "gw.example.org": hang }), sleep: noSleep, attempts: 2, timeoutMs: 50 });
      expect(slow.ok).toBe(false);
      expect(slow.details[0]).toMatchObject({ attempts: 2, error: "timed out" });
    } finally {
      hang.stop(true);
    }
    expect((await checkHealth({ cid: CID_NEW, expectedSha256: expected, gateways: [] })).ok).toBe(false);
  });
});

describe("config from the environment", () => {
  test("unset pieces are null; set ones become endpoints with the token kept out of the URL", () => {
    expect(deployConfigFromEnv({})).toEqual({ pinners: [null, null], arweave: null, gateways: null });
    expect(arweaveUploaderFor(deployConfigFromEnv({}))).toBeInstanceOf(NullUploader);
    const cfg = deployConfigFromEnv({
      VENTURES_IPFS_A_URL: "https://pin-a.example.com",
      VENTURES_IPFS_A_TOKEN: "tok-a-sample",
      VENTURES_IPFS_B_URL: "https://psa.example.net/v1",
      VENTURES_IPFS_B_KIND: "psa",
      VENTURES_ARWEAVE_URL: "https://bundler.example.com",
      VENTURES_ARWEAVE_TOKEN: "tok-ar-sample",
      VENTURES_IPFS_GATEWAYS: "https://gw.example.org, https://{cid}.ipfs.gw.example.net",
    });
    expect(cfg.pinners).toEqual([
      { kind: "kubo", name: "ipfs-a", url: "https://pin-a.example.com", token: "tok-a-sample" },
      { kind: "psa", name: "ipfs-b", url: "https://psa.example.net/v1", token: null },
    ]);
    expect(cfg.arweave).toEqual({ name: "arweave", url: "https://bundler.example.com", token: "tok-ar-sample" });
    expect(cfg.gateways).toEqual([
      { base: "https://gw.example.org", style: "path" },
      { base: "https://gw.example.net", style: "subdomain" },
    ]);
    expect(arweaveUploaderFor(cfg)).toBeInstanceOf(HttpBundlerUploader);
  });

  test("an endpoint URL with credentials in it is refused", () => {
    expect(() => new HttpBundlerUploader({ name: "b", url: "https://user:secret@bundler.example.com" })).toThrow("credentials");
  });
});

// independent base32 (RFC 4648 lowercase, no padding) for the vectors
function b32decode(s: string): Uint8Array {
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = "";
  for (const c of s) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Uint8Array.from(out);
}

beforeAll(() => {
  // sanity: the sample CIDs are well-formed CIDv1 strings
  for (const c of [CID_NEW, CID_OTHER, CID_PREV]) expect(b32decode(c.slice(1))[0]).toBe(1);
});
