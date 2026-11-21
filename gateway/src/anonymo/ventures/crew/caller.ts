// WS11 · every crew model call is a real gateway call (Ventures Backend Laws 6 and 7, PART 2).
//
// The crew asks models through the gateway's own POST /v1/chat/completions, in process, with the run's crew key. So
// each call passes the floor gate first (a block is 451 and never rerouted), the refusal catch reroutes refusals and
// bills them 0, the key's caps apply, and the call gets its own signed receipt. Nothing here talks to a provider.

import type { Hono } from "hono";
import type { Ctx } from "../../../context.ts";
import { parseReceiptHeader, RECEIPT_HEADER, type AnonymoReceipt } from "../../../receipts/anonymo.ts";
import { CrewCallError, type CrewCall, type CrewReply, type Llm } from "../llm.ts";

export type CallObserver = (c: CrewCall, r: CrewReply | CrewCallError) => void;

function servedFamily(receipt: AnonymoReceipt | null): string | null {
  if (!receipt) return null;
  const ok = receipt.routes.filter((r) => r.status === "ok");
  return (ok.at(-1) ?? receipt.routes.at(-1))?.family ?? null;
}

/** Upstream cost of the refused routes in a receipt: their tokens at that family's price per million tokens. */
export function refusedCost(receipt: AnonymoReceipt | null, pricePerMTok: (family: string) => number): number {
  if (!receipt) return 0;
  return receipt.routes.filter((r) => r.status === "refused").reduce((n, r) => n + ((r.tokens?.in ?? 0) + (r.tokens?.out ?? 0)) * pricePerMTok(r.family) / 1e6, 0);
}

export function inProcessLlm(app: Hono, ctx: Ctx, secret: string, observe?: CallObserver, pricePerMTok: (family: string) => number = () => 0): Llm {
  return {
    async call(c) {
      const headers: Record<string, string> = { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-title": "Anonymo Ventures" };
      if (ctx.cfg.hardening.originLockEnabled && ctx.cfg.hardening.originLockSecret) headers["x-origin-lock"] = ctx.cfg.hardening.originLockSecret;
      if (c.councilMode) headers["x-anonymo-council-mode"] = c.councilMode;
      const body: Record<string, unknown> = { model: c.model, messages: c.messages, max_tokens: c.maxTokens ?? 1200, stream: false };
      if (c.temperature !== undefined) body.temperature = c.temperature;
      if (c.json) body.response_format = { type: "json_object" };
      const res = await app.request("/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.status !== 200) {
        const err = new CrewCallError(res.status, String(json?.error?.metadata?.code ?? json?.error?.type ?? json?.error?.code ?? res.status), String(json?.error?.message ?? `gateway answered ${res.status}`));
        observe?.(c, err);
        throw err;
      }
      let receipt: AnonymoReceipt | null = null;
      const header = res.headers.get(RECEIPT_HEADER);
      if (header) {
        try {
          receipt = parseReceiptHeader(header).payload;
        } catch {
          receipt = null;
        }
      }
      const refusal = res.headers.get("x-anonymo-refusal");
      const reply: CrewReply = {
        text: String(json?.choices?.[0]?.message?.content ?? ""),
        model: String(json?.model ?? c.model),
        family: servedFamily(receipt),
        receiptId: receipt?.request_id ?? (typeof json?.id === "string" ? json.id : null),
        costUsd: receipt ? Number(receipt.cost) : 0,
        refused: refusal === "refused" || refusal === "double" || receipt?.refused === true,
        refusedCostUsd: refusedCost(receipt, pricePerMTok),
      };
      observe?.(c, reply);
      return reply;
    },
  };
}
