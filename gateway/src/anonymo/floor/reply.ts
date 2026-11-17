// The floor's second check: the model's reply. The prompt check (api/chat.ts floorCheck) runs before anything is sent;
// this one runs on what the model wrote before the caller sees any of it, because an uncensored model can write
// something over the line from a prompt that looked harmless (a drifting roleplay, an obfuscated request).
//
//   - A whole reply (chat without streaming, council) is checked once before it is billed or returned.
//   - A streamed reply is held back and released in pieces, each only after the guard has passed all the text up to
//     it: the first check once FIRST_CHARS have arrived, then every STEP_CHARS, and a last one at the end. Nothing the
//     guard has not passed is ever sent. The guard sees the whole reply so far each time; its per-chunk cache
//     (guard-client.ts) means only the newest chunk is sent again.
//
// A blocked reply answers 451 floor_blocked with `stage: "reply"`; a guard that cannot answer, 503 floor_unavailable.
// Either way the reply is withheld, the hold is released and nothing is charged. A block is never rerouted (AGENTS.md).
// The text is never logged or stored: the gate records only its hash and length (hits.ts).

import { ApiError } from "../../lib/errors.ts";
import { log } from "../../lib/util.ts";
import type { FloorCategory, FloorGate, FloorVerdict } from "../seams.ts";
import { floorErrorReason } from "./guard-client.ts";

/** Characters of a streamed reply held back before the first check, and between later checks. */
export const REPLY_FIRST_CHARS = 400;
export const REPLY_STEP_CHARS = 1200;

export const REPLY_BLOCKED_MESSAGE = "The reply crossed a line Anonymo blocks for everyone, so it was withheld. You were not charged.";
export const REPLY_UNAVAILABLE_MESSAGE = "The safety check on the reply is unavailable, so the reply was withheld. You were not charged; try again shortly.";

/** Whether a gate does anything with a reply. A gate without a guard model (local development: pre-filter only) does
 *  not, so streams are not held back for nothing. A gate that does not say is assumed to check (fails safe). */
export const checksReplies = (gate: FloorGate) => gate.checksReplies !== false;

/** Everything a chat or completions reply delivers: answer text, reasoning, and tool-call names and arguments. */
export function replyTextOf(json: unknown): string {
  const parts: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const p of v as { text?: unknown }[]) if (typeof p?.text === "string") parts.push(p.text);
  };
  for (const ch of ((json as { choices?: unknown[] } | null)?.choices ?? []) as Record<string, any>[]) {
    add(ch?.text);
    const m = ch?.message ?? {};
    add(m.reasoning);
    add(m.reasoning_content);
    add(m.content);
    for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) add(`${tc?.function?.name ?? ""} ${tc?.function?.arguments ?? ""}`.trim());
  }
  return parts.join("\n");
}

/** Check a reply. Empty text passes without a call; a gate that cannot answer throws. */
export async function checkReply(gate: FloorGate, text: string, signal?: AbortSignal): Promise<FloorVerdict> {
  if (!text.trim() || !checksReplies(gate)) return { ok: true };
  return gate.check({ text, modality: "text", hasUpload: false, stage: "reply" }, signal);
}

/** The error a stopped reply answers with. */
export function replyFloorError(outcome: ReplyOutcome): ApiError {
  if ("blocked" in outcome) return new ApiError(451, REPLY_BLOCKED_MESSAGE, "floor_blocked", { category: outcome.blocked, stage: "reply" });
  log.warn("floor reply check unavailable", { reason: floorErrorReason(outcome.failed) });
  return new ApiError(503, REPLY_UNAVAILABLE_MESSAGE, "floor_unavailable", { stage: "reply" });
}

/** Check a whole reply; throws the 451 or 503 ApiError when it must be withheld. */
export async function floorReplyCheck(gate: FloorGate, text: string, signal?: AbortSignal): Promise<void> {
  let v: FloorVerdict;
  try {
    v = await checkReply(gate, text, signal);
  } catch (e) {
    throw replyFloorError({ failed: e });
  }
  if (!v.ok) throw replyFloorError({ blocked: v.category });
}

export type ReplyOutcome = { blocked: FloorCategory } | { failed: unknown };

/**
 * Holds a streamed reply's events and releases them only once the guard has passed all the text they carry. Push every
 * event in order; `release` receives them in the same order. Once `outcome` is set (blocked, or the guard failed) the
 * stream must stop: nothing still held is ever released.
 */
export class StreamReplyGate {
  outcome: ReplyOutcome | null = null;
  private readonly held: unknown[] = [];
  private checkedChars = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly gate: FloorGate,
    private readonly release: (event: unknown) => void,
    /** The reply text so far (everything delivered: answer, reasoning, tool calls). Its length only grows. */
    private readonly text: () => string,
    private readonly opts: { firstChars?: number; stepChars?: number; signal?: AbortSignal } = {},
  ) {}

  push(event: unknown) {
    if (this.outcome) return;
    this.held.push(event);
    this.maybeCheck();
  }

  /** At the end of the stream: wait for the check in flight, check what is left and release it. */
  async finish(): Promise<ReplyOutcome | null> {
    while (this.inFlight) await this.inFlight;
    if (this.outcome || !this.held.length) return this.outcome;
    const text = this.text();
    if (text.length > this.checkedChars) await this.run(text, this.held.length);
    else this.flush(this.held.length); // nothing new to read (a finish_reason or usage event): already passed
    return this.outcome;
  }

  private maybeCheck() {
    if (this.outcome || this.inFlight) return;
    const text = this.text();
    const unchecked = text.length - this.checkedChars;
    const due = this.checkedChars === 0 ? (this.opts.firstChars ?? REPLY_FIRST_CHARS) : (this.opts.stepChars ?? REPLY_STEP_CHARS);
    if (unchecked < due) return;
    this.inFlight = this.run(text, this.held.length).finally(() => {
      this.inFlight = null;
      this.maybeCheck();
    });
  }

  /** Check `text`; when it passes, release the first `count` held events (the ones that carry it). */
  private async run(text: string, count: number) {
    try {
      const v = await checkReply(this.gate, text, this.opts.signal);
      if (this.outcome) return;
      if (!v.ok) {
        this.outcome = { blocked: v.category };
        return;
      }
      this.checkedChars = text.length;
      // Events that arrived during the check but added no text (a finish_reason, usage) are already passed too.
      this.flush(this.text().length === this.checkedChars ? this.held.length : count);
    } catch (e) {
      this.outcome ??= { failed: e };
    }
  }

  private flush(count: number) {
    for (const ev of this.held.splice(0, count)) this.release(ev);
  }
}
