// The Anonymo services every request can reach through ctx.anonymo. Each workstream swaps its stub for the real
// implementation here (WS02 the floor gate, WS03 the refusal classifier). Tests inject their own through
// createApp({ anonymo }) or by assigning ctx.anonymo.* on a running harness.

import { createFloorGate } from "./floor/gate.ts";
import { defaultRefusalClassifier } from "./refusal/classifier.ts";
import { type FloorGate, type FloorInput, type RefusalClassifier } from "./seams.ts";

export type AnonymoServices = {
  floor: FloorGate;
  refusal: RefusalClassifier;
};

export function createAnonymoServices(env: Record<string, unknown>, overrides: Partial<AnonymoServices> = {}): AnonymoServices {
  return {
    floor: overrides.floor ?? createFloorGate(env), // WS02: ANONYMO_FLOOR_URL selects the guard model; REQUIRED without it fails closed
    refusal: overrides.refusal ?? defaultRefusalClassifier(env), // WS03: phrase rules, plus the small model at ANONYMO_REFUSAL_URL
  };
}

type Part = { type?: unknown; text?: unknown };
const UPLOAD_PARTS = new Set(["image_url", "input_image", "input_audio", "file", "image", "audio"]);

/** What the floor gate reads from a chat or completions body: every text the caller sent, and whether it carried media. */
export function floorInputOf(body: Record<string, unknown>): FloorInput {
  const texts: string[] = [];
  let hasUpload = false;
  const take = (content: unknown) => {
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content))
      for (const p of content as Part[]) {
        if (typeof p?.text === "string") texts.push(p.text);
        if (typeof p?.type === "string" && UPLOAD_PARTS.has(p.type)) hasUpload = true;
      }
  };
  if (Array.isArray(body.messages)) for (const m of body.messages as { content?: unknown }[]) take(m?.content);
  take(body.prompt);
  if (typeof body.system === "string") texts.push(body.system);
  return { text: texts.join("\n"), modality: "text", hasUpload };
}
