import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRouter, type Harness } from "./helpers.ts";

const LLAMA = "meta-llama/llama-3.3-70b-instruct";

describe("Anonymo MCP server", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter();
  });
  afterAll(async () => {
    await h.close();
  });

  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    h.request("/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", ...headers }, json: body });
  const call = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const res = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, headers);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: number; result?: { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean }; error?: { code: number; message: string } };
  };

  test("initialize names the server and advertises tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const j = await res.json();
    expect(j).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "anonymo" } } });
  });

  test("notifications get 202 with an empty body; ping answers", async () => {
    const n = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
    expect(await (await rpc({ jsonrpc: "2.0", id: "p", method: "ping" })).json()).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  test("tools/list describes the tools with input schemas", async () => {
    const j = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    const tools = j.result.tools as { name: string; description: string; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["chat", "get_receipt", "list_attested_models", "list_models", "verify_provider", "verify_receipt"]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  test("list_models returns live models with per-1M prices, filtered and limited, without a key", async () => {
    const all = (await call("list_models", {})).result!.structuredContent;
    expect(all.total).toBe(((await (await h.request("/api/v1/models")).json()) as { data: unknown[] }).data.length);
    const llama = all.models.find((m: any) => m.id === LLAMA);
    expect(llama).toMatchObject({ id: LLAMA, price_per_1m_input_usd: 0.1, price_per_1m_output_usd: 0.32 });
    expect(typeof llama.name).toBe("string");
    expect(llama.context_length).toBeGreaterThan(0);
    const qwen = (await call("list_models", { query: "QWEN" })).result!.structuredContent;
    expect(qwen.models.map((m: any) => m.id)).toEqual(["qwen/qwen3-32b"]);
    expect(qwen.models[0].price_per_1m_input_usd).toBe(0.2);
    const one = (await call("list_models", { limit: 1 })).result!.structuredContent;
    expect(one).toMatchObject({ returned: 1, total: all.total });
  });

  test("chat goes through the router: reply, receipt id, cost, latency, billed to the key", async () => {
    const k = await h.fundedKey(5n);
    const before = await (await h.request("/api/v1/credits", { headers: k.auth })).json();
    const j = await call("chat", { model: LLAMA, prompt: "hello over MCP", max_tokens: 32, temperature: 0 }, k.auth);
    expect(j.result!.isError).toBeUndefined();
    const s = j.result!.structuredContent;
    expect(s.model).toBe(LLAMA);
    expect(s.receipt_id).toStartWith("gen-");
    expect(typeof s.latency_ms).toBe("number");
    expect(s.text.length).toBeGreaterThan(0);
    expect(s.cost_usd).toBeGreaterThan(0);
    expect(j.result!.content[0]).toEqual({ type: "text", text: s.text });
    // The generation is recorded against the caller's key at the price the receipt reports.
    const g = await (await h.request(`/api/v1/generation?id=${s.receipt_id}`, { headers: k.auth })).json();
    expect(g.data.total_cost).toBe(s.cost_usd);
    const after = await (await h.request("/api/v1/credits", { headers: k.auth })).json();
    expect(Number(after.data.total_usage)).toBeGreaterThan(Number(before.data.total_usage));
    // messages work too.
    const m = await call("chat", { model: LLAMA, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] }, k.auth);
    expect(m.result!.structuredContent.receipt_id).toStartWith("gen-");
  });

  test("05: a chat over MCP is marked origin mcp for its owner only; a direct REST call is not", async () => {
    const k = await h.fundedKey(2n);
    // A client's own attribution headers on /mcp are not forwarded, so they can neither change nor drop the mark.
    const j = await call("chat", { model: LLAMA, prompt: "Reply with ready.", max_tokens: 8 }, { ...k.auth, "x-title": "Some other app", "http-referer": "https://elsewhere.example" });
    const s = j.result!.structuredContent;
    expect(s.receipt_id).toStartWith("gen-");
    const g = await (await h.request(`/api/v1/generation?id=${s.receipt_id}`, { headers: k.auth })).json();
    expect(g.data).toMatchObject({ id: s.receipt_id, origin: "mcp", model: LLAMA, total_cost: s.cost_usd });
    expect(Date.parse(g.data.created_at)).toBeGreaterThan(0);
    // checked_at is the router's clock at lookup time, never before the call it describes.
    expect(Date.parse(g.data.checked_at)).toBeGreaterThanOrEqual(Date.parse(g.data.created_at));
    // The same lookup from another account's key is a 404, as before: origin is never shown to anyone else.
    const other = await h.fundedKey(1n);
    expect((await h.request(`/api/v1/generation?id=${s.receipt_id}`, { headers: other.auth })).status).toBe(404);
    expect((await h.request(`/api/v1/generation?id=${s.receipt_id}`)).status).toBe(404);
    // A call made straight to the REST route (with or without its own app headers) has no MCP origin.
    for (const extra of [{}, { "x-title": "My app" }]) {
      const res = await h.request("/api/v1/chat/completions", { method: "POST", headers: { ...k.auth, ...extra }, json: { model: LLAMA, messages: [{ role: "user", content: "hi" }] } });
      expect(res.status).toBe(200);
      const id = ((await res.json()) as { id: string }).id;
      const d = await (await h.request(`/api/v1/generation?id=${id}`, { headers: k.auth })).json();
      expect(d.data.origin).toBeNull();
    }
  });

  test("05: marking the MCP call keeps lane restrictions and billing: an attested-lane refusal charges nothing", async () => {
    const k = await h.fundedKey(2n);
    const before = await (await h.request("/api/v1/credits", { headers: k.auth })).json();
    const r = (await call("chat", { model: LLAMA, prompt: "hi", lane: "attested" }, k.auth)).result!;
    expect(r.isError).toBe(true);
    expect([409, 503]).toContain(r.structuredContent.error.code);
    const after = await (await h.request("/api/v1/credits", { headers: k.auth })).json();
    expect(after.data.total_usage).toBe(before.data.total_usage);
  });

  test("get_receipt returns the public receipt and verify_receipt reports valid true", async () => {
    const k = await h.fundedKey(2n);
    const id = (await call("chat", { model: LLAMA, prompt: "sign me" }, k.auth)).result!.structuredContent.receipt_id as string;
    const got = (await call("get_receipt", { id })).result!.structuredContent;
    expect(got).toMatchObject({ id, payload: { id, model: LLAMA } });
    expect(typeof got.sig).toBe("string");
    expect(typeof got.key_id).toBe("string");
    const ok = (await call("verify_receipt", { id })).result!;
    expect(ok.structuredContent).toMatchObject({ id, valid: true, signature_valid: true, anchored: false });
    expect(JSON.parse(ok.content[0]!.text).valid).toBe(true);
    // A tampered receipt does not verify through the same logic.
    const bad = await (await h.request("/api/v1/receipts/verify", { method: "POST", json: { payload: { ...got.payload, cost: "0" }, sig: got.sig, key_id: got.key_id } })).json();
    expect(bad.data.valid).toBe(false);
    const missing = (await call("verify_receipt", { id: "gen-does-not-exist" })).result!;
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error).toMatchObject({ code: 404, type: "not_found" });
  });

  test("chat needs an API key, with a clear error, and rejects a bad one", async () => {
    const none = (await call("chat", { model: LLAMA, prompt: "hi" })).result!;
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toContain("API key");
    expect(none.structuredContent.error).toMatchObject({ code: 401, type: "missing_key" });
    const bad = (await call("chat", { model: LLAMA, prompt: "hi" }, { authorization: "Bearer sk-ar-v1-nope" })).result!;
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error.code).toBe(401);
  });

  test("protocol errors are proper JSON-RPC errors", async () => {
    expect(((await (await rpc({ jsonrpc: "2.0", id: 3, method: "resources/list" })).json()) as any).error.code).toBe(-32601);
    expect(((await call("no_such_tool", {})) as any).error.code).toBe(-32602);
    expect(((await call("chat", { model: LLAMA })) as any).error.code).toBe(-32602);
    expect(((await call("chat", { model: LLAMA, prompt: "a", messages: [{ role: "user", content: "b" }] })) as any).error.code).toBe(-32602);
    const parse = await h.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as any).error.code).toBe(-32700);
    const batch = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(batch.status).toBe(200);
    expect(await batch.json()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect((await rpc({ id: 1, method: "ping" })).status).toBe(400);
  });

  test("GET /mcp is 405 and a foreign Origin is 403 (same origin passes)", async () => {
    const get = await h.request("/mcp");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const evil = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "null" })).toHaveProperty("status", 403);
    const same = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "http://localhost" });
    expect(same.status).toBe(200);
  });
});
