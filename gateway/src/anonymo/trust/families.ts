// Model family of a route: what the council needs three different ones of, and what the manifest lists.
//
// The route record's `family` (WS04) wins; for any route that leaves it blank the family is derived from the model id,
// name and repository through anonymo/models.ts's single family table (WS01). Reading is defensive on purpose: the field is taken from
// the offer first, then the model, and only a non-empty string counts.

import { familyFromName } from "../models.ts";

type Named = { id: string; name?: string | null; hfRepo?: string | null };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

/** The family a model id or name implies, or the author part of the id when no known family matches. */
export function deriveFamily(m: Named): string {
  const known = familyFromName([m.id, m.name ?? "", m.hfRepo ?? ""].join(" "));
  if (known) return known;
  const slash = m.id.indexOf("/");
  return (slash > 0 ? m.id.slice(0, slash) : m.id).toLowerCase();
}

/** The family of a route: the route record's own field when it has one (WS04), else derived from the model. */
export function familyOf(model: Named & { family?: unknown }, offer?: { family?: unknown } | null): string {
  return str(offer?.family) ?? str(model.family) ?? deriveFamily(model);
}

/** sha256 of the served weights, from the route record when it has one (WS04), else null. Never invented. */
export function weightsHashOf(offer: Record<string, unknown> | null | undefined, model?: Record<string, unknown> | null): string | null {
  const pick = (o: Record<string, unknown> | null | undefined) => (o ? str(o.weightsHash) ?? str(o.weights_hash) : null);
  return pick(offer) ?? pick(model ?? null);
}
