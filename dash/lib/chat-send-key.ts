export type ChatSendKey = 'enter' | 'modifier';
export const validChatSendKey = (value: unknown): value is ChatSendKey => value === 'enter' || value === 'modifier';
export function shouldSubmitChatKey(event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }, preference: ChatSendKey) {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) return false;
  return preference === 'enter' || event.ctrlKey || event.metaKey;
}
