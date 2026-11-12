// Floor hits: an encrypted, minimal record of each block, kept in memory only and dropped after a short TTL unless an
// operator reports it (Backend §10: "A floor hit stores an encrypted minimal record, kept only if it is reported").
// Reporting moves the record into the `preservation` table (src/anonymo/abuse/), which keeps it for one year.
//
// The record never holds the prompt: only a SHA-256 of it, its length, the category and which layer blocked it. The
// in-memory copy is sealed with a key generated at process start and never written anywhere.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { FloorCategory, FloorInput } from "../seams.ts";

export type FloorLayer = "prefilter" | "model";

export type FloorHitRecord = {
  id: string;
  at: string; // ISO time of the block
  category: FloorCategory;
  layer: FloorLayer;
  modality: FloorInput["modality"];
  hasUpload: boolean;
  textSha256: string;
  textLength: number;
};

export type FloorHitSummary = Pick<FloorHitRecord, "id" | "at" | "category" | "layer" | "modality" | "hasUpload">;

type Sealed = { summary: FloorHitSummary; expiresAt: number; blob: Buffer };

export class FloorHitLog {
  private readonly key = randomBytes(32);
  private readonly entries = new Map<string, Sealed>();

  constructor(
    private readonly ttlMs = 72 * 3_600_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  record(input: FloorInput, category: FloorCategory, layer: FloorLayer): FloorHitSummary {
    this.prune();
    const rec: FloorHitRecord = {
      id: "fh_" + randomBytes(12).toString("hex"),
      at: new Date(this.now()).toISOString(),
      category,
      layer,
      modality: input.modality,
      hasUpload: input.hasUpload,
      textSha256: createHash("sha256").update(input.text).digest("hex"),
      textLength: input.text.length,
    };
    const { textSha256: _h, textLength: _l, ...summary } = rec;
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(rec.id, { summary, expiresAt: this.now() + this.ttlMs, blob: this.seal(rec) });
    return summary;
  }

  /** Pending (unreported, unexpired) hits, metadata only. */
  list(): FloorHitSummary[] {
    this.prune();
    return [...this.entries.values()].map((e) => e.summary);
  }

  /** Remove a hit and return its full record, for the reporting flow. Null when unknown or expired. */
  take(id: string): FloorHitRecord | null {
    this.prune();
    const e = this.entries.get(id);
    if (!e) return null;
    this.entries.delete(id);
    return this.open(e.blob);
  }

  get size() {
    this.prune();
    return this.entries.size;
  }

  private prune() {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(id);
  }

  private seal(rec: FloorHitRecord): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(rec), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  private open(blob: Buffer): FloorHitRecord {
    const d = createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8"));
  }
}
