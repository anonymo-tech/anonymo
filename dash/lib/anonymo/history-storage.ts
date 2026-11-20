import { startVault, vault } from './vault-browser.ts';

export function readChatData(demo: boolean) {
  startVault();
  return vault.snapshotChats(demo);
}

export function writeChatData(demo: boolean, change: (previous: unknown[]) => unknown[]) {
  startVault();
  return vault.updateChats(demo, change).then(() => true, () => false);
}

export function clearChatData() {
  startVault();
  return vault.clearChats().then(() => true, () => false);
}
