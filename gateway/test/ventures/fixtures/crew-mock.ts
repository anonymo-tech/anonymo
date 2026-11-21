// A scripted crew for the end-to-end Ventures tests: mock providers answer each Mo's prompt with fixed JSON. One
// builder family writes working code and one writes a bug, so the tests can prove that tests (not chat) pick the winner.

const PLAN = {
  name: "Notewise",
  positioning: "Notes for small teams that want an API first.",
  audience: "Two-person product teams",
  problem: "Shared notes are trapped in heavy tools.",
  mvpFeatures: [
    { id: "create-note", title: "Create a note", description: "POST /notes with a title creates a note.", acceptance: ["POST /notes with {title} returns 201 and the note with an id", "POST /notes without a title returns 400"] },
    { id: "list-notes", title: "List notes", description: "GET /notes lists notes.", acceptance: ["GET /notes returns 200 and an array of notes"] },
    { id: "get-note", title: "Get a note", description: "GET /notes/:id returns one note.", acceptance: ["GET /notes/:id returns the note", "GET /notes/:id for an unknown id returns 404"] },
  ],
  pricing: [
    { name: "Free", priceUsdMonthly: 0, features: ["100 notes"] },
    { name: "Team", priceUsdMonthly: 9, features: ["Unlimited notes", "API access"] },
  ],
  launch: ["Day 1: post the demo"],
};

export const TESTS = `import { expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
const req = (path: string, method = "GET", body?: unknown) => new Request("http://app" + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
test("create returns 201 with an id", async () => {
  const app = createApp();
  const r = await app.fetch(req("/notes", "POST", { title: "a" }));
  expect(r.status).toBe(201);
  expect(typeof (await r.json()).id).toBe("string");
});
test("create without a title is 400", async () => {
  const app = createApp();
  expect((await app.fetch(req("/notes", "POST", {}))).status).toBe(400);
});
test("list returns the notes", async () => {
  const app = createApp();
  await app.fetch(req("/notes", "POST", { title: "a" }));
  const r = await app.fetch(req("/notes"));
  expect(r.status).toBe(200);
  expect((await r.json()).length).toBe(1);
});
test("get returns one note", async () => {
  const app = createApp();
  const { id } = await (await app.fetch(req("/notes", "POST", { title: "a" }))).json();
  const r = await app.fetch(req("/notes/" + id));
  expect(r.status).toBe(200);
  expect((await r.json()).title).toBe("a");
});
test("get unknown is 404", async () => {
  const app = createApp();
  expect((await app.fetch(req("/notes/nope"))).status).toBe(404);
});
`;

const app = (bug: boolean) => `type Note = { id: string; title: string };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
export function createApp() {
  const notes = new Map<string, Note>();
  let n = 0;
  return {
    async fetch(req: Request): Promise<Response> {
      const u = new URL(req.url);
      if (u.pathname === "/") return new Response("<h1>Notewise</h1><ul><li>Create</li><li>List</li><li>Get</li></ul>", { headers: { "content-type": "text/html" } });
      if (u.pathname === "/notes" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { title?: unknown };
        if (typeof b.title !== "string" || !b.title) return json({ error: "title is required" }, 400);
        const note = { id: String(++n), title: b.title };
        notes.set(note.id, note);
        return json(note, 201);
      }
      if (u.pathname === "/notes" && req.method === "GET") return json([...notes.values()]);
      const m = /^\\/notes\\/([^/]+)$/.exec(u.pathname);
      if (m && req.method === "GET") {
        const note = notes.get(m[1]!);
        return ${bug ? "json(note ?? {}, 200)" : 'note ? json(note) : json({ error: "not found" }, 404)'};
      }
      return json({ error: "not found" }, 404);
    },
  };
}
`;

export const GOOD_APP = app(false);
export const BUGGY_APP = app(true);

/** Families: deepseek (tester, cheapest), glm (good), qwen (buggy, even after repair), gemma (good). */
export function crewReply(prompt: string, body: any): string | undefined {
  const model = String(body?.model ?? "");
  const fence = /<cand_[a-z0-9]+>\n([\s\S]*?)\n<\/cand_[a-z0-9]+>/.exec(prompt);
  if (prompt.includes("Write the final merged answer now") && fence) return crewReply(fence[1]!, body);
  if (prompt.includes('Reply with JSON only: {"winner"')) return '{"winner":"A","reason":"clearest"}';
  if (prompt.includes("Give demand checks")) return JSON.stringify({ audience: "small teams", demand: [{ signal: "searches", how_to_check: "keyword tool" }], competitors: [{ name: "Big Notes", angle: "suite", weakness: "slow" }], risks: ["crowded"], wedge: "API first" });
  if (prompt.includes("Write the venture plan") || prompt.includes("Write the Parity+ plan") || prompt.includes("Plan the rebrand")) {
    const extra = prompt.includes("Parity+") ? { parity: [{ feature: "Notes", theirs: true, ours: "parity", note: "" }, { feature: "API", theirs: false, ours: "new", note: "asked for" }], gaps: ["CSV import"], priceUnder: { note: "under theirs" } } : {};
    return JSON.stringify({ ...PLAN, ...extra, ...(prompt.includes("Plan the rebrand") ? { improvements: ["faster search"] } : {}) });
  }
  if (prompt.includes("Write the landing page")) return JSON.stringify({ brand: "Notewise", eyebrow: "Notes, API first", tagline: "Notes your code can read", subhead: "A tiny notes API with a clean page on top.", cta: "Start free", features: [{ title: "Create", body: "Make notes with one call.", icon: "bolt" }, { title: "List", body: "Every note, in order.", icon: "layers" }, { title: "Guaranteed wealth", body: "You will earn passive income.", icon: "chart" }], steps: [{ title: "Sign up", body: "Get a key." }], stats: [{ label: "Endpoints", value: "3" }], faq: [{ q: "Is there an API?", a: "Yes." }], ctaHeadline: "Ship notes today", ctaBody: "Free to start." });
  if (prompt.includes("Write the ad kit")) return JSON.stringify({ hooks: ["Notes your code can read", "A bet you can't lose"], ads: [{ channel: "x", headline: "Notes, API first", body: "Three endpoints. Zero clutter.", cta: "Try it" }], posts: [{ channel: "hn", text: "Show HN: a notes API" }], emails: [{ subject: "Welcome", body: "Here is your key.", sendDay: 0 }] });
  if (prompt.includes("14-day launch plan")) return JSON.stringify({ days: [{ day: 1, tasks: ["post"] }], channels: ["hn"], metrics: ["signups"] });
  if (prompt.includes("Write tests in test/app.test.ts")) return JSON.stringify({ files: { "test/app.test.ts": TESTS } });
  if (prompt.includes("Build this MVP") || prompt.includes("Some tests failed")) return JSON.stringify({ files: { "src/app.ts": model.includes("qwen") ? BUGGY_APP : GOOD_APP } });
  if (prompt.includes("Write a head-to-head comparison")) {
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!);
    return JSON.stringify({ intro: "A plain comparison.", rows: [...ids.slice(0, 4).map((id, i) => ({ feature: `Row ${i + 1}`, us: true, them: false, finding: id })), { feature: "Uncited claim", us: true, them: false }], switchOffer: "Two months free when you switch.", cta: "Switch now" });
  }
  if (prompt.includes("the alternative to")) return JSON.stringify({ offer: { title: "Switch in a minute", body: "Import your export file.", cta: "Switch" }, page: { brand: "Notewise", eyebrow: "The alternative", tagline: "Move in a minute", subhead: "Bring your notes.", cta: "Switch", features: [{ title: "Import", body: "One file.", icon: "bolt" }], faq: [] }, migration: ["Export", "Import"] });
  if (prompt.includes("ads for unhappy")) return JSON.stringify({ ads: Array.from({ length: 30 }, (_, i) => ({ channel: "x", headline: `Tired of waiting? ${i}`, body: "Notewise is fast.", cta: "Switch", angle: "speed" })) });
  if (prompt.includes("Support these export formats")) return JSON.stringify({ files: { "src/import.ts": IMPORT_TOOL } });
  if (prompt.includes("single most valuable improvement")) return JSON.stringify({ title: "Search", why: "asked for", acceptance: ["GET /search?q= returns matches"] });
  if (prompt.includes("fresh ad variants")) return JSON.stringify({ ads: [{ channel: "x", headline: "Fresh", body: "New week, same speed.", cta: "Try" }] });
  if (prompt.includes("This week's facts")) return "- Ran every day\n- No changes from the competitor";
  return undefined;
}

export const IMPORT_TOOL = `export function parseExport(format: string, content: string): Record<string, string>[] {
  if (!/csv/i.test(format) && !/export/i.test(format)) throw new Error("unknown format " + format);
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (q) {
      if (ch === '"' && content[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\\n" || ch === "\\r") {
      if (ch === "\\r" && content[i + 1] === "\\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const [head, ...rest] = rows;
  if (!head) return [];
  return rest.filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
`;

const m = (id: string, slug: string, prompt: string) => ({ id, slug, prompt, completion: prompt });
export const CREW_PROVIDERS = [
  { id: "ds", name: "DS", models: [m("ds-up", "deepseek/deepseek-v4-flash", "0.0000001")], reply: crewReply },
  { id: "zp", name: "ZP", models: [m("glm-up", "zai/glm-5", "0.0000002")], reply: crewReply },
  { id: "qw", name: "QW", models: [m("qwen-up", "qwen/qwen3-32b", "0.0000003")], reply: crewReply },
  { id: "gm", name: "GM", models: [m("gemma-up", "google/gemma-4-26b", "0.0000004")], reply: crewReply },
];
