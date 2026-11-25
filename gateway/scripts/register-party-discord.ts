import { DISCORD_API, PARTY_COMMAND } from "../src/anonymo/party/discord.ts";

const applicationId = Bun.env.ANONYMO_DISCORD_APPLICATION_ID;
const token = Bun.env.ANONYMO_DISCORD_BOT_TOKEN;
if (!applicationId || !/^\d{16,22}$/.test(applicationId) || !token)
  throw new Error("Set ANONYMO_DISCORD_APPLICATION_ID and ANONYMO_DISCORD_BOT_TOKEN first.");
const result = await fetch(`${DISCORD_API}/applications/${applicationId}/commands`, {
  method: "POST",
  body: JSON.stringify(PARTY_COMMAND),
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  signal: AbortSignal.timeout(10_000),
});
if (!result.ok) throw new Error(`Discord command registration returned HTTP ${result.status}.`);
console.log("Registered /party.");
