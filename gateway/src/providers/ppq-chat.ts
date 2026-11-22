// Canonical PPQ offerings approved for Regular Chat. PPQ marks eleven as uncensored and
// explicitly names the legacy Dolphin offering "Venice: Uncensored" in its public chat catalogue.
// Source: https://api.ppq.ai/v1/models?type=chat (2026-11-22).
// Prices, availability and supported parameters continue to come from the live registry.
// PPQ's client-encrypted private/* protocol is separate, including from the two Venice e2ee-named IDs.
export const PPQ_CHAT_MODELS: readonly Readonly<{ id: string; name: string; privacyLevel: "anon" | "zdr" }>[] = [
  { id: "cognitivecomputations/dolphin-mistral-24b-venice-edition", name: "Venice: Uncensored", privacyLevel: "zdr" },
  { id: "venice/abliteration-abliterated-model-large-flash", name: "Abliterated Large Flash (DeepSeek V4.1 Flash)", privacyLevel: "anon" },
  { id: "venice/abliteration-abliterated-model-large-v2", name: "Abliterated Large V2 (GLM-5.3)", privacyLevel: "anon" },
  { id: "venice/deepseek-v4-1-flash-1017-uncensored", name: "DeepSeek V4.1 Flash 1017 Uncensored", privacyLevel: "zdr" },
  { id: "venice/deepseek-v4-1-flash-uncensored", name: "DeepSeek V4.1 Flash Uncensored", privacyLevel: "zdr" },
  { id: "venice/e2ee-deepseek-v4-1-flash-1017-abliterated", name: "DeepSeek V4.1 Flash 1017 Abliterated", privacyLevel: "zdr" },
  { id: "venice/e2ee-gemma-4-26b-a4b-uncensored-p", name: "Gemma 4 26B A4B Uncensored", privacyLevel: "zdr" },
  { id: "venice/gemma-4-uncensored", name: "Gemma 4 Uncensored", privacyLevel: "zdr" },
  { id: "venice/glm-5-3-flash-uncensored", name: "GLM 5.3 Flash Uncensored", privacyLevel: "zdr" },
  { id: "venice/olafangensan-glm-4.7-flash-heretic", name: "GLM 4.7 Flash Heretic", privacyLevel: "zdr" },
  { id: "venice/venice-uncensored-1-2", name: "Venice Uncensored 1.2", privacyLevel: "zdr" },
  { id: "venice/venice-uncensored-role-play", name: "Venice Role Play Uncensored", privacyLevel: "zdr" },
];

const modelsById = new Map(PPQ_CHAT_MODELS.map((model) => [model.id, model]));

/** Exact upstream identity only; an approved name alone does not establish a provider, offer or privacy level. */
export function ppqChatModel(id: string) {
  return modelsById.get(id);
}
