// Demo fixtures that follow the spec shapes (Backend §4, §8, §11). Every value here is invented sample data: route
// names follow the spec's examples, hashes are derived from the route name, and refusal counts are illustrative.

import { keccakHex } from '../proof.ts';
import type { Leaderboard, Manifest, ModelInfo } from '../types.ts';

const enc = new TextEncoder();
const fakeHash = (label: string) => keccakHex(enc.encode(`demo-weights:${label}`));

export const DEMO_GENERATED_AT = '2026-11-12T12:00:00.000Z';
export const DEMO_SIGNER = '0xabababababababababababababababababababab';
export const DEMO_RECEIPT_ROOTS = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

type RouteFixture = Manifest['routes'][number] & { refusal: [number, number] };

const route = (
  upstream: RouteFixture['upstream'],
  tier: RouteFixture['tier'],
  model: string,
  family: string,
  quant: string,
  attested: boolean,
  serves: string[],
  refusal: [number, number],
): RouteFixture => ({
  id: `${upstream}:${model}`,
  upstream,
  tier,
  family,
  model,
  quant,
  weights_hash: upstream === 'venice' ? null : fakeHash(`${upstream}:${model}`),
  attested,
  serves,
  enabled: true,
  refusal,
});

export const DEMO_ROUTES: RouteFixture[] = [
  route('venice', 'T0', 'venice-uncensored', 'mistral', 'bf16', false, ['anonymo-1', 'anonymo-council'], [48_210, 131]),
  route('venice', 'T0', 'deepseek-v4.1-flash-abliterated', 'deepseek', 'fp8', false, ['anonymo-1', 'anonymo-council'], [31_877, 96]),
  route('selfhost', 'T1', 'dolphin-venice-24b', 'mistral', 'fp8', false, ['anonymo-1', 'anonymo-rp'], [12_402, 51]),
  route('selfhost', 'T1', 'deepseek-v4.1-flash-abliterated', 'deepseek', 'fp8', false, ['anonymo-1', 'anonymo-council'], [9_115, 22]),
  route('selfhost', 'T1', 'gemma-4-26b-uncensored', 'gemma', 'q8', false, ['anonymo-1', 'anonymo-rp'], [7_390, 64]),
  route('selfhost', 'T1', 'qwen3.5-27b-abliterated', 'qwen', 'fp8', false, ['anonymo-rp'], [22_918, 41]),
  route('phala', 'T2', 'glm-5.2-abliterated', 'glm', 'fp8', true, ['anonymo-sealed', 'anonymo-council'], [3_604, 9]),
  route('chutes', 'T2', 'deepseek-v4.1-flash-abliterated', 'deepseek', 'fp8', true, ['anonymo-sealed'], [2_871, 7]),
  route('nanogpt', 'T2', 'kimi-k2.7-code', 'kimi', 'fp8', false, ['anonymo-1'], [4_013, 35]),
  route('featherless', 'T3', 'llama-4-scout-abliterated', 'llama', 'bf16', false, ['anonymo-1'], [1_220, 18]),
];

export const DEMO_MANIFEST: Manifest = {
  generated_at: DEMO_GENERATED_AT,
  routes: DEMO_ROUTES.map(({ refusal: _refusal, ...r }) => r),
};

export const DEMO_LEADERBOARD: Leaderboard = {
  generated_at: DEMO_GENERATED_AT,
  window_days: 30,
  rows: DEMO_ROUTES.map((r) => ({
    route_id: r.id,
    family: r.family,
    upstream: r.upstream,
    total: r.refusal[0],
    refused: r.refusal[1],
    refusal_rate: r.refusal[1] / r.refusal[0],
  })).sort((a, b) => a.refusal_rate - b.refusal_rate),
};

const rate = (ids: string[]) => {
  const rows = DEMO_ROUTES.filter((r) => ids.includes(r.id));
  const [total, refused] = rows.reduce(([t, f], r) => [t + r.refusal[0], f + r.refusal[1]], [0, 0]);
  return total ? refused / total : null;
};
const servesIds = (model: string) => DEMO_ROUTES.filter((r) => r.serves.includes(model)).map((r) => r.id);

export const DEMO_MODELS: ModelInfo[] = [
  {
    id: 'anonymo-1',
    object: 'model',
    owned_by: 'anonymo',
    family: null,
    quant: null,
    weights_hash: null,
    attested: false,
    refusal_rate_30d: rate(servesIds('anonymo-1')),
    context_length: 131072,
    description: 'Best uncensored route for the request. Refusals reroute to another family and are refunded.',
  },
  {
    id: 'anonymo-rp',
    object: 'model',
    owned_by: 'anonymo',
    family: null,
    quant: null,
    weights_hash: null,
    attested: false,
    refusal_rate_30d: rate(servesIds('anonymo-rp')),
    context_length: 65536,
    description: 'Cheap long-context roleplay on self-hosted 24–27B models, with character cards.',
  },
  {
    id: 'anonymo-council',
    object: 'model',
    owned_by: 'anonymo',
    family: null,
    quant: null,
    weights_hash: null,
    attested: false,
    refusal_rate_30d: rate(servesIds('anonymo-council')),
    context_length: 65536,
    description: 'Three model families answer and check each other; one merged reply. Slower, priced at 4–5×.',
  },
  {
    id: 'anonymo-sealed',
    object: 'model',
    owned_by: 'anonymo',
    family: null,
    quant: null,
    weights_hash: null,
    attested: true,
    refusal_rate_30d: rate(servesIds('anonymo-sealed')),
    context_length: 65536,
    description: 'Runs only on hardware-attested enclaves. Fails instead of downgrading.',
  },
  ...DEMO_ROUTES.filter((r) => r.upstream !== 'venice' && r.upstream !== 'featherless').map(
    (r): ModelInfo => ({
      id: r.model,
      object: 'model',
      owned_by: r.upstream,
      family: r.family,
      quant: r.quant,
      weights_hash: r.weights_hash,
      attested: r.attested,
      refusal_rate_30d: r.refusal[1] / r.refusal[0],
    }),
  ).filter((m, i, all) => all.findIndex((n) => n.id === m.id) === i),
];

/** Example micro-USD prices per 1M tokens (Overview §5 is "EXAMPLE until upstream contracts are signed"). */
export const DEMO_PRICES: Record<string, { in: number; out: number }> = {
  'anonymo-1': { in: 450_000, out: 1_800_000 },
  'anonymo-rp': { in: 80_000, out: 80_000 },
  'anonymo-council': { in: 2_000_000, out: 8_100_000 },
  'anonymo-sealed': { in: 540_000, out: 2_160_000 },
};

const SENTENCES: Record<string, string[]> = {
  'anonymo-1': [
    'This is a demo answer from the in-browser mock gateway, so no model ran and nothing left your device.',
    'Against the live gateway, anonymo-1 sends the request to the best uncensored route for it, with Venice first and warm backups behind it.',
    'If a model refuses a legal request, the router retries once on a different model family and refunds the refused attempt.',
    'Open the receipt below to see which routes ran, what it cost, and the Merkle path that ties it to an hourly on-chain root.',
  ],
  'anonymo-rp': [
    '*The lamplight flickers as the scene settles.* This is a demo reply from the mock gateway, written in the roleplay register.',
    'Live, anonymo-rp runs on self-hosted 24–27B uncensored models with long context, so a character can keep its voice across a long story.',
    'Import a character card from the Characters page and the workspace builds its prompt and lorebook on this device.',
  ],
  'anonymo-sealed': [
    'This is a demo answer from the mock gateway, standing in for a hardware-attested enclave.',
    'Live, anonymo-sealed runs only on attested routes and fails with 409 rather than downgrading to an unattested one.',
    'Its receipt carries the enclave quote hash, which you can check against the attestation service. That is what makes it provably private.',
  ],
};

const PROPOSER_SENTENCES = [
  [
    'Proposer A (mistral family): the strongest reading of the question is practical; start with the constraint that matters most.',
    'Then work outward to the details, and say plainly where the evidence is thin.',
  ],
  [
    'Proposer B (deepseek family): agree on the starting point, but add the edge case the first answer skips.',
    'Flag one disagreement: B would order the steps differently.',
  ],
  [
    'Proposer C (glm family): a shorter answer that matches A on the main point and B on the edge case.',
  ],
];

export const COUNCIL_MERGED = [
  'This is a merged demo reply from the mock council: three proposers from three model families answered, then an aggregator kept what they agree on.',
  'All three start from the same practical constraint. Two of them add the same edge case, so it stays in.',
  'They disagree on the order of the later steps; the merge marks that disagreement instead of hiding it.',
  'Use Compare to read each proposer side by side.',
].join(' ');

export function demoReply(model: string): string {
  return (SENTENCES[model] ?? SENTENCES['anonymo-1']).join(' ');
}

export const demoProposers = () => PROPOSER_SENTENCES.map((s) => s.join(' '));
