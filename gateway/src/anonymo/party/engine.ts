import { randomUUID } from "node:crypto";
import { desc, eq, and } from "drizzle-orm";
import { Context } from "hono";
import { requireKey, type KeyRow } from "../../api/auth.ts";
import { runChat } from "../../api/chat.ts";
import type { Ctx } from "../../context.ts";
import { keys } from "../../db/schema.ts";
import { fail, isApiError } from "../../lib/errors.ts";
import { canonicalJson, hmac, safeEqual, sha256 } from "../../lib/util.ts";
import { freeChatModel, fundedKeyRequired, hasFundedKey } from "../freetier/policy.ts";
import { assertKeyPolicy, readKeyPolicy } from "../keys/caps.ts";
import { partyTurnArt, type StudioReceipt } from "../media/routes.ts";
import { ANONYMO_1 } from "../models.ts";
import { forwardComplianceRegion } from "../region/compliance.ts";
import { mentionsSelfHarm } from "../region/party-signals.ts";
import { diceCommit, diceValue, newSeed } from "./dice.ts";
import { gmMessages, MAX_PLAYERS, openingCampaign, PARTY_RULES, RECENT_TURNS, sceneSchema, type Campaign } from "./rules.ts";
import { diceCommits, partyRooms } from "./schema.ts";
import { PartyStore, type Player, type Room, type RoomWriter } from "./store.ts";

const TURN_DEADLINE_MS = 55_000;
const ART_DEADLINE_MS = 45_000;
export type Checkpoint = { id: string; campaign: Campaign; mature: boolean; signature: string };
export type MemberAction =
  | { type: "turn"; text: string }
  | { type: "commit"; sides: number }
  | { type: "reveal"; commit: string; nonce: string }
  | { type: "leave" | "close" | "discard" };
type WebCreate = { mature: boolean; art: boolean; discord: boolean; checkpoint?: Checkpoint };

function modelContext(ctx: Ctx, c: Context, body: unknown, timeout: number, path: string) {
  const headers = new Headers({ "content-type": "application/json" });
  forwardComplianceRegion(c, headers);
  return new Context(new Request(new URL(path, ctx.cfg.publicUrl).toString(), {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  }));
}

const blocked = () => fail(403, "Mature campaigns require an eligible adult room.", "party_mature_unavailable");

export class PartyEngine {
  readonly store: PartyStore;

  constructor(readonly ctx: Ctx, now = Date.now) {
    this.store = new PartyStore(ctx.cfg.party?.redisUrl, ctx.cfg.appSecret, now);
  }

  private async limit(id: string, max: number) {
    const taken = await this.ctx.limiter.take(`party:${id}`, 1, max, 60_000);
    if (!taken.ok) fail(429, "Too many Party actions. Try again shortly.", "rate_limited");
  }

  private signature(id: string, keyHash: string, mature: boolean, campaign: Campaign) {
    return hmac(this.ctx.cfg.appSecret, canonicalJson(["party-campaign-v1", id, keyHash, mature, campaign]));
  }

  async create(authorization: string | undefined, body: WebCreate) {
    const key = await requireKey(this.ctx, authorization);
    await this.limit(key.keyHash, 3);
    await this.checkHostPolicy(key);
    if (body.mature && !(await hasFundedKey(this.ctx, key))) fundedKeyRequired();
    if (body.discord && !this.ctx.cfg.party?.discord) fail(503, "Discord Party is unavailable.", "discord_unavailable");
    if (body.art && !this.ctx.cfg.features.media) fail(503, "Turn art requires Studio.", "studio_unavailable");
    const checkpoint = body.checkpoint;
    if (checkpoint && (checkpoint.mature !== body.mature ||
        !safeEqual(this.signature(checkpoint.id, key.keyHash, checkpoint.mature, checkpoint.campaign), checkpoint.signature))) {
      fail(400, "This campaign save needs its original host key and room setting.", "party_invalid_checkpoint");
    }
    const id = randomUUID();
    const token = newSeed();
    const invite = newSeed();
    const room: Room = {
      id, campaignId: checkpoint?.id ?? id, hostKeyHash: key.keyHash, mature: body.mature, inviteHash: sha256(invite),
      players: [{ slot: 1, credential: sha256(token), host: true }],
      campaign: checkpoint?.campaign ?? structuredClone(openingCampaign),
      artEnabled: body.art, art: null, receipt: null, artReceipt: null, roll: null,
      rollOwner: null, seed: null, lastUsedRoll: 0, expiresAt: 0, version: 0,
      discord: body.discord ? { binding: null, host: null } : null,
    };
    await this.store.edit(id, async (_, write) => {
      await this.ctx.db.insert(partyRooms).values({
        id, hostKeyHash: Buffer.from(key.keyHash, "hex"), ruleset: PARTY_RULES, players: 1, mature: body.mature,
      });
      await write(room);
    });
    return { token, invite, room: this.view(room, room.players[0]) };
  }

  private async checkHostPolicy(key: KeyRow) {
    // A delegated room cannot establish that each participant is on the host's allowlisted network.
    await assertKeyPolicy(this.ctx.db, await readKeyPolicy(this.ctx.db, key.keyHash), { ip: null, sealed: false });
  }

  private async payer(room: Room) {
    const [key] = await this.ctx.db.select().from(keys).where(eq(keys.keyHash, room.hostKeyHash));
    if (!key || key.scope === "inference" || key.disabled || (key.expiresAt && key.expiresAt.getTime() <= Date.now()))
      fail(401, "The host’s key is unavailable.", "party_host_unavailable");
    await this.checkHostPolicy(key);
    if (room.mature && !(await hasFundedKey(this.ctx, key))) fundedKeyRequired();
    return key;
  }

  private view(room: Room, player: Player) {
    return {
      id: room.id, campaignId: room.campaignId, mature: room.mature, artEnabled: room.artEnabled, discord: !!room.discord,
      discordLinked: !!room.discord?.binding, you: player.slot, host: player.host, expiresAt: room.expiresAt, version: room.version,
      players: room.players.map(({ slot, host }) => ({ slot, host })),
      campaign: room.campaign, roll: room.roll, roller: room.rollOwner, art: room.art,
      receipt: room.receipt, artReceipt: room.artReceipt,
      checkpoint: player.host ? this.signature(room.campaignId, room.hostKeyHash, room.mature, room.campaign) : null,
    };
  }

  private requireRoom(room: Room | null): Room {
    if (!room) fail(410, "This Party room has closed.", "party_closed");
    return room;
  }

  private member(room: Room, digest: string) {
    const player = room.players.find((p) => p.credential === digest);
    if (!player) fail(403, "Your seat in this room is unavailable.", "party_invalid_player");
    return player;
  }

  async snapshot(id: string, token: string) {
    const room = this.requireRoom(await this.store.read(id));
    return this.view(room, this.member(room, sha256(token)));
  }

  async expiry(id: string, token: string) {
    const room = this.requireRoom(await this.store.read(id));
    this.member(room, sha256(token));
    return room.expiresAt;
  }

  private async addPlayer(room: Room, credential: string, write: RoomWriter) {
    if (room.players.length >= MAX_PLAYERS) fail(409, "This Party room is full.", "party_full");
    let slot = 1;
    while (room.players.some((p) => p.slot === slot)) slot++;
    const player = { slot, credential, host: false };
    room.players.push(player);
    await this.count(room);
    await write(room);
    return player;
  }

  private count(room: Room) {
    return this.ctx.db.update(partyRooms).set({ players: room.players.length }).where(eq(partyRooms.id, room.id));
  }

  async join(id: string, invite: string) {
    return this.store.edit(id, async (stored, write) => {
      const room = this.requireRoom(stored);
      if (room.discord || room.inviteHash !== sha256(invite)) fail(403, "This invite is unavailable.", "party_invalid_invite");
      await this.limit(room.id, 30);
      const token = newSeed();
      const player = await this.addPlayer(room, sha256(token), write);
      return { token, room: this.view(room, player) };
    });
  }

  async act(c: Context, id: string, token: string, action: MemberAction) {
    return this.store.edit(id, async (stored, write) => {
      const room = this.requireRoom(stored);
      const player = this.member(room, sha256(token));
      if (room.discord && action.type !== "close") fail(403, "Take turns in the linked Discord channel.", "party_discord_room");
      return this.apply(c, room, player, action, write);
    });
  }

  async discordAct(c: Context, id: string, binding: string, actor: string, eligible: boolean, action: MemberAction | "join" | { invite: string }) {
    return this.store.edit(id, async (stored, write) => {
      const room = this.requireRoom(stored);
      if (!room.discord) fail(403, "Create a Discord room from Party first.", "party_web_room");
      if (room.mature && !eligible && (typeof action !== "object" || !("type" in action) || action.type !== "leave")) blocked();
      if (typeof action === "object" && "invite" in action) {
        if (room.discord.binding === binding && room.discord.host === actor)
          return { room: this.view(room, room.players[0]) };
        if (room.discord.binding || room.inviteHash !== sha256(action.invite)) fail(403, "This Discord setup code is unavailable.", "party_invalid_invite");
        room.discord = { binding, host: actor };
        room.inviteHash = null;
        await write(room);
        return { room: this.view(room, room.players[0]) };
      }
      if (room.discord.binding !== binding) fail(403, "This room belongs to another Discord channel.", "party_discord_channel");
      const seated = room.discord.host === actor ? room.players[0] : room.players.find((p) => p.credential === actor);
      if (action === "join") {
        await this.limit(room.id, 30);
        return { room: this.view(room, seated ?? await this.addPlayer(room, actor, write)) };
      }
      return this.apply(c, room, seated ?? this.member(room, actor), action, write);
    });
  }

  private async apply(c: Context, room: Room, player: Player, action: MemberAction, write: RoomWriter) {
    if (action.type === "close" || action.type === "leave") {
      if (action.type === "close" && !player.host) fail(403, "Only the host can close the room.", "party_host_only");
      room.players = player.host ? [] : room.players.filter((p) => p !== player);
      if (room.rollOwner === player.slot && room.roll && room.roll.reveal === null) {
        room.roll = null;
        room.rollOwner = null;
        room.seed = null;
      }
      await this.count(room);
      await write(player.host ? null : room);
      return { room: null };
    }
    await this.limit(room.id, 30);
    if (action.type === "discard") {
      if (!player.host || !room.roll || room.roll.reveal !== null) fail(403, "Only the host can discard a pending roll.", "party_host_only");
      room.roll = null;
      room.rollOwner = null;
      room.seed = null;
    } else if (action.type === "commit") {
      await this.commit(room, player, action.sides);
    } else if (action.type === "reveal") {
      await this.reveal(room, player, action);
    } else if (action.type === "turn") {
      if (mentionsSelfHarm(action.text)) return { crisis: true as const };
      return this.turn(c, room, player, action.text, write);
    }
    await write(room);
    return { room: this.view(room, player) };
  }

  private async commit(room: Room, player: Player, sides: number) {
    if (room.roll && room.roll.reveal === null) fail(409, "Reveal the pending roll first.", "party_pending_roll");
    const [previous] = await this.ctx.db.select({ number: diceCommits.rollNo }).from(diceCommits)
      .where(eq(diceCommits.roomId, room.id)).orderBy(desc(diceCommits.rollNo)).limit(1);
    const number = (previous?.number ?? 0) + 1;
    const seed = newSeed();
    const commit = diceCommit(room.id, number, sides, seed);
    await this.ctx.db.insert(diceCommits).values({ roomId: room.id, rollNo: number, commit: Buffer.from(commit, "hex") });
    room.roll = { number, sides, commit, reveal: null, value: null };
    room.rollOwner = player.slot;
    room.seed = seed;
  }

  private async reveal(room: Room, player: Player, action: Extract<MemberAction, { type: "reveal" }>) {
    const roll = room.roll;
    if (!roll || roll.commit !== action.commit || room.rollOwner !== player.slot)
      fail(409, "Reveal the commitment you received for your current roll.", "party_invalid_roll");
    if (roll.reveal !== null) return;
    const seed = room.seed!;
    const row = and(eq(diceCommits.roomId, room.id), eq(diceCommits.rollNo, roll.number));
    const [saved] = await this.ctx.db.select({ reveal: diceCommits.reveal }).from(diceCommits).where(row);
    const nonce = saved.reveal?.subarray(32).toString("hex") ?? action.nonce;
    if (!saved.reveal) await this.ctx.db.update(diceCommits).set({ reveal: Buffer.from(seed + nonce, "hex") }).where(row);
    room.roll = { ...roll, reveal: seed + "." + nonce, value: diceValue(seed, nonce, roll.sides) };
    room.seed = null;
  }

  private async turn(c: Context, room: Room, player: Player, action: string, write: RoomWriter) {
    const key = await this.payer(room);
    await this.ctx.catalog.ensureFresh();
    const model = room.mature ? ANONYMO_1 : freeChatModel(this.ctx);
    if (!model) fail(503, "The moderated Party model is unavailable.", "free_unavailable");
    const roll = room.roll?.sides === 20 && room.roll.number > room.lastUsedRoll ? room.roll : null;
    const messages = gmMessages(room.campaign, room.players.map((p) => p.slot), room.mature, action, player.slot, roll?.value ?? null);
    const response = await runChat(this.ctx, modelContext(this.ctx, c, { model, messages, max_tokens: 1250 }, TURN_DEADLINE_MS, "/v1/chat/completions"),
      "chat", undefined, undefined, undefined, { key, moderated: !room.mature });
    if (!response.ok) fail(response.status, "The game master could not answer.", "party_turn_failed");
    const reply = await response.json() as { id?: string; choices?: { message?: { content?: unknown } }[] };
    const receipt = typeof reply.id === "string" ? reply.id : null;
    const refusal = response.headers.get("x-anonymo-refusal");
    if (refusal === "refused" || refusal === "double") return { room: this.view(room, player), refused: true, receipt };
    const text = reply.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) fail(502, "The game master returned an empty turn.", "party_turn_failed");
    if (mentionsSelfHarm(text)) return { crisis: true as const, receipt };
    let value: unknown;
    try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { value = null; }
    const parsed = sceneSchema.safeParse(value);
    const scene = parsed.success ? parsed.data : { scene: text.trim().slice(0, 2000) };
    room.campaign = {
      ...room.campaign, ...scene,
      log: [...room.campaign.log, { player: player.slot, action, scene: scene.scene }].slice(-RECENT_TURNS),
    };
    if (roll?.value != null) room.lastUsedRoll = roll.number;
    room.receipt = receipt;
    room.art = null;
    room.artReceipt = null;
    await write(room);
    let artError: string | undefined;
    if (room.artEnabled) {
      try {
        await this.checkHostPolicy(key);
        const artwork = await partyTurnArt(this.ctx, modelContext(this.ctx, c, {}, ART_DEADLINE_MS, "/v1/images/generations"), key,
          `Safe-for-work landscape and architecture only. Fully clothed people, if any. Adventure illustration: ${scene.scene}`);
        const output = await artwork.json() as { data?: { b64_json?: unknown }[]; anonymo?: { receipt?: StudioReceipt } };
        const image = output.data?.[0]?.b64_json;
        if (typeof image === "string") room.art = image;
        else artError = "art_unavailable";
        room.artReceipt = output.anonymo?.receipt ?? null;
      } catch (e) {
        artError = isApiError(e) && e.status === 451 ? "art_blocked" : "art_unavailable";
      }
      if (room.art) await write(room);
    }
    return { room: this.view(room, player), artError };
  }
}
