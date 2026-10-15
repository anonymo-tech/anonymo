import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const directory = new URL('../public/app-icons/', import.meta.url);
await mkdir(directory, { recursive: true });
const source = new URL('source.svg', directory);
// The star fits within the central 69%, including the maskable icon's safe zone.
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  await sharp(source.pathname).resize(size, size).png().toFile(new URL(name, directory).pathname);
}
