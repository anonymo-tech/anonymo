// Origin lock secret: the value Cloudflare adds to every request as `x-origin-lock`, which the API checks
// (src/hardening/client.ts) so nobody can skip Cloudflare and fake their country. Run it yourself from gateway/:
//
//   bun scripts/origin-lock.ts
//
// - Generates ORIGIN_LOCK_SECRET on the api service in Railway, only when missing (a re-run reuses it).
// - Copies it to the clipboard for you to paste as the value of the Cloudflare request-header rule, then clears the
//   clipboard when you press Enter. Nothing is printed and nothing is deployed.
// - It does not switch the lock on: ORIGIN_LOCK_ENABLED=true is set after Cloudflare is sending the header, so the
//   API never refuses traffic in between.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "anonymo-railway-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

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

const status = Bun.spawnSync(["railway", "status", "--json"], { stderr: "pipe" });
if (status.exitCode !== 0) throw new Error("No linked Railway project here. Run `railway link` in gateway/ first.");
const s = JSON.parse(status.stdout.toString());
const projectId: string = s.id;
const environmentId: string | undefined = s.environments.edges.find((e: { node: { name: string } }) => e.node.name === "production")?.node.id;
const serviceId: string | undefined = s.services.edges.find((e: { node: { name: string } }) => e.node.name === "api")?.node.id;
if (!environmentId || !serviceId) throw new Error("The linked project needs a production environment and an api service.");

const vars: Record<string, string> = railway(
  `query($p: String!, $e: String!, $s: String!) { variables(projectId: $p, environmentId: $e, serviceId: $s, unrendered: true) }`,
  { p: projectId, e: environmentId, s: serviceId },
).variables ?? {};

let secret = vars.ORIGIN_LOCK_SECRET;
if (secret && secret.length >= 32) console.log("ORIGIN_LOCK_SECRET is already set on api; reusing it.");
else {
  secret = randomBytes(32).toString("hex");
  railway(`mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`, {
    input: { projectId, environmentId, serviceId, skipDeploys: true, variables: { ORIGIN_LOCK_SECRET: secret } },
  });
  console.log("Generated ORIGIN_LOCK_SECRET and saved it on api in Railway.");
}

const copy = (text: string) => {
  const p = Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(text) });
  if (p.exitCode !== 0) throw new Error("Could not use the clipboard (pbcopy). Nothing was copied.");
};
copy(secret);
console.log("\nThe secret is on your clipboard. In the Cloudflare rule, paste it as the Value of the x-origin-lock header and Deploy.");
process.stdout.write("Press Enter when done to clear the clipboard... ");
for await (const _ of console) break;
copy("");
console.log("Clipboard cleared. Nothing was printed or deployed.");
