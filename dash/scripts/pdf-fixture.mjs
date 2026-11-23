// A minimal PDF writer for tests: Helvetica text placed at exact positions, one or more pages, optional /Rotate.
// Used to build two-column pages, repeated phrases and empty pages without a binary fixture in the repo.

/** pages: [{ width?, height?, rotate?, texts: [{ x, y, size?, text }] }] with PDF coordinates (origin bottom-left). */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null), tree = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const page of pages) {
    const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream = page.texts.map((t) => `BT /F1 ${t.size ?? 11} Tf ${t.x} ${t.y} Td (${esc(t.text)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${page.width ?? 612} ${page.height ?? 792}]${page.rotate ? ` /Rotate ${page.rotate}` : ''} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info << /Title (Fixture) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** Left column at x=50, right column at x=320, same baselines: the case a naive line grouping gets wrong. */
export function twoColumnPage(left, right, { top = 720, step = 18 } = {}) {
  return {
    texts: [
      ...left.map((text, i) => ({ x: 50, y: top - i * step, text })),
      ...right.map((text, i) => ({ x: 320, y: top - i * step, text })),
    ],
  };
}
