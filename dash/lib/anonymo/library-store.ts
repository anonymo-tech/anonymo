import { vault } from './vault-browser.ts';

const prefix = (demo: boolean) => demo ? 'image:demo:' : 'image:live:';
const utf8 = new TextEncoder();
const decoder = new TextDecoder();

type ImageDetails = { title: string; savedAt: number };
export type LibraryImage = ImageDetails & { id: string; png: Blob };

async function encodeImage(details: ImageDetails, png: Blob) {
  const header = utf8.encode(JSON.stringify(details));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, header.length);
  return new Blob([size, header, png]).arrayBuffer();
}

function decodeImage(id: string, bytes: ArrayBuffer): LibraryImage {
  const boundary = 4 + new DataView(bytes).getUint32(0);
  if (boundary >= bytes.byteLength) throw new Error('Could not read a saved image.');
  const details = JSON.parse(decoder.decode(new Uint8Array(bytes, 4, boundary - 4))) as ImageDetails;
  return { ...details, id, png: new Blob([new Uint8Array(bytes, boundary)], { type: 'image/png' }) };
}

export async function saveLibraryImages(demo: boolean, images: { png: Blob; title: string }[]) {
  const stamp = Date.now();
  const records = await Promise.all(images.map(async ({ png, title }): Promise<[string, ArrayBuffer]> => [
    prefix(demo) + crypto.randomUUID(),
    await encodeImage({ title, savedAt: stamp }, png),
  ]));
  await vault.saveImages(records);
}

export async function loadLibrary(demo: boolean) {
  const images = await vault.images(demo);
  return images.map(([id, bytes]) => decodeImage(id, bytes)).sort((a, b) => b.savedAt - a.savedAt);
}

export function deleteLibraryImage(demo: boolean, id: string) {
  if (!id.startsWith(prefix(demo))) throw new Error('Could not find this image.');
  return vault.deleteImages(prefix(demo), id);
}

export const deleteLibrary = (demo: boolean) => vault.deleteImages(prefix(demo));
