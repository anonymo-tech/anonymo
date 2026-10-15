'use client';

import { memo, type ReactNode } from 'react';
import { CodeClip } from './code-clip';
import './research-markdown.css';

/** Model output is untrusted. Only explicit HTTPS links become interactive. */
export function safeResearchHref(value: string): string | null {
  if (value.length > 2048 || /[\s\\]/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A small display-only Markdown subset. Raw HTML and images stay literal text. */
function inline(text: string, depth = 0): ReactNode {
  if (depth > 4) return text;
  const parts: ReactNode[] = [];
  const markers = /\\[\\`*{}[\]()#+.!_|>-]|`+|\*\*|__|\*|_|!?\[/g;
  const unmatched = new Set<string>();
  let cursor = 0;
  for (let match; (match = markers.exec(text)); ) {
    const marker = match[0], start = match.index;
    if (unmatched.has(marker)) continue;
    let finish = -1;
    let node: ReactNode;
    const key = start;
    if (marker[0] === '\\') {
      finish = start + marker.length;
      node = marker.slice(1);
    } else if (marker[0] === '`') {
      const end = text.indexOf(marker, start + marker.length);
      if (end < 0) { unmatched.add(marker); continue; }
      finish = end + marker.length;
      node = <code key={key}>{text.slice(start + marker.length, end)}</code>;
    } else if (marker.endsWith('[')) {
      const labelEnd = text.indexOf('](', start + marker.length);
      if (labelEnd < 0) { unmatched.add(marker); continue; }
      // Only consume a link with one label and a bounded, balanced destination.
      const nestedLabel = text.lastIndexOf('[', labelEnd);
      if (nestedLabel >= start + marker.length) { markers.lastIndex = nestedLabel; continue; }
      let end = labelEnd + 2, nesting = 1;
      for (; end < text.length && end - labelEnd < 2051; end++) {
        if (text[end] === '(') nesting++;
        else if (text[end] === ')' && --nesting === 0) break;
      }
      if (nesting) continue;
      finish = end + 1;
      const destination = text.slice(labelEnd + 2, end);
      const href = safeResearchHref(destination);
      const label = text.slice(start + marker.length, labelEnd);
      node = marker === '![' || !href
        ? text.slice(start, finish)
        : <a key={key} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{inline(label, depth + 1)}</a>;
    } else {
      const begin = start + marker.length;
      if (/\s/.test(text[begin] ?? '') || (marker[0] === '_' && /[\p{L}\p{N}]/u.test(text[start - 1] ?? ''))) continue;
      const end = text.indexOf(marker, begin);
      if (end < 0) { unmatched.add(marker); continue; }
      if (end === begin || /\s/.test(text[end - 1])) continue;
      finish = end + marker.length;
      node = marker.length === 2
        ? <strong key={key}>{inline(text.slice(begin, end), depth + 1)}</strong>
        : <em key={key}>{inline(text.slice(begin, end), depth + 1)}</em>;
    }
    parts.push(text.slice(cursor, start), node);
    cursor = finish;
    markers.lastIndex = finish;
  }
  parts.push(text.slice(cursor));
  return parts;
}

function cells(line: string): string[] {
  const result: string[] = [];
  let value = '', ticks = 0;
  const source = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\' && source[index + 1] === '|') { value += '|'; index++; }
    else if (char === '`') {
      const count = /^`+/.exec(source.slice(index))![0].length;
      ticks = ticks === count ? 0 : ticks || count;
      value += '`'.repeat(count);
      index += count - 1;
    } else if (char === '|' && !ticks) { result.push(value.trim()); value = ''; }
    else value += char;
  }
  result.push(value.trim());
  return result;
}

const listItem = /^( *)([-+*]|\d{1,9}[.)])\s+(.*)$/;
const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const fence = /^ {0,3}(`{3,}|~{3,})([^\s`]*)\s*$/;
const rule = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
function tableAlignment(line: string) {
  const columns = cells(line);
  return columns.length >= 2 && columns.every((column) => /^:?-{3,}:?$/.test(column))
    ? columns.map((column) => column.startsWith(':') && column.endsWith(':') ? 'center' : column.endsWith(':') ? 'right' : 'left') as ('left' | 'right' | 'center')[]
    : null;
}

function blocks(lines: string[], depth = 0, codeCopy = false): ReactNode[] {
  if (depth > 6) return [<p key="plain">{inline(lines.join('\n'))}</p>];
  const result: ReactNode[] = [];
  const startsBlock = (index: number) => !lines[index]?.trim() || heading.test(lines[index]) || fence.test(lines[index]) || rule.test(lines[index]) || listItem.test(lines[index]) || /^ {0,3}>/.test(lines[index]) || (lines[index].includes('|') && !!tableAlignment(lines[index + 1] ?? ''));
  let index = 0;
  while (index < lines.length) {
    const line = lines[index], key = index;
    if (!line.trim()) { index++; continue; }
    const code = fence.exec(line);
    if (code) {
      const body: string[] = [];
      index++;
      const close = new RegExp(`^ {0,3}${code[1][0]}{${code[1].length},}\\s*$`);
      while (index < lines.length && !close.test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index++;
      result.push(codeCopy ? <CodeClip key={key} code={body.join('\n')} language={code[2]} /> : <pre key={key}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      const level = Math.min(title[1].length + 1, 4);
      const content = inline(title[2]);
      result.push(level === 2 ? <h2 key={key}>{content}</h2> : level === 3 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>);
      index++;
      continue;
    }
    if (rule.test(line)) { result.push(<hr key={key} />); index++; continue; }
    const alignment = line.includes('|') ? tableAlignment(lines[index + 1] ?? '') : null;
    if (alignment) {
      const headers = cells(line);
      if (headers.length === alignment.length) {
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].includes('|')) rows.push(cells(lines[index++]));
        result.push(<div className="fomo-markdown-table" key={key} role="region" aria-label="Analysis evidence table" tabIndex={0}>
          <table><thead><tr>{headers.map((cell, column) => <th key={column} scope="col" style={{ textAlign: alignment[column] }}>{inline(cell)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, column) => <td key={column} style={{ textAlign: alignment[column] }}>{inline(column === headers.length - 1 ? row.slice(column).join(' | ') : row[column] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>);
        continue;
      }
    }
    const firstItem = listItem.exec(line);
    if (firstItem) {
      const indent = firstItem[1].length, ordered = /^\d/.test(firstItem[2]);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = listItem.exec(lines[index]);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
        const itemKey = index++, content = [item[3]];
        const contentIndent = item[1].length + item[2].length + 1;
        while (index < lines.length && lines[index].trim()) {
          const leading = lines[index].match(/^ */)?.[0].length ?? 0;
          if (leading <= indent) break;
          content.push(lines[index++].slice(Math.min(contentIndent, leading)));
        }
        items.push(<li key={itemKey}>{blocks(content, depth + 1, codeCopy)}</li>);
      }
      result.push(ordered ? <ol key={key} start={Number.parseInt(firstItem[2], 10)}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^ {0,3}> ?/, ''));
      result.push(<blockquote key={key}>{blocks(quote, depth + 1, codeCopy)}</blockquote>);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && !startsBlock(index)) paragraph.push(lines[index++]);
    result.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
  }
  return result;
}

export const ResearchMarkdown = memo(function ResearchMarkdown({ text, codeCopy = false }: { text: string; codeCopy?: boolean }) {
  return <div className="fomo-markdown">{blocks(text.replace(/\r\n?/g, '\n').split('\n'), 0, codeCopy)}</div>;
});
