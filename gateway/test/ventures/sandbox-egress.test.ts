// WS11 · sandbox egress proxy (Ventures Backend spec, PART 13 test 2): "A builder sandbox's request to the target
// domain is dropped and logged." Local servers stand in for an allowed host and the target; .test names are mapped to
// their loopback ports through the proxy's injectable resolver. No internet.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { defaultBuilderPolicy, startEgressProxy, type EgressDecision, type EgressProxy, type EgressResolver } from "../../src/anonymo/ventures/sandbox/index.ts";

let hits = 0;
let allowed: ReturnType<typeof Bun.serve>;
let target: ReturnType<typeof Bun.serve>;
let proxy: EgressProxy;
const dropped: EgressDecision[] = [];

beforeAll(async () => {
  allowed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello from allowed") });
  target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (hits++, new Response("target content")) });
  const map: Record<string, number> = { "allowed.test": allowed.port!, "target.test": target.port! };
  const resolve: EgressResolver = async (host) => {
    if (!map[host]) throw new Error("unmapped");
    return { host: "127.0.0.1", port: map[host]! };
  };
  const policy = defaultBuilderPolicy({ gatewayHost: "allowed.test", targetHosts: ["target.test"] });
  proxy = await startEgressProxy({ policy, resolve, logger: (d) => dropped.push(d) });
});

afterAll(async () => {
  await proxy.close();
  allowed.stop(true);
  target.stop(true);
});

/** Sends raw bytes to the proxy and collects everything until the socket closes. */
function raw(send: (s: net.Socket, first: string) => string | null, initial: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxy.port, "127.0.0.1");
    let got = "";
    let stage = 0;
    s.on("connect", () => s.write(initial));
    s.on("data", (b) => {
      got += b.toString();
      if (stage === 0 && got.includes("\r\n\r\n")) {
        stage = 1;
        const next = send(s, got);
        if (next) s.write(next);
      }
    });
    s.on("error", reject);
    s.on("close", () => resolve(got));
  });
}

describe("egress proxy", () => {
  test("listens on 127.0.0.1", () => {
    expect(proxy.host).toBe("127.0.0.1");
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
  });

  test("CONNECT to an allowed host tunnels", async () => {
    const out = await raw((_s, first) => (first.startsWith("HTTP/1.1 200") ? "GET / HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n" : null), "CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n");
    expect(out).toStartWith("HTTP/1.1 200 Connection Established");
    expect(out).toContain("hello from allowed");
  });

  test("CONNECT to the target is dropped and logged, and the target is never reached", async () => {
    const before = dropped.length;
    const out = await raw(() => null, "CONNECT target.test:443 HTTP/1.1\r\nHost: target.test:443\r\n\r\n");
    expect(out).toStartWith("HTTP/1.1 403");
    expect(hits).toBe(0);
    const d = dropped.slice(before);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ host: "target.test", port: 443, allowed: false, reason: "denylisted" });
    expect(typeof d[0]!.at).toBe("string");
  });

  test("subdomains of the target and IP literals are dropped", async () => {
    for (const [line, reason] of [
      ["CONNECT api.target.test:443", "denylisted"],
      ["CONNECT 127.0.0.1:" + 443, "ip-literal"],
      ["CONNECT [::1]:443", "ip-literal"],
      ["CONNECT unknown.test:443", "not-allowlisted"],
    ] as const) {
      const out = await raw(() => null, `${line} HTTP/1.1\r\n\r\n`);
      expect(out).toStartWith("HTTP/1.1 403");
      expect(proxy.decisions.at(-1)).toMatchObject({ allowed: false, reason });
    }
    expect(hits).toBe(0);
  });

  test("plain HTTP absolute-URI: allowed host forwards, target is dropped", async () => {
    const ok = await fetch("http://allowed.test/x?y=1", { proxy: proxy.url });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hello from allowed");
    const no = await fetch("http://target.test/", { proxy: proxy.url });
    expect(no.status).toBe(403);
    expect(no.headers.get("x-anonymo-egress")).toBe("denylisted");
    expect(hits).toBe(0);
    expect(proxy.decisions.filter((d) => d.host === "target.test").every((d) => !d.allowed)).toBe(true);
  });

  test("every decision is recorded, allowed ones included", () => {
    expect(proxy.decisions.some((d) => d.allowed && d.host === "allowed.test")).toBe(true);
    for (const d of proxy.decisions) expect(Object.keys(d).sort()).toEqual(["allowed", "at", "host", "port", "reason"]);
  });

  test("malformed requests are refused", async () => {
    const out = await raw(() => null, "NONSENSE\r\n\r\n");
    expect(out).toStartWith("HTTP/1.1 400");
  });
});
