// A small QR Code encoder (ISO/IEC 18004, model 2): byte mode, error correction level M, versions 1 to 40. It is
// written here so a ticket's QR code needs no dependency and no request: the link it carries holds a key, and that
// must never leave the page it is drawn on. Nothing in this file touches the network, storage or the console.
//
//   text -> UTF-8 bytes -> mode 0100 + length + data + padding -> Reed-Solomon blocks, interleaved
//        -> zigzag placement around the function patterns -> the mask with the lowest penalty -> format bits
//
// `modules[y][x]` is true for a dark module. The quiet zone (four light modules on every side) is the renderer's job.

export type QrCode = {
  version: number;
  /** Modules per side: 17 + 4 × version. */
  size: number;
  /** The mask pattern in use, 0 to 7. */
  mask: number;
  modules: boolean[][];
  /** True where a module belongs to a function pattern (finder, timing, alignment, format, version). */
  reserved: boolean[][];
};

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;
/** Light modules a reader needs around the symbol. */
export const QR_QUIET_ZONE = 4;

// Level M only. Index is version − 1. (ISO/IEC 18004 table 9: error correction codewords per block, and blocks.)
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
/** The two format bits for level M. */
const LEVEL_M = 0;

const sizeOf = (version: number) => 17 + 4 * version;

/** Modules left for data and error correction once every function pattern is placed. */
function rawModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

const totalCodewords = (version: number) => Math.floor(rawModules(version) / 8);
const dataCodewords = (version: number) => totalCodewords(version) - ECC_PER_BLOCK[version - 1] * BLOCKS[version - 1];
/** Bits of the length field in byte mode. */
const countBits = (version: number) => (version <= 9 ? 8 : 16);

/** How many bytes of text fit in a version at level M (byte mode). */
export function qrCapacity(version: number): number {
  if (!Number.isInteger(version) || version < QR_MIN_VERSION || version > QR_MAX_VERSION) throw new RangeError('QR version must be 1 to 40.');
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

/** The smallest version that holds `bytes` bytes, or null when even version 40 is too small. */
export function qrVersionFor(bytes: number): number | null {
  for (let v = QR_MIN_VERSION; v <= QR_MAX_VERSION; v++) if (bytes <= qrCapacity(v)) return v;
  return null;
}

// ---- Reed-Solomon over GF(2^8), reduced by x^8 + x^4 + x^3 + x^2 + 1 --------------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial (x − 2^0)(x − 2^1)…(x − 2^(degree−1)), highest power first, without its leading 1. */
function generator(degree: number): Uint8Array {
  const g = new Uint8Array(degree);
  g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = gfMultiply(g[j], root);
      if (j + 1 < degree) g[j] ^= g[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return g;
}

/** The `degree` error correction codewords for one block of data codewords. */
export function reedSolomon(data: ArrayLike<number>, degree: number): Uint8Array {
  const g = generator(degree);
  const rem = new Uint8Array(degree);
  for (let k = 0; k < data.length; k++) {
    const factor = data[k] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMultiply(g[i], factor);
  }
  return rem;
}

// ---- format and version information (BCH codes) -----------------------------------------------------------------

/** The 15 format bits for level M and a mask: 5 data bits, 10 BCH bits, XORed with the fixed pattern. */
export function formatBits(mask: number): number {
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up): 6 data bits and 12 BCH bits. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ---- the symbol -------------------------------------------------------------------------------------------------

/** Centres of the alignment patterns along one axis. */
export function alignmentCentres(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = sizeOf(version) - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

type Grid = { size: number; modules: boolean[][]; reserved: boolean[][] };

function blankGrid(size: number): Grid {
  const rows = () => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { size, modules: rows(), reserved: rows() };
}

function setFunction(g: Grid, x: number, y: number, dark: boolean) {
  if (x < 0 || y < 0 || x >= g.size || y >= g.size) return;
  g.modules[y][x] = dark;
  g.reserved[y][x] = true;
}

function drawFormat(g: Grid, mask: number) {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) setFunction(g, 8, i, bit(i));
  setFunction(g, 8, 7, bit(6));
  setFunction(g, 8, 8, bit(7));
  setFunction(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(g, 14 - i, 8, bit(i));
  // The second copy, split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i++) setFunction(g, g.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(g, 8, g.size - 15 + i, bit(i));
  setFunction(g, 8, g.size - 8, true); // always dark
}

function drawFunctionPatterns(g: Grid, version: number) {
  const { size } = g;
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFunction(g, 6, i, i % 2 === 0);
    setFunction(g, i, 6, i % 2 === 0);
  }
  // Three finder patterns with their light separators.
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(g, cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
  }
  // Alignment patterns, everywhere except on the finders.
  const centres = alignmentCentres(version);
  const last = centres.length - 1;
  centres.forEach((cy, i) =>
    centres.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) setFunction(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  drawFormat(g, 0); // reserves the cells; the real bits are written once the mask is known
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(g, a, b, dark);
      setFunction(g, b, a, dark);
    }
  }
}

/** Data codewords with their error correction, split into blocks and interleaved as the standard orders them. */
function withErrorCorrection(data: Uint8Array, version: number): Uint8Array {
  const blocks = BLOCKS[version - 1];
  const ecc = ECC_PER_BLOCK[version - 1];
  const total = totalCodewords(version);
  const short = blocks - (total % blocks); // blocks that are one data codeword shorter
  const shortData = Math.floor(total / blocks) - ecc;
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const len = shortData + (i < short ? 0 : 1);
    const block = data.subarray(at, at + len);
    at += len;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomon(block, ecc));
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (let i = 0; i <= shortData; i++) for (const block of dataBlocks) if (i < block.length) out[o++] = block[i];
  for (let i = 0; i < ecc; i++) for (const block of eccBlocks) out[o++] = block[i];
  return out;
}

/** Mode, length, bytes, terminator and padding, as the data codewords of a version. */
function dataFor(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataCodewords(version);
  const out = new Uint8Array(capacity);
  let bit = 0;
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--, bit++) out[bit >>> 3] |= ((value >>> i) & 1) << (7 - (bit & 7));
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  // The terminator (up to four zero bits) and the bits up to the next byte boundary are already zero.
  bit = Math.min(capacity * 8, bit + 4);
  bit = Math.ceil(bit / 8) * 8;
  for (let pad = 0xec; bit < capacity * 8; pad ^= 0xec ^ 0x11) push(pad, 8);
  return out;
}

/** Places the codewords in the two-module-wide zigzag, from the bottom-right corner upwards. */
function placeData(g: Grid, codewords: Uint8Array) {
  let i = 0;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern takes a whole column
    for (let step = 0; step < g.size; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - step : step;
        if (g.reserved[y][x] || i >= codewords.length * 8) continue;
        g.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

/** Whether a mask flips the module at column `x`, row `y`. */
export function maskFlips(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new RangeError('QR mask must be 0 to 7.');
  }
}

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.reserved[y][x] && maskFlips(mask, x, y)) g.modules[y][x] = !g.modules[y][x];
}

/**
 * The standard's four penalty rules, which pick the mask a reader finds easiest: runs of five or more modules of one
 * colour (3 points, plus 1 for each module past five), 2 × 2 blocks of one colour (3 each), anything that looks like a
 * finder pattern (dark-light-dark-light-dark in the ratio 1:1:3:1:1) with four light modules before or after it (40
 * each), and a dark share away from one half (10 for every 5 % past the first).
 *
 * The standard leaves room in the third rule. This reading counts a look-alike once, and only light modules inside
 * the symbol count as the space beside it. It is the reading that reproduces the reference generator's choice in the
 * checks (scripts/check-tickets.mjs). Whichever mask wins, the symbol is valid: the format bits name it.
 */
export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (at: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && at(i) === at(i - 1)) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    const fourLight = (from: number) => from >= 0 && from + 4 <= size && !at(from) && !at(from + 1) && !at(from + 2) && !at(from + 3);
    for (let i = 0; i + 7 <= size; i++) {
      const finderLike = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
      if (finderLike && (fourLight(i - 4) || fourLight(i + 7))) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) line((y) => modules[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = modules[y][x];
      if (c) dark++;
      if (x + 1 < size && y + 1 < size && c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

export type QrOptions = {
  /** Force a mask (0 to 7) instead of choosing the one with the lowest penalty. */
  mask?: number;
  /** Use at least this version. */
  minVersion?: number;
};

/** Encodes text (as UTF-8) or raw bytes. Throws when it does not fit in a version 40 symbol (2,331 bytes). */
export function encodeQr(input: string | Uint8Array, options: QrOptions = {}): QrCode {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const fit = qrVersionFor(bytes.length);
  if (fit === null) throw new RangeError('That is too long for a QR code.');
  const minVersion = options.minVersion ?? QR_MIN_VERSION;
  if (!Number.isInteger(minVersion) || minVersion < QR_MIN_VERSION || minVersion > QR_MAX_VERSION) throw new RangeError('QR version must be 1 to 40.');
  const version = Math.max(fit, minVersion);
  const base = blankGrid(sizeOf(version));
  drawFunctionPatterns(base, version);
  placeData(base, withErrorCorrection(dataFor(bytes, version), version));

  const masked = (mask: number): Grid => {
    const g: Grid = { size: base.size, modules: base.modules.map((row) => row.slice()), reserved: base.reserved };
    applyMask(g, mask);
    drawFormat(g, mask);
    return g;
  };
  let chosen: { mask: number; grid: Grid; score: number };
  if (options.mask !== undefined) {
    if (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7) throw new RangeError('QR mask must be 0 to 7.');
    chosen = { mask: options.mask, grid: masked(options.mask), score: 0 };
  } else {
    const first = masked(0);
    chosen = { mask: 0, grid: first, score: penalty(first.modules) };
    for (let mask = 1; mask < 8; mask++) {
      const grid = masked(mask);
      const score = penalty(grid.modules);
      if (score < chosen.score) chosen = { mask, grid, score }; // on a tie the lower mask number stays
    }
  }
  return { version, size: base.size, mask: chosen.mask, modules: chosen.grid.modules, reserved: base.reserved };
}

/**
 * The dark modules as one SVG path in module units, offset by the quiet zone: draw it in a viewBox of
 * `size + 2 × quiet` on a light background. Runs of dark modules in a row become one rectangle.
 */
export function qrPath(qr: QrCode, quiet = QR_QUIET_ZONE): string {
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      let w = 1;
      while (x + w < qr.size && qr.modules[y][x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w;
    }
  }
  return d;
}
