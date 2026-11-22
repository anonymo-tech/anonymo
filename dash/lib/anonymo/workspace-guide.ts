// A connected key can open chat even when its prepaid balance is zero.
export function workspaceStage(hasKey: boolean, hasReceipts: boolean) {
  if (!hasKey) return 'key';
  return hasReceipts ? 'returning' : 'first-chat';
}
