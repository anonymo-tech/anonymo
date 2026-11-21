// Run in the dashboard dev server's browser console:
// await (await import('/scripts/check-plush-browser.mjs')).checkPlushRenderer()
import { BASE_PLUSH, GLASSES, HATS, MARKS, MOUTHS, OUTFITS, SHAPES } from '../lib/anonymo/plush.ts';
import { plushCanvas } from '../lib/anonymo/plush-image.ts';

function pixels(canvas, x = 0, y = 0) {
  return canvas.getContext('2d').getImageData(x, y, 512, 512).data;
}

export async function checkPlushRenderer() {
  const original = pixels(await plushCanvas(BASE_PLUSH, 0));
  for (const [key, choices] of Object.entries({ outfit: OUTFITS, hat: HATS, glasses: GLASSES, shape: SHAPES, mouth: MOUTHS, marks: MARKS })) {
    for (const value of choices.filter(choice => choice !== BASE_PLUSH[key])) {
      const rendered = pixels(await plushCanvas({ ...BASE_PLUSH, [key]: value }, 0));
      if (rendered.every((channel, i) => channel === original[i])) throw new Error(`${key}: ${value} made no visible change`);
    }
  }

  for (const outfit of OUTFITS) {
    const design = { ...BASE_PLUSH, outfit, hat: 'Crown', glasses: 'Round' };
    const before = pixels(await plushCanvas(design, 2));
    const after = pixels(await plushCanvas({ ...design, coat: '#ed3695' }, 2));
    let changed = 0;
    for (let i = 0; i < after.length; i += 4) {
      if (before[i] === after[i] && before[i+1] === after[i+1] && before[i+2] === after[i+2]) continue;
      if (i < 310 * 512 * 4) throw new Error(`${outfit}: outfit dye reached the face`);
      changed++;
    }
    if (changed < 1400) throw new Error(`${outfit}: the fabric did not take the dye`);
  }

  const design = { ...BASE_PLUSH, coat: '#aa3366', hat: 'Western', glasses: 'Hearts', mouth: 'Fangs', shape: 'Pear' };
  const sheet = await plushCanvas(design);
  for (let i = 0; i < 6; i++) {
    const preview = pixels(await plushCanvas(design, i));
    const saved = pixels(sheet, (i % 3) * 512, Math.floor(i / 3) * 512);
    if (preview.some((value, j) => value !== saved[j])) throw new Error(`Sheet differs from preview at expression ${i}`);
  }
  return 'All parts render. Every outfit accepts custom dye. All six saved expressions match the preview.';
}
