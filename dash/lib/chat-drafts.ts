/** Appending an action must never erase an unsent draft. */
export function appendChatDraft(current: string, addition: string) {
  return `${current}${current ? '\n\n' : ''}${addition}`;
}
export function quotedReplyDraft(current: string, model: string, quote: string) {
  return appendChatDraft(current, `About this passage from ${model}:\n${quote.split('\n').map(line => `> ${line}`).join('\n')}\n\n`);
}
