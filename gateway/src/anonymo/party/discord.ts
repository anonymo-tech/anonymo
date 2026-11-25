import { createPublicKey, verify } from "node:crypto";
import { Context, type Hono } from "hono";
import { z } from "zod";
import { fail, isApiError } from "../../lib/errors.ts";
import { hmac, sha256 } from "../../lib/util.ts";
import { CRISIS_LINES } from "../region/party-signals.ts";
import { parseRegion } from "../region/rules.ts";
import type { createRegionPolicy } from "../region/policy.ts";
import type { StudioReceipt } from "../media/routes.ts";
import type { MemberAction, PartyEngine } from "./engine.ts";
import { DISCORD_PATH, roomId, sides, token, turnText } from "./wire.ts";

export const DISCORD_API = "https://discord.com/api/v10";
const HELP = "Party is an AI game master for up to six players. The host creates a Discord room in Anonymo Party and links it with /party host. Guests use /party join, then /party turn or /party commit and /party reveal. Discord keeps messages sent in Discord. Use the web app for a room that expires without a saved chat.";
const NO_MENTIONS = { parse: [] };
const snowflake = z.string().regex(/^\d{16,22}$/);
const interaction = z.object({
  id: snowflake, application_id: snowflake, type: z.literal(2),
  token: z.string().regex(/^[a-zA-Z0-9_.-]{1,512}$/),
  guild_id: snowflake, channel_id: snowflake,
  member: z.object({ user: z.object({ id: snowflake }) }),
  channel: z.object({ type: z.number(), nsfw: z.boolean().optional() }).optional(),
  data: z.object({
    name: z.literal("party"),
    options: z.array(z.object({
      name: z.enum(["help", "host", "join", "turn", "commit", "reveal", "leave"]),
      options: z.array(z.object({ name: z.string(), value: z.union([z.string().max(2048), z.number()]) })).max(4).optional(),
    })).length(1),
  }),
});
type Interaction = z.infer<typeof interaction>;
type DiscordConfig = NonNullable<NonNullable<PartyEngine["ctx"]["cfg"]["party"]>["discord"]>;

export function discordSignature(key: string, timestamp: string, signature: string, bytes: Uint8Array, now = Date.now()) {
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 180 ||
      !/^[a-f\d]{64}$/i.test(key) || !/^[a-f\d]{128}$/i.test(signature)) return false;
  const publicKey = createPublicKey({ key: Buffer.from("302a300506032b6570032100" + key, "hex"), format: "der", type: "spki" });
  return verify(null, Buffer.concat([Buffer.from(timestamp), bytes]), publicKey, Buffer.from(signature, "hex"));
}

export function discordMature(channel: { type: number; nsfw?: boolean } | undefined, level: unknown) {
  return channel?.type === 0 && channel.nsfw === true && level === 3;
}

async function ageRestricted(cfg: DiscordConfig, input: Interaction, request: typeof fetch) {
  if (input.channel?.type !== 0 || input.channel.nsfw !== true) return false;
  const get = (path: string) => request(DISCORD_API + path, {
    headers: { authorization: `Bot ${cfg.botToken}` }, signal: AbortSignal.timeout(2500),
  });
  const [guild, channel] = await Promise.all([get(`/guilds/${input.guild_id}`), get(`/channels/${input.channel_id}`)]);
  if (!guild.ok || !channel.ok) return false;
  const current = await channel.json() as { type: number; nsfw?: boolean; guild_id?: string };
  const { nsfw_level } = await guild.json() as { nsfw_level?: unknown };
  return current.guild_id === input.guild_id && discordMature(current, nsfw_level);
}

function commandAction(name: Interaction["data"]["options"][number]["name"], arg: Record<string, string | number>) {
  if (name === "host") return { invite: token.parse(arg.code) };
  if (name === "join") return "join" as const;
  if (name === "turn") return { type: "turn", text: turnText.parse(arg.action) } satisfies MemberAction;
  if (name === "commit") return { type: "commit", sides: sides.parse(arg.sides) } satisfies MemberAction;
  if (name === "reveal") return {
    type: "reveal", commit: token.parse(arg.commit),
    nonce: sha256(z.string().trim().min(1).max(100).parse(arg.nonce)),
  } satisfies MemberAction;
  return { type: "leave" } satisfies MemberAction;
}

const option = (name: string, description: string, type = 3) => ({ name, description, type, required: true });
const room = option("room", "Room ID provided by the host");
const region = option("region", "Your country and subdivision if applicable, in ISO format");
const command = (name: string, description: string, options = [] as ReturnType<typeof option>[]) => ({ name, description, type: 1, options });
export const PARTY_COMMAND = {
  name: "party", description: "Play an adventure with the Anonymo AI game master", type: 1, integration_types: [0], contexts: [0],
  options: [
    command("help", "How to play and what Discord keeps"),
    command("host", "Link a room you created in Anonymo Party", [room, region, option("code", "One-time setup code from the workspace")]),
    command("join", "Take a seat in the linked room", [room, region]),
    command("turn", "Tell the game master what you do", [room, region, option("action", "Your character’s action")]),
    command("commit", "Show the commitment for your next dice roll", [room, region, option("sides", "Number of sides", 4)]),
    command("reveal", "Reveal your committed roll", [room, region, option("commit", "Commitment from /party commit"), option("nonce", "A new phrase chosen after seeing the commitment")]),
    command("leave", "Leave a seat or close your own room", [room]),
  ],
};

export function discordPartyRoutes(app: Hono, engine: PartyEngine, cfg: DiscordConfig, policyFor: ReturnType<typeof createRegionPolicy>, request = fetch) {
  if (!snowflake.safeParse(cfg.applicationId).success || !/^[a-f\d]{64}$/i.test(cfg.publicKey))
    throw new Error("Invalid Discord application ID or public key.");

  async function reply(input: Interaction, content: string, publish = false, art?: string | null, receipt?: StudioReceipt | null) {
    const url = `${DISCORD_API}/webhooks/${cfg.applicationId}/${input.token}`;
    const body = (text: string) => JSON.stringify({ content: text, allowed_mentions: NO_MENTIONS, flags: 4 });
    const headers = { "content-type": "application/json" };
    const original = await request(`${url}/messages/@original`, {
      method: "PATCH", headers, body: body(publish ? "Party update shared in this channel." : content), signal: AbortSignal.timeout(5000),
    });
    if (!publish || !original.ok) return;
    let followup: RequestInit = { headers, body: body(content) };
    if (art) {
      const form = new FormData();
      form.set("payload_json", body(content));
      form.set("files[0]", new Blob([new Uint8Array(Buffer.from(art, "base64"))], { type: "image/png" }), "turn.png");
      if (receipt) form.set("files[1]", new Blob([JSON.stringify(receipt)], { type: "application/json" }), "art-receipt.json");
      followup = { body: form };
    }
    await request(url, { ...followup, method: "POST", signal: AbortSignal.timeout(5000) });
  }

  async function dispatch(input: Interaction) {
    try {
      if (!await engine.store.claimInteraction(sha256(input.id))) return;
      const entry = input.data.options[0];
      const args = Object.fromEntries((entry.options ?? []).map(({ name, value }) => [name, value]));
      const id = roomId.parse(args.room);
      const action = commandAction(entry.name, args);
      const declaration = typeof args.region === "string" ? args.region : null;
      if (entry.name !== "leave" && (!parseRegion(declaration) || (await policyFor(declaration, null)).mode !== "allowed"))
        fail(451, "Party is unavailable for the declared region in Discord. Open the web workspace for region and age-proof options.", "region_blocked");

      const binding = hmac(engine.ctx.cfg.appSecret, `party-channel:${input.guild_id}:${input.channel_id}`);
      const actor = hmac(engine.ctx.cfg.appSecret, `party-player:${id}:${input.member.user.id}`);
      const live = await engine.store.read(id);
      const eligible = !live?.mature || entry.name === "leave" || await ageRestricted(cfg, input, request);
      const headers = declaration ? { "x-anonymo-declared-region": declaration } : undefined;
      const result = await engine.discordAct(new Context(new Request(engine.ctx.cfg.publicUrl, { headers })), id, binding, actor, eligible, action);
      if ("crisis" in result) {
        await reply(input, "Let’s pause the adventure. You deserve support. " + CRISIS_LINES.map(({ what, action }) => `${what} — ${action}`).join("\n"));
      } else if ("refused" in result && result.refused) {
        await reply(input, `The game master declined that action. The refused attempt cost $0.${"receipt" in result && result.receipt ? ` Receipt: ${result.receipt}` : ""}`);
      } else if (entry.name === "turn" && result.room) {
        if (live?.mature && !await ageRestricted(cfg, input, request))
          return await reply(input, "This room requires an age-restricted Discord server and channel.");
        const scene = result.room.campaign.scene;
        await reply(input, `AI game master\n${scene.slice(0, 1820)}\nReceipt: ${result.room.receipt ?? "unavailable"}${result.room.artReceipt ? `\nArt receipt: ${result.room.artReceipt.payload.request_id}` : ""}`, true, result.room.art, result.room.artReceipt);
      } else if ((entry.name === "commit" || entry.name === "reveal") && result.room?.roll) {
        const { number, value, commit, reveal, sides } = result.room.roll;
        await reply(input, `Roll ${number} · d${sides} · Room ${id}\nCommitment: ${commit}${reveal ? `\nResult: ${value}\nReveal (seed.nonce): ${reveal}` : "\nUse /party reveal after choosing a fresh nonce phrase."}`, true);
      } else {
        const content = entry.name === "host" ? `Linked. Invite players with /party join using room ${id}. Discord keeps messages sent in Discord.` :
          entry.name === "join" ? `You’re Player ${result.room?.you}. The host pays. Discord keeps messages sent in Discord.` : "You left the room.";
        await reply(input, content);
      }
    } catch (e) {
      const content = isApiError(e)
        ? e.status === 451 && e.type !== "region_blocked" ? "The safety floor blocked this action. No turn was charged."
          : e.status >= 500 ? "Party is temporarily unavailable." : e.message
        : e instanceof z.ZodError ? "Check the room ID, command fields and region, then try again." : "Party is temporarily unavailable.";
      await reply(input, content);
    }
  }

  app.post(DISCORD_PATH, async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!discordSignature(cfg.publicKey, c.req.header("x-signature-timestamp") ?? "", c.req.header("x-signature-ed25519") ?? "", bytes))
      return c.body(null, 401);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return c.body(null, 400); }
    if (value && typeof value === "object" && "type" in value && value.type === 1) return c.json({ type: 1 });
    const parsed = interaction.safeParse(value);
    if (!parsed.success || parsed.data.application_id !== cfg.applicationId)
      return c.json({ type: 4, data: { content: "Use /party in a Discord server.", flags: 64 } });
    if (parsed.data.data.options[0].name === "help") return c.json({ type: 4, data: { content: HELP, flags: 64 } });
    // Acknowledge before storage, policy or inference work to meet Discord’s interaction deadline.
    void dispatch(parsed.data).catch(() => {});
    return c.json({ type: 5, data: { flags: 64 } });
  });
}
