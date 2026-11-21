// WS11 · local sandbox driver (Ventures Backend spec, PART 0 Law 1, PART 7, PART 13 test 2). Runs real processes in
// a private dir behind the sandbox's own egress proxy. Where the OS sandbox is available (sandbox-exec on macOS,
// bwrap on Linux) the tests also prove a process cannot route around the proxy. No internet: .test names map to local
// servers through the proxy resolver.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { defaultBuilderPolicy, LocalDriver, SandboxRefused, type EgressDecision, type EgressResolver } from "../../src/anonymo/ventures/sandbox/index.ts";

let hits = 0;
let rawHits = 0;
let allowed: ReturnType<typeof Bun.serve>;
let target: ReturnType<typeof Bun.serve>;
let rawServer: net.Server;
let rawPort = 0;
let resolve: EgressResolver;
const root = path.join(os.tmpdir(), `anonymo-sandbox-test-${process.pid}`);

beforeAll(async () => {
  allowed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello from allowed") });
  target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (hits++, new Response("target content")) });
  rawServer = net.createServer((s) => {
    rawHits++;
    s.end("raw");
  });
  await new Promise<void>((ok) => rawServer.listen(0, "127.0.0.1", () => ok()));
  rawPort = (rawServer.address() as net.AddressInfo).port;
  const map: Record<string, number> = { "allowed.test": allowed.port!, "gateway.test": allowed.port!, "target.test": target.port! };
  resolve = async (host) => {
    if (!map[host]) throw new Error("unmapped");
    return { host: "127.0.0.1", port: map[host]! };
  };
});

afterAll(() => {
  allowed.stop(true);
  target.stop(true);
  rawServer.close();
  rmSync(root, { recursive: true, force: true });
});

const policy = (timeMs = 60_000) => defaultBuilderPolicy({ gatewayHost: "gateway.test", targetHosts: ["target.test"], timeMs });

describe("LocalDriver", () => {
  test("files in, bun -e and bun test run inside, files out, dir removed on destroy", async () => {
    const sb = await new LocalDriver({ root, resolve }).create(policy());
    const dir = (sb as unknown as { path: string }).path;
    try {
      expect(sb.id).toMatch(/^sbx_[0-9a-f]{16}$/);
      expect(sb.policyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(dir.startsWith(path.resolve(root)) || dir.includes("anonymo-sandbox-test-")).toBe(true);
      expect((await Bun.file(dir).stat()).mode & 0o777).toBe(0o700);
      await sb.writeFiles({
        "src/add.ts": "export const add = (a: number, b: number) => a + b;\n",
        "src/add.test.ts": 'import { test, expect } from "bun:test";\nimport { add } from "./add.ts";\ntest("adds", () => expect(add(2, 3)).toBe(5));\n',
      });
      const hello = await sb.exec(["bun", "-e", "console.log('inside', process.cwd() === process.env.HOME)"]);
      expect(hello.code).toBe(0);
      expect(hello.stdout.trim()).toBe("inside true");
      const t = await sb.exec(["bun", "test"]);
      expect(t.code).toBe(0);
      expect(t.stderr).toContain("1 pass");
      await sb.exec(["bun", "-e", "await Bun.write('out/result.txt', 'built')"]);
      const files = await sb.readFiles();
      expect(files["out/result.txt"]).toBe("built");
      expect(files["src/add.ts"]).toContain("add");
      expect(await sb.readFiles(["out/result.txt"])).toEqual({ "out/result.txt": "built" });
    } finally {
      await sb.destroy();
    }
    expect(existsSync(dir)).toBe(false);
  }, 30_000);

  test("env is scrubbed and points at the sandbox's own proxy", async () => {
    process.env.ANONYMO_HOST_CANARY = "host-secret";
    const sb = await new LocalDriver({ root, resolve }).create(policy());
    try {
      const r = await sb.exec(["bun", "-e", "console.log(JSON.stringify(process.env))"], { env: { EXTRA: "1", HTTPS_PROXY: "http://evil.test" } });
      const env = JSON.parse(r.stdout) as Record<string, string>;
      expect(env.ANONYMO_HOST_CANARY).toBeUndefined();
      expect(env.EXTRA).toBe("1");
      expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
      expect(env.ALL_PROXY).toBe(env.HTTPS_PROXY);
      expect(env.NO_PROXY).toBe("");
      expect(env.TMPDIR!.startsWith(env.HOME!)).toBe(true);
    } finally {
      delete process.env.ANONYMO_HOST_CANARY;
      await sb.destroy();
    }
  }, 30_000);

  test("a fetch to the target through the proxy is dropped and logged; the allowed host works", async () => {
    const logged: EgressDecision[] = [];
    const sb = await new LocalDriver({ root, resolve }).create(policy(), { logger: (d) => logged.push(d) });
    try {
      const r = await sb.exec(["bun", "-e", "for (const u of ['http://gateway.test/', 'http://target.test/', 'https://target.test/']) { try { const r = await fetch(u); console.log(u, r.status, await r.text()); } catch (e) { console.log(u, 'error') } }"]);
      expect(r.stdout).toContain("http://gateway.test/ 200 hello from allowed");
      expect(r.stdout).toContain("http://target.test/ 403");
      expect(r.stdout).toMatch(/https:\/\/target\.test\/ (403|error)/);
      expect(hits).toBe(0);
      expect(logged.filter((d) => d.host === "target.test" && !d.allowed).length).toBeGreaterThanOrEqual(2);
      expect(sb.egressLog().some((d) => d.host === "gateway.test" && d.allowed)).toBe(true);
    } finally {
      await sb.destroy();
    }
  }, 30_000);

  test("a direct connection that bypasses the proxy is blocked when the OS enforces the network", async () => {
    const sb = await new LocalDriver({ root, resolve }).create(policy());
    try {
      if (sb.enforced.network !== "os") {
        console.warn(`skip: no OS network sandbox here (enforced.network=${sb.enforced.network})`);
        return;
      }
      const before = rawHits;
      const r = await sb.exec(["bun", "-e", `const s = require('net').connect(${rawPort}, '127.0.0.1'); s.on('connect', () => { console.log('CONNECTED'); s.destroy(); }); s.on('error', (e) => console.log('blocked', e.code));`]);
      expect(r.stdout).not.toContain("CONNECTED");
      expect(r.stdout).toContain("blocked");
      expect(rawHits).toBe(before);
    } finally {
      await sb.destroy();
    }
  }, 30_000);

  test("writes outside the sandbox dir and reads of a sibling sandbox are blocked when the OS enforces it", async () => {
    const driver = new LocalDriver({ root, resolve });
    const a = await driver.create(policy());
    const b = await driver.create({ ...policy(), zone: "SCOUT" });
    try {
      if (a.enforced.network !== "os") return console.warn("skip: no OS sandbox here");
      await b.writeFiles({ "scout.har": "target capture" });
      const siblingFile = path.join((b as unknown as { path: string }).path, "scout.har");
      const outside = path.join(path.dirname(path.resolve(root)), `anonymo-escape-${process.pid}.txt`);
      const r = await a.exec(["bun", "-e", `const fs = require('fs'); try { fs.writeFileSync(${JSON.stringify(outside)}, 'x'); console.log('WROTE'); } catch (e) { console.log('write blocked'); } try { console.log('READ', fs.readFileSync(${JSON.stringify(siblingFile)}, 'utf8')); } catch (e) { console.log('read blocked'); }`]);
      expect(r.stdout).toContain("write blocked");
      expect(r.stdout).toContain("read blocked");
      expect(existsSync(outside)).toBe(false);
    } finally {
      await a.destroy();
      await b.destroy();
    }
  }, 30_000);

  test("timeouts kill the whole process group", async () => {
    const sb = await new LocalDriver({ root, resolve }).create(policy());
    try {
      const marker = "late.txt";
      const r = await sb.exec(["sh", "-c", `(sleep 2; echo late > ${marker}) & sleep 30`], { timeoutMs: 300 });
      expect(r.timedOut).toBe(true);
      expect(r.code).toBe(124);
      expect(r.ms).toBeLessThan(5000);
      await Bun.sleep(2500);
      expect(await sb.readFiles()).not.toHaveProperty(marker);
    } finally {
      await sb.destroy();
    }
  }, 30_000);

  test("the policy time cap bounds every exec", async () => {
    const sb = await new LocalDriver({ root, resolve }).create(policy(500));
    try {
      const r = await sb.exec(["sleep", "10"]);
      expect(r.timedOut).toBe(true);
      const again = await sb.exec(["true"]);
      expect(again.timedOut).toBe(true);
    } finally {
      await sb.destroy();
    }
  }, 30_000);

  test("output is truncated at the cap", async () => {
    const sb = await new LocalDriver({ root, resolve, outputCapBytes: 1000 }).create(policy());
    try {
      const r = await sb.exec(["bun", "-e", "process.stdout.write('x'.repeat(50000))"]);
      expect(r.stdout.length).toBeLessThan(1100);
      expect(r.stdout).toContain("[output truncated]");
    } finally {
      await sb.destroy();
    }
  }, 30_000);

  test("paths cannot escape the sandbox dir", async () => {
    const sb = await new LocalDriver({ root, resolve }).create(policy());
    try {
      await expect(sb.writeFiles({ "../escape.txt": "x" })).rejects.toThrow();
      await expect(sb.writeFiles({ "/etc/escape.txt": "x" })).rejects.toThrow();
      await sb.exec(["ln", "-s", path.dirname(path.resolve(root)), "link"]);
      await expect(sb.writeFiles({ "link/escape.txt": "x" })).rejects.toThrow();
      await expect(sb.exec(["true"], { cwd: "../" })).rejects.toThrow();
    } finally {
      await sb.destroy();
    }
  }, 30_000);

  test("production refuses a CLEAN sandbox the OS cannot enforce", async () => {
    const d = new LocalDriver({ root, resolve, network: "proxy-only" });
    expect((await d.enforcement()).network).toBe("proxy-only");
    await expect(d.create(policy(), { production: true })).rejects.toThrow(SandboxRefused);
    const dev = await d.create(policy());
    expect(dev.enforced.network).toBe("proxy-only");
    await dev.destroy();
  });
});
