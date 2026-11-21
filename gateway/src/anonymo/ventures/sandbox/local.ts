// WS11 · Ventures local sandbox driver for dev and CI (Ventures Backend spec, PART 0 Law 1, PART 7, PART 13 test 2).
//
// Law 1 says isolation is "enforced by sandbox network policy and mounts, not prompts". Production runs one Firecracker
// microVM per candidate (e2b.ts). Locally each sandbox gets a private 0700 directory under a fixed root (the path never
// comes from venture input), a scrubbed environment, and its own egress proxy. Where the OS can enforce it, the process
// cannot route around the proxy: on macOS `sandbox-exec` denies all network except the proxy's loopback port, denies
// writes outside the sandbox dir and denies reads of sibling sandboxes; on Linux `bwrap --unshare-net` leaves the
// process with no network at all, and a tiny Bun relay inside the namespace forwards the proxy port to the host proxy's
// unix socket. Without either tool the driver reports `network: "proxy-only"`.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdirSync, chmodSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEgressProxy, type EgressLogger, type EgressProxy, type EgressResolver } from "./egress.ts";
import { policyHash, validatePolicy, type SandboxPolicy } from "./policy.ts";
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

export const DEFAULT_OUTPUT_CAP = 1024 * 1024;
const READ_ALL_CAP = 16 * 1024 * 1024;
const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export type LocalDriverOptions = {
  /** Where sandbox dirs live. Defaults to a fixed folder under os.tmpdir(). */
  root?: string;
  /** Injectable name resolution for the egress proxy (tests map *.test names to local ports). */
  resolve?: EgressResolver;
  logger?: EgressLogger;
  outputCapBytes?: number;
  /** Force a mode ("proxy-only" skips the OS sandbox); "auto" picks the strongest available. */
  network?: "auto" | "proxy-only";
};

type OsMode = "sandbox-exec" | "bwrap" | null;

/** The bun binary to run inside the sandbox. */
export function bunBinary(): string {
  const exec = process.execPath;
  if (path.basename(exec).startsWith("bun")) return exec;
  return Bun.which("bun") ?? exec;
}

function sbplString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** macOS Seatbelt profile: no network but the proxy port on loopback, no writes outside dir, no reads of siblings. */
export function seatbeltProfile(opts: { dir: string; root: string; proxyPort: number }): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    `(allow network-outbound (remote ip ${sbplString(`localhost:${opts.proxyPort}`)}))`,
    '(deny mach-lookup (global-name "com.apple.mDNSResponder" "com.apple.nsurlsessiond" "com.apple.nsurlsessiond.NSURLSessionProxyService"))',
    "(deny file-write*)",
    `(allow file-write* (subpath ${sbplString(opts.dir)}) (subpath "/dev"))`,
    `(deny file-read* (subpath ${sbplString(opts.root)}))`,
    `(allow file-read* (subpath ${sbplString(opts.dir)}))`,
  ].join("\n");
}

// Runs inside the bwrap network namespace: listen on the proxy port on loopback, forward to the host proxy's unix
// socket, run the command, exit with its code. Configuration comes in through env and is removed before the command.
const RELAY_JS = `
const net = require("net"); const { spawn } = require("child_process");
const port = Number(process.env.ANONYMO_RELAY_PORT); const sock = process.env.ANONYMO_RELAY_SOCK;
const cmd = JSON.parse(process.env.ANONYMO_RELAY_CMD);
for (const k of ["ANONYMO_RELAY_PORT", "ANONYMO_RELAY_SOCK", "ANONYMO_RELAY_CMD"]) delete process.env[k];
const srv = net.createServer((c) => { const u = net.connect(sock); c.pipe(u); u.pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); });
srv.listen(port, "127.0.0.1", () => {
  const p = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: process.env });
  p.on("error", (e) => { process.stderr.write(String(e) + "\\n"); process.exit(127); });
  p.on("exit", (code, sig) => process.exit(code ?? (sig ? 137 : 1)));
});
`;

let bwrapProbe: boolean | undefined;
function bwrapWorks(bin: string): boolean {
  if (bwrapProbe !== undefined) return bwrapProbe;
  const r = spawnSync(bin, ["--die-with-parent", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"], { timeout: 5000 });
  bwrapProbe = r.status === 0;
  return bwrapProbe;
}

function detectOsMode(): OsMode {
  if (process.platform === "darwin" && Bun.which("sandbox-exec")) return "sandbox-exec";
  if (process.platform === "linux") {
    const bin = Bun.which("bwrap");
    if (bin && bwrapWorks(bin)) return "bwrap";
  }
  return null;
}

function ensureRoot(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return realpathSync(root);
}

class Capture {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly cap: number) {}
  push(b: Buffer) {
    if (this.size >= this.cap) {
      this.truncated = true;
      return;
    }
    const take = b.subarray(0, this.cap - this.size);
    if (take.length < b.length) this.truncated = true;
    this.chunks.push(take);
    this.size += take.length;
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8") + (this.truncated ? "\n[output truncated]" : "");
  }
}

function killGroup(child: ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

class LocalSandbox implements Sandbox {
  readonly policyHash: string;
  private readonly running = new Set<ChildProcess>();
  private readonly deadline: number;
  private destroyed = false;

  constructor(
    readonly id: string,
    readonly policy: SandboxPolicy,
    readonly enforced: Enforcement,
    private readonly dir: string,
    private readonly root: string,
    private readonly proxy: EgressProxy,
    private readonly mode: OsMode,
    private readonly outputCap: number,
  ) {
    this.policyHash = policyHash(policy);
    this.deadline = Date.now() + policy.timeMs;
  }

  /** The sandbox's private directory (host side). */
  get path() {
    return this.dir;
  }

  private async resolveInside(rel: string, forWrite: boolean): Promise<string> {
    const clean = safeRelativePath(rel);
    const full = path.join(this.dir, clean);
    const parent = path.dirname(full);
    if (forWrite) await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
    if (realParent !== this.dir && !realParent.startsWith(this.dir + path.sep)) throw new Error(`sandbox path escapes: ${rel}`);
    const st = await lstat(full).catch(() => null);
    if (st?.isSymbolicLink()) throw new Error(`sandbox path is a symlink: ${rel}`);
    return full;
  }

  private async resolveDir(rel: string): Promise<string> {
    const full = path.join(this.dir, safeRelativePath(rel));
    await mkdir(full, { recursive: true });
    const real = await realpath(full);
    if (real !== this.dir && !real.startsWith(this.dir + path.sep)) throw new Error(`sandbox path escapes: ${rel}`);
    return real;
  }

  async writeFiles(files: Record<string, string | Uint8Array>): Promise<void> {
    this.assertLive();
    for (const [rel, content] of Object.entries(files)) {
      const full = await this.resolveInside(rel, true);
      await writeFile(full, content, { mode: 0o600 });
    }
  }

  async readFiles(paths?: string[]): Promise<Record<string, string>> {
    this.assertLive();
    const out: Record<string, string> = {};
    if (paths) {
      for (const rel of paths) {
        const full = await this.resolveInside(rel, false);
        out[safeRelativePath(rel)] = await readFile(full, "utf8");
      }
      return out;
    }
    let total = 0;
    const walk = async (relDir: string) => {
      const entries = await readdir(path.join(this.dir, relDir), { withFileTypes: true });
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          await walk(rel);
        } else if (e.isFile()) {
          const buf = await readFile(path.join(this.dir, rel));
          total += buf.length;
          if (total > READ_ALL_CAP) throw new Error("sandbox readFiles exceeded cap");
          out[rel] = buf.toString("utf8");
        }
      }
    };
    await walk("");
    return out;
  }

  private env(extra?: Record<string, string>): Record<string, string> {
    const bunDir = path.dirname(bunBinary());
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra ?? {})) if (!PROXY_ENV.includes(k)) env[k] = v;
    Object.assign(env, {
      PATH: [bunDir, ...SYSTEM_PATH].join(":"),
      HOME: this.dir,
      TMPDIR: path.join(this.dir, ".tmp"),
      LANG: "C.UTF-8",
      BUN_INSTALL_CACHE_DIR: path.join(this.dir, ".bun", "install", "cache"),
    });
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[k] = this.proxy.url;
    env.NO_PROXY = "";
    env.no_proxy = "";
    return env;
  }

  private argv(cmd: string[], env: Record<string, string>, cwd: string): string[] {
    const [first, ...rest] = cmd;
    if (!first) throw new Error("empty command");
    const bin = first === "bun" ? bunBinary() : first.includes("/") ? first : (Bun.which(first, { PATH: env.PATH }) ?? first);
    const resolved = [bin, ...rest];
    if (this.mode === "sandbox-exec") {
      return [Bun.which("sandbox-exec") ?? "/usr/bin/sandbox-exec", "-p", seatbeltProfile({ dir: this.dir, root: this.root, proxyPort: this.proxy.port }), ...resolved];
    }
    if (this.mode === "bwrap") {
      env.ANONYMO_RELAY_PORT = String(this.proxy.port);
      env.ANONYMO_RELAY_SOCK = this.proxy.unixPath!;
      env.ANONYMO_RELAY_CMD = JSON.stringify(resolved);
      return [
        Bun.which("bwrap")!,
        "--die-with-parent",
        "--unshare-net",
        "--unshare-pid",
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", this.root,
        "--bind", this.dir, this.dir,
        "--chdir", cwd,
        "--",
        bunBinary(), "-e", RELAY_JS,
      ];
    }
    return resolved;
  }

  async exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.assertLive();
    const started = Date.now();
    const remaining = this.deadline - started;
    const timeoutMs = Math.min(opts.timeoutMs ?? remaining, remaining);
    if (timeoutMs <= 0) return { code: 124, stdout: "", stderr: "sandbox time cap reached", ms: 0, timedOut: true };
    const cwd = opts.cwd ? await this.resolveDir(opts.cwd) : this.dir;
    const env = this.env(opts.env);
    const argv = this.argv(cmd, env, cwd);
    const out = new Capture(this.outputCap);
    const err = new Capture(this.outputCap);
    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      this.running.add(child);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, timeoutMs);
      child.stdout!.on("data", (b: Buffer) => out.push(b));
      child.stderr!.on("data", (b: Buffer) => err.push(b));
      let spawnError: string | null = null;
      child.on("error", (e) => {
        spawnError = String(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.running.delete(child);
        killGroup(child); // reap anything the command left running in its group
        resolve({
          code: timedOut ? 124 : (code ?? (signal ? 137 : 1)),
          stdout: out.text(),
          stderr: spawnError ? `${err.text()}${spawnError}` : err.text(),
          ms: Date.now() - started,
          timedOut,
        });
      });
    });
  }

  egressLog() {
    return [...this.proxy.decisions];
  }

  private assertLive() {
    if (this.destroyed) throw new Error(`sandbox ${this.id} destroyed`);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const c of this.running) killGroup(c);
    await this.proxy.close();
    await rm(this.dir, { recursive: true, force: true });
  }
}

export class LocalDriver implements SandboxDriver {
  readonly name = "local";
  private readonly root: string;
  constructor(private readonly opts: LocalDriverOptions = {}) {
    this.root = opts.root ?? path.join(os.tmpdir(), "anonymo-sandboxes");
  }

  async enforcement(): Promise<Enforcement> {
    const mode = this.opts.network === "proxy-only" ? null : detectOsMode();
    return { network: mode ? "os" : "proxy-only", fs: "private-dir" };
  }

  async create(policy: SandboxPolicy, opts: CreateOptions = {}): Promise<LocalSandbox> {
    validatePolicy(policy);
    const mode = this.opts.network === "proxy-only" ? null : detectOsMode();
    const enforced: Enforcement = { network: mode ? "os" : "proxy-only", fs: "private-dir" };
    if (!enforcementSufficient(policy, enforced, opts.production) && !(opts.allowUnenforced && !opts.production)) {
      throw new SandboxRefused(`local driver can only enforce network=${enforced.network}; refusing CLEAN sandbox`);
    }
    const root = ensureRoot(this.root);
    const dir = await realpath(await mkdtemp(path.join(root, "sbx-")));
    await chmod(dir, 0o700);
    await mkdir(path.join(dir, ".tmp"), { recursive: true, mode: 0o700 });
    const id = `sbx_${randomBytes(8).toString("hex")}`;
    let proxy: EgressProxy;
    try {
      proxy = await startEgressProxy({
        policy,
        resolve: this.opts.resolve,
        logger: opts.logger ?? this.opts.logger,
        unixPath: mode === "bwrap" ? path.join(dir, ".egress.sock") : undefined,
      });
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    return new LocalSandbox(id, policy, enforced, dir, root, proxy, mode, this.opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP);
  }
}
