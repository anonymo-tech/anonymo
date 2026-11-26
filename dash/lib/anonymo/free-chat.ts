import type { ChatMessage } from './types.ts';

export const FREE_DEVICE_SLOT = 'anonymo.free-device';
export const FREE_TOKEN_HEADER = 'x-anonymo-free-token';
export const FREE_PROOF_HEADER = 'x-anonymo-free-proof';
export const FREE_REMAINING_HEADER = 'x-anonymo-free-remaining';

export type FreeChallenge = {
  challenge: string | null;
  difficulty: number;
  expires: number;
  remaining: number;
  resets_at: number;
  model: string | null;
};

export function freeDevice(storage: Pick<Storage, 'getItem' | 'setItem'>, demo: boolean) {
  const slot = demo ? `${FREE_DEVICE_SLOT}.demo` : FREE_DEVICE_SLOT;
  const saved = storage.getItem(slot);
  if (saved && /^[a-f0-9]{64}$/.test(saved)) return saved;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  storage.setItem(slot, token);
  return token;
}

const encoder = new TextEncoder();

export async function hasFreeWork(challenge: string, nonce: number, difficulty: number) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(`${challenge}:${nonce}`));
  return new DataView(hash).getUint32(0) >>> (32 - difficulty) === 0;
}

export async function solveFreeWork(challenge: string, difficulty: number, expires: number) {
  for (let start = 0; Date.now() < expires; start += 16) {
    const matches = await Promise.all(Array.from({ length: 16 }, (_, offset) => hasFreeWork(challenge, start + offset, difficulty)));
    const first = matches.indexOf(true);
    if (first >= 0) return start + first;
  }
  return null;
}

/** Keep the system instructions and newest context within the free lane's input budget. */
export function freeContext(messages: ChatMessage[], byteLimit = 32_768, messageLimit = 32) {
  const first = messages.findIndex((message) => message.role === 'user');
  const instructions = messages.slice(0, first).filter((message) => message.role === 'system');
  const context = [];
  let left = byteLimit - instructions.reduce((bytes, message) => bytes + encoder.encode(message.content).byteLength, 0);
  for (let i = messages.length - 1; i >= Math.max(0, first) && context.length < messageLimit - instructions.length; i--) {
    const message = messages[i];
    left -= encoder.encode(message.content).byteLength;
    if (left < 0) break;
    context.push({ role: message.role, content: message.content });
  }
  if (!context.length)
    throw new Error('This message and its instructions are too long for free chat. Shorten them and try again.');
  return [...instructions.map(({ role, content }) => ({ role, content })), ...context.reverse()];
}
