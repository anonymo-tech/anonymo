// Local development only: create one API key and credit it with test credit, straight in the launch database.
//   bun scripts/launch-key.ts <usd>      (env: DATABASE_URL, APP_SECRET; prints the key on stdout)
// `bun run launch` runs this before it starts the router (the local database is single-process). It refuses to run
// against anything but a local pglite database, so it can never mint credit in a real deployment.
import { createApp } from "../src/app.ts";
import { registerRootKey } from "../src/api/auth.ts";
import { generateApiKey } from "../src/chain/keys.ts";
import { post } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";

const usd = Number(process.argv[2] ?? "10");
const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("pglite://")) throw new Error("launch-key only credits a local pglite database (DATABASE_URL=pglite://...).");
if (!(usd > 0 && usd <= 1000)) throw new Error("Credit must be between 0 and 1000 test USD.");

const { ctx, close } = await createApp({ env: { ...process.env, ANONYMO_ENV: "development", WORKERS: "false" }, startJobs: false });
try {
  const secret = generateApiKey();
  const key = await registerRootKey(ctx, secret, "Local launch key");
  await ctx.db.transaction((tx) => post(tx, { accountId: key.accountId, keyHash: key.keyHash, amount: usdToPico(usd), kind: "credit", ref: `launch-credit:${key.keyHash}`, description: "Local test credit (bun run launch)" }));
  console.log(secret);
} finally {
  await close();
}
