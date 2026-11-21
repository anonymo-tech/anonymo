import { dyeFabric, headUrl, partUrl, type Plush } from './plush.ts';

const sources = new Map<string, Promise<HTMLImageElement>>();
function source(url: string) {
  let pending = sources.get(url);
  if (!pending) {
    const img = new Image();
    img.src = url;
    pending = img
      .decode()
      .then(() => img)
      .catch((error: unknown) => {
        sources.delete(url);
        throw error;
      });
    sources.set(url, pending);
  }
  return pending;
}
const SIZE = 512;
function surface(w = SIZE, h = SIZE) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser could not open a canvas.');
  return ctx;
}

function headWidth(shape: Plush['shape'], y: number) {
  const t = Math.min(1, Math.max(0, y / 360));
  const amount = Math.min(1, Math.max(0, (364 - y) / 48));
  const widths = {
    Round: 1,
    Oval: 0.84,
    Broad: 1.13,
    Pear: 0.8 + 0.34 * t,
    Heart: 1.15 - 0.42 * t * t,
  };
  return 1 + amount * (widths[shape] - 1);
}

function cheekDetails(ctx: CanvasRenderingContext2D, marks: Plush['marks']) {
  if (marks === 'Plain') return;
  ctx.save();
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#9b5344';
  ctx.fillStyle = '#a36247';
  ctx.shadowColor = '#5e382771';
  ctx.shadowOffsetY = 1;
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(256 + side * 99, 264);
    ctx.scale(side, 1);
    if (marks === 'Freckles') {
      for (const [x, y, r] of [
        [-8, 2, 3],
        [1, -4, 2.4],
        [10, 3, 3.5],
        [4, 10, 2],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fill();
      }
    } else if (marks === 'Whiskers') {
      for (const slope of [-1, 0, 1]) {
        ctx.beginPath();
        ctx.moveTo(-6, 4 * slope);
        ctx.quadraticCurveTo(7, 5 * slope, 24, 9 * slope);
        ctx.stroke();
      }
    } else if (marks === 'Heart patch') {
      ctx.beginPath();
      ctx.moveTo(0, 12);
      ctx.bezierCurveTo(-21, -2, -10, -16, 0, -7);
      ctx.bezierCurveTo(13, -18, 21, -3, 0, 12);
      ctx.fillStyle = '#bb4960';
      ctx.fill();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = '#f4bfaf';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    } else {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI / 2,
          r = i % 2 ? 5 : 13;
        const x = r * Math.cos(a),
          y = r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = '#dda443';
      ctx.fill();
      ctx.strokeStyle = '#825a36';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

// Use the photographed mouth for each mood, including its felt texture. Fade the surrounding
// felt into the face so resizing a smile never brings a rectangular patch along with it.
function mouthLayer(
  ctx: CanvasRenderingContext2D,
  style: Plush['mouth'],
  mood: number,
) {
  if (style === 'Classic') return;
  const patch = surface(146, 92);
  patch.drawImage(ctx.canvas, 183, 240, 146, 92, 0, 0, 146, 92);
  const blank = surface(146, 92);
  blank.drawImage(ctx.canvas, 163, 262, 45, 60, 0, 0, 146, 92);
  const feather = (layer: CanvasRenderingContext2D) => {
    layer.save();
    layer.scale(73, 46);
    const g = layer.createRadialGradient(1, 1, 0.82, 1, 1, 1);
    g.addColorStop(0, '#000');
    g.addColorStop(1, 'transparent');
    layer.globalCompositeOperation = 'destination-in';
    layer.fillStyle = g;
    layer.fillRect(0, 0, 2, 2);
    layer.restore();
  };
  feather(blank);
  feather(patch);
  ctx.drawImage(blank.canvas, 183, 240);
  ctx.save();
  ctx.translate(256, 286);
  if (style === 'Tiny') ctx.scale(0.6, 0.66);
  if (style === 'Wide') ctx.scale(1.36, 1.12);
  if (style === 'Crooked') {
    ctx.rotate(-0.16);
    ctx.scale(1.03, 0.87);
  }
  ctx.drawImage(patch.canvas, -73, -46);
  ctx.restore();
  if (style === 'Fangs') {
    const y = [281, 268, 282, 285, 277, 286][mood];
    ctx.fillStyle = '#fff0d2';
    ctx.strokeStyle = '#69483b';
    ctx.lineWidth = 1.4;
    for (const x of [232, 279]) {
      ctx.beginPath();
      ctx.moveTo(x - 4, y);
      ctx.lineTo(x + 4, y);
      ctx.quadraticCurveTo(x + 3, y + 7, x - 1, y + 12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  if (style === 'Cat stitch') {
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#402d26';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(249, 255);
    ctx.quadraticCurveTo(256, 260, 263, 255);
    ctx.lineTo(256, 266);
    ctx.closePath();
    ctx.fillStyle = '#825649';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(256, 266);
    ctx.lineTo(256, mood === 1 ? 266 : 274);
    ctx.stroke();
  }
}

const hatSize: Partial<Record<Plush['hat'], [number, number, number]>> = {
  Beanie: [350, 154, 153],
  Western: [446, 160, 150],
  Beret: [382, 153, 151],
  Skipper: [354, 163, 152],
  Crown: [321, 149, 145],
  Ballcap: [401, 148, 150],
};

export async function plushCanvas(
  plush: Plush,
  mood?: number,
): Promise<HTMLCanvasElement> {
  if (mood === undefined) {
    const sheet = surface(SIZE * 3, SIZE * 2);
    for (let i = 0; i < 6; i++) {
      const tile = await plushCanvas(plush, i);
      sheet.drawImage(tile, (i % 3) * SIZE, Math.floor(i / 3) * SIZE);
    }
    return sheet.canvas;
  }
  const head =
    plush.hat === 'Flight helmet'
      ? 'pilot'
      : plush.hat === 'Star cap'
        ? 'stargazer'
        : 'captain';
  const fit = hatSize[plush.hat];
  const [atlas, outfit, hat, glasses] = await Promise.all([
    source(headUrl(head)),
    source(partUrl('outfit', plush.outfit)),
    fit ? source(partUrl('hat', plush.hat)) : null,
    plush.glasses === 'None' ? null : source(partUrl('glasses', plush.glasses)),
  ]);
  const tile = surface();
  tile.drawImage(
    atlas,
    (mood % 3) * SIZE,
    Math.floor(mood / 3) * SIZE,
    SIZE,
    SIZE,
    0,
    0,
    SIZE,
    SIZE,
  );
  tile.drawImage(outfit, 0, 319);
  mouthLayer(tile, plush.mouth, mood);
  const frame = tile.getImageData(0, 0, SIZE, SIZE);
  dyeFabric(frame.data, SIZE, SIZE, plush);
  tile.putImageData(frame, 0, 0);
  cheekDetails(tile, plush.marks);
  if (hat && fit) {
    const [w, h, bottom] = fit;
    tile.drawImage(hat, (SIZE - w) / 2, bottom - h, w, h);
  }
  if (glasses) {
    const w = 350,
      h = (w * glasses.height) / glasses.width;
    tile.drawImage(glasses, (SIZE - w) / 2, 194 - h / 2, w, h);
  }
  if (plush.shape === 'Round') return tile.canvas;
  const out = surface();
  // Extend the studio backdrop on either side of a narrower face.
  out.drawImage(tile.canvas, 0, 0, 12, SIZE, 0, 0, SIZE, SIZE);
  for (let y = 0; y < 364; y++) {
    const w = SIZE * headWidth(plush.shape, y);
    out.drawImage(tile.canvas, 0, y, SIZE, 1, (SIZE - w) / 2, y, w, 1);
  }
  out.drawImage(
    tile.canvas,
    0,
    364,
    SIZE,
    SIZE - 364,
    0,
    364,
    SIZE,
    SIZE - 364,
  );
  return out.canvas;
}
export const plushBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b
          ? resolve(b)
          : reject(new Error('This browser could not save the picture.')),
      'image/png',
    ),
  );
