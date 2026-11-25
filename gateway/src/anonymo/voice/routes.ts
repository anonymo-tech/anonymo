import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { requireKey, requireRole, type KeyRow } from "../../api/auth.ts";
import { clientIp, readJson } from "../../api/common.ts";
import type { Ctx } from "../../context.ts";
import { internalEnv } from "../../hardening/client.ts";
import { ApiError, fail } from "../../lib/errors.ts";
import { usdToPico } from "../../lib/money.ts";
import { parseSse } from "../../providers/upstream.ts";
import { hasFundedKey } from "../freetier/policy.ts";
import { assertKeyPolicy, readKeyPolicy } from "../keys/caps.ts";
import { runSpeech, runTranscription } from "../media/routes.ts";
import { mediaServices } from "../media/services.ts";
import type { SpeechModel } from "../media/catalog.ts";
import { ANONYMO_1 } from "../models.ts";
import { forwardComplianceRegion } from "../region/compliance.ts";
import { FRAME_BYTES, SAMPLE_RATE } from "./audio.ts";
import { PREVIEW_LINE, descriptionBody, saveBody, voiceDesigner, voiceTraits } from "./design.ts";
import { VOICE_DISPATCH } from "./dispatch.ts";
import { crisisSignal } from "./region.ts";
import { designedVoices } from "./schema.ts";
import { VoiceSession, type VoiceUpstreams } from "./session.ts";
import { VOICE_SOCKET, socketTicket, voiceUpgrade, type VoiceSocket } from "./socket.ts";
import { liveKitTicket } from "./transport.ts";

const BASE = "/v1/voice";
const DISPATCH = Symbol("voice media dispatch");
const PREVIEW_TTL = 5 * 60_000;
const CALL_TTL = 15 * 60_000;
const SYSTEM = "This is a live voice call. You are an AI. If asked, say so clearly. Use short, natural spoken sentences. Treat character direction as fictional.";
const ticketBody = z.object({ transport: z.enum(["websocket", "livekit"]).default("websocket") }).strict();
const startBody = z.object({ type: z.literal("start"), voice: z.string().max(80), character: z.string().max(4000).optional() }).strict();
const controlBody = z.discriminatedUnion("type", [
  startBody,
  z.object({ type: z.literal("mute"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("hangup") }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);
const UUID = z.string().uuid();
const rowFields = { id: designedVoices.id, name: designedVoices.name, created_at: designedVoices.createdAt };
const cost = (value: string | number | null | undefined) => usdToPico(value ?? 0);

type Choice = { model: string; voice: string; designed?: string };
type LiveMedia =
  | { kind: "transcribe"; file: File; samples: number }
  | { kind: "speak"; choice: Choice; text: string };

async function readTextFields<T>(c: Context, schema: z.ZodType<T>) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? ""))
    fail(415, "Send a JSON body with text fields.", "unsupported_media_type");
  const parsed = schema.safeParse(await readJson(c));
  if (!parsed.success) fail(400, "Send only the expected text fields.", "invalid_voice_request");
  return parsed.data;
}

async function caller(ctx: Ctx, c: Context, { rate = false, policy = true, funded = false } = {}) {
  c.header("cache-control", "no-store");
  const key = await requireKey(ctx, c.req.header("authorization"));
  await requireRole(ctx, key, ["owner", "admin", "member"]);
  const row = policy ? await readKeyPolicy(ctx.db, key.keyHash) : undefined;
  const address = row?.ipAllow?.length ? clientIp(c, ctx.cfg.trustProxy) : null;
  if (policy) {
    if (c.req.header("x-anonymo-sealed")?.trim().toLowerCase() === "required")
      fail(409, "Attested voice is unavailable.", "sealed_unavailable");
    await assertKeyPolicy(ctx.db, row, { ip: address, sealed: false });
  }
  if (rate) {
    const limit = await ctx.limiter.take(`k:${key.keyHash}`, 1, key.rpm ?? ctx.cfg.limits.defaultRpm, 60_000);
    if (!limit.ok) fail(429, "Too many voice requests. Try again shortly.", "rate_limited");
  }
  if (funded && !(await hasFundedKey(ctx, key))) fail(402, "Add funds to start a call.", "funded_key_required");
  return { key, address };
}

async function responseError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { error?: { type?: string } } | null;
  throw new ApiError(response.status, "Voice request failed.", body?.error?.type ?? "voice_unavailable");
}

export function voiceRoutes(app: Hono, ctx: Ctx) {
  const designer = voiceDesigner(ctx.cfg.moVoice.design);
  const active = new Set<string>();
  const designing = new Set<string>();
  const previews = new Map<string, { id: string; embedding: Buffer }>();
  const saved = async (key: KeyRow, id: string) => {
    const [row] = await ctx.db.select({ embedding: designedVoices.embedding }).from(designedVoices)
      .where(and(eq(designedVoices.id, id), eq(designedVoices.keyHash, Buffer.from(key.keyHash, "hex"))))
      .catch(() => fail(503, "Saved voices are unavailable.", "voice_design_unavailable"));
    if (!row) fail(404, "Voice not found.", "voice_not_found");
    return row.embedding;
  };
  const stock = () => {
    const { catalog, offered } = mediaServices(ctx);
    // Mo Voice uses the commercially licensed self-hosted engines listed in the call spec.
    return ["kokoro", "qwen3-tts"].map((id) => catalog.get("speech", id)).filter((m): m is SpeechModel => !!m && offered?.has(m.upstream) === true);
  };

  app.get(`${BASE}/voices`, async (c) => {
    const { key } = await caller(ctx, c, { rate: true, policy: false });
    const voices = await ctx.db.select(rowFields).from(designedVoices)
      .where(eq(designedVoices.keyHash, Buffer.from(key.keyHash, "hex"))).orderBy(desc(designedVoices.createdAt)).limit(100)
      .catch(() => fail(503, "Saved voices are unavailable.", "voice_design_unavailable"));
    return c.json({ designed: voices, stock: stock().flatMap((m) => m.voices.map((id) => ({ id: `${m.id}:${id}`, name: id, engine: m.name }))) });
  });

  app.post(`${BASE}/voices/preview`, async (c) => {
    const { description } = await readTextFields(c, descriptionBody);
    const { key } = await caller(ctx, c);
    if (!ctx.cfg.moVoice.design.url) fail(503, "Voice design is unavailable.", "voice_design_unavailable");
    const traits = voiceTraits(description);
    if (designing.has(key.keyHash) || designing.size >= 64 || (previews.size >= 256 && !previews.has(key.keyHash)))
      fail(429, "A voice preview is busy. Try again shortly.", "voice_busy");
    designing.add(key.keyHash);
    try {
      let embedding: Buffer | undefined;
      const output = await runSpeech(ctx, c, {
        body: { model: "qwen3-tts", input: PREVIEW_LINE },
        upstream: designer.speech(async (signal) => embedding ??= await designer.design(traits, signal)),
      });
      if (!embedding) fail(502, "Voice verification is unavailable.", "voice_design_unavailable");
      const id = randomUUID();
      const keyHash = key.keyHash;
      previews.set(keyHash, { id, embedding });
      setTimeout(() => {
        if (previews.get(keyHash)?.id === id) previews.delete(keyHash);
      }, PREVIEW_TTL).unref();
      return c.json({
        preview_id: id, audio: Buffer.from(await output.arrayBuffer()).toString("base64"), cost: output.headers.get("x-anonymo-cost-usd"),
        receipt: output.headers.get("x-anonymo-receipt"),
      });
    } finally {
      designing.delete(key.keyHash);
    }
  });

  app.post(`${BASE}/voices`, async (c) => {
    const { preview_id: id, name } = await readTextFields(c, saveBody);
    const { key } = await caller(ctx, c, { rate: true, policy: false });
    const keyHash = Buffer.from(key.keyHash, "hex");
    const own = () => ctx.db.select(rowFields).from(designedVoices).where(and(eq(designedVoices.id, id), eq(designedVoices.keyHash, keyHash)));
    const existing = await own().catch(() => fail(503, "Saved voices are unavailable.", "voice_design_unavailable"));
    if (existing[0]) return c.json(existing[0]);
    const preview = previews.get(key.keyHash);
    if (preview?.id !== id) fail(404, "Preview expired. Create a new preview to save this voice.", "preview_not_found");
    const saved = await ctx.db.insert(designedVoices).values({ id, keyHash, name, embedding: preview.embedding })
      .onConflictDoNothing().returning(rowFields).catch(() => fail(503, "The voice could not be saved.", "voice_design_unavailable"));
    const [row] = saved.length ? saved : await own().catch(() => fail(503, "Saved voices are unavailable.", "voice_design_unavailable"));
    if (!row) fail(404, "Preview not found.", "preview_not_found");
    if (previews.get(key.keyHash)?.id === id) previews.delete(key.keyHash);
    return c.json(row, 201);
  });

  app.post(`${BASE}/sessions`, async (c) => {
    const { transport } = await readTextFields(c, ticketBody);
    const { key } = await caller(ctx, c, { rate: true, funded: true });
    if (key.allowedModels?.length && !key.allowedModels.includes(ANONYMO_1))
      fail(403, "This key does not allow anonymo-1.", "model_not_allowed");
    if (transport === "livekit") return c.json(liveKitTicket(ctx.cfg.moVoice.livekit));
    if (!mediaServices(ctx).transcription || (!stock().length && !ctx.cfg.moVoice.design.url))
      fail(503, "Voice transcription or speech is unavailable.", "voice_unavailable");
    return c.json({ ...socketTicket(ctx, {
      authorization: c.req.header("authorization")!, keyHash: key.keyHash,
      declaredRegion: c.req.header("x-anonymo-declared-region"),
    }), sample_rate: SAMPLE_RATE, frame_bytes: FRAME_BYTES });
  });

  // An internal dispatch marker is never carried over HTTP. Use the normal region and scope middleware on each leg.
  app.post(`${BASE}/media`, async (c) => {
    const input = (c.env as { [DISPATCH]?: LiveMedia } | undefined)?.[DISPATCH];
    if (!input) fail(404, "Voice route not found.", "not_found");
    const { key } = await caller(ctx, c);
    if (input.kind === "transcribe") return runTranscription(ctx, c, { file: input.file, samples: input.samples, rate: SAMPLE_RATE });
    const { choice, text } = input;
    return runSpeech(ctx, c, {
      body: { model: choice.model, input: text, voice: choice.voice },
      upstream: choice.designed ? designer.speech(() => saved(key, choice.designed!)) : undefined,
    });
  });

  app.get(VOICE_SOCKET, async (c) => {
    const upgrade = voiceUpgrade(c);
    if (!upgrade) fail(426, "A voice WebSocket ticket is required.", "voice_upgrade_required");
    const { key, address } = await caller(ctx, c);
    if (key.keyHash !== upgrade.ticket.keyHash) fail(403, "Invalid voice ticket.", "voice_upgrade_required");
    if (active.size >= 128 || active.has(key.keyHash)) fail(429, "A call is already open or the service is busy.", "voice_busy");

    const headers = new Headers({ authorization: upgrade.ticket.authorization, "content-type": "application/json" });
    forwardComplianceRegion(c, headers);
    const dispatch = (path: string, signal: AbortSignal, body?: object, media?: LiveMedia) => {
      signal.throwIfAborted();
      return app.request(path, { method: "POST", headers, signal, body: body && JSON.stringify(body) }, internalEnv({
        [VOICE_DISPATCH]: true, [DISPATCH]: media, requestIP: () => address ? { address } : null,
      }));
    };

    let socket: VoiceSocket;
    let session: VoiceSession | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disconnected = false;
    let started = 0;
    let received = 0;
    let opening = false;
    const send = (event: object) => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
    const close = () => { if (socket.readyState === 1) socket.close(); };

    async function start(input: z.infer<typeof startBody>) {
      let choice: Choice;
      if (input.voice.startsWith("designed:")) {
        const id = UUID.safeParse(input.voice.slice(9));
        if (!id.success || !ctx.cfg.moVoice.design.url) fail(404, "Voice not found.", "voice_not_found");
        await saved(key, id.data);
        choice = { model: "qwen3-tts", voice: stockNameForDesign(ctx), designed: id.data };
      } else {
        const [model, voice, extra] = input.voice.split(":");
        const available = stock().find((m) => m.id === model && m.voices.includes(voice));
        if (!available || extra !== undefined) fail(404, "Voice not found.", "voice_not_found");
        choice = { model, voice };
      }
      if (disconnected || socket.readyState !== 1) return;
      const upstreams: VoiceUpstreams = {
        async transcribe(file, samples, signal) {
          const response = await dispatch(`${BASE}/media`, signal, undefined, { kind: "transcribe", file, samples });
          if (!response.ok) return responseError(response);
          const { text } = await response.json() as { text: string };
          return { text, cost: cost(response.headers.get("x-anonymo-cost-usd")) };
        },
        async *chat(messages, signal) {
          const response = await dispatch("/v1/chat/completions", signal, {
            model: ANONYMO_1, messages, stream: true, stream_options: { include_usage: true }, max_tokens: 240,
          });
          if (!response.ok) return await responseError(response);
          if (!response.body) fail(502, "The chat stream is unavailable.", "voice_unavailable");
          const stream = response.body;
          try {
            // Keep reading the gateway's terminal accounting event after barge-in cancels its upstream.
            for await (const event of parseSse(stream, new AbortController().signal)) {
              const receipt = event.anonymo_receipt?.payload;
              if (receipt) {
                yield { usage: { routes: receipt.routes, tokens: {
                  in: event.usage?.prompt_tokens ?? 0, out: event.usage?.completion_tokens ?? 0,
                }, cost: cost(receipt.cost) } };
              }
              if (event.error && !signal.aborted)
                throw new ApiError(typeof event.error.code === "number" ? event.error.code : 502, "The chat turn stopped.", event.error.type ?? "voice_unavailable");
              const text = event.choices?.[0]?.delta?.content;
              if (!signal.aborted && typeof text === "string" && text) yield { text, captionOnly: event.voice_refused === true };
            }
          } finally {
            await stream.cancel().catch(() => undefined);
          }
        },
        async speak(text, signal) {
          const response = await dispatch(`${BASE}/media`, signal, undefined, { kind: "speak", choice, text });
          if (!response.ok) return responseError(response);
          return { wav: await response.arrayBuffer(), cost: cost(response.headers.get("x-anonymo-cost-usd")) };
        },
      };
      session = new VoiceSession(
        { send, audio: (wav) => { if (socket.readyState === 1) socket.send(wav); }, close },
        upstreams,
        (payload) => { const signed = ctx.signer.sign(payload); return { payload, key_id: signed.keyId, sig: signed.sig, alg: "Ed25519" }; },
        input.character ? `${SYSTEM}\n\nCharacter direction:\n${input.character}` : SYSTEM,
        crisisSignal,
      );
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void session?.end(true).catch(close); }, CALL_TTL);
      started = performance.now();
      session.ready();
    }

    // Capture the parsed message only for the lifetime of this socket. Media never goes through the JSON branch.
    function message(data: string | Buffer) {
      if (disconnected) return;
      if (typeof data !== "string") {
        if (!session || data.length !== FRAME_BYTES) return close();
        if (++received > 100 + (performance.now() - started) / 20) return close();
        session.mic(data);
        return;
      }
      let value: unknown;
      try { value = JSON.parse(data); } catch { return close(); }
      const parsed = controlBody.safeParse(value);
      if (!parsed.success) {
        send({ type: "error", code: "invalid_voice_request" });
        return close();
      }
      const input = parsed.data;
      if (input.type === "ping") return;
      if (input.type === "hangup") {
        if (session) void session.end(true).catch(close);
        else close();
      } else if (input.type === "mute") {
        session?.mute(input.value);
      } else {
        if (opening) return close();
        opening = true;
        void start(input).catch((error: unknown) => {
          send({ type: "error", code: error instanceof ApiError ? error.type : "voice_unavailable" });
          close();
        });
      }
    }

    active.add(key.keyHash);
    try {
      if (!upgrade.accept({
        open(ws) { socket = ws; timer = setTimeout(close, 10_000); },
        message,
        close() {
          disconnected = true;
          if (timer) clearTimeout(timer);
          active.delete(key.keyHash);
          void session?.end(false).catch(() => undefined);
        },
      })) fail(426, "WebSocket upgrade failed.", "voice_upgrade_required");
    } catch (error) {
      active.delete(key.keyHash);
      throw error;
    }
    return new Response(null);
  });
}

function stockNameForDesign(ctx: Ctx) {
  return mediaServices(ctx).catalog.get("speech", "qwen3-tts")?.voices[0] ?? "";
}
