import type { ServerWebSocket, WebSocketHandler } from "bun";
import { handshake, voiceWebsocket } from "./anonymo/voice/socket.ts";
import { websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { log } from "./lib/util.ts";
import { installProcessGuard } from "./lib/process-guard.ts";

installProcessGuard();
const { app, ctx, close } = await createApp();

if (ctx.cfg.runtimeRole === "worker") throw new Error("Use src/worker.ts for worker-only workloads.");
const options = {
  hostname: ctx.cfg.host,
  port: ctx.cfg.port,
  idleTimeout: 255, // seconds; streams also send keep-alive comments every 5s
  maxRequestBodySize: Number.MAX_SAFE_INTEGER, // HD1: streamed middleware supplies the route-specific JSON 413.
};
// Mo Voice and Party share Bun's single WebSocket handler: a voice socket carries its own open/message/close in its
// data (voice/socket.ts); every other socket is a Hono upgrade (Party).
const voiceOn = ctx.cfg.features.moVoice;
const isVoice = (ws: ServerWebSocket<any>) => typeof ws.data?.open === "function" && typeof ws.data?.message === "function";
const sockets: WebSocketHandler<any> = {
  ...voiceWebsocket,
  maxPayloadLength: voiceOn ? voiceWebsocket.maxPayloadLength : 1024,
  open: (ws) => (isVoice(ws) ? voiceWebsocket.open?.(ws) : websocket.open?.(ws)),
  message: (ws, data) => (isVoice(ws) ? voiceWebsocket.message(ws, data) : websocket.message(ws, data)),
  close: (ws, code, reason) => (isVoice(ws) ? voiceWebsocket.close?.(ws, code, reason) : websocket.close?.(ws, code, reason)),
};
const server = voiceOn || ctx.cfg.features.party ? Bun.serve({
  ...options,
  websocket: sockets,
  fetch(request, server) {
    if (!voiceOn) return app.fetch(request, server);
    const incoming = handshake(ctx, request, server);
    return app.fetch(incoming.request, incoming.env.voiceUpgrade ? incoming.env : server);
  },
}) : Bun.serve({ ...options, fetch: app.fetch });
log.info("anonymo listening", { url: `http://${server.hostname}:${server.port}`, db: ctx.dbKind, chain: ctx.cfg.chain.id, env: ctx.cfg.env });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  server.stop(false); // stop accepting; let in-flight requests finish
  const deadline = Date.now() + 30_000;
  while (server.pendingRequests > 0 && Date.now() < deadline) await Bun.sleep(100);
  await close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
