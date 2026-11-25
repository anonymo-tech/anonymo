import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { eq, getTableName } from "drizzle-orm";
import { Context } from "hono";
import { websocket } from "hono/bun";
import { discordMature, discordSignature } from "../src/anonymo/party/discord.ts";
import { diceCommit, diceValue, newSeed } from "../src/anonymo/party/dice.ts";
import { PartyEngine } from "../src/anonymo/party/engine.ts";
import { openingCampaign, ROOM_TTL_MS } from "../src/anonymo/party/rules.ts";
import { accounts, diceCommits, generations, keys, ledger, offers, partyRooms } from "../src/db/schema.ts";
import { deployedInventory } from "../src/privacy/inventory.ts";
import { MediaCatalog } from "../src/anonymo/media/catalog.ts";
import { createMediaGate } from "../src/anonymo/media/gate.ts";
import { provenanceKeyFromSeed } from "../src/anonymo/media/c2pa.ts";
import { createProvenance } from "../src/anonymo/media/provenance.ts";
import { mediaServices, setMediaServices } from "../src/anonymo/media/services.ts";
import { solidPng, testWatermarker } from "./media/fixtures.ts";
import { PartyStore, type Room } from "../src/anonymo/party/store.ts";
import { startRouter, type Harness } from "./helpers.ts";

const privateAction = "action canary opens the silver gate";
const privateReply = "reply canary from the game master";
const calls: { provider: string; prompt: string }[] = [];
const mod = "anonymo-rp";
function provider(id: string, model: string, price: string) {
  return {
    id, name: id, models: [{ id, slug: model, prompt: price, completion: price, ctx: 65_536 }],
    reply: (prompt: string) => {
      calls.push({ provider: id, prompt });
      if (prompt.includes("double refusal") || (prompt.includes("reroute canary") && id === "party-qwen"))
        return "I can't help with that request.";
      return JSON.stringify({ ...openingCampaign, scene: privateReply, inventory: ["Brass key"], log: undefined });
    },
  };
}
const signed = generateKeyPairSync("ed25519");
const publicKey = signed.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const applicationId = "100000000000000000"; // gitleaks:allow
let h: Harness;

beforeAll(async () => {
  h = await startRouter({
    env: {
      ANONYMO_FEATURE_PARTY: "true", ANONYMO_FEATURE_MEDIA: "true", ANONYMO_FEATURE_COMPLIANCE: "true",
      ANONYMO_DISCORD_PUBLIC_KEY: publicKey, ANONYMO_DISCORD_APPLICATION_ID: applicationId, ANONYMO_DISCORD_BOT_TOKEN: "example-bot-token", // gitleaks:allow
    },
    providers: [provider("party-qwen", mod, "0.000001"), provider("party-llama", mod, "0.000002"), provider("party-unreviewed", mod, "0.0000001")],
    rand: () => 0,
  });
  for (const [id, family] of [["party-qwen", "qwen"], ["party-llama", "llama"]]) {
    await h.ctx.db.update(offers).set({ tier: 1, upstream: "selfhost", isModerated: true, family }).where(eq(offers.providerId, id));
  }
  await h.ctx.catalog.refresh();
});
afterAll(async () => h?.close());

const base = "/v1/party/rooms";
const post = (path: string, body: unknown, headers?: Record<string, string>) => h.request(path, { method: "POST", json: body, headers });
async function create(auth: Record<string, string>, body: Record<string, unknown> = {}) {
  const response = await post(base, { adult: true, ...body }, auth);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ token: string; invite: string; room: { id: string; campaignId: string; checkpoint: string; campaign: unknown } }>;
}
const join = (room: string, invite: string) => post(`${base}/${room}/join`, { adult: true, invite });
const act = (room: string, token: string, action: Record<string, unknown>) => post(`${base}/${room}/action`, { token, ...action });
const state = (room: string, token: string) => post(`${base}/${room}/state`, { token });
const payload = (r: Response) => r.json() as Promise<any>;
const callCount = () => calls.length;

test("Party and Discord routes and privacy inventory are off by default", async () => {
  const off = await startRouter({ providers: [], env: { ANONYMO_DISCORD_PUBLIC_KEY: "ignored" } });
  try {
    expect((await off.request("/v1/party")).status).toBe(404);
    expect((await off.request("/v1/party/discord/interactions", { method: "POST", json: {} })).status).toBe(404);
    const disabled = JSON.stringify(deployedInventory(off.ctx.cfg.features));
    expect(disabled).not.toContain("party_rooms");
    expect(disabled).not.toContain("party:room:");
    expect(disabled).not.toContain("/party/routes.ts");
    const enabled = JSON.stringify(deployedInventory(h.ctx.cfg.features));
    expect(enabled).toContain("party_rooms");
    expect(enabled).toContain("party:room:");
  } finally {
    await off.close();
  }
});

test("host starts a room, invite caps the table at six, and guests cannot close it", async () => {
  const key = await h.fundedKey();
  const host = await create(key.auth);
  const id = host.room.id;
  expect((await post(`${base}/${id}/join`, { adult: false, invite: host.invite })).status).toBe(400);
  const guest = await payload(await join(id, host.invite));
  expect(guest.room.checkpoint).toBeNull();
  expect(guest.room.you).toBe(2);
  expect(JSON.stringify(guest)).not.toContain(host.token);
  expect(JSON.stringify(guest)).not.toContain(host.invite);
  for (let i = 0; i < 4; i++) expect((await join(id, host.invite)).status).toBe(200);
  expect((await join(id, host.invite)).status).toBe(409);
  expect((await act(id, guest.token, { type: "close" })).status).toBe(403);
  expect((await act(id, guest.token, { type: "leave" })).status).toBe(200);
  expect((await state(id, guest.token)).status).toBe(403);
  expect((await join(id, host.invite)).status).toBe(200);
  expect((await act(id, host.token, { type: "close" })).status).toBe(200);
  expect((await state(id, host.token)).status).toBe(410);
  const [metadata] = await h.ctx.db.select().from(partyRooms).where(eq(partyRooms.id, id));
  expect(Object.keys(metadata).sort()).toEqual(["createdAt", "hostKeyHash", "id", "mature", "players", "ruleset"]);
  expect(metadata.players).toBe(0);
});

test("real Hono socket authorizes a seat, then pushes room changes without scene or tokens", async () => {
  const host = await create((await h.fundedKey()).auth);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch, websocket }); // gitleaks:allow
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${base}/${host.room.id}/socket`); // gitleaks:allow
  const next = () => new Promise<string>((resolve, reject) => {
    ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    ws.addEventListener("error", () => reject(new Error("Socket failed to open.")), { once: true });
  });
  try {
    const ready = next();
    ws.addEventListener("open", () => ws.send(host.token), { once: true });
    expect(await ready).toBe("changed");
    const update = next();
    expect((await join(host.room.id, host.invite)).status).toBe(200);
    expect(await update).toBe("changed");
    const closed = new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
    await act(host.room.id, host.token, { type: "close" });
    await closed;
  } finally {
    ws.close();
    server.stop(true);
  }
});

test("dice commit appears before reveal, verifies, and repeated reveal preserves the proof", async () => {
  const host = await create((await h.fundedKey()).auth);
  const id = host.room.id;
  const nonce = newSeed();
  const init = await payload(await act(id, host.token, { type: "commit", sides: 20 }));
  const roll = init.room.roll;
  expect(roll).toMatchObject({ sides: 20, number: 1, reveal: null, value: null });
  expect(roll.commit).toMatch(/^[\da-f]{64}$/);
  expect((await h.ctx.db.select().from(diceCommits).where(eq(diceCommits.roomId, id)))[0].reveal).toBeNull();
  const guest = await payload(await join(id, host.invite));
  expect((await act(id, guest.token, { type: "reveal", commit: roll.commit, nonce })).status).toBe(409);
  expect((await act(id, host.token, { type: "reveal", commit: newSeed(), nonce })).status).toBe(409);
  const shown = await payload(await act(id, host.token, { type: "reveal", commit: roll.commit, nonce }));
  const proof = shown.room.roll;
  const [seed, revealedNonce] = proof.reveal.split(".");
  expect(revealedNonce).toBe(nonce);
  expect(diceCommit(id, proof.number, proof.sides, seed)).toBe(roll.commit);
  expect(diceValue(seed, nonce, 20)).toBe(proof.value);
  expect(diceCommit(id, proof.number, 6, seed)).not.toBe(roll.commit);
  const repeated = await payload(await act(id, host.token, { type: "reveal", commit: roll.commit, nonce: newSeed() }));
  expect(repeated.room.roll).toEqual(proof);
  const [row] = await h.ctx.db.select().from(diceCommits).where(eq(diceCommits.roomId, id));
  expect(row.reveal?.toString("hex")).toBe(seed + nonce);
});

test("guest turns bill the host, stay moderated and leave no room content in database writes", async () => {
  const key = await h.fundedKey();
  const host = await create(key.auth);
  const id = host.room.id;
  const guest = await payload(await join(id, host.invite));
  const writes: unknown[] = [];
  const insert = h.ctx.db.insert.bind(h.ctx.db);
  const spy = spyOn(h.ctx.db, "insert").mockImplementation(((table: Parameters<typeof insert>[0]) => {
    const builder = insert(table);
    const values = builder.values.bind(builder);
    builder.values = ((parameters: Parameters<typeof values>[0]) => {
      writes.push([getTableName(table), parameters]);
      return values(parameters);
    }) as typeof builder.values;
    return builder;
  }) as typeof h.ctx.db.insert);
  try {
    const result = await act(id, guest.token, { type: "turn", text: privateAction });
    expect(result.status).toBe(200);
    const reply = (await payload(result)).room;
    expect(reply.campaign.scene).toBe(privateReply);
    expect(reply.checkpoint).toBeNull();
    expect(reply.campaign.log[0]).toMatchObject({ action: privateAction, player: 2 });
    expect(calls.at(-1)?.provider).toBe("party-qwen");
    const [generation] = await h.ctx.db.select().from(generations).where(eq(generations.id, reply.receipt));
    expect(generation.keyHash).toBe(key.hash);
    expect(generation.cost).toBeGreaterThan(0n);
    expect(writes.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(writes, (_, value) => typeof value === "bigint" ? String(value) : value);
    expect(serialized).not.toContain(privateReply);
    expect(serialized).not.toContain(privateAction);
    expect(serialized).not.toContain(guest.token);
    expect(serialized).not.toContain("campaign");
    expect(serialized).not.toContain("party_rooms");
    const view = await payload(await state(id, host.token));
    expect(view.campaign.scene).toBe(privateReply);
    const save = { id: view.campaignId, campaign: view.campaign, mature: view.mature, signature: view.checkpoint };
    expect((await post(base, { adult: true, checkpoint: { ...save, campaign: openingCampaign } }, key.auth)).status).toBe(400);
    const resumed = await create(key.auth, { checkpoint: save });
    expect(resumed.room.campaign).toEqual(view.campaign);
  } finally {
    spy.mockRestore();
  }
});

test("floor blocks with 451 before dispatch or billing; crisis returns only a support signal", async () => {
  const key = await h.fundedKey();
  const host = await create(key.auth);
  const id = host.room.id;
  const before = callCount();
  const date = (await payload(await state(id, host.token))).expiresAt;
  const signal = await act(id, host.token, { type: "turn", text: "I want to die." });
  expect(await signal.json()).toEqual({ crisis: true });
  expect((await payload(await state(id, host.token))).expiresAt).toBe(date);
  const floor = h.ctx.anonymo.floor;
  h.ctx.anonymo.floor = { check: async () => ({ ok: false, category: "cbrn" }) };
  try {
    const blocked = await act(id, host.token, { type: "turn", text: "Floor regression canary" });
    expect(blocked.status).toBe(451);
    expect((await payload(blocked)).error.type).toBe("floor_blocked");
    expect(callCount()).toBe(before);
    expect(await h.ctx.db.select().from(generations).where(eq(generations.keyHash, key.hash))).toEqual([]);
  } finally {
    h.ctx.anonymo.floor = floor;
  }
});

test("refusal retries stay moderated and a double refusal has zero net charge", async () => {
  const key = await h.fundedKey();
  const host = await create(key.auth);
  const id = host.room.id;
  const before = callCount();
  expect((await act(id, host.token, { type: "turn", text: "reroute canary" })).status).toBe(200);
  expect(calls.slice(before).map(({ provider }) => provider)).toEqual(["party-qwen", "party-llama"]);
  const [{ accountId }] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, key.hash));
  const balance = async () => (await h.ctx.db.select().from(accounts).where(eq(accounts.id, accountId)))[0].balance;
  const prior = await balance();
  const response = await payload(await act(id, host.token, { type: "turn", text: "double refusal" }));
  expect(response.refused).toBe(true);
  expect(await balance()).toBe(prior);
  const entries = await h.ctx.db.select().from(ledger).where(eq(ledger.generationId, response.receipt));
  expect(entries.filter((r) => r.kind === "refusal_refund")).toHaveLength(2);
});

test("optional turn art uses the SFW output gate and charges only for an allowed image", async () => {
  const original = mediaServices(h.ctx);
  let explicit = true;
  let imageCalls = 0;
  const images = {
    async generate() {
      imageCalls++;
      return [{ bytes: solidPng(64, 64, [25, 75, 125]), mime: "image/png" }];
    },
  };
  const services = setMediaServices(h.ctx, {
    catalog: MediaCatalog.fromEnv({}),
    gate: createMediaGate({ score: async () => ({ frames: [{ nsfw: explicit ? 0.98 : 0.02, apparentAge: 32 }] }) }, { timeoutMs: 2000 }),
    provenance: createProvenance({ key: provenanceKeyFromSeed(new Uint8Array(32).fill(8)), watermarker: testWatermarker() }),
    images: { comfyui: images, venice: images, nanogpt: images },
    offered: new Set(["comfyui", "venice", "nanogpt"]),
  });
  try {
    const key = await h.fundedKey();
    const host = await create(key.auth, { art: true });
    const art = () => act(host.room.id, host.token, { type: "turn", text: "Light the beacon." }).then(payload);
    const blocked = await art();
    expect(imageCalls).toBe(1);
    expect(blocked.room.art).toBeNull();
    expect(blocked.artError).toBe("art_blocked");
    expect((await h.ctx.db.select().from(ledger).where(eq(ledger.keyHash, key.hash))).filter((row) => row.kind === "media_image")).toHaveLength(0);
    explicit = false;
    const allowed = await art();
    expect(imageCalls).toBe(2);
    expect((await services.provenance.verify(Buffer.from(allowed.room.art, "base64"))).ok).toBe(true);
    expect(allowed.room.artReceipt.payload.request_id).toBeString();
    expect(allowed.room.artReceipt.sig).toBeString();
    expect(services.store.size()).toBe(0);
    expect((await h.ctx.db.select().from(ledger).where(eq(ledger.keyHash, key.hash))).filter((row) => row.kind === "media_image")).toHaveLength(1);
  } finally {
    setMediaServices(h.ctx, original);
  }
});

test("adult web declaration, region gate, funding, and both Discord age restrictions are enforced", async () => {
  const key = await h.fundedKey();
  expect((await post(base, { adult: false, mature: true }, key.auth)).status).toBe(400);
  expect((await post(base, { adult: true, mature: true }, { ...key.auth, "cf-ipcountry": "GB" })).status).toBe(451);
  expect((await post(base, { adult: true, mature: true }, (await h.newKey()).auth)).status).toBe(403);
  expect((await create(key.auth, { mature: true })).room).toMatchObject({ mature: true });
  expect(discordMature({ type: 0, nsfw: true }, 0)).toBe(false);
  expect(discordMature({ type: 0, nsfw: false }, 3)).toBe(false);
  expect(discordMature({ type: 1, nsfw: true }, 3)).toBe(false);
  expect(discordMature({ type: 0, nsfw: true }, 3)).toBe(true);
  const engine = new PartyEngine(h.ctx);
  try {
    const room = await engine.create(key.auth.authorization, { mature: true, discord: true, art: false });
    const context = new Context(new Request("https://example.invalid"));
    await expect(engine.discordAct(context, room.room.id, "channel", "host", false, { invite: room.invite }))
      .rejects.toMatchObject({ status: 403, type: "party_mature_unavailable" });
    await engine.discordAct(context, room.room.id, "channel", "host", true, { invite: room.invite });
    await expect(engine.discordAct(context, room.room.id, "other-channel", "host", true, { type: "turn", text: "Open the gate." }))
      .rejects.toMatchObject({ status: 403, type: "party_discord_channel" });
  } finally {
    engine.store.close();
  }
});

test("Discord verifies the raw signed bytes and timestamp and says Discord keeps messages", async () => {
  const stamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({ type: 1 });
  const signature = sign(null, Buffer.from(stamp + payload), signed.privateKey).toString("hex");
  expect(discordSignature(publicKey, stamp, signature, Buffer.from(payload))).toBe(true);
  expect(discordSignature(publicKey, stamp, signature, Buffer.from(payload + " "))).toBe(false);
  expect(discordSignature(publicKey, stamp, signature, Buffer.from(payload), Date.now() + 181_000)).toBe(false);
  const discord = (body: string, signature: string) => h.request("/v1/party/discord/interactions", {
    method: "POST", body, headers: { "x-signature-timestamp": stamp, "x-signature-ed25519": signature },
  });
  expect((await discord(payload + " ", signature)).status).toBe(401);
  expect(await (await discord(payload, signature)).json()).toEqual({ type: 1 });
  const help = JSON.stringify({
    type: 2, id: applicationId, application_id: applicationId, guild_id: applicationId, channel_id: applicationId,
    token: "example", member: { user: { id: applicationId } }, data: { name: "party", options: [{ name: "help" }] },
  });
  const response = await discord(help, sign(null, Buffer.from(stamp + help), signed.privateKey).toString("hex"));
  expect(JSON.stringify(await response.json())).toContain("Discord keeps messages sent in Discord.");
});

test("idle expiry extends on writes and never on reads; expired rooms cannot be resurrected", async () => {
  let now = 5000;
  const engine = new PartyEngine(h.ctx, () => now);
  try {
    const key = await h.fundedKey();
    const room = await engine.create(key.auth.authorization, { mature: false, art: false, discord: false });
    const id = room.room.id;
    now += ROOM_TTL_MS - 100;
    expect((await engine.snapshot(id, room.token)).expiresAt).toBe(5000 + ROOM_TTL_MS);
    await engine.join(id, room.invite);
    expect((await engine.snapshot(id, room.token)).expiresAt).toBe(now + ROOM_TTL_MS);
    now += ROOM_TTL_MS;
    await expect(engine.snapshot(id, room.token)).rejects.toMatchObject({ status: 410 });
    await expect(engine.join(id, room.invite)).rejects.toMatchObject({ status: 410 });
  } finally {
    engine.store.close();
  }
});

test.skipIf(!Bun.env.TEST_PARTY_REDIS_URL)("Redis shares encrypted TTL state with a second gateway and publishes only a change signal", async () => {
  let now = Date.now();
  const first = new PartyStore(Bun.env.TEST_PARTY_REDIS_URL, "party-fixture-secret", () => now); // gitleaks:allow
  const second = new PartyStore(Bun.env.TEST_PARTY_REDIS_URL, "party-fixture-secret", () => now); // gitleaks:allow
  const id = crypto.randomUUID();
  const room: Room = {
    id, campaignId: id, hostKeyHash: newSeed(), inviteHash: newSeed(), mature: false, campaign: openingCampaign,
    players: [], artEnabled: false, art: null, artReceipt: null, receipt: null, roll: null, rollOwner: null,
    seed: null, lastUsedRoll: 0, expiresAt: 0, version: 0, discord: null,
  };
  try {
    let notify!: () => void;
    const changed = new Promise<void>((resolve) => { notify = resolve; });
    const remove = await second.watch(id, notify);
    await first.edit(id, async (_, write) => write(room));
    await changed;
    expect((await second.read(id))?.campaign).toEqual(openingCampaign);
    const replay = newSeed();
    expect(await first.claimInteraction(replay)).toBe(true);
    expect(await second.claimInteraction(replay)).toBe(false);
    now += ROOM_TTL_MS;
    expect(await second.read(id)).toBeNull();
    await first.edit(id, async (_, write) => write(null));
    remove();
  } finally {
    first.close();
    second.close();
  }
});
