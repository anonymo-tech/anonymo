// WS11 · E2B sandbox driver (Ventures Backend spec, PART 7: self-hosted E2B, one microVM per candidate, egress
// allowlist passed as the sandbox network policy). Runs against a local Bun.serve mock of the control-plane and envd
// endpoints the driver uses. No internet.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultBuilderPolicy, E2BDriver, e2bNetworkConfig, REGISTRY_HOSTS, SandboxRefused } from "../../src/anonymo/ventures/sandbox/index.ts";

type Created = Record<string, any>;
const created: Created[] = [];
const killed: string[] = [];
const signals: any[] = [];
const files = new Map<string, string>();
const authSeen: Record<string, string | null>[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";

function frame(json: unknown, flags = 0): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(5 + body.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}
const b64 = (s: string) => Buffer.from(s).toString("base64");

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v2/sandboxes" && req.method === "POST") {
        if (req.headers.get("x-api-key") !== "test-key") return new Response("unauthorized", { status: 401 });
        const body = await req.json();
        created.push(body);
        return Response.json({ sandboxID: `mock${created.length}`, templateID: body.templateID, clientID: "c", envdVersion: "0.2.0", envdAccessToken: "envd-token", domain: "mock.test" }, { status: 201 });
      }
      if (url.pathname.startsWith("/sandboxes/") && req.method === "DELETE") {
        killed.push(url.pathname.slice("/sandboxes/".length));
        return new Response(null, { status: 204 });
      }
      authSeen.push({ token: req.headers.get("x-access-token"), auth: req.headers.get("authorization") });
      if (url.pathname === "/files" && req.method === "POST") {
        const form = await req.formData();
        files.set(url.searchParams.get("path")!, await (form.get("file") as Blob).text());
        return Response.json([{ path: url.searchParams.get("path"), type: "file" }]);
      }
      if (url.pathname === "/files" && req.method === "GET") {
        const v = files.get(url.searchParams.get("path")!);
        return v === undefined ? new Response("not found", { status: 404 }) : new Response(v);
      }
      if (url.pathname === "/process.Process/SendSignal") {
        signals.push(await req.json());
        return Response.json({});
      }
      if (url.pathname === "/process.Process/Start") {
        if (req.headers.get("content-type") !== "application/connect+json") return new Response("bad codec", { status: 415 });
        const buf = new Uint8Array(await req.arrayBuffer());
        const start = JSON.parse(new TextDecoder().decode(buf.subarray(5)));
        const { cmd, args, cwd } = start.process as { cmd: string; args: string[]; cwd: string };
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(frame({ event: { start: { pid: 42 } } }));
            if (cmd === "sleep") return; // hangs until the client aborts
            if (cmd === "echo") c.enqueue(frame({ event: { data: { stdout: b64(args.join(" ") + "\n") } } }));
            if (cmd === "find") {
              const list = [...files.keys()].filter((k) => k.startsWith(cwd + "/")).map((k) => "./" + k.slice(cwd.length + 1));
              c.enqueue(frame({ event: { data: { stdout: b64(list.join("\n") + "\n") } } }));
            }
            if (cmd === "false") c.enqueue(frame({ event: { data: { stderr: b64("nope\n") } } }));
            c.enqueue(frame({ event: { end: { exitCode: cmd === "false" ? 1 : 0, exited: true, status: "exit status" } } }));
            c.enqueue(frame({}, 0x02));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/connect+json" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const driver = (extra: Partial<ConstructorParameters<typeof E2BDriver>[0]> = {}) => new E2BDriver({ baseUrl: base, apiKey: "test-key", envdUrl: () => base, ...extra });
const policy = () => defaultBuilderPolicy({ gatewayHost: "gateway.test", targetHosts: ["target.test"], timeMs: 90_500 });

describe("E2BDriver", () => {
  test("needs a URL and API key", () => {
    const saved = [process.env.VENTURES_E2B_URL, process.env.VENTURES_E2B_API_KEY];
    delete process.env.VENTURES_E2B_URL;
    delete process.env.VENTURES_E2B_API_KEY;
    expect(() => new E2BDriver()).toThrow();
    if (saved[0]) process.env.VENTURES_E2B_URL = saved[0];
    if (saved[1]) process.env.VENTURES_E2B_API_KEY = saved[1];
  });

  test("create passes the egress allowlist as the VM network policy, then files, exec and kill work", async () => {
    const sb = await driver().create(policy());
    expect(sb.enforced).toEqual({ network: "vm", fs: "vm" });
    const body = created.at(-1)!;
    expect(body.templateID).toBe("base");
    expect(body.cpuCount).toBe(2);
    expect(body.timeout).toBe(91);
    expect(body.network.denyOut).toEqual(["0.0.0.0/0"]);
    expect(body.network.allowPublicTraffic).toBe(false);
    for (const h of REGISTRY_HOSTS) expect(body.network.allowOut).toContain(h);
    expect(body.network.allowOut).toContain("gateway.test");
    expect(JSON.stringify(body.network)).not.toContain("target.test");
    expect(body.metadata.anonymoPolicyHash).toBe(sb.policyHash);

    await sb.writeFiles({ "src/a.ts": "export const a = 1;\n", "README.md": "hi" });
    expect(files.get("/home/user/src/a.ts")).toBe("export const a = 1;\n");
    expect(authSeen.at(-1)).toEqual({ token: "envd-token", auth: `Basic ${Buffer.from("user:").toString("base64")}` });
    expect(await sb.readFiles(["src/a.ts"])).toEqual({ "src/a.ts": "export const a = 1;\n" });
    expect(await sb.readFiles()).toEqual({ "src/a.ts": "export const a = 1;\n", "README.md": "hi" });

    const r = await sb.exec(["echo", "hello", "vm"]);
    expect(r).toMatchObject({ code: 0, stdout: "hello vm\n", timedOut: false });
    const f = await sb.exec(["false"]);
    expect(f.code).toBe(1);
    expect(f.stderr).toBe("nope\n");
    await expect(sb.writeFiles({ "../x": "" })).rejects.toThrow();

    await sb.destroy();
    expect(killed).toContain(sb.id);
  });

  test("exec timeout kills the process and reports timedOut", async () => {
    const sb = await driver().create(policy());
    const r = await sb.exec(["sleep", "100"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
    expect(signals.at(-1)).toEqual({ process: { pid: 42 }, signal: "SIGNAL_SIGKILL" });
    await sb.destroy();
  });

  test("a cluster without network policy support refuses CLEAN unless allowUnenforced (never in production)", async () => {
    const d = driver({ nativeNetwork: false });
    const before = created.length;
    await expect(d.create(policy())).rejects.toThrow(SandboxRefused);
    await expect(d.create(policy(), { allowUnenforced: true, production: true })).rejects.toThrow(SandboxRefused);
    expect(created.length).toBe(before);
    const sb = await d.create(policy(), { allowUnenforced: true });
    expect(sb.enforced.network).toBe("none");
    expect(created.at(-1)!.network).toBeUndefined();
    await sb.destroy();
  });

  test("network config keeps deny-wins: covered patterns are dropped, a target under a wildcard is refused", () => {
    const p = { ...policy(), egressAllow: ["registry.npmjs.org", "api.target.test", "gateway.test"], egressDeny: ["target.test"] };
    expect(e2bNetworkConfig(p).allowOut).toEqual(["registry.npmjs.org", "gateway.test"]);
    expect(() => e2bNetworkConfig({ ...p, egressAllow: ["*.npmjs.org"], egressDeny: ["evil.npmjs.org"] })).toThrow(SandboxRefused);
    expect(e2bNetworkConfig({ ...p, egressAllow: ["*.target.test"] }).allowOut).toEqual([]);
  });
});
