export type ChatImage = { dataUrl: string };
export const VISION_FAMILIES = ['claude', 'gpt', 'gemini', 'grok'] as const;
export function imageCapable(family: string) {
  return (VISION_FAMILIES as readonly string[]).includes(family);
}
/** Inline images only: no remote URL fetching, SVG or active content. */
export function parseChatImages(value: unknown): ChatImage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new Error('INVALID_CHAT_IMAGES');
  return value.map((image) => {
    if (
      !image ||
      typeof image !== 'object' ||
      typeof image.dataUrl !== 'string' ||
      image.dataUrl.length > 4 * 1024 * 1024 ||
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        image.dataUrl,
      )
    )
      throw new Error('INVALID_CHAT_IMAGES');
    return { dataUrl: image.dataUrl };
  });
}
