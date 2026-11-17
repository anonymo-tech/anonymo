// Puts Anonymo's secrets into the linked Railway project without printing them or passing them on a command line.
// Run it yourself from gateway/ after `railway link` to the project:
//
//   bun scripts/railway-secrets.ts
//
// - APP_SECRET, ADMIN_TOKEN and RUNTIME_DB_PASSWORD: generated here as shared variables, only when missing (never
//   rotated by a re-run: APP_SECRET encrypts stored upstream keys, so rotating it is a maintenance step).
// - ANONYMO_FLOOR_KEY (shared): NANOGPT_API_KEY from gateway/.env.
// - ANONYMO_FLOOR_FALLBACK_KEY and ANONYMO_FLOOR_LLAMAGUARD_KEY (shared): a second PPQ API key, asked in a hidden
//   dialog. It must not be PPQ_API_KEY, which stays on the one-shot seeding services only.
// - upstreams-init gets PPQ_API_KEY and PPQ_CREDIT_ID, provider-init gets UPSTREAM_API_KEY, both from gateway/.env.
// Values travel to `railway api` in a mode-600 temporary file that is deleted straight after. Nothing is deployed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "anonymo-railway-"));
const cleanup = () => rmSync(dir, { recursive: true, force: true });
process.on("exit", cleanup);

function railway(query: string, variables: Record<string, unknown> = {}) {
  const q = join(dir, "q.graphql"), v = join(dir, "v.json");
  writeFileSync(q, query, { mode: 0o600 });
  writeFileSync(v, JSON.stringify(variables), { mode: 0o600 });
  const r = Bun.spawnSync(["railway", "api", "-f", q, "--variables", `@${v}`, "--compact"], { stderr: "pipe" });
  rmSync(v, { force: true });
  if (r.exitCode !== 0) throw new Error(`railway api failed: ${r.stderr.toString().replace(/\s+/g, " ").slice(0, 300)}`);
  const out = JSON.parse(r.stdout.toString());
  if (out.errors?.length) throw new Error(`railway api: ${out.errors.map((e: { message: string }) => e.message).join("; ")}`);
  return out.data;
}

function linked() {
  const r = Bun.spawnSync(["railway", "status", "--json"], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error("No linked Railway project here. Run `railway link` in gateway/ first.");
  const s = JSON.parse(r.stdout.toString());
  const env = s.environments.edges.find((e: { node: { name: string } }) => e.node.name === "production")?.node;
  if (!env) throw new Error("The linked project has no production environment.");
  const services = Object.fromEntries(s.services.edges.map((e: { node: { name: string; id: string } }) => [e.node.name, e.node.id]));
  return { projectId: s.id as string, environmentId: env.id as string, services: services as Record<string, string> };
}

function readEnv(file: string) {
  const out: Record<string, string> = {};
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function ask(prompt: string): string | null {
  const script = `on run argv
  set r to display dialog (item 1 of argv) default answer "" with hidden answer with title "Anonymo · Railway" buttons {"Skip", "Save"} default button 2 cancel button 1
  return text returned of r
end run`;
  const r = Bun.spawnSync(["osascript", "-", prompt], { stdin: new TextEncoder().encode(script), stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().replace(/\s+/g, "") || null : null;
}

const { projectId, environmentId, services } = linked();
const env = readEnv(join(import.meta.dir, "..", ".env"));
const upsert = `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`;
const set = (vars: Record<string, string>, serviceId?: string) =>
  railway(upsert, { input: { projectId, environmentId, ...(serviceId ? { serviceId } : {}), skipDeploys: true, variables: vars } });

const existing: Record<string, string> = railway(`query($p: String!, $e: String!) { variables(projectId: $p, environmentId: $e, unrendered: true) }`, { p: projectId, e: environmentId }).variables ?? {};
const done: string[] = [], skipped: string[] = [];

const shared: Record<string, string> = {};
for (const [name, bytes] of [["APP_SECRET", 32], ["ADMIN_TOKEN", 24], ["RUNTIME_DB_PASSWORD", 24]] as const) {
  if (existing[name]) continue;
  shared[name] = randomBytes(bytes).toString("hex");
  done.push(`${name} (generated)`);
}
if (env.NANOGPT_API_KEY) { shared.ANONYMO_FLOOR_KEY = env.NANOGPT_API_KEY; done.push("ANONYMO_FLOOR_KEY (NanoGPT)"); }
else if (!existing.ANONYMO_FLOOR_KEY) skipped.push("ANONYMO_FLOOR_KEY: no NANOGPT_API_KEY in gateway/.env (bash scripts/set-key.sh nanogpt)");

const second = ask("Paste a SECOND PayPerQ API key (make a new one in your PPQ account; not the one in gateway/.env). It is used for the fallback guard and Llama Guard. Skip keeps what Railway has.");
if (second && second === env.PPQ_API_KEY) skipped.push("second PPQ key: it is the same as PPQ_API_KEY, make a separate one");
else if (second) { shared.ANONYMO_FLOOR_FALLBACK_KEY = second; shared.ANONYMO_FLOOR_LLAMAGUARD_KEY = second; done.push("ANONYMO_FLOOR_FALLBACK_KEY and ANONYMO_FLOOR_LLAMAGUARD_KEY"); }
else if (!existing.ANONYMO_FLOOR_LLAMAGUARD_KEY) skipped.push("second PPQ key: without it the floor fails closed (Llama Guard checks every message)");
if (Object.keys(shared).length) set(shared);

if (env.PPQ_API_KEY && services["upstreams-init"] && services["provider-init"]) {
  set({ PPQ_API_KEY: env.PPQ_API_KEY, ...(env.PPQ_CREDIT_ID ? { PPQ_CREDIT_ID: env.PPQ_CREDIT_ID } : {}) }, services["upstreams-init"]);
  set({ UPSTREAM_API_KEY: env.PPQ_API_KEY }, services["provider-init"]);
  done.push(`PPQ_API_KEY${env.PPQ_CREDIT_ID ? " and PPQ_CREDIT_ID" : ""} on upstreams-init, UPSTREAM_API_KEY on provider-init`);
  if (!env.PPQ_CREDIT_ID) skipped.push("PPQ_CREDIT_ID: not in gateway/.env (bash scripts/set-key.sh ppq), re-run after");
} else skipped.push("PPQ_API_KEY: not in gateway/.env, or the seeding services are missing");

console.log(done.length ? `Set in Railway: ${done.join("; ")}.` : "Nothing new to set.");
for (const s of skipped) console.log(`Not set: ${s}`);
console.log("Nothing was deployed and no value was printed.");
