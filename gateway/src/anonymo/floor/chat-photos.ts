// Photos in chat: image parts of a chat request go through the upload rule (uploads.ts) before the floor, the
// refusal catch, any hold or any provider call, as an edit upload does on the media routes.
//
//   - Only data: URLs are accepted. A remote http(s) image is refused (400): we cannot check what we do not fetch.
//   - At most MAX_CHAT_PHOTOS images per request, each at most MAX_CHAT_PHOTO_BYTES once decoded, and only JPEG, PNG,
//     WebP or GIF (read from the bytes themselves, which must match the declared type).
//   - Each image is decoded in memory, hashed in memory and checked: our hash block list, the CSAM hash client and,
//     when one is configured, the media classifier (an explicit image of an apparent minor or of a real person is
//     blocked). A block is 451 with the category and is never rerouted. The request body is not changed, so a
//     passing image reaches the provider exactly as sent. Nothing is stored here.
//   - The checks start once a CSAM hash client is wired in (`ready`). Until then image parts pass exactly as they did
//     before this file existed (no checks, remote links allowed), so the API keeps working; the dashboard's photo button
//     stays switched off until then. Once ready, required mode (ANONYMO_ENV=production, ANONYMO_FLOOR_REQUIRED or
//     ANONYMO_UPLOADS_REQUIRED) fails closed: a check that cannot run refuses the photo with 503 `uploads_unavailable`.
//   - Sealed, attested-lane and `:private` requests: the hash service and the classifier are outside services, so
//     their image parts are refused (409 sealed_unavailable) before anything is sent, unless the checks stay in
//     this process or run inside the enclave.
//
// Kept beside ctx (like media/services.ts) because services.ts and seams.ts belong to WS00.

import type { Ctx } from "../../context.ts";
import { ApiError, fail } from "../../lib/errors.ts";
import { log } from "../../lib/util.ts";
import { dbHashBlocklist } from "../abuse/store.ts";
import type { FloorCategory } from "../seams.ts";
import { classifierFromEnv, mediaServices } from "../media/services.ts";
import { unconfiguredClassifier, type MediaOutputGate } from "../media/gate.ts";
import { createUploadRule, stubCsamHashClient, type CsamHashClient, type HashBlocklist } from "./uploads.ts";

export const MAX_CHAT_PHOTOS = 4;
export const MAX_CHAT_PHOTO_BYTES = 5 * 1024 * 1024;
export const CHAT_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ChatPhotoType = (typeof CHAT_PHOTO_TYPES)[number];

export type ChatPhotoServices = {
  blocklist: HashBlocklist;
  csam: CsamHashClient;
  /** The media classifier, or null when none is configured and photos are not required to be scored. */
  classifier: MediaOutputGate | null;
  /** Fail closed: a check that cannot run refuses the photo. */
  required: boolean;
  /** A real CSAM hash client is wired in. Until it is, image parts are not checked here (they pass as before). */
  ready: boolean;
  /** The classifier runs inside the attestation boundary (it always sends bytes to a service otherwise). */
  classifierInEnclave?: boolean;
};

const truthy = (v: unknown) => v === true || v === "1" || v === "true";

/** Whether photos must be fully checked before they are accepted (every real deployment). */
export const photosRequired = (env: Record<string, unknown>) =>
  truthy(env.ANONYMO_FLOOR_REQUIRED) || truthy(env.ANONYMO_UPLOADS_REQUIRED) || String(env.ANONYMO_ENV ?? "").trim() === "production";

export function buildChatPhotoServices(ctx: Ctx, env: Record<string, unknown> = process.env): ChatPhotoServices {
  const required = photosRequired(env);
  // No CSAM hash-matching contract exists yet (uploads.ts): the stub fails closed when required.
  const csam = stubCsamHashClient(required);
  const configured = classifierFromEnv(env as Record<string, string | undefined>) !== unconfiguredClassifier;
  return {
    blocklist: dbHashBlocklist(ctx.db),
    csam,
    // Required without a classifier: the media gate's unconfigured classifier scores nothing, so every photo is refused.
    classifier: configured || required ? mediaServices(ctx).gate : null,
    required,
    // Set this to true where a real CSAM hash client replaces the stub above.
    ready: false,
  };
}

const registry = new WeakMap<object, ChatPhotoServices>();
export function chatPhotoServices(ctx: Ctx): ChatPhotoServices {
  let s = registry.get(ctx);
  if (!s) registry.set(ctx, (s = buildChatPhotoServices(ctx)));
  return s;
}
/** Replace some of a gateway's chat photo services (tests, or a deployment wiring its own). */
export function setChatPhotoServices(ctx: Ctx, patch: Partial<ChatPhotoServices>): ChatPhotoServices {
  // Wiring a hash client in makes the checks ready, unless the patch says otherwise.
  const next = { ...chatPhotoServices(ctx), ...(patch.csam ? { ready: true } : {}), ...patch };
  registry.set(ctx, next);
  return next;
}

/** Whether checking a photo would send it to a service outside this process and outside the enclave. */
export function photoChecksLeaveProcess(s: ChatPhotoServices): boolean {
  const csamOutside = s.csam.inEnclave !== true && s.csam.sendsOutside !== false;
  const classifierOutside = s.classifier !== null && s.classifierInEnclave !== true;
  return csamOutside || classifierOutside;
}

export type ChatPhoto = { at: string; mime: ChatPhotoType; bytes: Uint8Array };

const IMAGE_PART_TYPES = new Set(["image_url", "input_image", "image"]);

function sniff(b: Uint8Array): ChatPhotoType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** The URL of an image part, in the shapes chat accepts: `image_url: "…"` or `image_url: { url }`. */
function urlOf(part: Record<string, unknown>, at: string): string {
  const v = part.image_url;
  const url = typeof v === "string" ? v : v && typeof v === "object" ? (v as Record<string, unknown>).url : undefined;
  if (typeof url !== "string" || !url.trim()) fail(400, `\`${at}\` needs \`image_url.url\`: a data: URL with a JPEG, PNG, WebP or GIF image.`, "invalid_image");
  return url.trim();
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode one data: URL in memory, enforcing the type and size caps. */
export function decodePhoto(url: string, at: string): ChatPhoto {
  if (/^https?:/i.test(url))
    fail(400, `\`${at}\` is a link to an image. Anonymo does not fetch images, so it cannot check them: attach the image itself as a data: URL.`, "remote_image_unsupported");
  const m = /^data:([^;,]+)((?:;[^;,]*)*?);base64,(.*)$/is.exec(url);
  if (!m) fail(400, `\`${at}\` must be a base64 data: URL (data:image/jpeg;base64,…).`, "invalid_image");
  const declared = m[1].trim().toLowerCase();
  if (!(CHAT_PHOTO_TYPES as readonly string[]).includes(declared)) fail(415, `\`${at}\` is ${declared}. Chat accepts JPEG, PNG, WebP and GIF images.`, "unsupported_image_type");
  const data = m[3].replace(/\s+/g, "");
  // Size from the encoded length first, so an oversized image is never decoded.
  if (Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) > MAX_CHAT_PHOTO_BYTES)
    fail(413, `\`${at}\` is over ${MAX_CHAT_PHOTO_BYTES / 1024 / 1024} MB. Send a smaller image.`, "image_too_large");
  if (!data || data.length % 4 === 1 || !B64.test(data)) fail(400, `\`${at}\` is not valid base64.`, "invalid_image");
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  const actual = sniff(bytes);
  if (!actual) fail(400, `\`${at}\` is not a JPEG, PNG, WebP or GIF image.`, "invalid_image");
  if (actual !== declared) fail(400, `\`${at}\` says ${declared} but holds ${actual}.`, "invalid_image");
  return { at, mime: actual, bytes };
}

/** Every image part of a chat body, decoded. Throws a 4xx for a remote URL, a bad part or a broken cap. */
export function chatPhotosOf(body: Record<string, unknown>): ChatPhoto[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const found: { part: Record<string, unknown>; at: string }[] = [];
  messages.forEach((msg, i) => {
    const content = msg && typeof msg === "object" ? (msg as Record<string, unknown>).content : undefined;
    if (!Array.isArray(content)) return;
    content.forEach((part, j) => {
      if (part && typeof part === "object" && IMAGE_PART_TYPES.has(String((part as Record<string, unknown>).type)))
        found.push({ part: part as Record<string, unknown>, at: `messages.${i}.content.${j}` });
    });
  });
  if (found.length > MAX_CHAT_PHOTOS) fail(400, `A chat request may carry at most ${MAX_CHAT_PHOTOS} images; this one has ${found.length}.`, "too_many_images");
  return found.map(({ part, at }) => {
    if (part.type !== "image_url") fail(400, `\`${at}\`: send images as \`image_url\` parts with a data: URL.`, "invalid_image");
    return decodePhoto(urlOf(part, at), at);
  });
}

export const photosUnavailable = () =>
  new ApiError(503, "Photos in chat open once image checks are available. Nothing was sent or charged.", "uploads_unavailable");

/**
 * The upload rule for the image parts of a chat request. Runs after the confidential check of the text floor and
 * before the floor itself: nothing is held, charged or sent to a provider until every image has passed.
 */
export async function checkChatPhotos(ctx: Ctx, body: Record<string, unknown>, confidential: boolean, signal?: AbortSignal): Promise<void> {
  const s = chatPhotoServices(ctx);
  if (!s.ready) return; // no hash client yet: images pass as they always have
  const photos = chatPhotosOf(body);
  if (!photos.length) return;
  if (confidential && photoChecksLeaveProcess(s))
    throw new ApiError(
      409,
      "Photos in sealed and private chats are checked only inside an attested enclave, and no such check is available right now. Nothing was sent to any provider or safety service, and nothing was charged.",
      "sealed_unavailable",
    );
  const rule = createUploadRule({ blocklist: s.blocklist, csam: s.csam });
  for (const p of photos) {
    let verdict;
    try {
      verdict = await rule.check({ workflow: "chat", nsfw: true, kind: "image", mime: p.mime, bytes: p.bytes }, signal);
    } catch (e) {
      log.warn("chat photo check unavailable", { reason: e instanceof Error ? e.message.slice(0, 120) : "error" });
      throw photosUnavailable();
    }
    if (!verdict.ok) throw blocked(verdict.category, verdict.reason);
    if (s.classifier) {
      const g = await s.classifier.assess(p.bytes, p.mime, { explicitAllowed: true, signal });
      if (!g.ok) {
        if (g.reason === "nsfw_minor") throw blocked("minor", g.reason);
        if (g.reason === "nsfw_real_person") throw blocked("real_person", g.reason);
        // The classifier failed, or could not read the age of someone in an explicit image: fail closed.
        throw photosUnavailable();
      }
    }
  }
}

function blocked(category: FloorCategory, reason: string) {
  log.warn("chat photo blocked", { category, reason });
  return new ApiError(451, "A photo in this request crosses a line Anonymo blocks for everyone. Nothing was sent or charged.", "floor_blocked", { category });
}
