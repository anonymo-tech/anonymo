// Everyone can open chat. The overview changes its guidance as they get started.
export function workspaceStage(hasKey: boolean, hasReceipts: boolean) {
  if (!hasKey) return 'key';
  return hasReceipts ? 'returning' : 'first-chat';
}
