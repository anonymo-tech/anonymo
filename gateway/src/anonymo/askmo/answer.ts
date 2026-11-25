import { isIP } from "node:net";
import { redactText } from "../../gateway/guardrails.ts";
import { ApiError } from "../../lib/errors.ts";
import { runWebSearch, searchQueryOf, type WebSearchUse } from "../search/chat.ts";
import type { WebSearchService } from "../search/types.ts";
import { CHECKLIST, REGION_NOTES, type Topic } from "./packs.ts";

/** Search receives a bounded query with no request metadata. Strip recognizable identifiers the caller typed, too. */
export function askMoQuery(question: string): string {
  const withoutIds = redactText(question).text
    .replace(/\[REDACTED_\w+\]/g, " ")
    .replace(/https?:\/\/\S+|\b(?:anm|anon)_live_[\w-]+\b|\b0x[\da-f]{40}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<!\w)@[\w.-]+/gi, " ")
    .replace(/(?<![\w:])[a-f\d:]*:[a-f\d:]+(?:%[\w-]+)?(?![\w:])/gi, (word) => isIP(word) ? " " : word);
  return searchQueryOf({ messages: [{ role: "user", content: withoutIds }] });
}

export function askMoServices(primary?: WebSearchService | null, fallback?: WebSearchService | null): WebSearchService[] {
  const available = [primary, fallback].filter((service): service is WebSearchService => !!service);
  return available.sort((a, b) => Number(b.provider === "brave") - Number(a.provider === "brave"))
    .filter((service, index, services) => services.findIndex((other) => other.provider === service.provider) === index);
}

export async function runAskMoSearch(use: WebSearchUse, services: WebSearchService[], signal: AbortSignal) {
  let error: unknown;
  let empty = false;
  const cap = use.maxResults;
  for (const service of services) {
    signal.throwIfAborted();
    use.service = service;
    use.maxResults = Math.min(cap, service.maxResults);
    try {
      await runWebSearch(use, signal);
      if (use.results?.length) return;
      empty = true;
    } catch (e) {
      error = e;
    }
  }
  if (empty) throw new ApiError(502, "The search found no usable sources. Try rephrasing your question.", "ask_mo_no_sources");
  throw error;
}

const SOURCE = /\[(\d+)\]/g;
const FIELDS = [CHECKLIST, REGION_NOTES];
const CREATIVE = /^(?:please\s+)?(?:write|draft|rewrite|compose)\s+(?:me\s+)?(?:a|an|my|this)\s+(?:(?:short|brief|polite|friendly)\s+)?(?:message|note|letter|poem|script|email)\b/i;

/** Treat general and mixed questions as factual. Allow uncited wording for explicit drafting requests. */
export function needsCitations(question: string): boolean {
  return !CREATIVE.test(question) || /\?|\b(?:whether|why|explain|research|fact|facts|law|legal|tax|diagnos\w*|statistic\w*)\b/i.test(question);
}

export function checkedAnswer(text: string, question: string, sourceCount: number, topic: Topic | null): string {
  const factual = needsCitations(question);
  const sections: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.trim().replace(/^#{1,6}\s+/, "").replace(/^\*\*(.*?)\*\*$/, "$1").replace(/:$/, "");
    const field = FIELDS.find((name) => name.toLowerCase() === heading.toLowerCase());
    if (field) {
      if (topic) sections.push({ heading: `## ${field}`, lines: [] });
      continue;
    }
    // Link labels and escaped brackets cannot stand in for a numbered citation.
    const clean = line.replace(/!?\[[^\]\r\n]*\]\([^\r\n)]*\)|\\\[\d+\]/g, "")
      .replace(SOURCE, (marker, n: string) => Number(n) >= 1 && Number(n) <= sourceCount && n === String(Number(n)) ? marker : "")
      .replace(/([.!?])\s+((?:\[\d+\]\s*)+)/g, (_, end: string, refs: string) => ` ${refs.trimEnd()}${end} `)
      .trim();
    const sentences = clean.split(/(?<=[.!?。！？])\s+|(?<=[。！？])/u)
      .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence.replace(SOURCE, "")) && (!factual || /\[\d+\]/.test(sentence)));
    if (sentences.length) sections.at(-1)!.lines.push(sentences.join(" "));
    else if (!line.trim()) sections.at(-1)!.lines.push("");
  }
  return sections.map(({ heading, lines }) => {
    const content = lines.join("\n").trim();
    return content && (heading ? `${heading}\n${content}` : content);
  }).filter(Boolean).join("\n\n");
}

// Custom upstream finish strings can contain arbitrary provider text.
const FINISH_REASONS = new Set(["stop", "length", "content_filter", "tool_calls", "function_call"]);
export const safeAskMoFinish = (value: unknown) => typeof value === "string" && FINISH_REASONS.has(value) ? value : null;
