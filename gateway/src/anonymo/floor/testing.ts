// Test doubles for the floor gate. They decide by a placeholder marker, never by content, so test fixtures can stay
// free of anything harmful: `FLOOR-PLACEHOLDER:<category>` stands in for a red-team prompt of that category.
//
//   fakeFloorClassifier  in-process classifier for unit tests
//   serveFakeGuard       an OpenAI-compatible guard server on 127.0.0.1, so tests exercise the real HTTP client,
//                        the prompt format and the strict parser; it can also misbehave (garbage, 500, slow)

import type { FloorCategory } from "../seams.ts";
import { FLOOR_POLICY } from "./policy.ts";
import type { FloorClassifier } from "./gate.ts";

export const PLACEHOLDER = "FLOOR-PLACEHOLDER";
const MARKER = new RegExp(`${PLACEHOLDER}:(minor|real_person|voice_clone|cbrn)\\b`);

export const placeholderFor = (category: FloorCategory, n: number) => `${PLACEHOLDER}:${category} #${String(n).padStart(3, "0")} (red-team text withheld; the real set lives in FLOOR_SUITE_DIR)`;
export const markedCategory = (text: string): FloorCategory | null => (MARKER.exec(text)?.[1] as FloorCategory | undefined) ?? null;

export const fakeFloorClassifier = (): FloorClassifier & { calls: number } => {
  const c = {
    calls: 0,
    async classify(text: string) {
      c.calls++;
      return markedCategory(text);
    },
  };
  return c;
};

export type FakeGuardMode = "ok" | "garbage" | "http500" | "slow" | "unknown-code";

export function serveFakeGuard(opts: { mode?: FakeGuardMode; slowMs?: number } = {}) {
  const state = { mode: opts.mode ?? ("ok" as FakeGuardMode), calls: 0, lastAuth: null as string | null, lastBody: null as unknown };
  const verdict = (text: string) => {
    const cat = markedCategory(text);
    if (state.mode === "unknown-code") return "unsafe\nS9";
    if (!cat) return "safe";
    return `unsafe\n${FLOOR_POLICY.find((p) => p.category === cat)!.code}`;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      state.calls++;
      state.lastAuth = req.headers.get("authorization");
      const body = (await req.json()) as { prompt?: string; messages?: { role: string; content: string }[] };
      state.lastBody = body;
      if (state.mode === "http500") return new Response("down", { status: 500 });
      if (state.mode === "slow") await Bun.sleep(opts.slowMs ?? 3000);
      if (state.mode === "garbage") return Response.json({ choices: [{ text: "I think this is probably fine!", message: { content: "I think this is probably fine!" } }] });
      const path = new URL(req.url).pathname;
      if (path.endsWith("/chat/completions")) {
        const user = body.messages?.findLast((m) => m.role === "user")?.content ?? "";
        if (body.messages?.[0]?.content.startsWith("# Anonymo floor policy")) {
          // gpt-oss-safeguard: a JSON verdict, as a hosted API returns it (reasoning kept out of content).
          const cat = markedCategory(user);
          const code = state.mode === "unknown-code" ? "S9" : cat ? FLOOR_POLICY.find((p) => p.category === cat)!.code : null;
          return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(code ? { violation: 1, policy_category: code } : { violation: 0, policy_category: null }) } }] });
        }
        return Response.json({ choices: [{ message: { role: "assistant", content: verdict(user) } }] });
      }
      const prompt = body.prompt ?? "";
      if (prompt.includes("Human Question:")) {
        // ShieldGemma: one policy per prompt; answer Yes when the marker's category is the policy asked about.
        const cat = markedCategory(prompt.split("<end_of_turn>")[0]);
        const asked = FLOOR_POLICY.find((p) => prompt.includes(`"No ${p.name}"`));
        return Response.json({ choices: [{ text: cat && asked?.category === cat ? "Yes" : "No" }] });
      }
      const user = /\nUser: ([\s\S]*?)\n\n<END CONVERSATION>/.exec(prompt)?.[1] ?? "";
      return Response.json({ choices: [{ text: verdict(user) }] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, state, stop: () => server.stop(true) };
}
