// ChatGPT's data export (`conversations.json`, or `conversations-000.json` and so on in a large export): a list of
// conversations. Each one keeps every branch of the chat in `mapping`, a tree of nodes `{ id, message, parent }`
// (older exports also list `children`); `current_node` is the leaf of the branch that was on screen last. Following
// `parent` from that leaf back to the root gives the thread the person last saw.
//
// Only what the person typed and what the assistant answered them is kept: tool calls, tool output, hidden system
// lines and reasoning are left out. The account file (`user.json`) is never opened.

import { isObj, shortId, text, type FoundChat, type FoundCharacter, type FoundMessage } from './types.ts';

type Node = { message?: unknown; parent?: unknown };

/** True for one element of `conversations.json`. */
export const detectChatGptConversation = (item: unknown): item is Record<string, unknown> => isObj(item) && isObj(item.mapping) && ('current_node' in item || 'conversation_id' in item || 'create_time' in item);

/** A node and its ancestors, oldest first. A loop in the parents ends the walk instead of hanging it. */
function pathTo(mapping: Record<string, unknown>, leaf: string | null): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  for (let id: string | null = leaf; id && !seen.has(id); ) {
    const node = mapping[id] as Node | undefined;
    if (!isObj(node)) break;
    seen.add(id);
    path.push(id);
    id = typeof node.parent === 'string' ? node.parent : null;
  }
  return path.reverse();
}

/** The node ids of the thread last shown, oldest first. */
export function threadOf(mapping: Record<string, unknown>, currentNode: unknown): string[] {
  if (typeof currentNode === 'string' && isObj(mapping[currentNode])) return pathTo(mapping, currentNode);
  // No usable `current_node`: take the leaf whose message is newest, and of two equally new the longer thread.
  // Exports since late 2026 list no `children`, so a leaf is a node that no other node names as its parent.
  const parents = new Set<string>();
  for (const node of Object.values(mapping)) if (isObj(node) && typeof node.parent === 'string') parents.add(node.parent);
  let best: string[] = [];
  let newest = -Infinity;
  for (const [id, node] of Object.entries(mapping)) {
    if (!isObj(node) || parents.has(id)) continue;
    const at = isObj(node.message) && typeof node.message.create_time === 'number' ? node.message.create_time : 0;
    if (at < newest) continue;
    const path = pathTo(mapping, id);
    if (at > newest || path.length > best.length) {
      newest = at;
      best = path;
    }
  }
  return best;
}

/** The readable text of a message's content: plain parts, and what was said aloud in a voice chat. */
function contentText(content: unknown): string {
  if (!isObj(content)) return '';
  const type = text(content.content_type);
  if (type !== 'text' && type !== 'multimodal_text') return '';
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((part) => (typeof part === 'string' ? part : isObj(part) && part.content_type === 'audio_transcription' ? text(part.text) : ''))
    .filter((part) => part.trim())
    .join('\n')
    .trim();
}

/** What the person set under "customize ChatGPT", as the export carries it inside each conversation. */
export type ChatGptSetup = { aboutModel?: string; aboutUser?: string; saved?: string[] };

export const emptyChatGptSetup = () => ({ setup: {} as ChatGptSetup, at: -1 });

export function latestChatGptSetup(current: ReturnType<typeof emptyChatGptSetup>, parsed: ReturnType<typeof parseChatGptConversation>) {
  const { chat, setup } = parsed;
  const at = chat?.updatedAt ?? chat?.createdAt ?? 0;
  return (setup.aboutModel || setup.aboutUser || setup.saved) && at >= current.at
    ? { setup: { ...current.setup, ...setup }, at }
    : current;
}

const unfence = (value: string) => {
  const fenced = /```([\s\S]*?)```/.exec(value);
  return (fenced ? fenced[1]! : value).trim();
};

function setupOf(message: Record<string, unknown>, into: ChatGptSetup) {
  const content = isObj(message.content) ? message.content : {};
  const meta = isObj(message.metadata) ? message.metadata : {};
  if (content.content_type === 'user_editable_context') {
    const data = isObj(meta.user_context_message_data) ? meta.user_context_message_data : {};
    const model = text(data.about_model_message).trim() || unfence(text(content.user_instructions));
    const user = text(data.about_user_message).trim() || unfence(text(content.user_profile));
    if (model) into.aboutModel = model;
    if (user) into.aboutUser = user;
  }
  if (content.content_type === 'model_editable_context') {
    // Saved memories arrive as one numbered text: "1. [2025-03-01]. Prefers short answers."
    const saved = text(content.model_set_context)
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\d+\.\s*/, '').replace(/^\[[^\]]{0,24}\]\.?\s*/, '').trim())
      .filter(Boolean);
    if (saved.length) into.saved = saved;
  }
}

/** One conversation's last-shown thread, plus any setup text it carried. Null when it holds no readable message. */
export function parseChatGptConversation(item: Record<string, unknown>): { chat: FoundChat | null; setup: ChatGptSetup } {
  const mapping = item.mapping as Record<string, unknown>;
  const messages: FoundMessage[] = [];
  const setup: ChatGptSetup = {};
  for (const id of threadOf(mapping, item.current_node)) {
    const message = (mapping[id] as Node).message;
    if (!isObj(message)) continue;
    setupOf(message, setup);
    const role = isObj(message.author) ? message.author.role : null;
    if (role !== 'user' && role !== 'assistant') continue;
    // An assistant line addressed to a tool is a tool call, not a reply to the person.
    if (role === 'assistant' && typeof message.recipient === 'string' && message.recipient !== 'all') continue;
    const meta = isObj(message.metadata) ? message.metadata : {};
    if (meta.is_visually_hidden_from_conversation === true) continue;
    const body = contentText(message.content);
    if (!body) continue;
    const at = typeof message.create_time === 'number' && message.create_time > 0 ? Math.round(message.create_time * 1000) : undefined;
    messages.push({ role, text: body, ...(at !== undefined ? { at } : {}) });
  }
  if (!messages.length) return { chat: null, setup };
  const id = text(item.conversation_id) || text(item.id);
  const createdAt = typeof item.create_time === 'number' ? Math.round(item.create_time * 1000) : messages[0]!.at;
  const updatedAt = typeof item.update_time === 'number' ? Math.round(item.update_time * 1000) : messages[messages.length - 1]!.at;
  return {
    chat: {
      source: 'chatgpt',
      key: id || shortId(`${text(item.title)}\n${createdAt ?? ''}\n${messages[0]!.text.slice(0, 200)}`),
      title: text(item.title).trim() || 'Untitled chat',
      character: CHATGPT_NAME,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      messages,
    },
    setup,
  };
}

export const CHATGPT_NAME = 'ChatGPT';

/** How an assistant that came from another app is told to carry on here. */
export const ASSISTANT_PROMPT =
  'You are an AI on Anonymo, continuing conversations {{user}} brought over from {{char}}. Carry on as the same helpful assistant: direct, clear and consistent with what you already know about them. You are not {{char}} itself; if asked, say you are an AI on Anonymo that has their earlier chats.';

/**
 * The character every ChatGPT chat moves in under. How it was asked to respond becomes the card; what the person told
 * it about themselves and what it had saved become memory patches, where they can be edited or deleted.
 */
export function chatGptCharacter(setup: ChatGptSetup): FoundCharacter {
  const facts = [...(setup.aboutUser ? [`About you, from your ChatGPT settings: ${setup.aboutUser}`] : []), ...(setup.saved ?? [])];
  return {
    source: 'chatgpt',
    name: CHATGPT_NAME,
    description: setup.aboutModel ? `How ${CHATGPT_NAME} was asked to respond:\n${setup.aboutModel}` : '',
    systemPrompt: ASSISTANT_PROMPT,
    ...(facts.length ? { memory: { facts } } : {}),
  };
}
