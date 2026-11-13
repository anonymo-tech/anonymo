// Local development only: seed the four Anonymo model IDs (anonymo-1, anonymo-rp, anonymo-council, anonymo-sealed)
// onto the launch's mock providers, using the same mock topology as the failover tests (src/routing/load-test.ts).
//   bun scripts/launch-upstreams.ts      (env: DATABASE_URL, APP_SECRET)
// Refuses anything but a local pglite database.
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/client.ts";
import { seedUpstreams } from "../src/providers/tiers.ts";
import { mockUpstreamsDoc } from "../src/routing/load-test.ts";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("pglite://")) throw new Error("launch-upstreams only seeds a local pglite database (DATABASE_URL=pglite://...).");
const cfg = loadConfig();
const { db, close } = await openDatabase(cfg.databaseUrl, { migrate: cfg.autoMigrate });
try {
  const p = (port: number) => `http://127.0.0.1:${port}`;
  // mock-tee (9103) answers the dev attestation the sealed route needs.
  const doc = mockUpstreamsDoc({ venice: p(9101), selfhostMistral: p(9102), selfhostDeepseek: p(9101), chutes: p(9103), nanogpt: p(9102) });
  const r = await seedUpstreams(db, doc, { appSecret: cfg.appSecret, production: false, env: { MOCK_UPSTREAM_KEY: "local-mock-key" } });
  console.log(`seeded ${r.routes} mock routes for ${r.models.join(", ")}`);
} finally {
  await close();
}
