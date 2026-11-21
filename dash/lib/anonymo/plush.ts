export const OUTFITS = [
  'Captain',
  'Stargazer',
  'Pilot',
  'Knit',
  'Racer',
  'Tuxedo',
  'Artist',
  'Explorer',
  'Astronaut',
] as const;
export const HATS = [
  'None',
  'Star cap',
  'Flight helmet',
  'Beanie',
  'Western',
  'Beret',
  'Skipper',
  'Crown',
  'Ballcap',
] as const;
export const GLASSES = [
  'None',
  'Round',
  'Square',
  'Cat-eye',
  'Aviator',
  'Hearts',
  'Visor',
] as const;
export const SHAPES = ['Round', 'Oval', 'Broad', 'Pear', 'Heart'] as const;
export const MOUTHS = [
  'Classic',
  'Tiny',
  'Wide',
  'Crooked',
  'Fangs',
  'Cat stitch',
] as const;
export const MARKS = [
  'Plain',
  'Freckles',
  'Star stitch',
  'Heart patch',
  'Whiskers',
] as const;
export const DYES = {
  Plum: '#70274c',
  Teal: '#267783',
  Iris: '#7861bb',
  Rose: '#c44e72',
  Moss: '#66804b',
  Cobalt: '#386fb9',
  Ruby: '#c13940',
  Apricot: '#ec925e',
  Honey: '#dbad51',
  Mint: '#98d8ba',
  Sky: '#82c3e6',
  Lilac: '#cba6db',
  Blush: '#eda8af',
  Cocoa: '#926448',
  Ivory: '#eee3d0',
  Slate: '#718497',
  Ink: '#353448',
  Gold: '#ffb331',
  Silver: '#dce5ee',
  Peach: '#ff9683',
  Oat: '#dfb993',
} as const;
type Dye = keyof typeof DYES | `#${string}`;
export type Plush = {
  outfit: (typeof OUTFITS)[number];
  hat: (typeof HATS)[number];
  glasses: (typeof GLASSES)[number];
  shape: (typeof SHAPES)[number];
  mouth: (typeof MOUTHS)[number];
  marks: (typeof MARKS)[number];
  mask: Dye;
  coat: Dye;
  thread: Dye;
  felt: Dye;
};
export const BASE_PLUSH: Plush = {
  outfit: 'Captain',
  mask: 'Plum',
  coat: 'Teal',
  thread: 'Gold',
  felt: 'Oat',
  shape: 'Round',
  mouth: 'Classic',
  marks: 'Plain',
  hat: 'None',
  glasses: 'None',
};
const validColor = (v: unknown) =>
  typeof v === 'string' &&
  (Object.hasOwn(DYES, v) || /^#[0-9a-f]{6}$/i.test(v));
const inList = (list: readonly string[], v: unknown) =>
  typeof v === 'string' && list.includes(v);
export function isPlush(value: unknown): value is Plush {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<Plush>;
  return (
    inList(OUTFITS, p.outfit) &&
    inList(HATS, p.hat) &&
    inList(GLASSES, p.glasses) &&
    inList(SHAPES, p.shape) &&
    inList(MOUTHS, p.mouth) &&
    inList(MARKS, p.marks) &&
    [p.mask, p.coat, p.thread, p.felt].every(validColor)
  );
}
/** Early saved wardrobes had their hat sewn into the outfit. */
export function readPlush(v: unknown): Plush | undefined {
  if (!v || typeof v !== 'object') return;
  const old = v as Partial<Plush>;
  const restored = {
    ...BASE_PLUSH,
    hat:
      old.outfit === 'Pilot'
        ? 'Flight helmet'
        : old.outfit === 'Stargazer'
          ? 'Star cap'
          : 'None',
    ...old,
  };
  return isPlush(restored) && old.outfit && old.mask && old.coat && old.thread
    ? restored
    : undefined;
}
export const partUrl = (part: 'outfit' | 'hat' | 'glasses', name: string) =>
  '/mascot/faces/' + part + '-' + name.toLowerCase() + '.webp';
export const dyeHex = (dye: Dye) =>
  dye.startsWith('#') ? dye : DYES[dye as keyof typeof DYES];
const rgb = (dye: Dye) =>
  [1, 3, 5].map((i) => parseInt(dyeHex(dye).slice(i, i + 2), 16));

// Dyes follow the source materials. Neutral trim, brass fittings and the photo's shadows stay intact.
export function dyeFabric(
  pixels: Uint8ClampedArray,
  width: number,
  tileHeight: number,
  plush: Plush,
) {
  const mask = plush.mask === 'Plum' ? null : rgb(plush.mask);
  const coat = plush.coat === 'Teal' ? null : rgb(plush.coat);
  const thread = plush.thread === 'Gold' ? null : rgb(plush.thread);
  const felt = plush.felt === 'Oat' ? null : rgb(plush.felt);
  if (!mask && !coat && !thread && !felt) return;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i],
      g = pixels[i + 1],
      b = pixels[i + 2];
    const y = (Math.floor(i / 4 / width) % tileHeight) / tileHeight;
    let dye, strength, reference;
    const x = (((i / 4) % width) + 0.5) / width;
    const belowCollar = y > 0.68 || (y > 0.62 && x > 0.22 && x < 0.78);
    if (coat && belowCollar && Math.min(g, b) > r + 7) {
      dye = coat;
      strength = (Math.min(b, g) - r - 7) / 15;
      reference = 82;
    } else if (mask && y > 0.23 && y < 0.51 && r > g && b > g) {
      dye = mask;
      strength = (Math.min(r, b) - g) / 12;
      reference = 85;
    } else if (thread && y > 0.31 && y < 0.45 && r > 1.35 * g && g > 1.55 * b) {
      dye = thread;
      strength = (g - b) / 48;
      reference = 240;
    } else if (
      felt &&
      y < 0.71 &&
      r > g &&
      g > b &&
      g > 0.63 * r &&
      b > 0.46 * r
    ) {
      dye = felt;
      strength = Math.min(r - g, g - b) / 18;
      reference = 216;
    } else continue;
    const amount = Math.min(1, strength);
    const light = Math.max(r, g, b) / reference;
    for (let c = 0; c < 3; c++) {
      const tinted = Math.min(
        255,
        dye[c] * light + 15 * Math.max(0, light - 0.5),
      );
      pixels[i + c] += (tinted - pixels[i + c]) * amount;
    }
  }
}
