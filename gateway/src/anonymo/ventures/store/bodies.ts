// WS11 · where artifact bodies live (Ventures Backend PART 1 "artifacts (S3, sha256)", PART 12 privacy).
//
// The database keeps only an artifact's hash, kind, zone and size; the body is in the artifact store, encrypted
// (AES-256-GCM) under a key derived from the app secret and the venture id, and deleted after 30 days. Keeping bodies
// out of Postgres keeps the gateway's promise that its database holds no prompt or answer text. The default store is a
// directory (VENTURES_ARTIFACT_DIR); an S3-compatible store implements the same three calls.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../../../db/client.ts";

export interface BodyStore {
  put(ventureId: string, sha256: string, bytes: Uint8Array): Promise<string>;
  get(ventureId: string, key: string): Promise<Uint8Array | null>;
  delete(ventureId: string, key: string): Promise<void>;
}

const SAFE = /^[a-z0-9_]+$/i;
const HEX = /^[0-9a-f]{64}$/;

export class FsBodyStore implements BodyStore {
  constructor(
    readonly root: string,
    private readonly secret: string,
  ) {}
  private key(ventureId: string) {
    return createHmac("sha256", this.secret).update(`venture-artifact:${ventureId}`).digest();
  }
  private path(ventureId: string, sha: string) {
    if (!SAFE.test(ventureId) || !HEX.test(sha)) throw new Error("bad artifact address");
    return join(this.root, ventureId, `${sha}.bin`);
  }
  async put(ventureId: string, sha: string, bytes: Uint8Array) {
    const p = this.path(ventureId, sha);
    await mkdir(join(this.root, ventureId), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(ventureId), iv);
    const body = Buffer.concat([c.update(bytes), c.final()]);
    await writeFile(p, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
    return `${ventureId}/${sha}`;
  }
  async get(ventureId: string, key: string) {
    const sha = key.split("/")[1] ?? "";
    let raw: Buffer;
    try {
      raw = await readFile(this.path(ventureId, sha));
    } catch {
      return null;
    }
    const d = createDecipheriv("aes-256-gcm", this.key(ventureId), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return new Uint8Array(Buffer.concat([d.update(raw.subarray(28)), d.final()]));
  }
  async delete(ventureId: string, key: string) {
    await rm(this.path(ventureId, key.split("/")[1] ?? ""), { force: true });
  }
}

const stores = new WeakMap<Db, BodyStore>();

export const defaultArtifactDir = (env: Record<string, string | undefined> = process.env) => env.VENTURES_ARTIFACT_DIR ?? join(tmpdir(), "anonymo-venture-artifacts");

export function configureBodies(db: Db, store: BodyStore) {
  stores.set(db, store);
}

export function bodiesFor(db: Db): BodyStore {
  const s = stores.get(db);
  if (!s) throw new Error("the ventures artifact store is not configured");
  return s;
}
