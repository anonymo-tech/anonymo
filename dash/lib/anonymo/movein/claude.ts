// Claude's data export (`conversations.json`): a list of conversations, each with `chat_messages` in order. A message
// has a `sender` ("human" or "assistant") and its `text`; newer exports also carry `content`, a list of blocks, where
// only the "text" blocks are what was said (the rest is reasoning and tool traffic). The account file (`users.json`)
// is never opened.

import { ASSISTANT_PROMPT } from './chatgpt.ts';
import { isObj, parseWhen, shortId, text, type FoundCharacter, type FoundChat, type FoundMessage } from './types.ts';

export const CLAUDE_NAME = 'Claude';

/** True for one element of `conversations.json`. */
export const detectClaudeConversation = (item: unknown): item is Record<string, unknown> => isObj(item) && Array.isArray(item.chat_messages);

function messageText(message: Record<string, unknown>): string {
  if (Array.isArray(message.content)) {
    const said = message.content.filter((block) => isObj(block) && block.type === 'text').map((block) => text((block as Record<string, unknown>).text).trim());
    if (said.some(Boolean)) return said.filter(Boolean).join('\n\n');
  }
  return text(message.text).trim();
}

/** One conversation. Null when it holds no readable message. */
export function parseClaudeConversation(item: Record<string, unknown>): FoundChat | null {
  const messages: FoundMessage[] = [];
  for (const raw of item.chat_messages as unknown[]) {
    if (!isObj(raw)) continue;
    const role = raw.sender === 'human' ? 'user' : raw.sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const body = messageText(raw);
    if (!body) continue;
    const at = parseWhen(raw.created_at);
    messages.push({ role, text: body, ...(at !== undefined ? { at } : {}) });
  }
  if (!messages.length) return null;
  const createdAt = parseWhen(item.created_at) ?? messages[0]!.at;
  const updatedAt = parseWhen(item.updated_at) ?? messages[messages.length - 1]!.at;
  return {
    source: 'claude',
    key: text(item.uuid) || shortId(`${text(item.name)}\n${createdAt ?? ''}\n${messages[0]!.text.slice(0, 200)}`),
    title: text(item.name).trim() || 'Untitled chat',
    character: CLAUDE_NAME,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    messages,
  };
}

/** True for the export's `memories.json`: what Claude had written down about the person. */
export const detectClaudeMemories = (value: unknown): boolean => {
  const first = Array.isArray(value) ? value[0] : value;
  return isObj(first) && typeof first.conversations_memory === 'string';
};

/** The memory text of `memories.json`, if the export has one. */
export function parseClaudeMemories(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  return isObj(first) ? text(first.conversations_memory).trim() : '';
}

/** The character every Claude chat moves in under. */
export function claudeCharacter(memory = ''): FoundCharacter {
  return {
    source: 'claude',
    name: CLAUDE_NAME,
    description: '',
    systemPrompt: ASSISTANT_PROMPT,
    ...(memory ? { memory: { summary: memory } } : {}),
  };
}
