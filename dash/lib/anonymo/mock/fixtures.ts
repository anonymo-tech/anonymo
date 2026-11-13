// Demo fixtures that follow the spec shapes (Backend §4, §8, §11). Every value here is invented sample data: route
// names follow the spec's examples, hashes are derived from the route name, and refusal counts are illustrative.

import { keccakHex } from '../proof.ts';
import type { Leaderboard, Manifest, ManifestRoute, ModelInfo } from '../types.ts';

const enc = new TextEncoder();
const fakeHash = (label: string) => keccakHex(enc.encode(`demo-weights:${label}`));

export const DEMO_GENERATED_AT = '2026-11-12T12:00:00.000Z';
export const DEMO_SIGNER = '0xabababababababababababababababababababab';
export const DEMO_RECEIPT_ROOTS = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
/** Sample contract addresses for the demo deposit instructions. Not deployed anywhere. */
export const DEMO_ROUTER = '0xabababababababababababababababababababab';
export const DEMO_COIN_PAY = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
export const DEMO_ANMO = '0xefefefefefefefefefefefefefefefefefefefef';

type RouteFixture = {
  id: string;
  upstream: 'venice' | 'selfhost' | 'phala' | 'chutes' | 'nanogpt' | 'featherless';
  tier: 'T0' | 'T1' | 'T2' | 'T3';
  family: string;
  model: string;
  quant: string;
  weights_hash: string | null;
  attested: boolean;
  serves: string[];
  refusal: [number, number];
};

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

const rate = (rows: RouteFixture[]) => {
  const [total, refused] = rows.reduce(([t, f], r) => [t + r.refusal[0], f + r.refusal[1]], [0, 0]);
  return total ? Number((refused / total).toFixed(4)) : null;
};
const servers = (model: string) => DEMO_ROUTES.filter((r) => r.serves.includes(model) || r.model === model);
const shared = <T>(xs: T[]): T | null => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null);

const MODEL_INFO: Record<string, { context_length: number; description: string }> = {
  'anonymo-1': { context_length: 131072, description: 'Best uncensored route for the request. Refusals reroute to another family and are refunded.' },
  'anonymo-rp': { context_length: 65536, description: 'Cheap long-context roleplay on self-hosted 24–27B models, with character cards.' },
  'anonymo-council': { context_length: 65536, description: 'Three model families answer and check each other; one merged reply. Slower, priced at 4–5×.' },
  'anonymo-sealed': { context_length: 65536, description: 'Runs only on hardware-attested enclaves. Fails instead of downgrading.' },
};

const DIRECT_IDS = [...new Set(DEMO_ROUTES.filter((r) => r.upstream !== 'venice' && r.upstream !== 'featherless').map((r) => r.model))];

/** `GET /v1/models` entries (only the fields the dashboard reads). */
export const DEMO_MODELS: ModelInfo[] = [...Object.keys(MODEL_INFO), ...DIRECT_IDS].map((id) => {
  const rows = servers(id);
  return {
    id,
    ...MODEL_INFO[id],
    family: shared(rows.map((r) => r.family)) ?? rows[0]?.family ?? null,
    quant: shared(rows.map((r) => r.quant)),
    weights_hash: shared(rows.map((r) => r.weights_hash)),
    attested: rows.some((r) => r.attested),
    refusal_rate_30d: rate(rows),
  };
});

const manifestRoute = (r: RouteFixture): ManifestRoute => ({
  route: `${r.upstream}:${r.model}`,
  upstream: r.upstream,
  family: r.family,
  quant: r.quant,
  weights_hash: r.weights_hash,
  attested: r.attested,
  tee: r.attested ? 'tdx' : null,
  attestation_hash: r.attested ? fakeHash(`quote:${r.id}`) : null,
  attested_at: r.attested ? DEMO_GENERATED_AT : null,
});

export const DEMO_MANIFEST: Manifest = (() => {
  const models = DEMO_MODELS.map((m) => ({ ...m, routes: servers(m.id).map(manifestRoute) })).map(
    ({ id, family, quant, weights_hash, attested, refusal_rate_30d, routes }) => ({ id, family, quant, weights_hash, attested, refusal_rate_30d, routes }),
  );
  const routes = models.flatMap((m) => m.routes);
  return {
    generated_at: DEMO_GENERATED_AT,
    counts: { models: models.length, routes: routes.length, attested_routes: routes.filter((r) => r.attested).length, families: new Set(routes.map((r) => r.family)).size },
    notes: ['Demo data: invented sample routes, not a live manifest.'],
    models,
  };
})();

export const DEMO_LEADERBOARD: Leaderboard = (() => {
  const routes = DEMO_ROUTES.map((r) => ({ route: `${r.model}@${r.upstream}`, model: r.model, family: r.family, total_30d: r.refusal[0], refused_30d: r.refusal[1], refusal_rate_30d: rate([r]) })).sort(
    (a, b) => (a.refusal_rate_30d ?? 1) - (b.refusal_rate_30d ?? 1),
  );
  const fam = new Map<string, { total: number; refused: number }>();
  for (const r of routes) {
    const f = fam.get(r.family) ?? { total: 0, refused: 0 };
    f.total += r.total_30d;
    f.refused += r.refused_30d;
    fam.set(r.family, f);
  }
  const families = [...fam.entries()]
    .map(([family, f]) => ({ family, total_30d: f.total, refused_30d: f.refused, refusal_rate_30d: f.total ? Number((f.refused / f.total).toFixed(4)) : null }))
    .sort((a, b) => (a.refusal_rate_30d ?? 1) - (b.refusal_rate_30d ?? 1));
  return { generated_at: DEMO_GENERATED_AT, window_days: 30, available: true, routes, families };
})();

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

export const COUNCIL_MERGED = [
  'This is a merged demo reply from the mock council: three proposers from three model families answered, then an aggregator kept what they agree on.',
  'All three start from the same practical constraint. Two of them add the same edge case, so it stays in.',
  'They disagree on the order of the later steps; the merge marks that disagreement instead of hiding it.',
  'Open Council to see which proposers answered and what each cost.',
].join(' ');

export function demoReply(model: string): string {
  return (SENTENCES[model] ?? SENTENCES['anonymo-1']).join(' ');
}

