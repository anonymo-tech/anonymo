// Update "tickets": the ticket link, the QR encoder, amount and expiry rules, the status reducer, what is kept on the
// device, and the money rules a ticket rides on (lib/anonymo/tickets.ts, lib/anonymo/qr.ts, the demo gateway).
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { createAnonymoClient, AnonymoApiError, newIdempotencyKey } from '../lib/anonymo/client.ts';
import { wipeDevice } from '../lib/anonymo/history.ts';
import { isApiKey } from '../lib/anonymo/key-store.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { expiredKeyRefusal } from '../lib/anonymo/mock/tickets.ts';
import { usdToMusd } from '../lib/anonymo/money.ts';
import { alignmentCentres, encodeQr, formatBits, maskFlips, penalty, qrCapacity, qrPath, qrVersionFor, reedSolomon, versionBits } from '../lib/anonymo/qr.ts';
import {
  applyToTicket,
  canTakeBack,
  checkTicketAmount,
  daysLeft,
  DEFAULT_EXPIRY_DAYS,
  expiresSoon,
  expiryFor,
  forgetTicket,
  isGivenTicket,
  isSettled,
  keepTicket,
  keyFromFragment,
  keyFromLink,
  loadTickets,
  MAX_TICKETS,
  newTicket,
  reduceTicket,
  TICKET_AMOUNTS,
  TICKET_EXPIRY_DAYS,
  TICKET_MAX,
  TICKET_MIN,
  TICKET_STATUS_LABEL,
  ticketLink,
  ticketsSlot,
  ticketStatus,
  timeLeft,
  validExpiryDays,
} from '../lib/anonymo/tickets.ts';

const SAMPLE_KEY = `anm_live_${'ab'.repeat(32)}`;
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const keyBody = fc.array(fc.constantFrom(...KEY_ALPHABET), { minLength: 16, maxLength: 128 }).map((c) => c.join(''));
const anyKey = fc.tuple(fc.constantFrom('anm_live_', 'anm_test_'), keyBody).map(([p, b]) => p + b);
const anyOrigin = fc.constantFrom('https://anonymo.example', 'http://localhost:5199', 'https://app.anonymo.example:8443', 'https://anonymo.example/', 'http://127.0.0.1:5173//');

// ---- the link ---------------------------------------------------------------------------------------------------

test('a ticket link carries the key in the fragment only', () => {
  const link = ticketLink('https://anonymo.example', SAMPLE_KEY);
  assert.equal(link, `https://anonymo.example/ticket#k=${SAMPLE_KEY}`);
  const url = new URL(link);
  assert.equal(url.pathname, '/ticket');
  assert.equal(url.search, '');
  assert.equal(url.hash, `#k=${SAMPLE_KEY}`);
  assert.ok(!link.slice(0, link.indexOf('#')).includes(SAMPLE_KEY), 'nothing before the # holds the key');
  assert.equal(keyFromLink(link), SAMPLE_KEY);
  assert.equal(keyFromFragment(url.hash), SAMPLE_KEY);
  assert.equal(keyFromFragment(`k=${SAMPLE_KEY}`), SAMPLE_KEY);
  assert.equal(keyFromFragment(`#x=1&k=${SAMPLE_KEY}&y=2`), SAMPLE_KEY, 'other fragment entries are ignored');
  assert.throws(() => ticketLink('https://anonymo.example', 'not-a-key'));
  assert.throws(() => ticketLink('https://anonymo.example', ` ${SAMPLE_KEY}`));
});

test('link build and parse round trip for every key the gateway can issue', () => {
  fc.assert(
    fc.property(anyKey, anyOrigin, (key, origin) => {
      assert.ok(isApiKey(key));
      const link = ticketLink(origin, key);
      const url = new URL(link);
      assert.equal(keyFromLink(link), key);
      assert.equal(keyFromFragment(url.hash), key);
      assert.equal(url.pathname, '/ticket');
      assert.equal(url.search, '');
      assert.equal(link.split('#').length, 2, 'exactly one #');
      assert.ok(!link.split('#')[0].includes(key));
      assert.ok(link.endsWith(key), 'the key needs no escaping in a fragment');
    }),
    { numRuns: 500 },
  );
});

test('anything that is not a ticket link gives no key', () => {
  for (const bad of [
    '',
    'not a url',
    `https://anonymo.example/ticket?k=${SAMPLE_KEY}`, // in the query: it would have been sent to the server
    `https://anonymo.example/ticket/${SAMPLE_KEY}`, // in the path
    `https://anonymo.example/dashboard#k=${SAMPLE_KEY}`, // not the ticket page
    'https://anonymo.example/ticket',
    'https://anonymo.example/ticket#',
    'https://anonymo.example/ticket#k=',
    'https://anonymo.example/ticket#k=anm_live_short',
    `https://anonymo.example/ticket#key=${SAMPLE_KEY}`,
    `https://anonymo.example/ticket#k=${SAMPLE_KEY}%20`,
    `https://anonymo.example/ticket#k=%E0%A4%A`, // broken escape
    `https://anonymo.example/ticket#k=sk_live_${'a'.repeat(40)}`,
  ])
    assert.equal(keyFromLink(bad), null, bad);
  assert.equal(keyFromLink(`https://anonymo.example/ticket/#k=${SAMPLE_KEY}`), SAMPLE_KEY, 'a trailing slash is still the ticket page');
  fc.assert(
    fc.property(fc.string(), (s) => {
      const key = keyFromFragment(s);
      assert.ok(key === null || isApiKey(key));
    }),
  );
});

// ---- the QR encoder ---------------------------------------------------------------------------------------------

// ISO/IEC 18004 table 7, byte mode at level M, versions 1 to 40.
const CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331];
// ISO/IEC 18004 annex E: alignment pattern centres, versions 1 to 40.
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];
// Level M blocks and error correction codewords per block (table 9), used by the decoder below.
const BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const ECC_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];

const rowsOf = (qr) => qr.modules.map((r) => r.map((v) => (v ? '1' : '0')).join(''));
/** Rows written as hex, first module in the top bit, padded with zero bits to whole hex digits. */
const fromHexRows = (hex, size) => hex.map((h) => [...h].map((d) => Number.parseInt(d, 16).toString(2).padStart(4, '0')).join('').slice(0, size));

test('capacity and version choice match the standard for level M', () => {
  for (let v = 1; v <= 40; v++) assert.equal(qrCapacity(v), CAPACITY_M[v - 1], `version ${v}`);
  for (let v = 1; v <= 40; v++) {
    assert.equal(qrVersionFor(CAPACITY_M[v - 1]), v);
    assert.equal(qrVersionFor(CAPACITY_M[v - 1] + 1), v === 40 ? null : v + 1);
  }
  assert.equal(qrVersionFor(0), 1);
  assert.throws(() => qrCapacity(0));
  assert.throws(() => qrCapacity(41));
  assert.throws(() => encodeQr('x'.repeat(2332)), RangeError);
  assert.equal(encodeQr('x'.repeat(2331)).version, 40);
  for (let v = 1; v <= 40; v++) assert.deepEqual(alignmentCentres(v), ALIGNMENT[v - 1], `alignment, version ${v}`);
});

test('known vectors: Reed-Solomon, format bits and version bits', () => {
  // The widely published worked example: "HELLO WORLD" at 1-M has these 16 data codewords and these 10 check codewords.
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual([...reedSolomon(data, 10)], [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  // ISO/IEC 18004 annex C: the 15 format bits for level M and masks 0 to 7.
  const format = ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'];
  format.forEach((bits, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, '0'), bits, `mask ${mask}`));
  // Annex D: the 18 version bits.
  const version = { 7: '000111110010010100', 8: '001000010110111100', 9: '001001101010011001', 10: '001010010011010011', 40: '101000110001101001' };
  for (const [v, bits] of Object.entries(version)) assert.equal(versionBits(Number(v)).toString(2).padStart(18, '0'), bits, `version ${v}`);
});

test('known vectors: whole symbols, module for module', () => {
  // Reference: Apple Core Image's CIQRCodeGenerator at correction level M, read on 20 November 2026. For text with no
  // run of digits it encodes in byte mode like this encoder, and for these two inputs it picks the same mask.
  const hello = encodeQr('hello, world');
  assert.deepEqual({ version: hello.version, size: hello.size, mask: hello.mask }, { version: 1, size: 21, mask: 0 });
  assert.deepEqual(
    rowsOf(hello),
    fromHexRows(['fe5bf8', '82ca08', 'ba4ae8', 'ba32e8', 'ba9ae8', '821208', 'feabf8', '002000', 'aa4890', 'b1d098', '4f75f8', 'f5f910', '7eb080', '00d3b8', 'fe4cb8', '821110', 'badd10', 'ba5db0', 'ba98a8', '825090', 'fef118'], 21),
  );
  const link = encodeQr(ticketLink('https://anonymo.example', SAMPLE_KEY));
  assert.deepEqual({ version: link.version, size: link.size, mask: link.mask }, { version: 6, size: 41, mask: 2 });
  assert.deepEqual(
    rowsOf(link),
    fromHexRows(
      [
        'fe133d0bbf8', '826aecda208', 'bac6a7912e8', 'badcc2f42e8', 'bac27d4bae8', '82c64432208', 'feaaaaaabf8', '00ff16a9800', 'be05c2f53e0', '91bc950ffb8', '320aa8b8c00',
        '3d478cb18c0', '8ba643a1070', '2948bd29fb8', 'daac6cda560', '6597a7912d8', 'd2b1c2f4530', 'acd8bd0bb98', '8b782016ec0', 'dcb594a22c8', 'cebfc2fc430', '7102394fb98',
        '9e790efcc20', 'e93627b20d8', 'c3b8424c038', '45833f4f7d8', '5b29e474d80', '1daf2e29ed8', '4661d2e5070', '8db8bd0bed8', 'b37f2016ec0', 'a56694a27c0', '9babc2f4ff0',
        '008d3d0a898', 'fe7decdbaa0', '82c727918c0', 'ba94a2f4fb8', 'bad9fd4ed18', 'baf8e4747c0', '825b3498ad0', 'fe8c22e51a0',
      ],
      41,
    ),
  );
});

test('known vectors: each of the eight masks, as a tile and as a whole symbol', () => {
  // ISO/IEC 18004 figure 21: the top-left 6 × 6 modules of every mask, written out. 1 = the module is flipped.
  const tiles = [
    ['101010', '010101', '101010', '010101', '101010', '010101'],
    ['111111', '000000', '111111', '000000', '111111', '000000'],
    ['100100', '100100', '100100', '100100', '100100', '100100'],
    ['100100', '001001', '010010', '100100', '001001', '010010'],
    ['111000', '111000', '000111', '000111', '111000', '111000'],
    ['111111', '100000', '100100', '101010', '100100', '100000'],
    ['111111', '111000', '110110', '101010', '101101', '100011'],
    ['101010', '000111', '100011', '010101', '111000', '011100'],
  ];
  tiles.forEach((tile, mask) => {
    tile.forEach((row, y) => [...row].forEach((bit, x) => assert.equal(maskFlips(mask, x, y), bit === '1', `mask ${mask} at ${x},${y}`)));
    // Every mask repeats every 12 modules both ways.
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) assert.equal(maskFlips(mask, x + 12, y + 12), maskFlips(mask, x, y));
  });
  assert.throws(() => maskFlips(8, 0, 0), RangeError);
  // The same reference generator as above: one version 1 symbol for each mask it can choose.
  const symbols = [
    ['printer slot', ['fe33f8', '82d208', 'ba6ae8', 'ba5ae8', 'bafae8', '825208', 'feabf8', '006000', 'aa0890', '9195c8', '32f298', '60b990', 'fe1488', '00d4e8', 'fe2df8', '825010', 'bab990', 'ba6bb0', 'babb88', '826910', 'feb1d8']],
    ['admit one', ['fed3f8', '824208', 'baf2e8', 'ba3ae8', 'ba5ae8', '82fa08', 'feabf8', '002800', 'a32128', '2cf6c8', '379ce8', '49d5d0', '6b3c58', '00c4e8', 'fee2a8', '826850', 'ba67d0', 'ba36a0', 'bafdb8', '821640', 'fe9e88']],
    ['sleep mask', ['fe5bf8', '827a08', 'badae8', 'bafae8', 'ba9ae8', '82ca08', 'feabf8', '00d800', 'be6be0', 'c509c8', '4ff430', 'e58478', 'd31680', '0099f8', 'fe2e70', '82fd68', 'baeb08', 'bacbe0', 'bab760', '826160', 'fef150']],
    ['mask three', ['feabf8', '829a08', 'ba4ae8', 'ba9ae8', 'ba62e8', '824208', 'feabf8', '00c000', 'b74258', '6828a8', '62e918', 'd028c0', 'ba13d8', '00c6c0', 'fea1e0', '829d68', 'ba3160', 'bae130', 'ba9440', '821a48', 'fe9ca0']],
    ['stub', ['febbf8', '823a08', 'ba72e8', 'bae2e8', 'badae8', '82ca08', 'feabf8', '008000', '8befc8', '7cae60', '838c50', '689918', '5a33d8', '00f960', 'feb390', '820680', 'baee08', 'ba2e38', 'ba2c60', '827940', 'fe93a8']],
    ['credit', ['fe03f8', '82b208', 'baaae8', 'bae2e8', 'ba5ae8', '822a08', 'feabf8', '00f800', '82ae70', '78cab0', 'af3490', 'dcc0f8', '9ba258', '00de68', 'fe4b70', '821ce0', 'ba2810', 'ba29e0', 'ba02f8', '826160', 'fe9590']],
    ['ticket', ['feabf8', '82b208', 'ba92e8', 'ba22e8', 'baaae8', '827a08', 'feabf8', '003800', '9fccb8', 'c0ea80', '7be6b8', '94d020', 'b68248', '00f820', 'fecfc0', '82bce0', 'baba58', 'baf940', 'ba4298', '824778', 'feb080']],
    ['ticket six', ['fe23f8', '824a08', 'ba3ae8', 'ba0ae8', 'ba7ae8', '82a208', 'feabf8', '002000', '969d00', '7994f8', '63f168', '2deb58', '3b9098', '00e358', 'fe1c90', '82a118', 'ba2910', 'baa4b8', 'ba53c8', '821880', 'fec1d0']],
  ];
  symbols.forEach(([text, hex], mask) => {
    const qr = encodeQr(text);
    assert.equal(qr.mask, mask, `"${text}" takes mask ${mask}`);
    assert.deepEqual(rowsOf(qr), fromHexRows(hex, 21), text);
  });
});

// An independent reader, written from the standard rather than from the encoder: it finds the function patterns from
// the tables above, reads the format bits, lifts the mask, walks the zigzag, undoes the interleaving, checks every
// block against the Reed-Solomon code with its own arithmetic (log tables), and parses the byte segment.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
/** True when a block is a codeword: it evaluates to zero at every root 2^0 … 2^(ecc−1) of the generator. */
function isCodeword(block, ecc) {
  for (let j = 0; j < ecc; j++) {
    let s = 0;
    for (const c of block) s = mul(s, EXP[j]) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

function functionMap(version) {
  const size = 17 + 4 * version;
  const map = Array.from({ length: size }, () => new Array(size).fill(false));
  const fill = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) map[y][x] = true;
  };
  fill(0, 0, 9, 9); // top-left finder, its separator and the format bits beside it
  fill(size - 8, 0, 8, 9); // top-right
  fill(0, size - 8, 9, 8); // bottom-left (with the dark module)
  fill(6, 0, 1, size); // timing
  fill(0, 6, size, 1);
  const centres = ALIGNMENT[version - 1];
  for (const cy of centres)
    for (const cx of centres) {
      const onFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
      if (!onFinder) fill(cx - 2, cy - 2, 5, 5);
    }
  if (version >= 7) {
    fill(size - 11, 0, 3, 6);
    fill(0, size - 11, 6, 3);
  }
  return map;
}

const FORMAT_CELLS_A = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
const formatCellsB = (size) => [...Array.from({ length: 8 }, (_, i) => [size - 1 - i, 8]), ...Array.from({ length: 7 }, (_, i) => [8, size - 7 + i])];
const readBits = (modules, cells) => cells.reduce((n, [x, y], i) => n | ((modules[y][x] ? 1 : 0) << i), 0);

function decodeQr(modules) {
  const size = modules.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 40, 'size is 17 + 4 × version');
  const format = readBits(modules, FORMAT_CELLS_A);
  assert.equal(readBits(modules, formatCellsB(size)), format, 'both copies of the format bits agree');
  const plain = (format ^ 0x5412) >>> 10;
  assert.equal(plain >>> 3, 0, 'level M');
  const mask = plain & 7;
  assert.equal(formatBits(mask), format, 'the format bits are a valid codeword');
  const fn = functionMap(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is not part of any pair
    const pair = right > 6 ? (size - 1 - right) / 2 : (size - 2 - right) / 2; // which pair of columns, counted from the right
    for (let step = 0; step < size; step++) {
      for (const x of [right, right - 1]) {
        const y = pair % 2 === 0 ? size - 1 - step : step; // the first pair is read upwards, then it alternates
        if (fn[y][x]) continue;
        bits.push((modules[y][x] ? 1 : 0) ^ (maskFlips(mask, x, y) ? 1 : 0));
      }
    }
  }
  const total = Math.floor(bits.length / 8);
  const codewords = Array.from({ length: total }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((n, b) => (n << 1) | b, 0));
  const blocks = BLOCKS_M[version - 1];
  const ecc = ECC_M[version - 1];
  const short = blocks - (total % blocks);
  const shortData = Math.floor(total / blocks) - ecc;
  const data = Array.from({ length: blocks }, () => []);
  const check = Array.from({ length: blocks }, () => []);
  let at = 0;
  for (let i = 0; i <= shortData; i++) for (let b = 0; b < blocks; b++) if (i < shortData + (b < short ? 0 : 1)) data[b].push(codewords[at++]);
  for (let i = 0; i < ecc; i++) for (let b = 0; b < blocks; b++) check[b].push(codewords[at++]);
  assert.equal(at, total);
  data.forEach((d, b) => assert.ok(isCodeword([...d, ...check[b]], ecc), `block ${b} satisfies the Reed-Solomon code`));
  const stream = data.flat().flatMap((c) => Array.from({ length: 8 }, (_, i) => (c >>> (7 - i)) & 1));
  let p = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | stream[p++];
    return v;
  };
  assert.equal(take(4), 0b0100, 'byte mode');
  const length = take(version <= 9 ? 8 : 16);
  const bytes = Uint8Array.from({ length }, () => take(8));
  return { version, mask, bytes };
}

test('structure: finders, timing, the dark module, and both copies of the format and version bits', () => {
  for (const text of ['', 'a', 'x'.repeat(100), 'y'.repeat(150), 'z'.repeat(700)]) {
    const qr = encodeQr(text);
    const { size, modules, version } = qr;
    assert.equal(size, 17 + 4 * version);
    assert.equal(modules.length, size);
    assert.ok(modules.every((row) => row.length === size));
    const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
    for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]])
      finder.forEach((row, dy) => assert.equal(modules[y0 + dy].slice(x0, x0 + 7).map((v) => (v ? '1' : '0')).join(''), row));
    for (let i = 0; i < 8; i++) {
      // the light separators around each finder
      assert.equal(modules[7][i], false);
      assert.equal(modules[i][7], false);
      assert.equal(modules[7][size - 1 - i], false);
      assert.equal(modules[i][size - 8], false);
      assert.equal(modules[size - 8][i], false);
      assert.equal(modules[size - 1 - i][7], false);
    }
    for (let i = 8; i < size - 8; i++) {
      assert.equal(modules[6][i], i % 2 === 0, 'horizontal timing');
      assert.equal(modules[i][6], i % 2 === 0, 'vertical timing');
    }
    assert.equal(modules[size - 8][8], true, 'the dark module');
    assert.equal(readBits(modules, FORMAT_CELLS_A), formatBits(qr.mask));
    assert.equal(readBits(modules, formatCellsB(size)), formatBits(qr.mask));
    if (version >= 7) {
      const cells = Array.from({ length: 18 }, (_, i) => [size - 11 + (i % 3), Math.floor(i / 3)]);
      assert.equal(readBits(modules, cells), versionBits(version));
      assert.equal(readBits(modules, cells.map(([x, y]) => [y, x])), versionBits(version));
    }
    // What the encoder calls a function module is what the standard's tables say it is.
    assert.deepEqual(qr.reserved, functionMap(version));
  }
});

test('the penalty rules, on grids small enough to score by hand', () => {
  const grid = (rows) => rows.map((r) => [...r].map((c) => c === '1'));
  // All one colour, 5 × 5: ten runs of five (3 each), sixteen 2 × 2 blocks (3 each), and a dark share 50 % from half (90).
  assert.equal(penalty(grid(Array(5).fill('00000'))), 30 + 48 + 90);
  assert.equal(penalty(grid(Array(5).fill('11111'))), 30 + 48 + 90);
  // A 7 × 7 checkerboard breaks no rule.
  assert.equal(penalty(grid(Array.from({ length: 7 }, (_, y) => (y % 2 ? '0101010' : '1010101')))), 0);
  // Eleven rows of a finder look-alike with four light modules after it: 40 a row; eleven one-colour columns
  // (3 + 6 each); five pairs of matching neighbour columns, ten 2 × 2 blocks each (3 each); 55 of 121 dark is within 5 %.
  assert.equal(penalty(grid(Array(11).fill('10111010000'))), 440 + 99 + 150);
  assert.equal(penalty(grid(Array(11).fill('00001011101'))), 440 + 99 + 150, 'four light modules before it count the same');
  // Light on both sides is still one look-alike: 40 a row. Fifteen columns (3 + 10 each), eight pairs of matching
  // neighbour columns (fourteen blocks each), and 75 of 225 dark is 16.7 % from half (30).
  assert.equal(penalty(grid(Array(15).fill('000010111010000'))), 600 + 195 + 336 + 30);
  // With only three light modules beside it, it is not counted: what is left is the columns (99) and four pairs of
  // matching neighbour columns (120). 66 of 121 dark is within 5 %.
  assert.equal(penalty(grid(Array(11).fill('10111010001'))), 99 + 120);
});

test('the chosen mask is the one with the lowest penalty, and a forced mask is honoured', () => {
  // Texts for which the reference generator and this encoder choose the same mask (76 of 80 short texts tried; for
  // the other four the symbols match once the mask is forced). A change to the scoring shows up here first.
  const pins = [['ticket', 6], ['admit one', 1], ['sleep mask', 2], ['gold thread', 2], ['plum band', 1], ['no account', 2], ['adults only', 2], ['receipt', 2], ['cream paper', 2], ['night', 2], ['key', 2], ['printer slot', 0], ['headphones', 2], ['demo', 6], ['anonymo', 1], ['x-y-z', 0], ['credit', 5], ['stub', 4], ['ticket two', 0], ['ticket six', 7], ['ticket seven', 0], ['mask three', 3], ['feed', 7], ['paper', 0], ['plush', 6], ['felt', 6], ['gold', 3], ['amber', 0], ['plum', 0], ['stitch', 0], ['thread', 6], ['three', 4], ['five', 0], ['a ticket', 1], ['the stub', 0], ['tear here', 6], ['good until', 1], ['no wallet', 3], ['for adults', 6], ['thank you', 6], ['open me', 0], ['printed', 3], ['quiet', 4], ['lamp', 6]];
  for (const [text, mask] of pins) assert.equal(encodeQr(text).mask, mask, text);
  for (const text of ['hello, world', ticketLink('https://anonymo.example', SAMPLE_KEY), 'q'.repeat(300)]) {
    const auto = encodeQr(text);
    const scores = Array.from({ length: 8 }, (_, mask) => penalty(encodeQr(text, { mask }).modules));
    assert.equal(auto.mask, scores.indexOf(Math.min(...scores)));
    for (let mask = 0; mask < 8; mask++) assert.equal(decodeQr(encodeQr(text, { mask }).modules).mask, mask);
  }
  assert.throws(() => encodeQr('x', { mask: 8 }), RangeError);
  assert.equal(encodeQr('x', { minVersion: 5 }).version, 5);
});

test('every symbol reads back to the bytes that went in', () => {
  const text = new TextDecoder();
  const link = ticketLink('https://anonymo.example', SAMPLE_KEY);
  assert.equal(text.decode(decodeQr(encodeQr(link).modules).bytes), link);
  assert.equal(text.decode(decodeQr(encodeQr('ünïcödé ✓').modules).bytes), 'ünïcödé ✓', 'text is UTF-8');
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 420 }), fc.option(fc.integer({ min: 0, max: 7 }), { nil: undefined }), (bytes, mask) => {
      const qr = encodeQr(bytes, { mask });
      const read = decodeQr(qr.modules);
      assert.equal(read.version, qrVersionFor(bytes.length));
      assert.deepEqual([...read.bytes], [...bytes]);
    }),
    { numRuns: 150 },
  );
  // Every version once, at its full capacity, so each block layout and both length-field sizes are exercised.
  for (let v = 1; v <= 40; v++) {
    const bytes = Uint8Array.from({ length: CAPACITY_M[v - 1] }, (_, i) => (i * 31 + v * 7) & 0xff);
    const read = decodeQr(encodeQr(bytes, { mask: v % 8 }).modules);
    assert.equal(read.version, v);
    assert.deepEqual([...read.bytes], [...bytes], `version ${v}`);
  }
});

test('the ticket link for a real key fits a small symbol, and the drawn path covers exactly the dark modules', () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...'0123456789abcdef'), { minLength: 64, maxLength: 64 }), (hex) => {
      const link = ticketLink('https://anonymo.example', `anm_live_${hex.join('')}`);
      const qr = encodeQr(link);
      assert.ok(qr.version <= 7, 'at most 45 modules a side, so it prints large');
      assert.equal(new TextDecoder().decode(decodeQr(qr.modules).bytes), link);
    }),
    { numRuns: 50 },
  );
  const qr = encodeQr(ticketLink('https://anonymo.example', SAMPLE_KEY));
  const drawn = Array.from({ length: qr.size }, () => new Array(qr.size).fill(false));
  for (const [, x, y, w] of qrPath(qr, 4).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) for (let i = 0; i < Number(w); i++) drawn[Number(y) - 4][Number(x) - 4 + i] = true;
  assert.deepEqual(drawn, qr.modules);
});

// ---- amount and expiry ------------------------------------------------------------------------------------------

test('a ticket amount is plain dollars and whole cents between the smallest and the largest ticket', () => {
  assert.deepEqual(checkTicketAmount('5'), { ok: true, musd: 5_000_000 });
  assert.deepEqual(checkTicketAmount('$7.50'), { ok: true, musd: 7_500_000 });
  assert.deepEqual(checkTicketAmount(' 25 '), { ok: true, musd: 25_000_000 });
  assert.deepEqual(checkTicketAmount('1'), { ok: true, musd: TICKET_MIN });
  assert.deepEqual(checkTicketAmount('100.00'), { ok: true, musd: TICKET_MAX });
  for (const bad of ['', 'abc', '-5', '1e3', '5,00', '0', '0.99', '100.01', '7.505', '1000000', '5 dollars', '0x10', '٥'])
    assert.equal(checkTicketAmount(bad).ok, false, bad);
  assert.match(checkTicketAmount('0.50').reason, /smallest ticket is \$1\.00/);
  assert.match(checkTicketAmount('250').reason, /largest ticket is \$100\.00/);
  assert.match(checkTicketAmount('7.505').reason, /whole cents/);
  for (const musd of TICKET_AMOUNTS) assert.deepEqual(checkTicketAmount(String(musd / 1_000_000)), { ok: true, musd });
  assert.deepEqual([...TICKET_AMOUNTS], [1_000_000, 5_000_000, 10_000_000, 25_000_000]);
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 50_000 }), (cents) => {
      const typed = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      const r = checkTicketAmount(typed);
      assert.equal(r.ok, cents >= 100 && cents <= 10_000, typed);
      if (r.ok) assert.equal(r.musd, cents * 10_000);
    }),
  );
});

test('expiry is 1 to 365 whole days or none, sent as the ISO time the gateway accepts', () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  assert.equal(expiryFor(30, now), '2026-12-20T12:00:00.000Z');
  assert.equal(expiryFor(7, now), '2026-11-27T12:00:00.000Z');
  assert.equal(expiryFor(null, now), null);
  assert.equal(DEFAULT_EXPIRY_DAYS, 30);
  assert.ok(TICKET_EXPIRY_DAYS.includes(DEFAULT_EXPIRY_DAYS) && TICKET_EXPIRY_DAYS.includes(null));
  for (const days of TICKET_EXPIRY_DAYS) assert.ok(validExpiryDays(days));
  for (const bad of [0, -1, 366, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '30', undefined]) {
    assert.equal(validExpiryDays(bad), false);
    assert.throws(() => expiryFor(bad, now), RangeError);
  }
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 365 }), fc.integer({ min: 0, max: 4_000_000_000_000 }), (days, at) => {
      const iso = expiryFor(days, at);
      assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'what z.string().datetime() takes');
      assert.equal(Date.parse(iso) - at, days * 86_400_000);
      assert.equal(daysLeft(iso, at), days);
    }),
  );
  assert.equal(daysLeft(null, now), null);
  assert.equal(daysLeft('2026-11-20T12:00:00.001Z', now), 1, 'a part of a day counts as a day left');
  assert.equal(daysLeft('2026-11-20T12:00:00.000Z', now), 0);
  assert.equal(daysLeft('2026-01-01T00:00:00.000Z', now), 0);
  // What a person reads is to the nearest day: the page's clock is never exactly the moment the ticket was made.
  assert.equal(timeLeft(expiryFor(30, now), now), '30 days left');
  assert.equal(timeLeft(expiryFor(30, now), now + 90_000), '30 days left');
  assert.equal(timeLeft(expiryFor(30, now), now - 90_000), '30 days left');
  assert.equal(timeLeft(expiryFor(2, now), now + 10 * 3_600_000), '2 days left');
  assert.equal(timeLeft(expiryFor(1, now), now), '1 day left');
  assert.equal(timeLeft(expiryFor(1, now), now + 13 * 3_600_000), 'less than a day left');
});

// ---- the status reducer -----------------------------------------------------------------------------------------

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const WALLET = { chain: 'rhc', address: '0xabababababababababababababababababababab' };
const fresh = (over = {}) => ({ ...newTicket({ id: 't1', key: SAMPLE_KEY, amountMusd: 5_000_000, createdAt: new Date(NOW).toISOString(), expiresAt: expiryFor(30, NOW) }), ...over });
const run = (t, ...events) => events.reduce(reduceTicket, t);

test('a ticket goes from unpaid to credited, in use and taken back', () => {
  let t = fresh();
  assert.equal(ticketStatus(t, NOW), 'unpaid');
  assert.equal(canTakeBack(t), false);
  t = reduceTicket(t, { type: 'payment_sent', txHash: '0xfeed', from: WALLET });
  assert.equal(ticketStatus(t, NOW), 'pending');
  assert.equal(t.txHash, '0xfeed');
  t = reduceTicket(t, { type: 'credited', amountMusd: 5_000_000, from: WALLET });
  assert.equal(ticketStatus(t, NOW), 'ready');
  assert.equal(t.leftMusd, 5_000_000);
  assert.deepEqual(t.paidFrom, WALLET);
  assert.equal(canTakeBack(t), true);
  t = reduceTicket(t, { type: 'balance', leftMusd: 3_200_000, at: '2026-11-21T00:00:00.000Z' });
  assert.equal(ticketStatus(t, NOW), 'in_use');
  assert.equal(t.checkedAt, '2026-11-21T00:00:00.000Z');
  t = reduceTicket(t, { type: 'taken_back', amountMusd: 3_200_000, at: '2026-11-22T00:00:00.000Z' });
  assert.equal(ticketStatus(t, NOW), 'taken_back');
  assert.equal(t.leftMusd, 0);
  assert.equal(t.takenBackMusd, 3_200_000);
  assert.equal(canTakeBack(t), false);
  assert.ok(isSettled(ticketStatus(t, NOW)));
});

test('used up, held, expired and unknown tickets say so', () => {
  const credited = run(fresh(), { type: 'credited', amountMusd: 5_000_000, from: WALLET });
  assert.equal(ticketStatus(run(credited, { type: 'balance', leftMusd: 0, at: 'x' }), NOW), 'used_up');
  assert.equal(ticketStatus(run(fresh(), { type: 'payment_sent', txHash: '0x1', from: null }, { type: 'held' }), NOW), 'held');
  assert.equal(ticketStatus(run(credited, { type: 'held' }), NOW), 'ready', 'a late "held" does not undo credit that arrived');
  // Expired by the clock, and expired because the gateway said so.
  const later = Date.parse(credited.expiresAt) + 1;
  assert.equal(ticketStatus(credited, later - 2), 'ready');
  assert.equal(ticketStatus(credited, later), 'expired');
  const refused = run(credited, { type: 'key_expired' });
  assert.equal(ticketStatus(refused, NOW), 'expired');
  assert.equal(canTakeBack(refused), false, 'the gateway refuses an expired key, so there is nothing to offer');
  assert.equal(ticketStatus(fresh({ expiresAt: null }), NOW + 10 * 365 * 86_400_000), 'unpaid', 'no expiry never expires');
  // An empty ticket is settled even after its date; one with credit left is "expired".
  assert.equal(ticketStatus(run(credited, { type: 'taken_back', amountMusd: 5_000_000, at: 'x' }), later), 'taken_back');
  assert.equal(ticketStatus(run(credited, { type: 'key_unknown' }), NOW), 'unknown');
  for (const status of Object.keys(TICKET_STATUS_LABEL)) assert.ok(TICKET_STATUS_LABEL[status].length > 0);
});

test('what the gateway reports wins over what this device assumed', () => {
  // The page was closed before the payment was recorded: a balance above zero proves it arrived.
  const seen = run(fresh(), { type: 'balance', leftMusd: 5_000_000, at: 'x', from: WALLET });
  assert.equal(seen.credit, 'credited');
  assert.deepEqual(seen.paidFrom, WALLET);
  assert.equal(ticketStatus(seen, NOW), 'ready');
  assert.equal(run(fresh(), { type: 'balance', leftMusd: 0, at: 'x' }).credit, 'none', 'an empty balance proves nothing');
  // The gateway credited a different amount than was asked for: its figure is the ticket's amount.
  const odd = run(fresh(), { type: 'credited', amountMusd: 4_990_000, from: WALLET });
  assert.equal(odd.amountMusd, 4_990_000);
  assert.equal(odd.leftMusd, 4_990_000);
  // A repeated "credited" (the same deposit row seen again) does not refill what was spent.
  const spent = run(odd, { type: 'balance', leftMusd: 1_000_000, at: 'x' }, { type: 'credited', amountMusd: 4_990_000, from: WALLET });
  assert.equal(spent.leftMusd, 1_000_000);
  // A balance answer means the key works again (for example after its expiry was moved).
  assert.equal(run(odd, { type: 'key_expired' }, { type: 'balance', leftMusd: 4_990_000, at: 'x' }).keyState, 'ok');
  // Credit close to its date is flagged so it can be taken back in time.
  const soon = { ...odd, expiresAt: new Date(NOW + 3 * 86_400_000).toISOString() };
  assert.equal(expiresSoon(soon, NOW), true);
  assert.equal(expiresSoon({ ...odd, expiresAt: new Date(NOW + 7 * 86_400_000).toISOString() }, NOW), false, 'a 7-day ticket is not flagged the day it is made');
  assert.equal(expiresSoon({ ...soon, leftMusd: 0 }, NOW), false);
  assert.equal(expiresSoon(odd, NOW), false, '30 days away');
  assert.equal(expiresSoon({ ...odd, expiresAt: null }, NOW), false);
});

test('the reducer is pure and keeps its invariants for any run of events', () => {
  const source = fc.constantFrom(WALLET, { chain: 'base', address: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' });
  const amount = fc.integer({ min: 0, max: 100_000_000 });
  const event = fc.oneof(
    fc.record({ type: fc.constant('payment_sent'), txHash: fc.constant('0xfeed'), from: fc.option(source, { nil: null }) }),
    fc.record({ type: fc.constant('credited'), amountMusd: fc.integer({ min: 1, max: 100_000_000 }), from: source }),
    fc.constant({ type: 'held' }),
    fc.record({ type: fc.constant('balance'), leftMusd: amount, at: fc.constant('2026-11-21T00:00:00.000Z') }),
    fc.record({ type: fc.constant('taken_back'), amountMusd: amount, at: fc.constant('2026-11-22T00:00:00.000Z') }),
    fc.constant({ type: 'key_expired' }),
    fc.constant({ type: 'key_unknown' }),
  );
  fc.assert(
    fc.property(fc.array(event, { maxLength: 30 }), fc.integer({ min: NOW - 1e9, max: NOW + 1e11 }), (events, at) => {
      let t = fresh();
      for (const e of events) {
        const before = JSON.stringify(t);
        const next = reduceTicket(t, e);
        assert.equal(JSON.stringify(t), before, 'the ticket passed in is not changed');
        assert.ok(isGivenTicket(next), 'still a valid stored ticket');
        assert.equal(next.key, SAMPLE_KEY);
        assert.equal(next.id, 't1');
        assert.ok(next.takenBackMusd >= t.takenBackMusd);
        assert.ok(next.leftMusd === null || next.leftMusd >= 0);
        if (e.type !== 'taken_back') assert.deepEqual(reduceTicket(next, e), next, 'a report seen twice changes nothing more');
        t = next;
      }
      const status = ticketStatus(t, at);
      assert.ok(status in TICKET_STATUS_LABEL);
      if (canTakeBack(t)) assert.ok(t.leftMusd > 0 && t.credit === 'credited' && t.keyState === 'ok');
      if (status === 'taken_back' || status === 'used_up') assert.equal(t.leftMusd, 0);
    }),
    { numRuns: 300 },
  );
});

// ---- kept on this device ----------------------------------------------------------------------------------------

function fakeStorage({ failWrites = false } = {}) {
  const m = new Map();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      if (failWrites) throw new Error('QuotaExceededError');
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}
const useStorage = (storage) => Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });

test('tickets are kept on the device, live and demo apart, and "Wipe this device" removes them', () => {
  const storage = fakeStorage();
  useStorage(storage);
  assert.equal(ticketsSlot(false), 'anonymo.tickets.v1');
  assert.equal(ticketsSlot(true), 'anonymo.demo.tickets.v1');
  assert.deepEqual(loadTickets(true), []);
  assert.equal(keepTicket(true, fresh()), true);
  assert.equal(keepTicket(true, fresh({ id: 't2', key: `anm_live_${'cd'.repeat(32)}` })), true);
  assert.equal(keepTicket(false, fresh({ id: 'live' })), true);
  assert.deepEqual(loadTickets(true).map((t) => t.id), ['t2', 't1'], 'newest first');
  assert.deepEqual(loadTickets(false).map((t) => t.id), ['live']);
  applyToTicket(true, 't1', { type: 'credited', amountMusd: 5_000_000, from: WALLET });
  assert.equal(loadTickets(true).find((t) => t.id === 't1').credit, 'credited');
  assert.equal(loadTickets(true).find((t) => t.id === 't2').credit, 'none');
  forgetTicket(true, 't2');
  assert.deepEqual(loadTickets(true).map((t) => t.id), ['t1']);
  // Damaged or foreign entries are dropped, never trusted.
  storage.setItem(ticketsSlot(true), JSON.stringify([fresh(), { id: 'x', key: 'not-a-key' }, null, 7, { ...fresh({ id: 'y' }), credit: 'gift' }]));
  assert.deepEqual(loadTickets(true).map((t) => t.id), ['t1']);
  storage.setItem(ticketsSlot(true), '{not json');
  assert.deepEqual(loadTickets(true), []);
  // Wipe: every anonymo entry goes, tickets included, and nothing else.
  keepTicket(true, fresh());
  storage.setItem('other.site', 'stays');
  assert.ok(wipeDevice([storage]) >= 2);
  assert.equal(storage.getItem(ticketsSlot(true)), null);
  assert.equal(storage.getItem(ticketsSlot(false)), null);
  assert.equal(storage.getItem('other.site'), 'stays');
  assert.deepEqual(loadTickets(true), []);
});

test('a ticket that cannot be kept is refused before any payment', () => {
  useStorage(fakeStorage({ failWrites: true }));
  assert.equal(keepTicket(true, fresh()), false, 'storage blocked or full');
  const storage = fakeStorage();
  useStorage(storage);
  storage.setItem(ticketsSlot(true), JSON.stringify(Array.from({ length: MAX_TICKETS }, (_, i) => fresh({ id: `n${i}` }))));
  assert.equal(keepTicket(true, fresh({ id: 'one-more' })), false, 'the list is full: an older ticket is never pushed out');
  assert.equal(loadTickets(true).length, MAX_TICKETS);
  assert.equal(keepTicket(true, fresh({ id: 'n3', amountMusd: 9_000_000 })), true, 'an existing ticket can still be rewritten');
});

// ---- the money rules a ticket rides on (demo gateway, same client code as live) --------------------------------

const BASE = 'https://demo.anonymo.invalid';
const errorOf = (p) => p.then(() => assert.fail('expected the gateway to refuse'), (e) => (assert.ok(e instanceof AnonymoApiError), e));

test('a ticket is a new key, funded by a deposit, spent by whoever holds it, and taken back only to the paying wallet', async () => {
  const mock = createMockGateway({ delayMs: 0 });
  const keyless = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch });
  // The giver's own key and its credit.
  const own = await keyless.createKey();
  const giver = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key: own.key });
  await mock.simulateDeposit(own.key, 'rhc', 'USDG', 10_000_000);
  // The ticket: POST /keys with an expiry, then a deposit to that key's own commitment.
  const expiresAt = expiryFor(30, Date.now());
  const made = await keyless.createKey({ caps: { expires_at: expiresAt } });
  assert.equal(made.caps.expires_at, expiresAt);
  assert.notEqual(made.key, own.key);
  assert.ok(!made.deposit.paused && made.deposit.evm.key_commit !== own.deposit.evm.key_commit, 'its own deposit commitment');
  const ticket = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key: made.key });
  assert.equal((await ticket.balance()).available_usd, 0);
  const ref = await mock.simulateDeposit(made.key, 'rhc', 'USDG', 5_000_000);
  const row = (await ticket.deposits()).data.find((d) => d.ref === ref);
  assert.equal(row.status, 'credited');
  const funded = await ticket.balance();
  assert.equal(funded.available_usd, 5);
  assert.deepEqual(funded.withdraw_to, [{ chain: 'rhc', address: row.from, max_usd: 5 }], 'one way back: the wallet that paid');
  assert.equal((await giver.balance()).available_usd, 10, "the giver's own credit did not move");

  // Whoever holds the ticket chats with it.
  const reply = await ticket.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'Hello' }] });
  assert.ok(reply.content.length > 0 && reply.receiptId);
  const used = await ticket.balance();
  assert.ok(used.available_usd < 5 && used.available_usd > 4);

  // It cannot be sent anywhere but back.
  const elsewhere = await errorOf(ticket.withdraw({ chain: 'rhc', to: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', amount_usd: 'all' }, newIdempotencyKey()));
  assert.equal(elsewhere.code, 'not_source_address');
  const giverWallet = (await giver.balance()).withdraw_to[0].address;
  assert.notEqual(giverWallet, row.from, 'the demo pays each key from its own test wallet');
  assert.equal((await errorOf(ticket.withdraw({ chain: 'rhc', to: giverWallet, amount_usd: 'all' }, newIdempotencyKey()))).code, 'not_source_address');

  // "Take back what's left": everything that remains, to the paying wallet, once.
  const idem = newIdempotencyKey();
  const back = await ticket.withdraw({ chain: 'rhc', to: row.from, amount_usd: 'all' }, idem);
  assert.equal(usdToMusd(back.withdrawal.amount_usd), usdToMusd(used.available_usd));
  assert.equal(back.withdrawal.to, row.from);
  const again = await ticket.withdraw({ chain: 'rhc', to: row.from, amount_usd: 'all' }, idem);
  assert.equal(again.replay, true, 'a retry with the same Idempotency-Key does not pay twice');
  assert.equal(again.withdrawal.id, back.withdrawal.id);
  const empty = await ticket.balance();
  assert.equal(empty.available_usd, 0);
  assert.equal(empty.withdraw_to[0].max_usd, 0);
  assert.equal((await errorOf(ticket.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'Hello' }] }))).status, 402, 'an emptied ticket no longer chats');
  assert.equal((await giver.balance()).available_usd, 10);
});

test('less than the smallest withdrawal cannot be taken back', async () => {
  const mock = createMockGateway({ delayMs: 0 });
  const made = await createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch }).createKey();
  const ticket = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key: made.key });
  await mock.simulateDeposit(made.key, 'rhc', 'USDG', TICKET_MIN);
  await ticket.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'Hello' }] });
  const left = await ticket.balance();
  assert.ok(left.available_usd > 0 && left.available_usd < 1);
  const e = await errorOf(ticket.withdraw({ chain: 'rhc', to: left.withdraw_to[0].address, amount_usd: 'all' }, newIdempotencyKey()));
  assert.equal(e.code, 'below_minimum');
});

test('an expired key is refused on every route, taking credit back included, as the gateway does today', async () => {
  const refuse = (status, type, message) => new Response(JSON.stringify({ error: { code: status, type, message } }), { status });
  const now = Date.UTC(2026, 10, 20);
  assert.equal(expiredKeyRefusal({ expires_at: null }, now, refuse), null);
  assert.equal(expiredKeyRefusal({ expires_at: '2026-12-20T00:00:00.000Z' }, now, refuse), null);
  assert.equal(expiredKeyRefusal({ expires_at: 'not a date' }, now, refuse), null);
  assert.equal(expiredKeyRefusal({ expires_at: '2026-11-19T23:59:59.999Z' }, now, refuse).status, 401);

  const mock = createMockGateway({ delayMs: 0 });
  const keyless = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch });
  // Made already expired.
  const old = await keyless.createKey({ caps: { expires_at: '2000-01-01T00:00:00.000Z' } });
  const lapsed = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key: old.key });
  const refusal = await errorOf(lapsed.balance());
  assert.deepEqual([refusal.status, refusal.code], [401, 'key_expired']);
  // Funded, then run out: the credit is still there, and nothing can reach it.
  const made = await keyless.createKey({ caps: { expires_at: expiryFor(30, Date.now()) } });
  const ticket = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key: made.key });
  await mock.simulateDeposit(made.key, 'rhc', 'USDG', 5_000_000);
  const source = (await ticket.balance()).withdraw_to[0];
  await ticket.updateCaps({ expires_at: new Date(Date.now() - 1000).toISOString() });
  for (const call of [
    () => ticket.balance(),
    () => ticket.deposits(),
    () => ticket.keyInfo(),
    () => ticket.chat({ model: 'anonymo-1', messages: [{ role: 'user', content: 'Hello' }] }),
    () => ticket.withdraw({ chain: source.chain, to: source.address, amount_usd: 'all' }, newIdempotencyKey()),
    () => ticket.updateCaps({ expires_at: null }),
  ]) {
    const e = await errorOf(call());
    assert.deepEqual([e.status, e.code], [401, 'key_expired']);
  }
  // A key with a future expiry, or none, is unaffected.
  const fine = await keyless.createKey();
  assert.equal((await createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key: fine.key }).balance()).available_usd, 0);
});
