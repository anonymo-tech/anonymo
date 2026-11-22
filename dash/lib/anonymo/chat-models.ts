import { ANONYMO_MODEL_IDS, type AnonymoModelId, type ModelInfo } from './types.ts';

export const isAnonymoModel = (id: string): id is AnonymoModelId => (ANONYMO_MODEL_IDS as readonly string[]).includes(id);
const separateProtocol = /(?:^|[/:._-])(?:embed(?:ding)?s?|rerank(?:er)?|guard|safeguard|moderation|classifier|whisper|transcri(?:be|ption)|tts|asr)(?:$|[/:._-])/i;

export function publishedPpqChat(m: ModelInfo): boolean {
  return m.anonymo_chat?.source === 'ppq' && m.anonymo_chat.standard_chat === true && m.anonymo_chat.category === 'uncensored';
}
export const uncensoredChatModel = (m: ModelInfo): boolean => publishedPpqChat(m) || m.ppq_uncensored === true || m.variant === 'abliterated' || m.variant === 'native_low_refusal';
export const chatModelName = (m: ModelInfo): string => (publishedPpqChat(m) && m.anonymo_chat?.name?.trim()) || m.name?.trim() || m.id;

/** /v1/models applies route eligibility. Media and separate-protocol transports cannot run from a text composer. */
export function chatModels(rows: readonly ModelInfo[]): ModelInfo[] {
  return rows.filter(m => {
    if (typeof m.id !== 'string' || isAnonymoModel(m.id) || m.id === 'anonymo-auto' || m.id.startsWith('private/') || separateProtocol.test(m.id)) return false;
    if (/(?:^|[/:._-])(?:e2ee|e2e)(?:$|[/:._-])/i.test(m.id) && !publishedPpqChat(m)) return false;
    const architecture = m.architecture;
    return architecture ? architecture.input_modalities?.includes('text') && architecture.output_modalities?.length === 1 &&
      architecture.output_modalities[0] === 'text' : publishedPpqChat(m);
  });
}

export function searchChatModels(models: readonly ModelInfo[], search: string): readonly ModelInfo[] {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? models.filter(m => {
    const text = `${chatModelName(m)} ${m.name ?? ''} ${m.id} ${m.family ?? ''} ${uncensoredChatModel(m) ? 'uncensored' : ''}`.toLowerCase();
    return terms.every(term => text.includes(term));
  }) : models;
}
