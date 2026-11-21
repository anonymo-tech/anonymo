// The printable ticket (update "tickets"), drawn to a canvas so it can be saved as a PNG: cream paper, a border of gold
// stitches, a plum band with the sleep-mask mark, "ADMIT ONE", the amount, "No account needed", the QR code, and a stub
// that says who it is for. Everything is drawn here from shapes and text: no image is loaded, nothing is fetched, and
// the picture holds nothing but what is on it (a PNG from a canvas carries no metadata).

import { formatUsd } from './money.ts';
import { QR_QUIET_ZONE, type QrCode } from './qr.ts';
import type { MicroUsd } from './types.ts';

export type TicketArt = {
  amountMusd: MicroUsd;
  /** ISO time the ticket stops working, or null for none. */
  expiresAt: string | null;
  /** The code to print. Null draws the place where it will go (the preview before a ticket is paid for). */
  qr: QrCode | null;
  /** With no code: a rubber stamp in its place, for a ticket shown to the person who opened it ("VALID"). */
  stamp?: string;
};

/** The picture's size in pixels. It is drawn at this size whatever the screen, so every saved ticket is the same. */
export const TICKET_ART = { width: 900, height: 1620 } as const;

const W = TICKET_ART.width;
const H = TICKET_ART.height;
/** Where the stub tears off. */
const TEAR = 1320;
const NOTCH = 26;
const PAPER = '#f4e8dd';
const INK = '#4a2c4d';
const INK_SOFT = '#7a5a77';
const INK_FAINT = '#8b5f7f';
const AMBER_INK = '#a8640f';
const PLUM = '#2e1531';
const QR_DARK = '#24092a';
const QR_LIGHT = '#fbf6ef';
const QR_BOX = { x: 250, y: 772, size: 400 };

// The sleep-mask mark (components/brand.tsx MaskGlyph), on its 48 × 24 grid.
const MASK = 'M4 12C4 5.5 11 3.5 24 6.5 37 3.5 44 5.5 44 12s-7 8.5-20 5.5C11 20.5 4 18.5 4 12Z';
const MASK_EYES = 'M10.5 11.5q4.5 3.6 9 0M28.5 11.5q4.5 3.6 9 0';
const MASK_LASHES = 'M12.6 13.6l-.9 1.6M15 14.4v1.8M17.4 13.6l.9 1.6M30.6 13.6l-.9 1.6M33 14.4v1.8M35.4 13.6l.9 1.6';

/** "20 Dec 2026", in the reader's own time zone. */
export function ticketDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

export const expiryLine = (expiresAt: string | null) => (expiresAt ? `Good until ${ticketDate(expiresAt)}` : 'No expiry date');

/** What the picture says, for people who cannot see it. */
export function ticketAlt(art: Pick<TicketArt, 'amountMusd' | 'expiresAt' | 'stamp'> & { qr: unknown }): string {
  const code = art.qr ? 'A QR code opens it.' : art.stamp ? `Stamped ${art.stamp}.` : 'Its QR code prints once it is paid for.';
  return `An Anonymo ticket. Admit one. ${formatUsd(art.amountMusd)} of chat credit. No account needed. ${code} 18+ adults only. ${expiryLine(art.expiresAt)}.`;
}

/** A file name for the saved picture. It says the amount and nothing about the key. */
export const ticketFileName = (amountMusd: MicroUsd) => `anonymo-ticket-${formatUsd(amountMusd).replace(/[^0-9.]/g, '').replace(/\.00$/, '')}-usd.png`;

type Ctx = CanvasRenderingContext2D;

function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The paper's outline: rounded corners and a half-round bite on each side where the stub tears off. */
function paperPath(ctx: Ctx) {
  const r = 44;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(W, 0, W, H, r);
  ctx.lineTo(W, TEAR - NOTCH);
  ctx.arc(W, TEAR, NOTCH, -Math.PI / 2, Math.PI / 2, true);
  ctx.arcTo(W, H, 0, H, r);
  ctx.arcTo(0, H, 0, 0, r);
  ctx.lineTo(0, TEAR + NOTCH);
  ctx.arc(0, TEAR, NOTCH, Math.PI / 2, -Math.PI / 2, true);
  ctx.arcTo(0, 0, W, 0, r);
  ctx.closePath();
}

/** A frame of stitches: a darker pass under a lighter one, so the thread has a little depth. */
function stitches(ctx: Ctx, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.setLineDash([20, 14]);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#a97a1f';
  roundedRect(ctx, x, y + 1.5, w, h, 26);
  ctx.stroke();
  ctx.strokeStyle = '#e0ae45';
  roundedRect(ctx, x, y, w, h, 26);
  ctx.stroke();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#f6dc9a';
  roundedRect(ctx, x, y - 1.2, w, h, 26);
  ctx.stroke();
  ctx.restore();
}

/** Text with even spacing between letters, centred on `cx` or ending at `right`. */
function spaced(ctx: Ctx, text: string, y: number, spacing: number, at: { cx: number } | { right: number }) {
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (widths.length - 1);
  let x = 'cx' in at ? at.cx - total / 2 : at.right - total;
  ctx.save();
  ctx.textAlign = 'left';
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, x, y);
    x += widths[i] + spacing;
  });
  ctx.restore();
}

/** Sets the largest font size up to `size` at which `text` is no wider than `max`. */
function fit(ctx: Ctx, text: string, weight: number, size: number, max: number, family: string) {
  let px = size;
  do ctx.font = `${weight} ${px}px ${family}`;
  while (ctx.measureText(text).width > max && (px -= 4) > 24);
}

function maskMark(ctx: Ctx, x: number, y: number, scale: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = '#3b1240';
  ctx.strokeStyle = '#ff5fae';
  ctx.lineWidth = 2;
  const mask = new Path2D(MASK);
  ctx.fill(mask);
  ctx.stroke(mask);
  ctx.strokeStyle = '#f6b84b';
  ctx.lineWidth = 1.6;
  ctx.stroke(new Path2D(MASK_EYES));
  ctx.stroke(new Path2D(MASK_LASHES));
  ctx.restore();
}

function drawQr(ctx: Ctx, qr: QrCode) {
  const { x, y, size } = QR_BOX;
  ctx.fillStyle = QR_LIGHT;
  roundedRect(ctx, x - 12, y - 12, size + 24, size + 24, 18);
  ctx.fill();
  // Whole pixels per module, so every edge is sharp; the quiet zone is part of the measured square.
  const cells = qr.size + QR_QUIET_ZONE * 2;
  const px = Math.max(1, Math.floor(size / cells));
  const left = x + Math.floor((size - cells * px) / 2) + QR_QUIET_ZONE * px;
  const top = y + Math.floor((size - cells * px) / 2) + QR_QUIET_ZONE * px;
  ctx.fillStyle = QR_DARK;
  for (let row = 0; row < qr.size; row++) {
    for (let col = 0; col < qr.size; col++) {
      if (!qr.modules[row][col]) continue;
      let run = 1;
      while (col + run < qr.size && qr.modules[row][col + run]) run++;
      ctx.fillRect(left + col * px, top + row * px, run * px, px);
      col += run;
    }
  }
}

function drawQrPlace(ctx: Ctx, family: string) {
  const { x, y, size } = QR_BOX;
  ctx.save();
  ctx.fillStyle = QR_LIGHT;
  roundedRect(ctx, x - 12, y - 12, size + 24, size + 24, 18);
  ctx.fill();
  ctx.setLineDash([14, 12]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#4a2c4d66';
  roundedRect(ctx, x + 14, y + 14, size - 28, size - 28, 12);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'center';
  ctx.fillStyle = INK_SOFT;
  ctx.font = `600 34px ${family}`;
  ctx.fillText('The code prints here', x + size / 2, y + size / 2 - 8);
  ctx.font = `500 28px ${family}`;
  ctx.fillStyle = INK_FAINT;
  ctx.fillText('once the ticket is paid for', x + size / 2, y + size / 2 + 34);
  ctx.restore();
}

/** A rubber stamp where the code would be: an amber frame and capitals, pressed on at a slight angle. */
function drawStamp(ctx: Ctx, text: string, family: string) {
  const { x, y, size } = QR_BOX;
  ctx.save();
  ctx.fillStyle = QR_LIGHT;
  roundedRect(ctx, x - 12, y - 12, size + 24, size + 24, 18);
  ctx.fill();
  ctx.translate(x + size / 2, y + size / 2);
  ctx.rotate((-9 * Math.PI) / 180);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.86;
  fit(ctx, text, 600, 104, size - 110, family);
  const width = [...text].reduce((w, ch) => w + ctx.measureText(ch).width + 10, -10);
  ctx.strokeStyle = '#d4851a';
  ctx.lineWidth = 9;
  roundedRect(ctx, -width / 2 - 34, -86, width + 68, 172, 14);
  ctx.stroke();
  ctx.fillStyle = '#d4851a';
  spaced(ctx, text, 36, 10, { cx: 0 });
  ctx.restore();
}

/**
 * Draws the ticket on a canvas context sized TICKET_ART.width × TICKET_ART.height. `family` is the CSS font family
 * to draw with; load it first (document.fonts.load) or the first drawing uses the fallback.
 */
export function drawTicket(ctx: Ctx, art: TicketArt, family: string) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  // Paper.
  paperPath(ctx);
  ctx.fillStyle = PAPER;
  ctx.fill();
  ctx.save();
  paperPath(ctx);
  ctx.clip();
  const edge = ctx.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, '#00000014');
  edge.addColorStop(0.08, '#00000000');
  edge.addColorStop(0.92, '#00000000');
  edge.addColorStop(1, '#00000014');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, W, H);
  // A fixed sprinkle of fibres, the same on every ticket.
  let seed = 20261120;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = next() < 0.5 ? '#4a2c4d0d' : '#ffffff2e';
    ctx.fillRect(next() * W, next() * H, 1 + next() * 2.4, 1 + next() * 1.2);
  }
  ctx.restore();

  // The tear line.
  ctx.fillStyle = '#4a2c4d59';
  for (let x = NOTCH + 22; x <= W - NOTCH - 22; x += 17) {
    ctx.beginPath();
    ctx.arc(x, TEAR, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  stitches(ctx, 34, 34, W - 68, TEAR - 30 - 34);
  stitches(ctx, 34, TEAR + 30, W - 68, H - 34 - (TEAR + 30));

  // The plum band with the mark and the name.
  const band = ctx.createLinearGradient(0, 70, 0, 290);
  band.addColorStop(0, '#3a1b3d');
  band.addColorStop(1, PLUM);
  ctx.fillStyle = band;
  roundedRect(ctx, 70, 70, W - 140, 220, 22);
  ctx.fill();
  ctx.font = `600 84px ${family}`;
  const name = 'anonymo';
  const nameWidth = ctx.measureText(name).width;
  const markScale = 4.6;
  const markWidth = 48 * markScale;
  const start = (W - (markWidth + 26 + nameWidth)) / 2;
  maskMark(ctx, start, 180 - 12 * markScale, markScale);
  ctx.fillStyle = '#f6ede4';
  ctx.textAlign = 'left';
  ctx.fillText(name, start + markWidth + 26, 208);

  // The body.
  ctx.fillStyle = INK;
  ctx.font = `600 84px ${family}`;
  spaced(ctx, 'ADMIT ONE', 394, 15, { cx: W / 2 });
  ctx.fillStyle = '#4a2c4d59';
  for (let x = 150; x <= W - 150; x += 15) {
    ctx.beginPath();
    ctx.arc(x, 426, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  const amount = formatUsd(art.amountMusd);
  ctx.textAlign = 'center';
  ctx.fillStyle = AMBER_INK;
  fit(ctx, amount, 600, 188, W - 220, family);
  ctx.fillText(amount, W / 2, 604);
  ctx.fillStyle = INK_SOFT;
  ctx.font = `500 38px ${family}`;
  ctx.fillText('of chat credit', W / 2, 658);
  ctx.fillStyle = INK;
  ctx.font = `600 48px ${family}`;
  ctx.fillText('No account needed', W / 2, 734);

  if (art.qr) drawQr(ctx, art.qr);
  else if (art.stamp) drawStamp(ctx, art.stamp, family);
  else drawQrPlace(ctx, family);
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  ctx.font = `600 34px ${family}`;
  ctx.fillText(art.qr || !art.stamp ? 'Scan to start chatting' : 'Paid for. Ready when you are.', W / 2, 1226);
  ctx.fillStyle = INK_FAINT;
  ctx.font = `500 27px ${family}`;
  ctx.fillText('Anyone holding this ticket can spend it.', W / 2, 1266);

  // The stub.
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `600 50px ${family}`;
  ctx.fillText('18+ adults only', 86, 1452);
  ctx.fillStyle = INK_SOFT;
  ctx.font = `500 30px ${family}`;
  ctx.fillText(expiryLine(art.expiresAt), 86, 1512);
  ctx.fillStyle = INK_FAINT;
  ctx.font = `600 26px ${family}`;
  spaced(ctx, 'ADMIT ONE', 1440, 6, { right: W - 86 });
  ctx.textAlign = 'right';
  ctx.fillStyle = AMBER_INK;
  ctx.font = `600 44px ${family}`;
  ctx.fillText(amount, W - 86, 1512);
  ctx.restore();
}

/** Saves the ticket as a PNG, straight from the canvas. Nothing is uploaded: the browser writes the file itself. */
export function saveTicketPng(canvas: HTMLCanvasElement, fileName: string): Promise<boolean> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve(false);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      resolve(true);
    }, 'image/png');
  });
}
