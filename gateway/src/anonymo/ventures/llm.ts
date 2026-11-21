// WS11 · how a crew module asks a model. Every crew call goes through the gateway's own /v1/chat/completions (see
// crew/caller.ts), so the floor gate (451, never rerouted), the refusal catch (refused attempts free), receipts and the
// key's spend caps apply to every agent call exactly as they do today (Ventures Laws 6 and 7).

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type CrewCall = {
  /** A model id from the catalogue, or a routed id (anonymo-1, anonymo-council). */
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** For anonymo-council: merge (plans) or select (copy variants). */
  councilMode?: "merge" | "select";
  /** Ask for a JSON object back (response_format json_object). */
  json?: boolean;
};

export type CrewReply = {
  text: string;
  model: string;
  family: string | null;
  receiptId: string | null;
  costUsd: number;
  /** The route refused (the gateway billed it 0). */
  refused: boolean;
  /** What the provider still charged for refused attempts inside this call (estimated from their tokens), in USD. */
  refusedCostUsd?: number;
};

export class CrewCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  /** A floor block, a cap or an exhausted balance stops the whole venture; anything else fails one candidate. */
  get fatal() {
    return this.status === 451 || this.status === 402 || this.code === "key_cap_reached" || this.code === "insufficient_balance";
  }
}

export interface Llm {
  call(c: CrewCall): Promise<CrewReply>;
}

/** Pulls the first JSON object or array out of a model reply (fenced or bare). */
export function parseJsonReply<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.search(/[[{]/);
    if (start < 0) continue;
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** A scripted Llm for tests: answers by the first matching rule. */
export function scriptedLlm(rules: { when: (c: CrewCall) => boolean; reply: (c: CrewCall) => string | Partial<CrewReply> }[]): Llm & { calls: CrewCall[] } {
  const calls: CrewCall[] = [];
  return {
    calls,
    async call(c) {
      calls.push(c);
      const rule = rules.find((r) => r.when(c));
      const out = rule ? rule.reply(c) : "";
      const base: CrewReply = { text: "", model: c.model, family: null, receiptId: null, costUsd: 0, refused: false };
      return typeof out === "string" ? { ...base, text: out } : { ...base, ...out };
    },
  };
}
