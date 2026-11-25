import type { Context, Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { ZodType } from "zod";
import { readJson } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import { fail, isApiError } from "../../lib/errors.ts";
import { createRegionPolicy } from "../region/policy.ts";
import { discordPartyRoutes } from "./discord.ts";
import { PartyEngine } from "./engine.ts";
import { actionInput, createInput, joinInput, roomId, token } from "./wire.ts";

const BASE = "/v1/party";
const NO_STORE = { "Cache-Control": "no-store" };

function parse<T>(schema: ZodType<T>, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail(400, "Check the room details and confirm that you’re 18 or older.", "party_invalid_request");
  return parsed.data;
}

function socket(engine: PartyEngine, id: string) {
  let connected = false;
  let closed = false;
  let unwatch: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let refresh = 0;
  const stop = () => {
    closed = true;
    clearTimeout(timer);
    unwatch?.();
  };
  async function authorize(credential: string, ws: WSContext) {
    const update = async () => {
      const seq = ++refresh;
      const expiry = await engine.expiry(id, credential);
      if (closed || seq !== refresh) return;
      clearTimeout(timer);
      timer = setTimeout(() => void update().catch(() => ws.close(1008, "Room closed")), Math.max(1, expiry - Date.now()));
      // The browser reads a snapshot over HTTP, where every read receives the current region check.
      ws.send("changed");
    };
    const notify = () => void update().catch(() => ws.close(1008, "Room closed"));
    unwatch = await engine.store.watch(id, notify);
    if (closed) { unwatch(); return; }
    await update();
  }
  return {
    onOpen(_event: Event, ws: WSContext) { timer = setTimeout(() => ws.close(1008, "Seat required"), 5000); },
    onMessage(event: MessageEvent, ws: WSContext) {
      const credential = token.safeParse(event.data);
      if (connected || !credential.success) { ws.close(1008, "Invalid seat"); return; }
      connected = true;
      void authorize(credential.data, ws).catch(() => ws.close(1008, "Seat unavailable"));
    },
    onClose: stop,
    onError: stop,
  };
}

export function partyRoutes(app: Hono, ctx: Ctx, env: Record<string, unknown>) {
  const engine = new PartyEngine(ctx);
  const endpoint = (handler: (c: Context) => Promise<unknown>) => async (c: Context) => {
    try {
      return c.json(await handler(c), 200, NO_STORE);
    } catch (e) {
      // Redis, driver and provider errors can carry arguments. Keep these outside the generic logger.
      if (isApiError(e)) {
        if (e.status === 451 || e.status < 500) return c.json(e.toJSON(), e.status as never, NO_STORE);
        return c.json({ error: { code: e.status, type: e.type, message: "Party is temporarily unavailable." } }, e.status as never, NO_STORE);
      }
      return c.json({ error: { code: 503, type: "party_unavailable", message: "Party is temporarily unavailable." } }, 503, NO_STORE);
    }
  };
  app.get(BASE, (c) => c.json({ art: ctx.cfg.features.media, discord: !!ctx.cfg.party?.discord }, 200, NO_STORE));
  app.post(`${BASE}/rooms`, endpoint(async (c) =>
    engine.create(c.req.header("authorization"), parse(createInput, await readJson(c)))));
  app.post(`${BASE}/rooms/:id/join`, endpoint(async (c) => {
    const { invite } = parse(joinInput, await readJson(c));
    return engine.join(parse(roomId, c.req.param("id")), invite);
  }));
  app.post(`${BASE}/rooms/:id/state`, endpoint(async (c) =>
    engine.snapshot(parse(roomId, c.req.param("id")), parse(token, (await readJson(c)).token))));
  app.post(`${BASE}/rooms/:id/action`, endpoint(async (c) => {
    const { token: credential, ...action } = parse(actionInput, await readJson(c));
    return engine.act(c, parse(roomId, c.req.param("id")), credential, action);
  }));
  app.get(`${BASE}/rooms/:id/socket`, upgradeWebSocket((c) => socket(engine, parse(roomId, c.req.param("id")))));

  if (ctx.cfg.party?.discord) discordPartyRoutes(app, engine, ctx.cfg.party.discord, createRegionPolicy(ctx.db, env));
  return () => engine.store.close();
}
