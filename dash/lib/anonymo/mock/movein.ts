// Update "movein" in the demo gateway. Building a character's memory sends ordinary chat requests: a running summary
// (card.ts's summaryRequest) and one request for short facts. The mock answers them with memory-shaped text instead of
// its stock reply, recognizing each by the marker its system message starts with. The model list also carries text
// prices, as the real gateway's does, so the page can show what a build will cost before it starts.

import { FACTS_MARKER, SUMMARY_MARKER } from '../movein/memory.ts';
import { SAMPLE_MEMORY } from '../movein/sample.ts';

type Message = { role: string; content: unknown };
const asText = (content: unknown) => (typeof content === 'string' ? content : '');
const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** "Name: what they said" lines of a request, newest last. */
function linesOf(log: string): { name: string; said: string }[] {
  const out: { name: string; said: string }[] = [];
  for (const line of log.split('\n')) {
    const m = /^([^:\n]{1,40}): (.+)$/.exec(line);
    if (m) out.push({ name: m[1]!.trim(), said: m[2]!.trim() });
    else if (out.length && line.trim()) out[out.length - 1]!.said += ` ${line.trim()}`;
  }
  return out;
}

const sampleFor = (names: string[]) => names.map((name) => SAMPLE_MEMORY[name]).find(Boolean);

/** The reply to a memory request, or null for any other chat request. */
export function moveInReply(messages: Message[]): string | null {
  const system = asText(messages.find((m) => m.role === 'system')?.content);
  const asked = asText([...messages].reverse().find((m) => m.role === 'user')?.content);
  if (system.startsWith(SUMMARY_MARKER)) {
    const [, before = '', log = ''] = /^Summary so far:\n([\s\S]*?)\n\nNew turns:\n([\s\S]*)$/.exec(asked) ?? [];
    const lines = linesOf(log);
    const names = [...new Set(lines.map((l) => l.name))];
    const sample = sampleFor(names);
    if (sample) return sample.summary;
    const [first, last] = [lines[0], lines.at(-1)];
    const carried = before.trim() && before.trim() !== '(none)' ? `${clip(before.replace(/^Demo summary[^:]*:\s*/, ''), 500)} ` : '';
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? 'The two of you');
    const next = first && last ? `${who} went on: ${first.name} said “${clip(first.said, 90)}”, and it ends with ${last.name} saying “${clip(last.said, 90)}”.` : `${who} went on talking.`;
    return `Demo summary (a real model writes this from the chats): ${carried}${next}`;
  }
  if (system.startsWith(FACTS_MARKER)) {
    const [, summary = '', log = ''] = /^Summary:\n([\s\S]*?)\n\nNewest turns:\n([\s\S]*)$/.exec(asked) ?? [];
    const lines = linesOf(log);
    const names = [...new Set(lines.map((l) => l.name))];
    const sample = sampleFor(names) ?? Object.values(SAMPLE_MEMORY).find((m) => m.summary === summary.trim());
    if (sample) return sample.facts.join('\n');
    const facts = ['Demo facts: a real model picks these out of the chats.'];
    const person = lines.findLast((l) => /^(user|you)$/i.test(l.name)) ?? lines.at(-2);
    const other = lines.findLast((l) => l !== person);
    if (person) facts.push(`${person.name} last wrote: “${clip(person.said, 80)}”`);
    if (other) facts.push(`${other.name} last answered: “${clip(other.said, 80)}”`);
    if (names.length) facts.push(`The newest turns are between ${names.join(' and ')}.`);
    return facts.join('\n');
  }
  return null;
}

/** A micro-USD-per-million-tokens price as the USD-per-token string the gateway lists ("0.00000045"). */
export function perTokenUsd(perMillion: number): string {
  const digits = String(Math.max(0, Math.trunc(perMillion))).padStart(13, '0');
  const whole = digits.slice(0, -12).replace(/^0+(?=\d)/, '');
  const frac = digits.slice(-12).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** The demo model list with each model's text price, in the shape of the gateway's `pricing` (api/models.ts). */
export function withTextPrices<T extends { id: string }>(models: T[], prices: Record<string, { in: number; out: number }>): (T & { pricing?: { prompt: string; completion: string } })[] {
  return models.map((model) => {
    const price = prices[model.id];
    return price ? { ...model, pricing: { prompt: perTokenUsd(price.in), completion: perTokenUsd(price.out) } } : model;
  });
}
