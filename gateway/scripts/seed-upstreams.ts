// WS04 · Seed the Anonymo upstream tiers and routes from YAML (default config/upstreams.yaml):
//   bun scripts/seed-upstreams.ts [config/upstreams.yaml]
// Base URLs and API keys are read from the env vars the file names; keys are stored encrypted with APP_SECRET and never
// printed. Outside production, ANONYMO_SEED_ALLOW_MISSING_KEYS=1 seeds routes whose key is unset (local mocks).
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { parseUpstreamsYaml, seedUpstreams } from "../src/providers/tiers.ts";

const file = process.argv[2] ?? process.env.ANONYMO_UPSTREAMS_FILE ?? "config/upstreams.yaml";
const doc = parseUpstreamsYaml(readFileSync(file, "utf8"));
const cfg = loadConfig();
const { db, close } = await openDatabase(cfg.databaseUrl, { migrate: cfg.autoMigrate });
try {
  const r = await seedUpstreams(db, doc, { appSecret: cfg.appSecret, production: cfg.production, env: process.env, allowMissingKeys: process.env.ANONYMO_SEED_ALLOW_MISSING_KEYS === "1" });
  console.log(`✓ ${r.routes} routes; model IDs: ${r.models.join(", ")}`);
} finally {
  await close();
}
