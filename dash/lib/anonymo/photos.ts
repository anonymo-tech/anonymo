// Update "photos": show the model a picture in chat. Photos are shrunk and re-encoded in the browser before they are
// sent: at most MAX_EDGE px on the long side, as JPEG at JPEG_QUALITY, drawn through a canvas, which also drops EXIF
// and GPS metadata. They go to the gateway as OpenAI `image_url` parts with data URLs, where they are checked before
// anything else happens. Photo bytes live in this tab's memory only: saved chats keep a "photo not saved" placeholder.

import { chatModelName, isAnonymoModel } from './chat-models.ts';
import type { ChatMessage, ChatPart, ChatPhotoMessage, ModelInfo } from './types.ts';
export type { ChatPart, ChatPhotoMessage };

export const MAX_PHOTOS = 4;
export const MAX_EDGE = 1568;
export const JPEG_QUALITY = 0.85;
/** The gateway refuses a photo over 5 MB once decoded; a 1568 px JPEG is far below that. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Larger files are refused before they are decoded, so a huge file cannot stall the tab. */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const PHOTO_ACCEPT = PHOTO_TYPES.join(',');
export const PHOTO_NOTE = 'Photos go with this message only and are never saved.';

export type PreparedPhoto = { id: string; dataUrl: string; width: number; height: number; bytes: number };

export class PhotoError extends Error {}

/** The size to draw at: the long side at most `max`, never upscaled, aspect kept, at least 1 px. */
export function fitWithin(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
  if (!(width > 0 && height > 0)) throw new PhotoError('The image has no size.');
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// ---- Which models can see photos --------------------------------------------------------------------------------------

export const acceptsImages = (m: ModelInfo | undefined): boolean => !!m?.architecture?.input_modalities?.includes('image');

/** The chat models that take image input, by name, for "photos work with …". */
export function photoModels(models: readonly ModelInfo[]): ModelInfo[] {
  return models.filter(acceptsImages);
}

export type PhotoSupport = { ok: true } | { ok: false; reason: string; models: ModelInfo[] };

/**
 * Whether the selected model can be shown photos. Anonymo's own models route across several models, not all of which
 * see images, and a sealed chat may not send a photo to an outside check, so only a direct model that lists image
 * input in `/v1/models` gets the attach control.
 */
export function photoSupport(modelId: string, models: readonly ModelInfo[]): PhotoSupport {
  const able = photoModels(models);
  if (modelId === 'anonymo-sealed') return { ok: false, reason: 'Sealed chats cannot take photos yet.', models: able };
  const listed = models.find((m) => m.id === modelId);
  if (!isAnonymoModel(modelId) && acceptsImages(listed)) return { ok: true };
  const name = listed ? chatModelName(listed) : modelId;
  return { ok: false, reason: `${name} reads text only.`, models: able };
}

/** One short sentence naming a few models that can see photos. */
export function photoHint(support: PhotoSupport, max = 3): string {
  if (support.ok) return '';
  if (!support.models.length) return `${support.reason} No model here takes photos right now.`;
  const names = support.models.slice(0, max).map(chatModelName);
  const more = support.models.length > max ? ` and ${support.models.length - max} more` : '';
  return `${support.reason} Photos work with ${names.join(', ')}${more}.`;
}

// ---- Building the request -------------------------------------------------------------------------------------------

/** The content of a message with photos: the text first, then each photo as an `image_url` part. */
export function photoParts(text: string, photos: readonly string[]): string | ChatPart[] {
  if (!photos.length) return text;
  return [...(text ? [{ type: 'text' as const, text }] : []), ...photos.map((url) => ({ type: 'image_url' as const, image_url: { url } }))];
}

/** Attach this turn's photos to the last user message. Earlier photos are not sent again. */
export function attachPhotos(messages: readonly ChatMessage[], photos: readonly string[]): ChatPhotoMessage[] {
  if (photos.length > MAX_PHOTOS) throw new PhotoError(`Attach at most ${MAX_PHOTOS} photos.`);
  const out: ChatPhotoMessage[] = messages.map((m) => ({ ...m }));
  if (!photos.length) return out;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue;
    out[i] = { ...out[i], content: photoParts(messages[i].content, photos) };
    return out;
  }
  throw new PhotoError('There is no message to attach the photos to.');
}

/** What an earlier turn's text says in place of its photos, which are not sent again. */
export const photoNote = (count: number) => (count > 0 ? `[${count === 1 ? 'A photo was' : `${count} photos were`} shared here and not sent again.]` : '');
export const withPhotoNote = (prompt: string, count: number | undefined) => (!count ? prompt : prompt ? `${prompt}\n\n${photoNote(count)}` : photoNote(count));

// ---- Shrinking and re-encoding in the browser --------------------------------------------------------------------------

type Drawable = { width: number; height: number; close?: () => void };
type Canvas2D = { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void; drawImage(image: Drawable, x: number, y: number, w: number, h: number): void };
export type PhotoCanvas = { getContext(kind: '2d'): Canvas2D | null };
export type PhotoDeps = {
  /** Decode the file with its EXIF orientation applied (so dropping the metadata never turns a photo sideways). */
  decode(file: Blob): Promise<Drawable>;
  canvas(width: number, height: number): PhotoCanvas;
  toJpeg(canvas: PhotoCanvas, quality: number): Promise<Blob>;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const browserDeps = (): PhotoDeps => ({
  decode: (file) => createImageBitmap(file, { imageOrientation: 'from-image' }),
  canvas(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height) as unknown as PhotoCanvas;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c as unknown as PhotoCanvas;
  },
  async toJpeg(canvas, quality) {
    if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Promise<Blob>((resolve, reject) =>
      (canvas as unknown as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new PhotoError('The photo could not be prepared.'))), 'image/jpeg', quality));
  },
});

/** Shrink a picture to MAX_EDGE, draw it on white (for transparent images) and re-encode it as JPEG. */
export async function preparePhoto(file: Blob, deps: PhotoDeps = browserDeps()): Promise<PreparedPhoto> {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) throw new PhotoError('Use a JPEG, PNG, WebP or GIF image.');
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('That image is too large. Try one under 40 MB.');
  let image: Drawable;
  try {
    image = await deps.decode(file);
  } catch {
    throw new PhotoError('That image could not be opened.');
  }
  try {
    const size = fitWithin(image.width, image.height);
    const canvas = deps.canvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoError('This browser cannot prepare photos.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(image, 0, 0, size.width, size.height);
    const jpeg = await deps.toJpeg(canvas, JPEG_QUALITY);
    if (jpeg.size > MAX_PHOTO_BYTES) throw new PhotoError('That photo is still over 5 MB after shrinking.');
    const dataUrl = `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(await jpeg.arrayBuffer()))}`;
    return { id: crypto.randomUUID(), dataUrl, ...size, bytes: jpeg.size };
  } finally {
    image.close?.();
  }
}

/** The image files among dropped or pasted items, in order. */
export const imageFiles = (files: Iterable<File> | ArrayLike<File> | null | undefined): File[] =>
  Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));

// ---- What the gateway accepts (the demo gateway applies the same rules) ---------------------------------------------

export type PhotoPartsCheck = { ok: true; count: number; messages: ChatMessage[] } | { ok: false; status: number; type: string; message: string };

/**
 * Read the photo parts of a chat request the way the gateway does (gateway/src/anonymo/floor/chat-photos.ts): at most
 * MAX_PHOTOS, data: URLs only (a link is refused, since it cannot be checked), JPEG, PNG, WebP or GIF, at most 5 MB
 * each. Returns the messages with their text only, for code that reads text.
 */
export function readPhotoParts(messages: readonly (ChatMessage | ChatPhotoMessage)[]): PhotoPartsCheck {
  let count = 0;
  const text: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      text.push(m as ChatMessage);
      continue;
    }
    if (!Array.isArray(m.content)) return { ok: false, status: 400, type: 'invalid_request', message: 'Message content must be text or a list of parts.' };
    const parts: string[] = [];
    for (const p of m.content) {
      if (p?.type === 'text') {
        parts.push(String(p.text ?? ''));
        continue;
      }
      if (p?.type !== 'image_url') return { ok: false, status: 400, type: 'invalid_request', message: 'Only text and image_url parts are accepted.' };
      count++;
      const url = String(p.image_url?.url ?? '');
      if (/^https?:/i.test(url)) return { ok: false, status: 400, type: 'remote_image_unsupported', message: 'Anonymo does not fetch images, so it cannot check them: attach the image itself.' };
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (!match) return { ok: false, status: 400, type: 'invalid_image', message: 'Send each image as a base64 data: URL.' };
      if (!(PHOTO_TYPES as readonly string[]).includes(match[1].toLowerCase())) return { ok: false, status: 415, type: 'unsupported_image_type', message: 'Chat accepts JPEG, PNG, WebP and GIF images.' };
      if (Math.floor((match[2].length * 3) / 4) > MAX_PHOTO_BYTES) return { ok: false, status: 413, type: 'image_too_large', message: 'An image is over 5 MB.' };
    }
    text.push({ ...m, content: parts.join('\n') } as ChatMessage);
  }
  if (count > MAX_PHOTOS) return { ok: false, status: 400, type: 'too_many_images', message: `A chat request may carry at most ${MAX_PHOTOS} images.` };
  return { ok: true, count, messages: text };
}
