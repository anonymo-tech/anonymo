// Use confirmed, spendable credit to choose the next task. A failed balance read is its own state.
export function workspaceStage(
  hasKey: boolean,
  available: number | null,
  hasReceipts: boolean,
) {
  if (!hasKey) return 'key';
  if (available === null || !Number.isFinite(available)) return 'unknown';
  if (available <= 0) return 'funds';
  return hasReceipts ? 'returning' : 'first-chat';
}
