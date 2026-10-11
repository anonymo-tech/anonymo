import {
  parseSynthesisAnalysis,
  type BriefSynthesisAnalysis,
} from './brief-synthesis.ts';

export type BriefEvidence = {
  callId: string;
  comparisonId: string;
  routeVersionId: string;
  modelId: string;
  question: string;
  answer: string;
  answerHash: string;
  actualUsd6: string | null;
  billingState:
    | 'captured'
    | 'released'
    | 'reconciliation_pending'
    | 'held'
    | 'running';
};

export type BriefAnalysis = {
  decision: string;
  notes: { callId: string; text: string }[];
  matrix: {
    topic: string;
    positions: {
      callId: string;
      position: 'agrees' | 'disagrees' | 'unclear';
    }[];
  }[];
};

export type BriefDocument = {
  version: 1;
  savedAt: string;
  evidenceHash: string;
  evidence: BriefEvidence[];
  analysis: BriefAnalysis;
  synthesis?: BriefGeneratedSynthesis;
};

export type BriefGeneratedSynthesis = {
  runId: string;
  callId: string;
  routeVersionId: string;
  modelId: string;
  evidenceHash: string;
  promptVersion: 1;
  outputVersion: 1;
  createdAt: string;
  outputHash: string;
  maximumUsd6: string;
  actualUsd6: string | null;
  billingState: BriefEvidence['billingState'];
  analysis: BriefSynthesisAnalysis;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_BRIEF_DOCUMENT');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.trim())
  )
    throw new Error('INVALID_BRIEF_DOCUMENT');
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new Error('INVALID_BRIEF_DOCUMENT');
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error('INVALID_BRIEF_DOCUMENT');
  return value;
}

export function parseBriefGeneratedSynthesis(
  value: unknown,
  evidence: readonly BriefEvidence[],
  evidenceHash: string,
): BriefGeneratedSynthesis {
  const r = object(value);
  const money = (value: unknown): value is string =>
    typeof value === 'string' && /^(0|[1-9]\d{0,14})$/.test(value);
  if (
    r.evidenceHash !== evidenceHash ||
    !hash.test(evidenceHash) ||
    r.promptVersion !== 1 ||
    r.outputVersion !== 1 ||
    typeof r.outputHash !== 'string' ||
    !hash.test(r.outputHash) ||
    typeof r.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(r.createdAt) ||
    !r.createdAt.endsWith('Z') ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    !money(r.maximumUsd6) ||
    (r.actualUsd6 !== null && !money(r.actualUsd6)) ||
    ![
      'captured',
      'released',
      'reconciliation_pending',
      'held',
      'running',
    ].includes(String(r.billingState)) ||
    (r.billingState === 'captured' || r.billingState === 'released') !==
      (r.actualUsd6 !== null) ||
    (r.actualUsd6 !== null &&
      BigInt(r.actualUsd6 as string) > BigInt(r.maximumUsd6 as string)) ||
    (r.billingState === 'released' && r.actualUsd6 !== '0') ||
    evidence.some((source) => source.callId === r.callId)
  )
    throw new Error('INVALID_BRIEF_DOCUMENT');
  return {
    runId: id(r.runId),
    callId: id(r.callId),
    routeVersionId: id(r.routeVersionId),
    modelId: text(r.modelId, 300),
    evidenceHash,
    promptVersion: 1,
    outputVersion: 1,
    createdAt: r.createdAt,
    outputHash: r.outputHash,
    maximumUsd6: r.maximumUsd6 as string,
    actualUsd6: r.actualUsd6 as string | null,
    billingState: r.billingState as BriefEvidence['billingState'],
    analysis: parseSynthesisAnalysis(r.analysis, evidence),
  };
}

export function parseBriefAnalysis(
  value: unknown,
  callIds: string[],
): BriefAnalysis {
  const r = object(value),
    ids = new Set(callIds);
  const notes = array(r.notes, 4).map((value) => {
    const n = object(value),
      callId = id(n.callId);
    if (!ids.has(callId)) throw new Error('INVALID_BRIEF_DOCUMENT');
    return { callId, text: text(n.text, 1600, true) };
  });
  if (new Set(notes.map((n) => n.callId)).size !== notes.length)
    throw new Error('INVALID_BRIEF_DOCUMENT');
  const matrix = array(r.matrix, 8).map((value) => {
    const row = object(value);
    const positions = array(row.positions, 4).map((value) => {
      const cell = object(value),
        callId = id(cell.callId);
      if (
        !ids.has(callId) ||
        !['agrees', 'disagrees', 'unclear'].includes(String(cell.position))
      )
        throw new Error('INVALID_BRIEF_DOCUMENT');
      return {
        callId,
        position: cell.position as 'agrees' | 'disagrees' | 'unclear',
      };
    });
    if (
      positions.length !== ids.size ||
      new Set(positions.map((p) => p.callId)).size !== ids.size
    )
      throw new Error('INVALID_BRIEF_DOCUMENT');
    return { topic: text(row.topic, 240), positions };
  });
  return { decision: text(r.decision, 4000, true), notes, matrix };
}

export function parseBriefDocument(value: unknown): BriefDocument {
  const r = object(value);
  if (
    r.version !== 1 ||
    typeof r.savedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(r.savedAt) ||
    !r.savedAt.endsWith('Z') ||
    !Number.isFinite(Date.parse(r.savedAt)) ||
    typeof r.evidenceHash !== 'string' ||
    !hash.test(r.evidenceHash)
  )
    throw new Error('INVALID_BRIEF_DOCUMENT');
  let length = 0;
  const evidence = array(r.evidence, 4).map((value) => {
    const e = object(value),
      question = text(e.question, 32768),
      answer = text(e.answer, 24000);
    length += question.length + answer.length;
    if (
      typeof e.answerHash !== 'string' ||
      !hash.test(e.answerHash) ||
      (e.actualUsd6 !== null &&
        (typeof e.actualUsd6 !== 'string' ||
          !/^(0|[1-9]\d{0,14})$/.test(e.actualUsd6))) ||
      ![
        'captured',
        'released',
        'reconciliation_pending',
        'held',
        'running',
      ].includes(String(e.billingState))
    )
      throw new Error('INVALID_BRIEF_DOCUMENT');
    if (
      (e.billingState === 'captured' || e.billingState === 'released') !==
      (e.actualUsd6 !== null)
    )
      throw new Error('INVALID_BRIEF_DOCUMENT');
    return {
      callId: id(e.callId),
      comparisonId: id(e.comparisonId),
      routeVersionId: id(e.routeVersionId),
      modelId: text(e.modelId, 300),
      question,
      answer,
      answerHash: e.answerHash,
      actualUsd6: e.actualUsd6 as string | null,
      billingState: e.billingState as BriefEvidence['billingState'],
    };
  });
  if (
    !evidence.length ||
    length > 24000 ||
    new Set(evidence.map((e) => e.callId)).size !== evidence.length
  )
    throw new Error('INVALID_BRIEF_DOCUMENT');
  return {
    version: 1,
    savedAt: r.savedAt,
    evidenceHash: r.evidenceHash,
    evidence,
    analysis: parseBriefAnalysis(
      r.analysis,
      evidence.map((e) => e.callId),
    ),
    ...(r.synthesis === undefined
      ? {}
      : {
          synthesis: parseBriefGeneratedSynthesis(
            r.synthesis,
            evidence,
            r.evidenceHash,
          ),
        }),
  };
}

const quote = (value: string) =>
  value
    .split('\n')
    .map((line) => `> ${inline(line)}`)
    .join('\n');
const inline = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_{}[\]()#+.!|<>~=:-]/g, '\\$&')
    .replace(/[\r\n]/g, ' ');
function dollars(value: string) {
  const n = BigInt(value);
  return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0')}`;
}

export function renderBriefMarkdown(
  title: string,
  document: BriefDocument,
): string {
  const d = parseBriefDocument(document);
  const lines = [
    `# ${inline(title)}`,
    '',
    `Saved: ${d.savedAt}`,
    `Evidence SHA-256: ${d.evidenceHash}`,
    '',
    d.synthesis
      ? 'This saved snapshot contains the selected model responses. Owner notes, decisions and assessments remain separate from generated analysis. These are not independently verified consensus.'
      : 'This saved snapshot contains the selected model responses. Notes, decisions and agreement assessments are written by the account owner; they are not independently verified consensus.',
    '',
    '## Decision',
    '',
    quote(d.analysis.decision || 'No decision recorded.'),
    '',
    '## Agreement matrix',
  ];
  if (d.analysis.matrix.length) {
    lines.push(
      '',
      `| Topic | ${d.evidence.map((e) => inline(e.modelId)).join(' | ')} |`,
      `| --- | ${d.evidence.map(() => '---').join(' | ')} |`,
    );
    for (const row of d.analysis.matrix)
      lines.push(
        `| ${inline(row.topic)} | ${d.evidence.map((e) => row.positions.find((p) => p.callId === e.callId)!.position).join(' | ')} |`,
      );
  } else lines.push('', 'No assessment recorded.');
  lines.push(...generatedMarkdown(d));
  for (const evidence of d.evidence) {
    const note = d.analysis.notes.find(
      (n) => n.callId === evidence.callId,
    )?.text;
    lines.push(
      '',
      `## ${inline(evidence.modelId)}`,
      '',
      '### Your summary / notes',
      '',
      quote(note || 'No notes recorded.'),
      '',
      '### Question',
      '',
      quote(evidence.question),
      '',
      '### Original response',
      '',
      quote(evidence.answer),
      '',
      `Call: ${evidence.callId}`,
      `Comparison: ${evidence.comparisonId}`,
      `Route version: ${evidence.routeVersionId}`,
      `Response SHA-256: ${evidence.answerHash}`,
      `Usage at save: ${evidence.actualUsd6 === null ? 'Pending reconciliation' : `$${dollars(evidence.actualUsd6)}`}`,
      `Billing state at save: ${evidence.billingState}`,
    );
  }
  lines.push(
    '',
    'Model text is source material, not a verified citation. Receipt linkage uses the call ID; a snapshot hash is not an onchain proof.',
    '',
  );
  return lines.join('\n');
}

/** Self-contained print document: source strings are escaped, never interpreted as markup. */
export function renderBriefPrintHtml(
  title: string,
  document: BriefDocument,
): string {
  const d = parseBriefDocument(document);
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]!,
    );
  const paragraph = (value: string) => `<p class="text">${escape(value)}</p>`;
  const matrix = d.analysis.matrix.length
    ? `<table><thead><tr><th>Topic</th>${d.evidence.map((e) => `<th>${escape(e.modelId)}</th>`).join('')}</tr></thead><tbody>${d.analysis.matrix.map((row) => `<tr><th>${escape(row.topic)}</th>${d.evidence.map((e) => `<td>${row.positions.find((p) => p.callId === e.callId)!.position}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : paragraph('No assessment recorded.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>@page{margin:20mm}*{box-sizing:border-box}body{max-width:800px;margin:40px auto;color:#171713;background:white;font:14px/1.6 system-ui,sans-serif}h1{font:36px/1.1 Georgia,serif}h2{font-size:21px;margin-top:32px}h3{font-size:14px;margin-top:22px}p,td,th{overflow-wrap:anywhere}.text{white-space:pre-wrap}small,.meta{font-size:11px;color:#555}.meta{font-family:monospace}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:8px;border:1px solid #ddd;text-align:left}blockquote{margin:0;border-left:2px solid #ddd;padding-left:16px}h1,h2,h3{break-after:avoid}.notice{border-top:1px solid #ddd;padding-top:16px}@media print{body{margin:0;max-width:none}}</style></head><body><small>CONCLAVE · SAVED BRIEF</small><h1>${escape(title)}</h1><p class="meta">Saved ${escape(d.savedAt)}<br>Evidence SHA-256 ${d.evidenceHash}</p><p>${d.synthesis ? 'Owner notes, decisions and assessments remain separate from generated analysis. These are not independently verified consensus.' : 'Notes, decisions and agreement assessments are written by the account owner. They are not independently verified consensus.'}</p><h2>Decision</h2>${paragraph(d.analysis.decision || 'No decision recorded.')}<h2>Agreement matrix</h2>${matrix}${generatedPrintHtml(d, escape, paragraph)}${d.evidence.map((e) => `<section><h2>${escape(e.modelId)}</h2><h3>Your summary / notes</h3>${paragraph(d.analysis.notes.find((n) => n.callId === e.callId)?.text || 'No notes recorded.')}<h3>Question</h3>${paragraph(e.question)}<h3>Original response</h3><blockquote>${paragraph(e.answer)}</blockquote><p class="meta">Call ${e.callId}<br>Comparison ${e.comparisonId}<br>Route version ${e.routeVersionId}<br>Response SHA-256 ${e.answerHash}<br>Usage at save ${e.actualUsd6 === null ? 'Pending reconciliation' : `$${dollars(e.actualUsd6)}`} · ${e.billingState}</p></section>`).join('')}<p class="notice">Model text is source material, not a verified citation. Receipt linkage uses the call ID; a snapshot hash is not an onchain proof.</p></body></html>`;
}

function sourceLabel(document: BriefDocument, callId: string): string {
  const index = document.evidence.findIndex(
    (source) => source.callId === callId,
  );
  return `Response ${index + 1} · ${document.evidence[index].modelId}`;
}

function generatedMarkdown(document: BriefDocument): string[] {
  const generated = document.synthesis;
  if (!generated) return [];
  const lines = [
    '',
    '## Generated analysis',
    '',
    `Analyst model: ${inline(generated.modelId)}`,
    `Generated: ${generated.createdAt}`,
    `Analysis charge: ${generated.actualUsd6 === null ? 'Pending reconciliation' : `$${dollars(generated.actualUsd6)}`}`,
    `Approved maximum: $${dollars(generated.maximumUsd6)}`,
    `Billing state: ${generated.billingState}`,
    '',
    'This separate model assessment uses the saved responses. Matching quotes establish where text came from; they do not verify the assessment or the source claims.',
  ];
  for (const summary of generated.analysis.summaries) {
    lines.push(
      '',
      `### ${inline(sourceLabel(document, summary.callId))}`,
      '',
      quote(summary.text),
    );
    for (const citation of summary.quotes)
      lines.push(
        '',
        `Source call: ${summary.callId} · UTF-16 range [${citation.start}, ${citation.end})`,
        quote(citation.text),
      );
  }
  lines.push('', '### Generated agreement assessment');
  for (const row of generated.analysis.matrix) {
    lines.push('', `#### ${inline(row.topic)}`);
    for (const evidence of document.evidence) {
      const cell = row.positions.find(
        (position) => position.callId === evidence.callId,
      )!;
      lines.push(
        '',
        `${inline(sourceLabel(document, evidence.callId))}: ${cell.position}`,
      );
      if (cell.quote)
        lines.push(
          `Source call: ${cell.callId} · UTF-16 range [${cell.quote.start}, ${cell.quote.end})`,
          quote(cell.quote.text),
        );
      else lines.push('No supporting quote supplied.');
    }
  }
  lines.push(
    '',
    `Analysis run: ${generated.runId}`,
    `Analysis call: ${generated.callId}`,
    `Analysis route version: ${generated.routeVersionId}`,
    `Output SHA-256: ${generated.outputHash}`,
    `Source evidence SHA-256: ${generated.evidenceHash}`,
    `Prompt version: ${generated.promptVersion} · Output version: ${generated.outputVersion}`,
  );
  return lines;
}

function generatedPrintHtml(
  document: BriefDocument,
  escape: (value: string) => string,
  paragraph: (value: string) => string,
): string {
  const generated = document.synthesis;
  if (!generated) return '';
  const citation = (
    callId: string,
    item: { text: string; start: number; end: number },
  ) =>
    `<blockquote>${paragraph(item.text)}</blockquote><p class="meta">Source call ${callId} · UTF-16 range [${item.start}, ${item.end})</p>`;
  return `<section><h2>Generated analysis</h2><p>Analyst model: ${escape(generated.modelId)}<br>Generated ${escape(generated.createdAt)}<br>Analysis charge: ${generated.actualUsd6 === null ? 'Pending reconciliation' : `$${dollars(generated.actualUsd6)}`} · ${generated.billingState}<br>Approved maximum: $${dollars(generated.maximumUsd6)}</p><p>This separate model assessment uses the saved responses. Matching quotes establish where text came from; they do not verify the assessment or the source claims.</p>${generated.analysis.summaries.map((summary) => `<h3>${escape(sourceLabel(document, summary.callId))}</h3>${paragraph(summary.text)}${summary.quotes.map((item) => citation(summary.callId, item)).join('')}`).join('')}<h3>Generated agreement assessment</h3>${generated.analysis.matrix
    .map(
      (row) =>
        `<h3>${escape(row.topic)}</h3>${document.evidence
          .map((source) => {
            const cell = row.positions.find(
              (item) => item.callId === source.callId,
            )!;
            return `<p><strong>${escape(sourceLabel(document, source.callId))}</strong>: ${cell.position}</p>${cell.quote ? citation(cell.callId, cell.quote) : paragraph('No supporting quote supplied.')}`;
          })
          .join('')}`,
    )
    .join(
      '',
    )}<p class="meta">Analysis run ${generated.runId}<br>Analysis call ${generated.callId}<br>Analysis route version ${generated.routeVersionId}<br>Output SHA-256 ${generated.outputHash}<br>Source evidence SHA-256 ${generated.evidenceHash}<br>Prompt version ${generated.promptVersion} · Output version ${generated.outputVersion}</p></section>`;
}
