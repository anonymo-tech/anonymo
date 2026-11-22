// Auto Model classifier (src/auto/classify.ts): fixtures for each class, the precedence between them, and determinism.
import { describe, expect, test } from "bun:test";
import { AUTO_CLASSES, classifyRequest, type AutoClass } from "../src/auto/classify.ts";

const user = (content: unknown) => ({ role: "user", content });
const sys = (content: string) => ({ role: "system", content });
const chat = (messages: unknown[], extra: Record<string, unknown> = {}) => ({ body: { model: "anonymo-auto", messages, ...extra }, kind: "chat" as const });

const FIXTURES: Record<AutoClass, { name: string; input: Parameters<typeof classifyRequest>[0] }[]> = {
  vision: [
    { name: "image_url part", input: chat([user([{ type: "text", text: "What is in this picture?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }])]) },
    { name: "input_image part, even with code words", input: chat([user([{ type: "input_image", image_url: "https://example.com/a.png" }, { type: "text", text: "Fix the python bug in this screenshot" }])]) },
    { name: "an earlier image still in context", input: chat([user([{ type: "image_url", image_url: { url: "https://example.com/a.png" } }]), { role: "assistant", content: "A cat." }, user("And its colour?")]) },
  ],
  code: [
    { name: "tools present", input: chat([user("What's the weather in Lisbon?")], { tools: [{ type: "function", function: { name: "weather", parameters: {} } }] }) },
    { name: "legacy functions", input: chat([user("Look this up")], { functions: [{ name: "lookup" }] }) },
    { name: "a code fence", input: chat([user("Why does this fail?\n```\nx = [1,2\n```")]) },
    { name: "a Python traceback", input: chat([user('Traceback (most recent call last):\n  File "a.py", line 3\nTypeError: unsupported operand')]) },
    { name: "source without a fence", input: chat([user("def total(xs):\n    return sum(xs)\nmake it handle None")]) },
    { name: "two programming words", input: chat([user("Write a python script that renames files")]) },
    { name: "a completion prompt with code", input: { body: { model: "anonymo-auto", prompt: "function add(a, b) {\n  return" }, kind: "completion" } },
    { name: "a fence in the assistant's last reply", input: chat([user("give me a snippet"), { role: "assistant", content: "```js\nlet a = 1\n```" }, user("now make it shorter")]) },
  ],
  roleplay: [
    { name: "a character card", input: { ...chat([user("Hi there")]), character: true } },
    { name: "{{char}} template", input: chat([sys("You are {{char}}, a ship's captain. Write {{char}}'s next reply to {{user}}."), user("Ahoy!")]) },
    { name: "roleplay system prompt", input: chat([sys("This is a roleplay. Stay in character as Mira, a tavern keeper."), user("I order an ale.")]) },
    { name: "the dashboard's character prompt (macros expanded)", input: chat([sys("Write Mira's next reply in a fictional chat between Mira and Sam. Keep the story consistent."), user("Good evening.")]) },
    { name: "persona and scenario fields", input: chat([sys("Persona: a sardonic android.\nScenario: a derelict station."), user("Hello?")]) },
    { name: "asterisk actions", input: chat([user("*pushes the door open and shakes off the rain* Anyone here?")]) },
    { name: "second-person narration", input: chat([user("You walk into the old library. You notice a candle still burning on the desk.")]) },
    { name: "let's roleplay", input: chat([user("Let's roleplay: you're a detective and I'm a suspect.")]) },
    { name: "card beats code words", input: { ...chat([user("Tell me about your python and your java")]), character: true } },
  ],
  reasoning: [
    { name: "step by step", input: chat([user("Explain step by step how a bill becomes law.")]) },
    { name: "arithmetic", input: chat([user("What is 17 * 23?")]) },
    { name: "a proof", input: chat([user("Prove that there are infinitely many primes.")]) },
    { name: "probability", input: chat([user("Two dice are rolled. What is the probability the sum is 7?")]) },
    { name: "logic puzzle", input: chat([user("Here's a logic puzzle for you about three boxes and their labels.")]) },
    { name: "reasoning requested", input: chat([user("Hello")], { reasoning: { effort: "high" } }) },
    {
      name: "a long analytical question",
      input: chat([
        user(
          "I run a small bakery that sells bread, pastries and coffee to a mostly local crowd in a mid-sized town. Rent is going up by about a fifth next year, " +
            "and a chain café is opening two streets away in the spring. I could raise prices, cut opening hours on quiet weekdays, start wholesale deliveries " +
            "to restaurants nearby, or move to a cheaper unit a little further from the centre where foot traffic is lower. My staff are loyal and I would " +
            "rather not lose anyone. Could you compare these options and their trade-offs for a business like mine, and say which risks matter most over the next two years?",
        ),
      ]),
    },
  ],
  general: [
    { name: "a greeting", input: chat([user("Hey, how are you today?")]) },
    { name: "a short fact question", input: chat([user("Who painted the Mona Lisa?")]) },
    { name: "a writing request", input: chat([user("Write a short birthday message for my aunt.")]) },
    { name: "one programming-ish word only", input: chat([user("I found a bug in my soup, what should I tell the waiter?")]) },
    { name: "a date is not arithmetic", input: chat([user("What happened on 2024-05-01 in Lisbon?")]) },
    { name: "reasoning switched off", input: chat([user("Tell me a joke")], { reasoning: { enabled: false } }) },
    { name: "an empty request", input: { body: { model: "anonymo-auto" }, kind: "chat" } },
  ],
};

describe("auto classifier fixtures", () => {
  for (const cls of AUTO_CLASSES)
    for (const f of FIXTURES[cls])
      test(`${cls}: ${f.name}`, () => {
        expect(classifyRequest(f.input)).toBe(cls);
      });

  test("every class has fixtures", () => {
    for (const cls of AUTO_CLASSES) expect(FIXTURES[cls].length).toBeGreaterThanOrEqual(3);
  });
});

describe("auto classifier properties", () => {
  test("deterministic: the same request always gets the same class, and the body is not changed", () => {
    for (const cls of AUTO_CLASSES)
      for (const f of FIXTURES[cls]) {
        const before = JSON.stringify(f.input.body);
        const first = classifyRequest(f.input);
        for (let i = 0; i < 5; i++) expect(classifyRequest(structuredClone(f.input))).toBe(first);
        expect(JSON.stringify(f.input.body)).toBe(before);
      }
  });

  test("precedence: images beat tools, tools beat a character card", () => {
    const img = { type: "image_url", image_url: { url: "https://example.com/a.png" } };
    const tools = [{ type: "function", function: { name: "f", parameters: {} } }];
    expect(classifyRequest({ ...chat([user([img])], { tools }), character: true })).toBe("vision");
    expect(classifyRequest({ ...chat([user("hello")], { tools }), character: true })).toBe("code");
  });

  test("malformed messages never throw", () => {
    const odd = [null, 3, "text", { role: "user" }, { role: "user", content: [null, 4, { type: "text" }] }, { role: "user", content: { a: 1 } }];
    expect(AUTO_CLASSES).toContain(classifyRequest({ body: { messages: odd }, kind: "chat" }));
    expect(AUTO_CLASSES).toContain(classifyRequest({ body: { prompt: ["a", 3, null] }, kind: "completion" }));
  });
});
