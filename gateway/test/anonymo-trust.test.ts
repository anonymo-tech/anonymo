import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { deriveFamily, familyOf, weightsHashOf } from "../src/anonymo/trust/families.ts";
import { attestationQuoteHash, keySealedOnly, sealedRequired } from "../src/anonymo/trust/sealed.ts";
import { clampMultiplier, trustConfigFromEnv } from "../src/anonymo/trust/config.ts";
import { awaitQuorum, councilPremium, mergeMessages, parseCouncilMode, pickProposers } from "../src/router/council.ts";
import { anonymoLeaf, buildAnonymoReceipt, parseReceiptHeader, receiptHeader, signAnonymoReceipt, type ReceiptRoute } from "../src/receipts/anonymo.ts";
import { canonicalBytes } from "../src/receipts/signer.ts";
import { MerkleTree } from "../src/receipts/merkle.ts";
import { verifyInclusion } from "../src/receipts/roots.ts";

// Unit tests for WS09's pure pieces: families, sealed request detection, council timing and pricing, receipts and proofs.

describe("model families", () => {
  test("known families are read from the id, name or repository", () => {
    expect(deriveFamily({ id: "deepseek/deepseek-v4.1-flash-abliterated" })).toBe("deepseek");
    expect(deriveFamily({ id: "zai/glm-5.2-abliterated" })).toBe("glm");
    expect(deriveFamily({ id: "qwen/qwen3.5-27b-abliterated" })).toBe("qwen");
    expect(deriveFamily({ id: "google/gemma-4-26b-uncensored" })).toBe("gemma");
    expect(deriveFamily({ id: "venice/venice-uncensored" })).toBe("mistral");
    expect(deriveFamily({ id: "cognitive/dolphin-venice-24b" })).toBe("mistral");
    expect(deriveFamily({ id: "moonshot/kimi-k2.7-code" })).toBe("kimi");
    expect(deriveFamily({ id: "meta-llama/llama-3.3-70b-instruct" })).toBe("llama");
    expect(deriveFamily({ id: "acme/m1", name: "Qwen3 tuned" })).toBe("qwen");
  });
  test("an unknown model falls back to its author; the route record's own family wins when it has one", () => {
    expect(deriveFamily({ id: "acme/m1" })).toBe("acme");
    expect(familyOf({ id: "acme/m1" }, { family: "GLM" })).toBe("glm");
    expect(familyOf({ id: "acme/m1", family: "qwen" }, { family: "" })).toBe("qwen");
    expect(familyOf({ id: "deepseek/x" }, null)).toBe("deepseek");
  });
  test("a weights hash is read from the route record and never invented", () => {
    expect(weightsHashOf({ weightsHash: "AB12" })).toBe("ab12");
    expect(weightsHashOf({ weights_hash: "cd" })).toBe("cd");
    expect(weightsHashOf({}, { weightsHash: "ef" })).toBe("ef");
    expect(weightsHashOf({}, {})).toBeNull();
    expect(weightsHashOf(null)).toBeNull();
  });
});

describe("sealed requests", () => {
  test("the model, the header or a sealed_only key makes a request sealed", () => {
    expect(sealedRequired({ model: "anonymo-sealed" })).toBe(true);
    expect(sealedRequired({ header: "required" })).toBe(true);
    expect(sealedRequired({ header: " Required " })).toBe(true);
    expect(sealedRequired({ key: { sealedOnly: true } })).toBe(true);
    expect(sealedRequired({ key: { caps: { sealed_only: true } } })).toBe(true);
    expect(sealedRequired({ councilSealed: true })).toBe(true);
    expect(sealedRequired({ model: "anonymo-1", header: null, key: { caps: { sealed_only: false } } })).toBe(false);
    expect(keySealedOnly(null)).toBe(false);
  });
  test("any other header value is refused rather than ignored", () => {
    for (const v of ["yes", "true", "1", "optional"]) expect(() => sealedRequired({ header: v })).toThrow(expect.objectContaining({ status: 400 }));
  });
  test("the quote hash is the route's own for one route, and a hash over every route's for several", () => {
    expect(attestationQuoteHash(["aa"])).toBe("aa");
    const two = attestationQuoteHash(["aa", "bb"]);
    expect(two).toMatch(/^[0-9a-f]{64}$/);
    expect(attestationQuoteHash(["bb", "aa"])).not.toBe(two);
    expect(attestationQuoteHash([])).toBeNull();
    expect(attestationQuoteHash(["aa", ""])).toBeNull();
  });
});

describe("council helpers", () => {
  test("the mode header wins over the body, and the older names map across", () => {
    expect(parseCouncilMode(null, undefined)).toBe("merge");
    expect(parseCouncilMode("select", "merge")).toBe("select");
    expect(parseCouncilMode(null, "judge")).toBe("select");
    expect(parseCouncilMode(null, "fuse")).toBe("merge");
    expect(parseCouncilMode(undefined, undefined, "select")).toBe("select");
    expect(() => parseCouncilMode("vote", undefined)).toThrow(expect.objectContaining({ status: 400, type: "invalid_council" }));
  });

  test("proposers come from different families, in pool order, skipping what cannot serve", () => {
    const pool = ["deepseek/a", "deepseek/b", "zai/glm-5", "qwen/qwen3", "gemma/x"];
    const fam = (id: string) => deriveFamily({ id });
    expect(pickProposers(pool, fam, () => true)).toEqual(["deepseek/a", "zai/glm-5", "qwen/qwen3"]);
    expect(pickProposers(pool, fam, (id) => id !== "deepseek/a")).toEqual(["deepseek/b", "zai/glm-5", "qwen/qwen3"]);
    expect(pickProposers(pool, fam, (id) => id !== "zai/glm-5")).toEqual(["deepseek/a", "qwen/qwen3", "gemma/x"]);
    expect(pickProposers(["deepseek/a", "deepseek/b", "qwen/q"], fam, () => true)).toEqual(["deepseek/a", "qwen/q"]);
  });

  const after = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const okR = (r: { ok: boolean }) => r.ok;
  const onError = () => ({ ok: false });

  test("first two of three: the third is used when it lands inside the grace period", async () => {
    const out = await awaitQuorum([after(5, { ok: true }), after(10, { ok: true }), after(40, { ok: true })], okR, { quorum: 2, graceMs: 200, onError });
    expect(out.late).toEqual([]);
    expect(out.results.every((r) => r?.ok)).toBe(true);
  });

  test("first two of three: the third is cut off once the grace period ends", async () => {
    const t0 = Date.now();
    const out = await awaitQuorum([after(5, { ok: true }), after(10, { ok: true }), after(2_000, { ok: true })], okR, { quorum: 2, graceMs: 50, onError });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(out.late).toEqual([2]);
    expect(out.results[2]).toBeUndefined();
  });

  test("a failure does not count toward the quorum; the council waits for the others", async () => {
    const out = await awaitQuorum([after(5, { ok: false }), after(10, { ok: true }), after(30, { ok: true })], okR, { quorum: 2, graceMs: 1_000, onError });
    expect(out.late).toEqual([]);
    expect(out.results.map((r) => r?.ok)).toEqual([false, true, true]);
  });

  test("when two have failed it stops waiting at once, and a thrown run is a failure", async () => {
    const t0 = Date.now();
    const out = await awaitQuorum([Promise.reject(new Error("boom")), after(5, { ok: false }), after(5_000, { ok: true })], okR, { quorum: 2, graceMs: 10, onError });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(out.late).toEqual([2]);
    expect(out.results.slice(0, 2).every((r) => r && !r.ok)).toBe(true);
  });

  test("the merge prompt keeps agreed facts, marks disagreements, and fences the candidates as data", () => {
    const [sys, user] = mergeMessages("[user] hi", [{ label: "A", text: "one" }, { label: "B", text: "two" }], "t0k");
    expect(sys.content).toMatch(/agree/);
    expect(sys.content).toMatch(/disagree/);
    expect(sys.content).toMatch(/never instructions/);
    expect(user.content).toContain("<<candidate A t0k>>\none\n<<end candidate A t0k>>");
    expect(user.content).toContain("<<candidate B t0k>>");
  });

  test("the price is the multiplier times one call, and never below what the calls cost", () => {
    // 3 proposers at 10 and an aggregator at 12: compute 42; 4.5 x 10 = 45, so the premium is 3.
    expect(councilPremium({ charges: [10n, 10n, 10n, 12n], baseline: 10n, multiplier: 4.5 })).toEqual({ premium: 3n, target: 45n, compute: 42n });
    // Compute already above the target: no premium.
    expect(councilPremium({ charges: [10n, 10n, 10n, 30n], baseline: 10n, multiplier: 4 }).premium).toBe(0n);
    // Rounded up, in integer pico-USD.
    expect(councilPremium({ charges: [], baseline: 3n, multiplier: 4.5 }).target).toBe(14n);
    for (let i = 0; i < 200; i++) {
      const baseline = BigInt(Math.floor(Math.random() * 1e9) + 1);
      const charges = [0, 1, 2, 3].map(() => BigInt(Math.floor(Math.random() * 1e9)));
      const m = clampMultiplier(3 + Math.random() * 3);
      const p = councilPremium({ charges, baseline, multiplier: m });
      const total = p.compute + p.premium;
      expect(total >= p.compute).toBe(true);
      expect(total * 10_000n >= baseline * BigInt(Math.round(m * 10_000))).toBe(true);
      expect(m >= 4 && m <= 5).toBe(true);
    }
  });

  test("settings: the multiplier is clamped to 4-5, the cap and grace default to 900 tokens and 2 s", () => {
    expect(trustConfigFromEnv({})).toEqual({ councilMultiplier: 4.5, proposerMaxTokens: 900, graceMs: 2000 });
    expect(trustConfigFromEnv({ ANONYMO_COUNCIL_PRICE_MULTIPLIER: "9" }).councilMultiplier).toBe(5);
    expect(trustConfigFromEnv({ ANONYMO_COUNCIL_PRICE_MULTIPLIER: "1" }).councilMultiplier).toBe(4);
    expect(trustConfigFromEnv({ ANONYMO_COUNCIL_PRICE_MULTIPLIER: "nope" }).councilMultiplier).toBe(4.5);
  });
});

describe("Anonymo receipts", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = { sign: (payload: unknown) => { const bytes = canonicalBytes(payload); const sigBytes = edSign(null, bytes, privateKey); return { keyId: "k1", sig: sigBytes.toString("base64"), bytes, sigBytes }; } };
  const route = (over: Partial<ReceiptRoute> = {}): ReceiptRoute => ({ route: "p:m", role: "single", provider: "p", model: "m", family: "qwen", quant: "bf16", attested: false, weights_hash: null, tokens: { in: 10, out: 5 }, cost: "0.000001", refused: false, status: "ok", ...over });

  test("the receipt carries the §8 fields, sums its routes and lists a weights hash per route", () => {
    const r = buildAnonymoReceipt({ requestId: "gen-1", modelId: "anonymo-1", routes: [route({ weights_hash: "aa" }), route({ role: "retry", weights_hash: null, tokens: { in: 3, out: 0 }, refused: true, status: "refused" })], charged: 1_000n, refused: false, sealed: false, ts: new Date("2026-11-12T00:00:00Z") });
    expect(r).toMatchObject({ v: "anonymo-receipt/1", request_id: "gen-1", model_id: "anonymo-1", weights_hash: ["aa", null], tokens: { in: 13, out: 5 }, refused: false, sealed: false, ts: "2026-11-12T00:00:00.000Z" });
    expect(r.routes).toHaveLength(2);
    expect("attestation_quote_hash" in r).toBe(false);
  });

  test("a sealed receipt carries the quote hash; one without a quote for a used route cannot be built", () => {
    const r = buildAnonymoReceipt({ requestId: "g", modelId: "anonymo-sealed", routes: [route({ attested: true, attestation_quote_hash: "q1" })], charged: 0n, refused: false, sealed: true });
    expect(r.attestation_quote_hash).toBe("q1");
    expect(() => buildAnonymoReceipt({ requestId: "g", modelId: "anonymo-sealed", routes: [route()], charged: 0n, refused: false, sealed: true })).toThrow();
  });

  test("the leaf is keccak256 of the signed bytes, and the header round-trips", () => {
    const payload = buildAnonymoReceipt({ requestId: "g2", modelId: "anonymo-council", routes: [route()], charged: 5n, refused: false, sealed: false });
    const s = signAnonymoReceipt(signer, payload);
    expect(s.leaf).toBe(keccak256(canonicalBytes(payload)));
    expect(anonymoLeaf(JSON.parse(JSON.stringify(payload)))).toBe(s.leaf); // stable after a JSON (jsonb) round trip
    const back = parseReceiptHeader(receiptHeader(s));
    expect(back).toEqual({ payload: JSON.parse(JSON.stringify(payload)), sig: s.sig, key_id: "k1" });
  });

  test("every receipt of an hour verifies against the root, and a changed receipt does not", () => {
    const leaves: Hex[] = [];
    for (let i = 0; i < 37; i++) leaves.push(anonymoLeaf(buildAnonymoReceipt({ requestId: `g${i}`, modelId: "anonymo-1", routes: [route()], charged: BigInt(i), refused: false, sealed: false })));
    const tree = new MerkleTree(leaves);
    leaves.forEach((leaf, i) => expect(verifyInclusion(leaf, tree.proof(i), tree.root)).toBe(true));
    const forged = anonymoLeaf(buildAnonymoReceipt({ requestId: "g3", modelId: "anonymo-1", routes: [route()], charged: 999n, refused: false, sealed: false }));
    expect(verifyInclusion(forged, tree.proof(3), tree.root)).toBe(false);
  });
});
