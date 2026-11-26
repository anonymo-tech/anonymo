import { expect, test } from "bun:test";
import { boundFreeChat, FREE_LIMITS } from "../src/anonymo/freetier/policy.ts";
import { ApiError } from "../src/lib/errors.ts";

const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as ApiError).type;
  }
  return null;
};
const say = (content: string) => ({ role: "user", content });
const reply = (content: string) => ({ role: "assistant", content });

test("the reply is capped, whatever the request asks for", () => {
  for (const asked of [undefined, 100_000, "lots", 0]) {
    const body: Record<string, unknown> = { model: "m", messages: [say("hi")], ...(asked === undefined ? {} : { max_completion_tokens: asked }) };
    boundFreeChat(body);
    expect(body.max_tokens as number).toBeLessThanOrEqual(FREE_LIMITS.replyTokens);
    expect(body.max_tokens as number).toBeGreaterThan(0);
    expect("max_completion_tokens" in body).toBe(false);
  }
});

test("a long new message is refused with a plain reason, not cut", () => {
  const body = { model: "m", messages: [say("x".repeat(FREE_LIMITS.messageChars + 1))] };
  expect(codeOf(() => boundFreeChat(body))).toBe("free_message_too_long");
  expect(codeOf(() => boundFreeChat({ model: "m", messages: [say("x".repeat(FREE_LIMITS.messageChars))] }))).toBeNull();
});

test("long instructions or a long character description are refused", () => {
  const body = { model: "m", messages: [{ role: "system", content: "y".repeat(FREE_LIMITS.instructionChars + 1) }, say("hi")] };
  expect(codeOf(() => boundFreeChat(body))).toBe("free_context_too_long");
});

test("a long conversation keeps going: oldest turns are dropped until the rest fits", () => {
  const turn = "z".repeat(1_500);
  const history = Array.from({ length: 40 }, (_, i) => (i % 2 ? reply(`${i} ${turn}`) : say(`${i} ${turn}`)));
  const system = { role: "system", content: "You are a pirate." };
  const body: Record<string, unknown> = { model: "m", messages: [system, ...history, say("and now?")] };
  boundFreeChat(body);
  const kept = body.messages as { role: string; content: string }[];
  expect(kept[0]).toEqual(system);
  expect(kept.at(-1)).toEqual(say("and now?"));
  expect(kept.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(FREE_LIMITS.contextChars);
  expect(kept.length).toBeLessThan(history.length);
  // What is kept is the most recent stretch, in order.
  const last = history.slice(-(kept.length - 2));
  expect(kept.slice(1, -1)).toEqual(last);
});

test("the message being answered must be the user's", () => {
  expect(codeOf(() => boundFreeChat({ model: "m", messages: [say("hi"), reply("prefill")] }))).toBe("free_text_only");
});
