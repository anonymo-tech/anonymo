// WS11 · step events for SSE and webhooks (Ventures Backend PART 2: "streams step events over SSE/webhook").
//
// Each venture has an in-memory hub with a replay buffer, so a client that connects late (or reconnects with
// Last-Event-ID) sees everything from the start. Events carry ids, states, families, hashes and costs, never model
// text. A venture created with a webhook_url also gets every event POSTed there, signed like the gateway's other
// webhooks (t=…,v1=hmac). The signing secret is derived from the app secret and the venture id, so it is never stored.

import { createHmac } from "node:crypto";
import type { Ctx } from "../../context.ts";
import { sendWebhook, webhookUrlProblem } from "../../services/spend-watch.ts";
import { webhookSignature } from "../../webhooks/signature.ts";
import type { VentureEvent } from "./types.ts";

export type Numbered = { id: number; event: VentureEvent };
type Listener = (e: Numbered) => void;

const REPLAY = 2_000;

class Hub {
  readonly buffer: Numbered[] = [];
  readonly listeners = new Set<Listener>();
  seq = 0;
  closed = false;
}

export class VentureEvents {
  private hubs = new Map<string, Hub>();
  private webhooks = new Map<string, { url: string; secret: string }>();
  /** Pending webhook deliveries, so tests (and shutdown) can wait for them. */
  readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly send: typeof sendWebhook = sendWebhook) {}

  private hub(id: string) {
    let h = this.hubs.get(id);
    if (!h) this.hubs.set(id, (h = new Hub()));
    return h;
  }

  setWebhook(ventureId: string, url: string, secret: string) {
    this.webhooks.set(ventureId, { url, secret });
  }

  emit(e: VentureEvent) {
    const h = this.hub(e.ventureId);
    const n = { id: ++h.seq, event: e };
    h.buffer.push(n);
    if (h.buffer.length > REPLAY) h.buffer.shift();
    for (const l of h.listeners) l(n);
    const hook = this.webhooks.get(e.ventureId);
    if (hook) {
      const body = JSON.stringify(e);
      const p = this.send(hook.url, e, { headers: { "x-anonymo-signature": webhookSignature(hook.secret, body), "x-anonymo-event-id": `${e.ventureId}:${n.id}` } }).catch(() => undefined);
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    }
    if (e.type === "venture" && ["DONE", "FAILED", "CAPPED", "CANCELLED"].includes(e.status)) this.close(e.ventureId);
  }

  /** Replays everything after `after`, then follows live events until the venture ends or `unsubscribe` is called. */
  subscribe(ventureId: string, after: number, l: Listener): { unsubscribe: () => void; closed: boolean } {
    const h = this.hub(ventureId);
    for (const n of h.buffer) if (n.id > after) l(n);
    if (h.closed) return { unsubscribe: () => {}, closed: true };
    h.listeners.add(l);
    return { unsubscribe: () => h.listeners.delete(l), closed: false };
  }

  isClosed(ventureId: string) {
    return this.hubs.get(ventureId)?.closed ?? false;
  }

  history(ventureId: string): VentureEvent[] {
    return (this.hubs.get(ventureId)?.buffer ?? []).map((n) => n.event);
  }

  private close(ventureId: string) {
    const h = this.hub(ventureId);
    h.closed = true;
    for (const l of h.listeners) l({ id: -1, event: { type: "log", ventureId, step: "", role: "boss", message: "__end__", at: new Date().toISOString() } });
    h.listeners.clear();
    this.webhooks.delete(ventureId);
  }

  async drain() {
    await Promise.all([...this.inflight]);
  }
}

export const webhookSecretFor = (ctx: Ctx, ventureId: string) => "whsec_" + createHmac("sha256", ctx.cfg.appSecret).update(`venture-webhook:${ventureId}`).digest("hex");

/** null when the url is acceptable (https, public host), else why not. */
export const ventureWebhookProblem = (url: string) => webhookUrlProblem(url);
