// WS11 · Ventures E2B sandbox driver (Ventures Backend spec, PART 0 Law 1 and PART 7).
//
// PART 7: "self-hosted E2B (Apache-2.0) on crypto-paid servers; one Firecracker microVM per candidate; egress allowlist
// = package registries + Anonymo gateway only (no target domains)". The allowlist is handed to E2B as the sandbox's
// network config, so the microVM's firewall enforces it (network "vm"). If the cluster cannot take a network config,
// the driver refuses CLEAN sandboxes unless allowUnenforced is set (never in production).
//
// API shapes, checked against the e2b-dev/E2B repo specs (spec/openapi.yml, spec/envd/envd.yaml, process.proto):
//   control plane  POST /v2/sandboxes {templateID, timeout (s), cpuCount, network{allowOut, denyOut, allowPublicTraffic}}
//                  -> {sandboxID, envdAccessToken?, domain?}; DELETE /sandboxes/{sandboxID}; auth header X-API-Key.
//                  allowOut takes domains or CIDRs and wins over denyOut; denyOut takes CIDRs/IPs only.
//   envd (port 49983 on the sandbox host)
//                  GET/POST /files?path=&username= (multipart field "file"); auth header X-Access-Token.
//                  process.Process/Start: Connect server-streaming, JSON codec, StartRequest{process{cmd,args,envs,cwd}}
//                  -> stream of {event:{start{pid}|data{stdout|stderr (base64)}|end{exitCode,exited,status,error}}}.
// UNVERIFIED against a live cluster: the envd host form "49983-{sandboxID}.{domain}", Basic auth carrying the envd
// user, process.Process/SendSignal with {process:{pid}, signal:"SIGNAL_SIGKILL"}, and whether wildcard domains
// ("*.npmjs.org") are accepted in allowOut. memoryMB is not a create parameter: memory comes from the template.

import { egressDecide } from "./egress.ts";
import { normalizeHost, policyHash, validatePolicy, type SandboxPolicy } from "./policy.ts";
import {
  enforcementSufficient,
  safeRelativePath,
  SandboxRefused,
  type CreateOptions,
  type Enforcement,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxDriver,
} from "./driver.ts";
import type { EgressDecision } from "./egress.ts";

export const ENVD_PORT = 49983;
const OUTPUT_CAP = 1024 * 1024;

export type E2BDriverOptions = {
  baseUrl?: string;
  apiKey?: string;
  template?: string;
  /** false when the cluster's E2B version ignores the network config. Env VENTURES_E2B_NETWORK=off sets it. */
  nativeNetwork?: boolean;
  /** Where envd for a sandbox is reachable. Default https://49983-{id}.{domain}. */
  envdUrl?: (sb: { sandboxID: string; domain?: string | null }) => string;
  user?: string;
  workdir?: string;
  fetch?: typeof fetch;
};

type CreatedSandbox = { sandboxID: string; envdAccessToken?: string; domain?: string | null };

/** The E2B network config for a policy. Throws when E2B cannot express "deny wins" for it. */
export function e2bNetworkConfig(policy: SandboxPolicy): { allowOut: string[]; denyOut: string[]; allowPublicTraffic: boolean } {
  const allowOut: string[] = [];
  const denies = policy.egressDeny.map((d) => normalizeHost(d).replace(/^\*\./, "")).filter(Boolean);
  for (const raw of policy.egressAllow) {
    const p = normalizeHost(raw);
    const wildcard = p.startsWith("*.");
    const base = wildcard ? p.slice(2) : p;
    // A deny entry covering the whole pattern: drop the pattern (deny wins).
    if (egressDecide(base, { egressAllow: [base], egressDeny: denies }).reason === "denylisted") continue;
    // E2B lets allowOut win over denyOut, so a target under an allowed wildcard cannot be expressed: refuse.
    if (wildcard && denies.some((d) => d.endsWith("." + base))) {
      throw new SandboxRefused(`egress allow ${raw} covers a target domain; E2B cannot enforce deny-wins for it`);
    }
    allowOut.push(p);
  }
  return { allowOut, denyOut: ["0.0.0.0/0"], allowPublicTraffic: false };
}

function envelope(json: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(5 + body.length);
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

/** Splits a Connect streaming body into (flags, JSON) frames. */
export async function* connectFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ flags: number; json: any }> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  while (true) {
    while (buf.length >= 5) {
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
      if (buf.length < 5 + len) break;
      const flags = buf[0]!;
      const text = new TextDecoder().decode(buf.subarray(5, 5 + len));
      buf = buf.slice(5 + len);
      yield { flags, json: text ? JSON.parse(text) : {} };
    }
    const { done, value } = await reader.read();
    if (done) return;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
  }
}

const b64 = (s: string) => Buffer.from(s, "base64");

class E2BSandbox implements Sandbox {
  readonly policyHash: string;
  private destroyed = false;
  private readonly deadline: number;
  constructor(
    readonly id: string,
    readonly policy: SandboxPolicy,
    readonly enforced: Enforcement,
    private readonly envd: string,
    private readonly token: string | undefined,
    private readonly drv: Required<Pick<E2BDriverOptions, "user" | "workdir" | "fetch">> & { baseUrl: string; apiKey: string },
  ) {
    this.policyHash = policyHash(policy);
    this.deadline = Date.now() + policy.timeMs;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Basic ${Buffer.from(`${this.drv.user}:`).toString("base64")}`, ...extra };
    if (this.token) h["X-Access-Token"] = this.token;
    return h;
  }

  private abs(rel: string) {
    return `${this.drv.workdir.replace(/\/$/, "")}/${safeRelativePath(rel)}`;
  }

  async writeFiles(files: Record<string, string | Uint8Array>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const form = new FormData();
      form.append("file", new Blob([typeof content === "string" ? content : new Uint8Array(content)]), rel.split("/").pop());
      const q = new URLSearchParams({ path: this.abs(rel), username: this.drv.user });
      const r = await this.drv.fetch(`${this.envd}/files?${q}`, { method: "POST", headers: this.headers(), body: form });
      if (!r.ok) throw new Error(`e2b write ${rel} failed: ${r.status}`);
    }
  }

  async readFiles(paths?: string[]): Promise<Record<string, string>> {
    let list = paths?.map(safeRelativePath);
    if (!list) {
      const r = await this.exec(["find", ".", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "./.*"]);
      if (r.code !== 0) throw new Error(`e2b list files failed: ${r.stderr}`);
      list = r.stdout.split("\n").map((l) => l.replace(/^\.\//, "").trim()).filter(Boolean).map(safeRelativePath);
    }
    const out: Record<string, string> = {};
    for (const rel of list) {
      const q = new URLSearchParams({ path: this.abs(rel), username: this.drv.user });
      const r = await this.drv.fetch(`${this.envd}/files?${q}`, { headers: this.headers() });
      if (!r.ok) throw new Error(`e2b read ${rel} failed: ${r.status}`);
      out[rel] = await r.text();
    }
    return out;
  }

  async exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const remaining = this.deadline - started;
    const timeoutMs = Math.min(opts.timeoutMs ?? remaining, remaining);
    if (timeoutMs <= 0) return { code: 124, stdout: "", stderr: "sandbox time cap reached", ms: 0, timedOut: true };
    const [bin, ...args] = cmd;
    if (!bin) throw new Error("empty command");
    const cwd = opts.cwd ? this.abs(opts.cwd) : this.drv.workdir;
    const ctl = new AbortController();
    let pid: number | undefined;
    let timedOut = false;
    let killing: Promise<void> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) killing = this.kill(pid);
      ctl.abort();
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    let code = 1;
    try {
      const r = await this.drv.fetch(`${this.envd}/process.Process/Start`, {
        method: "POST",
        signal: ctl.signal,
        headers: this.headers({ "Content-Type": "application/connect+json", "Connect-Protocol-Version": "1", "Connect-Timeout-Ms": String(timeoutMs) }),
        body: envelope({ process: { cmd: bin, args, envs: opts.env ?? {}, cwd }, stdin: false }),
      });
      if (!r.ok || !r.body) throw new Error(`e2b exec failed: ${r.status}`);
      for await (const f of connectFrames(r.body)) {
        if (f.flags & 0x02) {
          if (f.json?.error) stderr += `${f.json.error.code ?? "error"}: ${f.json.error.message ?? ""}`;
          break;
        }
        const ev = f.json?.event ?? {};
        if (ev.start) pid = ev.start.pid;
        if (ev.data?.stdout && stdout.length < OUTPUT_CAP) stdout += b64(ev.data.stdout).toString("utf8");
        if (ev.data?.stderr && stderr.length < OUTPUT_CAP) stderr += b64(ev.data.stderr).toString("utf8");
        if (ev.end) code = typeof ev.end.exitCode === "number" ? ev.end.exitCode : ev.end.exited ? 0 : 1;
      }
    } catch (e) {
      if (!timedOut) throw e;
    } finally {
      clearTimeout(timer);
      await killing;
    }
    if (stdout.length > OUTPUT_CAP) stdout = stdout.slice(0, OUTPUT_CAP) + "\n[output truncated]";
    if (stderr.length > OUTPUT_CAP) stderr = stderr.slice(0, OUTPUT_CAP) + "\n[output truncated]";
    return { code: timedOut ? 124 : code, stdout, stderr, ms: Date.now() - started, timedOut };
  }

  private async kill(pid: number) {
    await this.drv
      .fetch(`${this.envd}/process.Process/SendSignal`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", "Connect-Protocol-Version": "1" }),
        body: JSON.stringify({ process: { pid }, signal: "SIGNAL_SIGKILL" }),
      })
      .catch(() => undefined);
  }

  /** E2B's firewall drops non-allowlisted egress inside the VM; it does not hand us a per-request log. */
  egressLog(): EgressDecision[] {
    return [];
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const r = await this.drv.fetch(`${this.drv.baseUrl}/sandboxes/${encodeURIComponent(this.id)}`, { method: "DELETE", headers: { "X-API-Key": this.drv.apiKey } });
    if (!r.ok && r.status !== 404) throw new Error(`e2b kill ${this.id} failed: ${r.status}`);
  }
}

export class E2BDriver implements SandboxDriver {
  readonly name = "e2b";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly nativeNetwork: boolean;
  constructor(private readonly opts: E2BDriverOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.VENTURES_E2B_URL;
    const apiKey = opts.apiKey ?? process.env.VENTURES_E2B_API_KEY;
    if (!baseUrl || !apiKey) throw new Error("E2BDriver needs VENTURES_E2B_URL and VENTURES_E2B_API_KEY");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.nativeNetwork = opts.nativeNetwork ?? process.env.VENTURES_E2B_NETWORK !== "off";
  }

  async enforcement(): Promise<Enforcement> {
    return { network: this.nativeNetwork ? "vm" : "none", fs: "vm" };
  }

  async create(policy: SandboxPolicy, opts: CreateOptions = {}): Promise<E2BSandbox> {
    validatePolicy(policy);
    const enforced = await this.enforcement();
    if (!enforcementSufficient(policy, enforced, opts.production) && !(opts.allowUnenforced && !opts.production)) {
      throw new SandboxRefused("this E2B cluster cannot enforce a network policy; refusing CLEAN sandbox");
    }
    const restrict = policy.zone === "CLEAN" || policy.egressAllow.length > 0;
    const body: Record<string, unknown> = {
      templateID: this.opts.template ?? process.env.VENTURES_E2B_TEMPLATE ?? "base",
      timeout: Math.max(1, Math.ceil(policy.timeMs / 1000)),
      cpuCount: policy.vcpu,
      autoPause: false,
      metadata: { anonymoPolicyHash: policyHash(policy), zone: policy.zone },
    };
    if (this.nativeNetwork && restrict) body.network = e2bNetworkConfig(policy);
    const f = this.opts.fetch ?? fetch;
    const r = await f(`${this.baseUrl}/v2/sandboxes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`e2b create failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const sb = (await r.json()) as CreatedSandbox;
    if (!sb.sandboxID) throw new Error("e2b create returned no sandboxID");
    const host = sb.domain ?? new URL(this.baseUrl).hostname;
    const envd = this.opts.envdUrl ? this.opts.envdUrl(sb) : `https://${ENVD_PORT}-${sb.sandboxID}.${host}`;
    return new E2BSandbox(sb.sandboxID, policy, enforced, envd.replace(/\/$/, ""), sb.envdAccessToken, {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      user: this.opts.user ?? "user",
      workdir: this.opts.workdir ?? "/home/user",
      fetch: f,
    });
  }
}
