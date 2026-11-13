// One command to run the gateway on this machine: three mock model providers, the router (contract-free), and a local
// API key funded with test credit.
//   bun run launch              # http://127.0.0.1:8787
//   bun run launch --fresh      # wipe the local chain and database first
//   bun run launch --open       # also open the site in the default browser
//   bun run launch --port 8800  # serve on another port
// If it is already running, it prints the address instead of starting a second copy.
// The database, the admin token and the local key persist in .data/ between runs. Everything here is local test
// infrastructure: mock models and test credit. No chain is started; deposits are WS05's and need real chains.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const DATA = resolve(ROOT, ".data");
const DB_DIR = resolve(DATA, "pglite-launch");
const SECRETS_FILE = resolve(DATA, "launch.env");
const PROVIDER_PORTS = [9101, 9102, 9103];

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const openBrowser = args.includes("--open");
const portArg = args.indexOf("--port");
const PORT_FIXED = portArg >= 0 || !!process.env.PORT;
let PORT = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.PORT ?? 8787);
let URL_BASE = `http://127.0.0.1:${PORT}`;

const children: { name: string; proc: Subprocess; signal: NodeJS.Signals }[] = [];
let stopping = false;
const say = (msg: string) => console.log(`[launch] ${msg}`);

function die(msg: string): never {
  console.error(`[launch] ${msg}`);
  void shutdown(1);
  throw new Error(msg);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  // Router first (it may be writing), then the providers.
  for (const c of [...children].reverse()) {
    if (c.proc.exitCode !== null) continue;
    c.proc.kill(c.signal);
    await Promise.race([c.proc.exited, Bun.sleep(8_000)]);
    if (c.proc.exitCode === null) c.proc.kill("SIGKILL");
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

function spawn(name: string, cmd: string[], opts: { env?: Record<string, string>; log?: string; signal?: NodeJS.Signals } = {}) {
  const out = opts.log ? Bun.file(opts.log) : "inherit";
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...opts.env }, stdout: out, stderr: out, stdin: "ignore" });
  children.push({ name, proc, signal: opts.signal ?? "SIGTERM" });
  void proc.exited.then((code) => {
    if (!stopping) {
      console.error(`[launch] ${name} exited unexpectedly (code ${code})${opts.log ? `; see ${opts.log}` : ""}. Stopping.`);
      void shutdown(1);
    }
  });
  return proc;
}

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  const code = await proc.exited;
  if (code !== 0) die(`${cmd.join(" ")} failed (exit ${code}).`);
}

async function listening(port: number) {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open() {}, close() {}, error() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(250);
  }
  die(`${what} did not come up within ${timeoutMs / 1000}s.`);
}

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, "$1");
  }
  return out;
}

/** A router started by this launcher already serving on a nearby port? (It answers with the launch database's marker.) */
async function runningInstance(): Promise<string | null> {
  const marker = readEnvFile(SECRETS_FILE).LAUNCH_MARKER;
  if (!marker) return null;
  for (let port = 8787; port < 8807; port++) {
    if (!(await listening(port))) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { signal: AbortSignal.timeout(1500) });
      const d = ((await r.json()) as { data?: { env?: string; receipts?: { key_id?: string } } }).data;
      if (d?.env === "development" && (await listening(PROVIDER_PORTS[0]))) return `http://127.0.0.1:${port}`;
    } catch {
      /* not ours */
    }
  }
  return null;
}

function openUrl(url: string) {
  Bun.spawn(process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
}

async function main() {
  const existing = fresh ? null : await runningInstance();
  if (existing) {
    console.log(`\n  The gateway is already running: ${existing}/v1\n  Stop it with Ctrl-C in the terminal that started it, then run this again to restart.\n`);
    if (openBrowser) openUrl(existing + "/");
    process.exit(0);
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) die("--port needs a port number.");
  if (await listening(PORT)) {
    if (PORT_FIXED) die(`port ${PORT} is already in use. Stop whatever is using it or pick another --port.`);
    const first = PORT;
    while (PORT < first + 20 && (await listening(PORT))) PORT++;
    if (await listening(PORT)) die(`ports ${first}-${PORT} are all in use; pass --port.`);
    URL_BASE = `http://127.0.0.1:${PORT}`;
    say(`port ${first} is busy (another program), using ${PORT} instead`);
  }
  for (const port of PROVIDER_PORTS) if (await listening(port)) die(`port ${port} (mock providers) is already in use — is another "bun run launch" still running? Stop it and retry.`);
  mkdirSync(DATA, { recursive: true });

  if (fresh) {
    say("--fresh: removing the launch database and its key");
    rmSync(DB_DIR, { recursive: true, force: true });
    rmSync(SECRETS_FILE, { force: true });
  }

  // ---- secrets for this local install (never committed; .data/ is ignored)
  if (!existsSync(SECRETS_FILE)) {
    writeFileSync(SECRETS_FILE, `APP_SECRET=${randomBytes(32).toString("hex")}\nADMIN_TOKEN=${randomBytes(24).toString("hex")}\nLAUNCH_MARKER=1\n`, { mode: 0o600 });
  }
  const env: Record<string, string> = {
    ...readEnvFile(SECRETS_FILE),
    ANONYMO_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    PUBLIC_BASE_URL: URL_BASE,
    DATABASE_URL: `pglite://${DB_DIR}`,
    ALLOW_DEV_ATTESTATION: "true",
    CANARIES: "false",
    // Faster than production so the hourly receipt root is visible within minutes.
    ANCHOR_INTERVAL_MS: "120000",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  };

  // ---- mock providers, then seed them (the database is single-process, so seed before the router)
  say("starting three mock model providers (ports 9101-9103)");
  spawn("mock providers", ["bun", "scripts/mock-providers.ts"], { log: resolve(DATA, "launch-providers.log") });
  await waitFor("the mock providers", async () => (await Promise.all(PROVIDER_PORTS.map(listening))).every(Boolean), 20_000);
  await run(["bun", "scripts/seed.ts", "config/providers.local.yaml"], ROOT, env);
  await run(["bun", "scripts/launch-upstreams.ts"], ROOT, env); // the four Anonymo model IDs on the mock providers
  if (!readEnvFile(SECRETS_FILE).LAUNCH_KEY) {
    say("creating a local API key with $10 of test credit");
    const made = Bun.spawnSync(["bun", "scripts/launch-key.ts", "10"], { cwd: ROOT, env: { ...process.env, ...env }, stderr: "inherit" });
    const key = made.stdout.toString().trim().split("\n").at(-1) ?? "";
    if (made.exitCode !== 0 || !key) die("could not create the local API key.");
    writeFileSync(SECRETS_FILE, `${readFileSync(SECRETS_FILE, "utf8")}LAUNCH_KEY=${key}\n`, { mode: 0o600 });
  }

  // ---- router
  say(`starting the router on ${URL_BASE}`);
  spawn("router", ["bun", "src/index.ts"], { env });
  await waitFor("the router", async () => (await fetch(`${URL_BASE}/health`)).ok, 60_000);

  const secrets = readEnvFile(SECRETS_FILE);
  console.log(`
  The gateway is running locally.

    API        ${URL_BASE}/v1   (OpenAI-compatible; /api/v1 works too)
    Key        ${secrets.LAUNCH_KEY.slice(0, 12)}… in .data/launch.env (LAUNCH_KEY), $10 of test credit

  Try it:
    curl ${URL_BASE}/v1/chat/completions -H "authorization: Bearer $LAUNCH_KEY" \\
      -H "content-type: application/json" -d '{"model":"meta-llama/llama-3.3-70b-instruct","messages":[{"role":"user","content":"hello"}]}'

  The models are local mocks and the credit is test credit. The admin token (tRPC at /trpc, header x-admin-token) is
  ADMIN_TOKEN in .data/launch.env. "bun run launch --fresh" starts over. Press Ctrl-C to stop everything.
`);
  if (openBrowser) openUrl(URL_BASE + "/");
}

main().catch((e) => {
  if (!stopping) {
    console.error(`[launch] ${(e as Error).message}`);
    void shutdown(1);
  }
});
