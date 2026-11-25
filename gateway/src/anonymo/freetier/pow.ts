import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DAY_MS = 86_400_000;
export const MAX_BATCH = 8;
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export const nextDay = (now: number) => now - now % DAY_MS + DAY_MS;

export const FREE_TOKEN_HEADER = "x-anonymo-free-token";
export const FREE_PROOF_HEADER = "x-anonymo-free-proof";
export const FREE_REMAINING_HEADER = "x-anonymo-free-remaining";

export function hashDevice(token: string | undefined) {
  return token && /^[a-f0-9]{64}$/.test(token) ? createHash("sha256").update(token).digest() : null;
}

function signature(secret: string, device: Buffer, data: string) {
  return createHmac("sha256", secret).update("free-challenge-v1:").update(device).update(data).digest();
}

export function workDifficulty(base: number, load: number, failures: number, batch: number) {
  return Math.min(24, base + Math.min(4, Math.floor(load / 60)) +
    Math.min(4, Math.floor(failures / 3)) + Math.ceil(Math.log2(batch)));
}

export function issueChallenge(secret: string, device: Buffer, used: number, batch: number, difficulty: number, now: number) {
  const expires = Math.min(now + 180_000, nextDay(now));
  const data = [randomBytes(16).toString("hex"), expires, used, batch, difficulty].join(".");
  return { challenge: `${data}.${signature(secret, device, data).toString("hex")}`, difficulty, expires, batch };
}

export function verifyProof(secret: string, device: Buffer, proof: string | undefined, now: number) {
  // The hashcash input is UTF-8 "<challenge>:<decimal nonce>". One solution spends the signed slots in order.
  const fields = proof?.match(/^([a-f0-9]{32}\.\d{13}\.\d{1,4}\.\d\.\d{1,2})\.([a-f0-9]{64}):(0|[1-9]\d{0,9}):(\d)$/);
  if (!fields) return null;
  const [, data, mac, nonce, slotString] = fields;
  const [, expires, used, batch, difficulty] = data.split(".").map(Number);
  const slot = Number(slotString);
  if (expires <= now || expires > nextDay(now) || batch > MAX_BATCH || slot >= batch || difficulty < 1 || difficulty > 24 ||
      !timingSafeEqual(Buffer.from(mac, "hex"), signature(secret, device, data))) return null;

  const hash = createHash("sha256").update(`${data}.${mac}:${nonce}`).digest();
  if (hash.readUInt32BE() >>> (32 - difficulty)) return null;
  return { device, expected: used + slot, day: utcDay(now), expires, difficulty };
}
export type FreeProof = NonNullable<ReturnType<typeof verifyProof>>;
