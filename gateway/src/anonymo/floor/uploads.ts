// The upload rule (Backend §10, "Upload rule", fails closed):
//   1. No photo uploads to NSFW image or video workflows (blocks real-person "undress" edits at the door).
//   2. No voice uploads for cloning: audio into any synthesis workflow is refused (stock voices only).
//   3. Every other upload is hash-matched: our own block list (takedowns, reports) and a CSAM hash API.
// WS06 calls `check()` on every upload before anything is stored or sent upstream. The upload bytes are hashed in
// memory and never persisted here.

import { createHash } from "node:crypto";
import type { FloorCategory } from "../seams.ts";

export type UploadWorkflow = "image_generation" | "image_edit" | "video_generation" | "speech" | "voice_clone" | "chat" | "other";
export type UploadKind = "image" | "video" | "audio" | "file";

export type Upload = {
  workflow: UploadWorkflow;
  /** True unless the workflow forces safe-for-work output. When unsure, pass true. */
  nsfw: boolean;
  kind: UploadKind;
  mime: string;
  bytes: Uint8Array;
};

export type UploadBlockReason = "photo_to_nsfw" | "voice_upload" | "blocked_hash" | "csam_hash_match";
export type UploadVerdict = { ok: true; sha256: string } | { ok: false; category: FloorCategory; reason: UploadBlockReason; sha256: string };

/** Content we were told to block (takedowns, reports), by SHA-256 of the exact bytes. */
export interface HashBlocklist {
  lookup(sha256: string): Promise<FloorCategory | null>;
}

/** A known-CSAM hash-matching service (Hive-style, PhotoDNA-class). Access is unverified (U), so only the interface
 *  and a stub exist. A real client must throw on any failure so the upload is refused, never passed unchecked. */
export interface CsamHashClient {
  match(upload: { bytes: Uint8Array; mime: string }, signal?: AbortSignal): Promise<{ matched: boolean }>;
}

/** Placeholder until a hash-matching contract exists. With `required` it fails closed, like the floor stub. */
export const stubCsamHashClient = (required: boolean): CsamHashClient => ({
  async match() {
    if (required) throw new Error("CSAM hash matching is not configured");
    return { matched: false };
  },
});

const VISUAL_WORKFLOWS = new Set<UploadWorkflow>(["image_generation", "image_edit", "video_generation"]);
const SYNTHESIS_WORKFLOWS = new Set<UploadWorkflow>(["speech", "voice_clone", "video_generation"]);

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function createUploadRule(deps: { blocklist: HashBlocklist; csam: CsamHashClient }) {
  return {
    async check(u: Upload, signal?: AbortSignal): Promise<UploadVerdict> {
      const sha256 = sha256Hex(u.bytes);
      const visual = u.kind === "image" || u.kind === "video" || /^(image|video)\//i.test(u.mime);
      const audio = u.kind === "audio" || /^audio\//i.test(u.mime);
      if (visual && u.nsfw && VISUAL_WORKFLOWS.has(u.workflow)) return { ok: false, category: "real_person", reason: "photo_to_nsfw", sha256 };
      if (audio && SYNTHESIS_WORKFLOWS.has(u.workflow)) return { ok: false, category: "voice_clone", reason: "voice_upload", sha256 };
      const listed = await deps.blocklist.lookup(sha256);
      if (listed) return { ok: false, category: listed, reason: "blocked_hash", sha256 };
      if (visual && (await deps.csam.match({ bytes: u.bytes, mime: u.mime }, signal)).matched) return { ok: false, category: "minor", reason: "csam_hash_match", sha256 };
      return { ok: true, sha256 };
    },
  };
}
