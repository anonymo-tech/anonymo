import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { quantCanaryApplies, runCanaries } from "../src/services/canaries.ts";
import { canaries, health } from "../src/db/schema.ts";

// Quant canaries only run where they can find something: a relay reselling a whole third-party catalogue declares no
// precision and attests nothing, so its models are skipped (they only timed out and dragged the public probe figure down).

const provider = (p: Partial<{ status: string; attested: boolean; teeKind: string | null }>) =>
  ({ status: "live", attested: false, teeKind: null, ...p }) as unknown as Parameters<typeof quantCanaryApplies>[0]["provider"];

describe("quant canary scope", () => {
  test("skips unknown precision on a live, unattested, non-TEE provider", () => {
    expect(quantCanaryApplies({ quant: "unknown", provider: provider({}) })).toBe(false);
    expect(quantCanaryApplies({ quant: "UNKNOWN", provider: provider({}) })).toBe(false);
  });

  test("keeps declared precision, shadow onboarding, attested and TEE providers", () => {
    expect(quantCanaryApplies({ quant: "bf16", provider: provider({}) })).toBe(true);
    expect(quantCanaryApplies({ quant: "unknown", provider: provider({ status: "shadow" }) })).toBe(true);
    expect(quantCanaryApplies({ quant: "unknown", provider: provider({ attested: true }) })).toBe(true);
    expect(quantCanaryApplies({ quant: "unknown", provider: provider({ teeKind: "tdx" }) })).toBe(true);
  });
});

describe("runCanaries leaves a relay catalogue alone", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startRouter({
      providers: [
        { id: "declared", name: "Declared", models: [MODELS.llama] },
        { id: "relay", name: "Relay", models: [{ ...MODELS.llama, quant: "unknown" }] },
      ],
    });
    await h.ctx.catalog.refresh();
  });
  afterAll(async () => h.close());

  test("no calls, no canary rows and no health rows for the relay", async () => {
    const r = await runCanaries(h.ctx);
    expect(r.results.map((x) => x.provider)).toEqual(["declared"]);
    await h.ctx.health.flush(h.ctx.db);
    expect(await h.ctx.db.select().from(canaries).where(eq(canaries.providerId, "relay"))).toHaveLength(0);
    expect((await h.ctx.db.select().from(health).where(eq(health.providerId, "relay"))).filter((x) => x.source === "canary")).toHaveLength(0);
  });
});
