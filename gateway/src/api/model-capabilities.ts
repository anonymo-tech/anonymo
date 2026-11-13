import type { Ctx } from "../context.ts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { deriveCapabilities } from "../catalog/model-capabilities.js";
import { attestationFresh } from "../router/select.ts";

/** Public catalogue metadata only: no request content, addresses, new storage or logs. */
export function capabilityJson(ctx: Ctx, model: ModelRow, offers: Candidate[]) {
  const fresh = (offer: Candidate) => attestationFresh(offer, ctx.cfg.attestation.intervalMs * 3, true);
  return { provider_names: [...new Set(offers.map(o => o.provider.name))].sort(), capabilities: deriveCapabilities({
    architecture: { input_modalities: (model.arch as { input_modalities?: string[] } | null)?.input_modalities ?? ["text"], output_modalities: (model.arch as { output_modalities?: string[] } | null)?.output_modalities ?? ["text"] }, context_length: model.ctx,
    supported_parameters: [...new Set(offers.flatMap(o => o.supportedParameters ?? []))],
    attested_available: offers.some(fresh),
  }) };
}

/** The offers the catalogue lists for a model. */
export function catalogOffers(ctx: Ctx, model: ModelRow): Candidate[] {
  return ctx.catalog.offers(model.id);
}
