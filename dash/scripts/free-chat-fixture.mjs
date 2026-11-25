// Browser checks for the existing setup sheet start with a used daily allowance.
import { randomBytes } from 'node:crypto';
import { keccak256, stringToHex } from 'viem';

export function useUpDemoFreeChat(page) {
  const token = randomBytes(32).toString('hex');
  return page.addInitScript(({ token, digest }) => {
    const deviceSlot = 'anonymo.free-device.demo';
    if (localStorage.getItem(deviceSlot)) return;
    localStorage.setItem(deviceSlot, token);
    const slot = 'anonymo.demo.state.v2';
    const state = JSON.parse(localStorage.getItem(slot) ?? '{"v":2,"keys":{},"receipts":{}}');
    const resetsAt = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 86_400_000;
    (state.free ??= {})[digest] = { resetsAt, used: 10 };
    localStorage.setItem(slot, JSON.stringify(state));
  }, { token, digest: keccak256(stringToHex(token)) });
}
