// Update "sidebyside": what the demo gateway adds for Side by Side. Each direct model id gets its own demo answer, so
// three columns read differently; a merge request gets a merged-shaped reply; and every demo model lists its price
// (fixtures.ts), as the gateway's /v1/models does. A prompt with the word "reroute" is still refused and rerouted
// only for anonymo-1 (gateway.ts), and a merge request ends with its instruction, so one column shows the stamp beside
// two plain answers. Every sentence here is sample text: no model runs.

import { MERGE_INSTRUCTION } from '../sidebyside.ts';
import type { ChatMessage, ModelInfo } from '../types.ts';

// Nothing here may import fixtures.ts: fixtures.ts imports listPricing from this file.

/** A direct model's demo answer, and how the demo merge describes it under "Where they differed". */
const VOICES: Record<string, { text: string; differed: string }> = {
  'qwen3.5-27b-abliterated': {
    text: [
      'This is a demo answer from the mock gateway, in the column for qwen3.5-27b-abliterated. No model ran and nothing left your device.',
      'Live, this column streams that model’s own answer while the other two write theirs:\n1. Each column is a separate request with its own signed receipt.\n2. Each is charged for its own length.\n3. A model that says no costs nothing.',
    ].join('\n\n'),
    differed: 'set it out as three numbered points.',
  },
  'glm-5.2-abliterated': {
    text: [
      'Demo answer from the mock gateway, in the column for glm-5.2-abliterated. Nothing was sent anywhere.',
      'Against the live gateway you would read three different takes on your question here, from three model families, and see where they disagree before you trust any one of them. When you want a single answer, merge them: it keeps what they agree on and lists where they differed.',
    ].join('\n\n'),
    differed: 'argued for reading all three before trusting one.',
  },
  'gemma-4-26b-uncensored': {
    text: [
      'A demo answer from the mock gateway, standing in for gemma-4-26b-uncensored. No model ran.',
      'Live, this model answers in its own words. If it says no to a legal request, the refused attempt is billed nothing and the receipt says so. A direct model has no other family behind it, so put anonymo-1 in a column when you want a refusal rerouted.',
    ].join('\n\n'),
    differed: 'pointed out that a direct model has no other family to fall back on.',
  },
  'deepseek-v4.1-flash-abliterated': {
    text: [
      'This is a demo answer from the mock gateway, in the column for deepseek-v4.1-flash-abliterated. No model ran.',
      'The short version: three columns, three requests, three receipts. The longer version is the same thing with the numbers on it, which is what the receipt under each column is for. Open one to see the route that ran, the tokens in and out, and the cost.',
    ].join('\n\n'),
    differed: 'kept to the short version and pointed at the receipts.',
  },
  'dolphin-venice-24b': {
    text: [
      'Demo answer from the mock gateway, standing in for dolphin-venice-24b. Nothing left your device.',
      'Live, this is a self-hosted model answering on its own, next to two models from other families. Read across the columns: where all three say the same thing you can lean on it, and where one stands alone it is worth a second look.',
    ].join('\n\n'),
    differed: 'said to lean on what all three agree on.',
  },
  'kimi-k2.7-code': {
    text: [
      'A demo answer from the mock gateway, in the column for kimi-k2.7-code. No model ran.',
      'Each column is one ordinary request, the same one any app can send with your key:',
      '```\nPOST /v1/chat/completions\n{ "model": "kimi-k2.7-code", "stream": true }\n```',
      'The reply streams back with a signed receipt at the end.',
    ].join('\n\n'),
    differed: 'showed the request itself.',
  },
};

const ROUTED_DIFFERED: Record<string, string> = {
  'anonymo-1': 'explained how a refusal is rerouted to another family and refunded.',
  'anonymo-rp': 'answered in the roleplay register.',
  'anonymo-sealed': 'answered from an attested enclave and said what its receipt carries.',
};

const lastUserText = (messages: readonly ChatMessage[]) => {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content;
  return typeof last === 'string' ? last : '';
};

/** The merged demo reply, built from the labels and model names the request carries. */
function mergedReply(messages: readonly ChatMessage[]): string {
  const material = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const answers = [...material.matchAll(/^Answer (\S{1,3}) \(from ([^)\n]{1,90})\):$/gm)].map((m) => ({ label: m[1], model: m[2] }));
  const lines = answers.map((a) => `- ${a.label} (${a.model}) ${VOICES[a.model]?.differed ?? ROUTED_DIFFERED[a.model] ?? 'answered in its own words.'}`);
  return [
    'This is a merged demo answer from the mock gateway in your browser, so no model ran. Against the live gateway, anonymo-1 reads the answers and writes one answer from them.',
    'What they agree on: each column is its own request with its own signed receipt, each is charged for its own length, and a model that says no costs nothing.',
    `Where they differed:\n${lines.length ? lines.join('\n') : '- They did not differ.'}`,
  ].join('\n\n');
}

/**
 * The demo text for a chat request, given the text the mock would otherwise send: a merge request gets the merged
 * reply, a direct model id its own demo answer, and everything else is left as it was.
 */
export function sideBySideReply(model: string, messages: readonly ChatMessage[], text: string): string {
  if (lastUserText(messages) === MERGE_INSTRUCTION) return mergedReply(messages);
  return VOICES[model]?.text ?? text;
}

/** Micro-USD per million tokens as the USD-per-token decimal string the gateway lists ("0.00000045"). */
const perToken = (musdPerMillion: number) => (musdPerMillion / 1e12).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');

/** A demo price (micro-USD per million tokens) in the shape the gateway lists on /v1/models: USD per token. */
export const listPricing = (price: { in: number; out: number }): NonNullable<ModelInfo['pricing']> => ({ prompt: perToken(price.in), completion: perToken(price.out) });
