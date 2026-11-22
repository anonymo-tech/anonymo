import type { Candidate } from "../catalog/catalog.ts";
import { ppqChatModel } from "../providers/ppq-chat.ts";
import { isRestricted, type ModelLane } from "./lane.ts";

type OfferIdentity = Pick<Candidate, "provider"> & Partial<Pick<Candidate, "modelId" | "providerModelId" | "upstream">>;

/** The public picker and the send path use the observed upstream weight and actual service destination. */
export function ordinaryPpqTransport(o: OfferIdentity) {
  const reviewed = o.providerModelId && ppqChatModel(o.providerModelId);
  if (!reviewed) return undefined;
  try {
    const url = new URL(o.provider.baseUrl);
    if (url.origin === "https://api.ppq.ai" && !url.username && !url.password && !url.search && !url.hash &&
        (url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/")) return reviewed;
  } catch { /* Invalid provider URL. */ }
  return undefined;
}

export function regularPpqOffer(o: OfferIdentity) {
  if (!o.modelId || !o.providerModelId || !o.provider.apiKeyEnc) return undefined;
  const direct = o.modelId === o.providerModelId;
  const pooled = (o.modelId === "anonymo-1" || o.modelId === "anonymo-council") && o.upstream === "ppq";
  return direct || pooled ? ordinaryPpqTransport(o) : undefined;
}

export function offerLane(model: ModelLane, weight?: ModelLane): ModelLane {
  return {
    variant: weight && isRestricted(weight.variant) ? weight.variant : model.variant,
    servable: model.servable && (weight?.servable ?? true),
  };
}
