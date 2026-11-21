import type { KeyRow } from "../../api/auth.ts";
import { CHARACTER_PREFIX, loadCharacter } from "../../characters/registry.ts";
import type { Ctx } from "../../context.ts";
import { fail } from "../../lib/errors.ts";
import { guardInferenceModels } from "../../provisioning/inference.ts";
import { PRESET_PREFIX, resolvePreset } from "../../routing/presets.ts";
import { ROUTE_PREFIX, findSavedRoute, resolveSavedRoute } from "../../routing/saved-routes.ts";
import { assertKeyPolicy, isSealedRequest, readKeyPolicy } from "./caps.ts";

export async function assertBatchSubmissionPolicy(
  ctx: Ctx,
  key: KeyRow,
  ip: string | null,
  lines: ReadonlyArray<{ body: Record<string, unknown> }>,
) {
  const policy = await readKeyPolicy(ctx.db, key.keyHash);
  await assertKeyPolicy(ctx.db, policy, {
    ip,
    sealed: policy?.sealedOnly === true && lines.every(({ body }) => isSealedRequest(body.model, undefined)),
  });

  const allowed = new Set(key.allowedModels ?? []);
  if (!allowed.size && key.scope !== "inference") return;
  if (allowed.size) await ctx.catalog.ensureFresh();
  const routing = key.routing as { aliases?: Record<string, { model: string; models?: string[] }> } | null;
  for (const { body } of lines) {
    const alias = routing?.aliases?.[String(body.model)];
    const model = alias?.model ?? body.model;
    const models = body.models ?? alias?.models;
    guardInferenceModels(key, { model, models });
    if (!allowed.size) continue;
    const request = { model, models };
    // Resolve only model identifiers here. The chat handler re-resolves the full request when it runs.
    let scopedModels: string[] = [];
    if (typeof model === "string" && model.startsWith(ROUTE_PREFIX)) {
      const slug = await resolveSavedRoute(ctx.db, key.accountId, request);
      if (slug && allowed.has(model)) {
        const route = await findSavedRoute(ctx.db, key.accountId, slug);
        scopedModels = (route?.config as { models?: string[] } | undefined)?.models ?? [];
      }
    } else if (typeof model === "string" && model.startsWith(PRESET_PREFIX)) {
      const preset = await resolvePreset(ctx.db, key.accountId, request);
      if (preset && allowed.has(`${PRESET_PREFIX}${preset.name}`)) scopedModels = preset.models;
    } else if (typeof model === "string" && model.startsWith(CHARACTER_PREFIX)) {
      const character = await loadCharacter(ctx, model.slice(CHARACTER_PREFIX.length));
      if (!character || (character.visibility === "private" && character.accountId !== key.accountId))
        fail(404, "The batch line's character is unavailable.", "character_not_found");
      request.model = (Array.isArray(models) && typeof models[0] === "string" ? models[0] : character.defaultModel);
    }
    const modelId = (id: unknown) => typeof id === "string" ? ctx.catalog.resolve(id)?.model.id ?? "" : "";
    const scopedIds = new Set(scopedModels.map(modelId).filter(Boolean));
    const candidates = [request.model, ...(Array.isArray(request.models) ? request.models : [])];
    if (!candidates.map(modelId).some((id) => allowed.has(id) || scopedIds.has(id)))
      fail(403, "A batch line requests no model allowed by this key.", "model_not_allowed");
  }
}
