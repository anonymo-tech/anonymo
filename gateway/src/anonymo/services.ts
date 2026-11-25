// The Anonymo services every request can reach through ctx.anonymo. Each workstream swaps its stub for the real
// implementation here (WS02 the floor gate, WS03 the refusal classifier). Tests inject their own through
// createApp({ anonymo }) or by assigning ctx.anonymo.* on a running harness.

import { createFloorGate } from "./floor/gate.ts";
import { defaultRefusalClassifier } from "./refusal/classifier.ts";
import { createWebSearch } from "./search/config.ts";
import type { WebSearchService } from "./search/types.ts";
import type { AgeProofVerifier } from "./region/age-proof.ts";
import { type FloorGate, type RefusalClassifier } from "./seams.ts";

export { floorInputOf } from "./floor/input.ts";

export type AnonymoServices = {
  floor: FloorGate;
  refusal: RefusalClassifier;
  /** Private Web Search (src/anonymo/search/): the engine from ANONYMO_WEB_SEARCH, or null when it is not set up. */
  search?: WebSearchService | null;
  ageProofVerifier?: AgeProofVerifier;
};

export function createAnonymoServices(env: Record<string, unknown>, overrides: Partial<AnonymoServices> = {}): AnonymoServices {
  return {
    floor: overrides.floor ?? createFloorGate(env), // WS02: ANONYMO_FLOOR_URL selects the guard model; REQUIRED without it fails closed
    refusal: overrides.refusal ?? defaultRefusalClassifier(env), // WS03: phrase rules, plus the small model at ANONYMO_REFUSAL_URL
    search: overrides.search !== undefined ? overrides.search : createWebSearch(env), // Private Web Search: ANONYMO_WEB_SEARCH
    ageProofVerifier: overrides.ageProofVerifier,
  };
}
