// WS03 · which model family a route belongs to, so a refused attempt is retried on a different family (Backend §5).
//
// The route record's `family` field (WS04) wins when present (on the offer, the provider, the model row or the model's
// `arch`); otherwise the family is derived, through anonymo/models.ts's single table, from the base model the operator
// declared or from the model slug. Fine-tunes and abliterated variants count as their base family, since
// they tend to share their base's refusals.

import type { Candidate, ModelRow } from "../../catalog/catalog.ts";
import { familyFromName } from "../models.ts";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

/** The family table is anonymo/models.ts (one source for the router, WS01). Re-exported for existing callers. */
export { familyFromName };

/**
 * The family of a route. Read in order: an explicit `family` on the offer, provider, model row or `arch` (WS04),
 * then the declared base model (models_lane.base_model), then the model id. Unknown models count as a family of
 * their own author, so two unknown models of the same author are never treated as different families.
 */
export function familyOf(model: ModelRow, candidate?: Candidate | null, baseModel?: string | null): string {
  const explicit =
    str((candidate as { family?: unknown } | null | undefined)?.family) ??
    str((model as { family?: unknown }).family) ??
    str((model.arch as { family?: unknown } | null)?.family);
  if (explicit) return explicit;
  return (baseModel ? familyFromName(baseModel) : null) ?? familyFromName(model.id) ?? familyFromName(model.name ?? "") ?? `author:${(model.author || model.id.split("/")[0] || model.id).toLowerCase()}`;
}
