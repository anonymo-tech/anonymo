import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Context } from "hono";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";

export const VOICE_SOCKET = "/v1/voice/socket";
const PROTOCOL = "movoice";
const TTL_MS = 30_000;
type Ticket = { authorization: string; keyHash: string; declaredRegion?: string; until: number };
type SocketData = { open(ws: VoiceSocket): void; message(data: string | Buffer): void; close(): void };
export type VoiceSocket = ServerWebSocket<SocketData>;
type Upgrade = { ticket: Ticket; accept(data: SocketData): boolean };

const entries = new WeakMap<Ctx, Map<string, Ticket>>();
const tickets = (ctx: Ctx) => {
  let map = entries.get(ctx);
  if (!map) entries.set(ctx, map = new Map());
  for (const [id, value] of map) if (value.until <= Date.now()) map.delete(id);
  return map;
};

export function socketTicket(ctx: Ctx, ticket: Omit<Ticket, "until">) {
  const map = tickets(ctx);
  if (map.size >= 256) fail(503, "Voice connections are busy.", "voice_busy");
  const id = randomBytes(24).toString("base64url");
  const entry = { ...ticket, until: Date.now() + TTL_MS };
  map.set(id, entry);
  setTimeout(() => map.delete(id), TTL_MS).unref();
  return { transport: "websocket", path: VOICE_SOCKET, protocol: PROTOCOL, ticket: id, expires_in: TTL_MS / 1000 };
}

export function handshake(ctx: Ctx, request: Request, server: Server<SocketData>) {
  const input: { request: Request; env: { voiceUpgrade?: Upgrade; requestIP?: () => ReturnType<typeof server.requestIP> } } = { request, env: {} };
  if (new URL(request.url).pathname !== VOICE_SOCKET || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return input;
  const [protocol, id, extra] = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
  if (protocol !== PROTOCOL || !id || extra !== undefined || !/^[\w-]{32}$/.test(id)) return input;
  const map = tickets(ctx);
  const ticket = map.get(id);
  if (!ticket) return input;
  map.delete(id);

  const headers = new Headers(request.headers);
  headers.set("authorization", ticket.authorization);
  if (ticket.declaredRegion) headers.set("x-anonymo-declared-region", ticket.declaredRegion);
  input.request = new Request(request, { headers });
  input.env = {
    voiceUpgrade: {
      ticket,
      accept: (data) => server.upgrade(request, { data, headers: { "sec-websocket-protocol": PROTOCOL } }),
    },
    // Use Bun's original request for address lookup on the internally authorized request.
    requestIP: () => server.requestIP(request),
  };
  return input;
}

export function voiceUpgrade(c: Context) {
  return (c.env as { voiceUpgrade?: Upgrade } | undefined)?.voiceUpgrade;
}

export const voiceWebsocket: WebSocketHandler<SocketData> = {
  idleTimeout: 30,
  maxPayloadLength: 16_384,
  backpressureLimit: 2 * 1024 * 1024,
  closeOnBackpressureLimit: true,
  open: (ws) => ws.data.open(ws),
  message: (ws, data) => ws.data.message(data),
  close: (ws) => ws.data.close(),
};
