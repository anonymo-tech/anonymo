import { expect, test } from "bun:test";
import { Hono } from "hono";
import { capabilityJson } from "../src/api/model-capabilities.ts";
import { modelsRoutes } from "../src/api/models.ts";
import { loadConfig } from "../src/config.ts";
import type { Ctx } from "../src/context.ts";
import type { Candidate, ModelRow } from "../src/catalog/catalog.ts";
const PHALA_PROVIDER = "phala";

const model = { id: "sample/model", name: "Sample model", hidden: false, ctx: 128000, createdUnix: 1, arch: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] } } as ModelRow;
function fixture() {
  const offer = { modelId: model.id, providerId: PHALA_PROVIDER, providerModelId: model.id, status: "live", pricePrompt: 1n, priceCompletion: 2n, priceRequest: 0n, priceImage: 0n, priceWebSearch: 0n, priceReasoning: 0n, supportedParameters: ["tools", "max_tokens", "stream"], provider: {
    id: PHALA_PROVIDER, name: "Confidential gateway", status: "live", teeKind: "tdx", attested: true, attestedAt: new Date(), attestationHash: "fresh-evidence", attestationUrl: "https://gateway.example/attestation", baseUrl: "https://gateway.example/v1", apiKeyEnc: "fixture-encrypted-value",
  } } as unknown as Candidate;
  const cfg = loadConfig({});
  const ctx = { cfg, health: { outage: () => false, uptime30d: () => 1, quality: () => 1, stats: () => null }, catalog: {
    providers: new Map([[PHALA_PROVIDER, offer.provider]]), models: new Map([[model.id, model]]), offers: () => [offer], ensureFresh: async () => {},
    disclosure: new Map([[PHALA_PROVIDER, { retention: "attested", legalHold: false, updatedAt: new Date() }]]), manifests: new Map(), lane: new Map(),
    laneOf: () => ({ variant: "mainstream", servable: true, source: "default" }),
  } } as unknown as Ctx;
  return { ctx, offer };
}

test("both public model endpoints retain fields and add the same capability and provider arrays", async () => {
  const { ctx } = fixture();
  const app = new Hono(); modelsRoutes(app, ctx);
  const get = async (path: string) => {
    const response = await app.request(path); expect(response.status).toBe(200); return (await response.json()).data[0];
  };
  const first = await get("/api/v1/models");
  expect(await get("/v1/models")).toEqual(first);
  expect(first).toMatchObject({ id: model.id, context_length: 128000, architecture: model.arch, pricing: { prompt: "0.000000000001", completion: "0.000000000002" }, supported_parameters: ["max_tokens", "stream", "tools"], provider_names: ["Confidential gateway"] });
  expect(first.capabilities).toEqual(["vision", "imageOut", "tools", "longContext", "attested"]);
});

