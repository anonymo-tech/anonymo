// WS04 · Prompt-cache stickiness (Backend §4): the same key and conversation prefix stay on the same route while the
// route is healthy, so the upstream's prompt cache keeps paying off.
//
// The sticky key is a SHA-256 of the API key hash and the conversation's opening messages (every system/developer
// message and the first user message), never the text itself, and it lives only in this process's memory for
// `sticky_ttl_s`. router/select.ts reads and writes it when a request passes `sticky` (chat.ts: WS03 wires one line).

import { canonicalJson, sha256 } from "../lib/util.ts";

type Entry = { providerId: string; until: number };

const MAX_ENTRIES = 50_000;

export class StickyRoutes {
  private map = new Map<string, Entry>();
  constructor(private max = MAX_ENTRIES) {}

  get(key: string, now = Date.now()): string | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.until <= now) {
      this.map.delete(key);
      return null;
    }
    return e.providerId;
  }

  set(key: string, providerId: string, ttlMs: number, now = Date.now()) {
    if (ttlMs <= 0) return;
    this.map.delete(key); // re-insert at the end: the Map keeps insertion order, so the oldest entry is first
    this.map.set(key, { providerId, until: now + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  delete(key: string) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}

/** The process-wide table the router uses. */
export const stickyRoutes = new StickyRoutes();

type Message = { role?: unknown; content?: unknown };

/**
 * The sticky key of a request: its API key (hash) and conversation prefix, per model. Null without a key or messages
 * (nothing to keep together). Only a hash leaves this function.
 */
export function stickyKeyOf(keyHash: string | null | undefined, model: string, body: { messages?: unknown; prompt?: unknown }): string | null {
  if (!keyHash) return null;
  const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : null;
  let prefix: unknown[];
  if (messages?.length) {
    const firstUser = messages.findIndex((m) => m?.role === "user");
    prefix = messages.filter((m, i) => m?.role === "system" || m?.role === "developer" || i === firstUser).map((m) => [m.role, m.content]);
  } else if (typeof body.prompt === "string") prefix = [body.prompt.slice(0, 2_000)];
  else return null;
  if (!prefix.length) return null;
  return sha256(canonicalJson({ k: keyHash, m: model, p: prefix }));
}
