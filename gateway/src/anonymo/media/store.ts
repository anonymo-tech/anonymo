// Short-lived output storage behind signed temporary URLs (ported from Anonyma's API_MEDIA_TTL signed links).
// Output media is held in process memory only, for the signed-URL window, and is then dropped: it never touches the
// database or disk, so there is nothing to purge and nothing a backup can keep. b64_json responses skip the store
// entirely. With several gateway replicas, a URL is served only by the replica that made it, so a deployment runs
// media on one replica or pins a caller's media traffic to one (WS10). A shared store would need the same TTL and
// no persistence (for example Redis with RDB and AOF off) and is not built yet.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type StoredMedia = { bytes: Uint8Array; mime: string; accountId: string; expiresAt: number };
export interface MediaStore {
  put(item: { bytes: Uint8Array; mime: string; accountId: string }, ttlMs: number): { id: string; expiresAt: number };
  get(id: string): StoredMedia | null;
  delete(id: string): void;
  /** Bytes held now, for capacity checks and tests. */
  size(): number;
}

export class StoreFullError extends Error {}

export class MemoryMediaStore implements MediaStore {
  private items = new Map<string, StoredMedia>();
  private bytes = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private maxBytes = 512 * 1024 * 1024,
    private now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref?.();
  }
  sweep() {
    const t = this.now();
    for (const [id, it] of this.items) if (it.expiresAt <= t) this.delete(id);
  }
  put(item: { bytes: Uint8Array; mime: string; accountId: string }, ttlMs: number) {
    this.sweep();
    if (this.bytes + item.bytes.length > this.maxBytes) throw new StoreFullError("media store is full");
    const id = "m_" + randomBytes(18).toString("base64url");
    const expiresAt = this.now() + ttlMs;
    this.items.set(id, { ...item, expiresAt });
    this.bytes += item.bytes.length;
    return { id, expiresAt };
  }
  get(id: string) {
    const it = this.items.get(id);
    if (!it) return null;
    if (it.expiresAt <= this.now()) {
      this.delete(id);
      return null;
    }
    return it;
  }
  delete(id: string) {
    const it = this.items.get(id);
    if (!it) return;
    it.bytes.fill(0);
    this.items.delete(id);
    this.bytes -= it.bytes.length;
  }
  size() {
    return this.bytes;
  }
  close() {
    clearInterval(this.timer);
  }
}

const sigOf = (secret: string, id: string, expires: number) => createHmac("sha256", secret).update(`anonymo-media:${id}:${expires}`).digest("hex");

/** `/v1/media/{id}?expires={unix seconds}&sig={hmac}`: valid until `expires`, for that id only. */
export function signedMediaPath(secret: string, id: string, expiresAtMs: number) {
  const expires = Math.floor(expiresAtMs / 1000);
  return `/v1/media/${id}?expires=${expires}&sig=${sigOf(secret, id, expires)}`;
}

export function checkMediaSignature(secret: string, id: string, expiresRaw: string | undefined, sig: string | undefined, nowMs = Date.now()) {
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires * 1000 <= nowMs || !sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(sigOf(secret, id, expires)));
}
