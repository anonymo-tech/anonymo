// Update "ventures": Anonymo Ventures. A crew of AI agents, the Mos, builds a business from a brief, a rival's public
// site, or an open-source repo. This file is the plain logic the pages share with the demo gateway and the checks: the
// gateway's shapes (gateway/src/anonymo/ventures/routes.ts, orchestrator.ts ventureSnapshot(), types.ts VentureEvent,
// pricing.ts), the four modes and their prices, the crew, the DAG laid out in waves, events folded into a run, an SSE
// frame reader, and the readers for the artifacts the results tabs show. Nothing here touches the DOM or the network.

import type { Plush } from './plush.ts';

// ---- the gateway's shapes ---------------------------------------------------------------------------------------

export type VentureMode = 'BUILD_BETTER' | 'DUPE_DROP' | 'FORK_FLIP' | 'IDEA_TO_LIVE' | 'TAKEOVER' | 'RUN';
export type Role = 'boss' | 'scout' | 'spec-filter' | 'strategist' | 'builder' | 'tester' | 'designer' | 'merchant' | 'adman' | 'red-team' | 'licence' | 'deployer';
export type StepState = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';
export type Zone = 'SCOUT' | 'CLEAN';
export type VentureStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CAPPED' | 'CANCELLED';
export type Tier = 'solo' | 'crew' | 'gang' | 'syndicate';
export const TIERS: readonly Tier[] = ['solo', 'crew', 'gang', 'syndicate'];

export type ArtifactRef = { sha256: string; kind: string; zone: Zone; name?: string };

export type Candidate = {
  family: string;
  model: string;
  pass_rate: number | null;
  lint_errors?: number | null;
  type_errors?: number | null;
  bundle_bytes?: number | null;
  refused: boolean;
  chosen: boolean;
  receipt_id?: string | null;
  cost_usd?: number;
  error?: string | null;
};

export type VentureStep = {
  key: string;
  task: string;
  role: Role;
  kind: string;
  zone: Zone;
  fanout: number;
  select: string;
  needs: string[];
  state: StepState;
  cost_usd: number;
  cap_usd: number;
  receipts: string[];
  outputs: ArtifactRef[];
  error: string | null;
  candidates: Candidate[];
};

export type RunModeInfo = {
  enabled: boolean;
  daily_cap_usd: number;
  hours_per_day: number;
  tasks: string[];
  spent_today_usd: number;
  ticks_today: number;
  next_tick_at: string | null;
  last_brief: string | null;
};

/** GET /v1/ventures/{id}. */
export type VentureSnapshot = {
  id: string;
  mode: VentureMode;
  status: VentureStatus;
  tier: Tier;
  caps: { total: number; perStep: number } | null;
  price_usd: number;
  cost_usd: number;
  target_commit: string | null;
  recipe_id: string | null;
  error: string | null;
  created_at: string;
  input: { mode: VentureMode; brief: string; brand: string | null } | null;
  steps: VentureStep[];
  run_mode: RunModeInfo | null;
};

/** One row of GET /v1/ventures. */
export type VentureSummary = {
  id: string;
  mode: VentureMode;
  status: VentureStatus;
  tier: Tier;
  price_usd: number;
  cost_usd: number;
  brand: string | null;
  brief: string | null;
  created_at: string;
  repo: string | null;
};

/** GET /v1/ventures/{id}/events, one `data:` line each (types.ts VentureEvent). */
export type VentureEvent =
  | { type: 'venture'; ventureId: string; status: VentureStatus; at: string; costUsd: number }
  | { type: 'step'; ventureId: string; step: string; role: Role; state: StepState; at: string; costUsd: number; error?: string }
  | { type: 'candidate'; ventureId: string; step: string; family: string; model: string; passRate: number | null; chosen: boolean; refused: boolean; at: string }
  | { type: 'artifact'; ventureId: string; step: string; artifact: ArtifactRef; at: string }
  | { type: 'log'; ventureId: string; step: string; role: Role; message: string; at: string };

/** GET /v1/ventures/{id}/artifacts. */
export type ArtifactInfo = { sha256: string; kind: string; zone: Zone; name: string | null; mime: string; size: number; purged: boolean; created_at: string };

export type CleanRoom = {
  scoutArtifactHashes: string[];
  specHash: string | null;
  sandboxPolicyHash: string;
  builderArtifactHashes: string[];
  gateReportHash: string | null;
  licenceReportHash: string | null;
  root: string;
  anchored: boolean;
  note: string;
};

/** GET /v1/ventures/{id}/receipt. */
export type VentureReceipt = {
  venture: { id: string; mode: VentureMode; status: VentureStatus; target_commit: string | null; price_usd: number; cost_usd: number };
  steps: { key: string; role: Role; zone: Zone; state: StepState; cost_usd: number; receipts: string[]; outputs: ArtifactRef[] }[];
  candidates: { step: string | null; family: string; model: string; pass_rate: number | null; chosen: boolean; refused: boolean; receipt_id: string | null; cost_usd: number }[];
  clean_room: CleanRoom;
  receipts_api: string;
};

export type TierRules = {
  tier: Tier;
  stakeNymo: number;
  builders: number;
  families: number;
  modes: VentureMode[];
  runModeHoursPerDay: number;
  recipeSelling: boolean;
  sealedRoutes: boolean;
  apiAndMcp: boolean;
};

/** GET /v1/ventures/tier. */
export type TierInfo = { tier: Tier; source: 'chain' | 'fallback'; wallet: string | null; twabNymo: number | null; rules: TierRules };

/** GET /v1/recipes. */
export type Recipe = {
  id: string;
  title: string;
  summary: string;
  mode: VentureMode;
  steps: { key: string; task: string; role: Role; fanout: number }[];
  price_usd: number;
  runs: number;
  recipe_hash: string;
  created_at: string;
};

/** POST /v1/ventures. */
export type CreateVentureBody = {
  mode: VentureMode;
  brief: string;
  target_url?: string;
  repo_url?: string;
  brand?: string;
  rival?: string;
  recipe_id?: string;
};
export type CreatedVenture = {
  id: string;
  mode: VentureMode;
  tier: Tier;
  price_usd: number;
  recipe_price_usd: number;
  steps: { key: string; role: Role; fanout: number }[];
  target_commit?: string;
  target_salt?: string;
  events: string;
};

export const RUN_TASKS = ['watch', 'improve', 'ads', 'brief'] as const;
export type RunTask = (typeof RUN_TASKS)[number];
export type RunModeBody = { daily_cap_usd: number; tasks: RunTask[]; target_url?: string };
export type RecipeBody = { title: string; summary: string; price_usd: number };

// ---- prices and tiers (pricing.ts) ------------------------------------------------------------------------------

export const NYMO_DISCOUNT_PCT = 25;
export const RUN_MODE = { dailyFeeUsd: 5, minDailyCapUsd: 6, maxDailyCapUsd: 500 } as const;
export const RECIPE_MAX_USD = 500;

export const TIER_RULES: Record<Tier, TierRules> = {
  solo: { tier: 'solo', stakeNymo: 0, builders: 1, families: 1, modes: ['IDEA_TO_LIVE', 'DUPE_DROP', 'FORK_FLIP'], runModeHoursPerDay: 0, recipeSelling: false, sealedRoutes: false, apiAndMcp: false },
  crew: { tier: 'crew', stakeNymo: 50_000, builders: 3, families: 3, modes: ['IDEA_TO_LIVE', 'DUPE_DROP', 'FORK_FLIP', 'BUILD_BETTER', 'TAKEOVER', 'RUN'], runModeHoursPerDay: 2, recipeSelling: false, sealedRoutes: false, apiAndMcp: false },
  gang: { tier: 'gang', stakeNymo: 250_000, builders: 5, families: 5, modes: ['IDEA_TO_LIVE', 'DUPE_DROP', 'FORK_FLIP', 'BUILD_BETTER', 'TAKEOVER', 'RUN'], runModeHoursPerDay: 12, recipeSelling: true, sealedRoutes: false, apiAndMcp: false },
  syndicate: { tier: 'syndicate', stakeNymo: 1_000_000, builders: 8, families: 8, modes: ['IDEA_TO_LIVE', 'DUPE_DROP', 'FORK_FLIP', 'BUILD_BETTER', 'TAKEOVER', 'RUN'], runModeHoursPerDay: 24, recipeSelling: true, sealedRoutes: true, apiAndMcp: true },
};

export const tierLabel = (t: Tier) => t.charAt(0).toUpperCase() + t.slice(1);
export const tierAllows = (tier: Tier, mode: VentureMode) => TIER_RULES[tier].modes.includes(mode);
/** The lowest tier a mode needs. */
export const tierFor = (mode: VentureMode): Tier => TIERS.find((t) => tierAllows(t, mode)) ?? 'syndicate';

/** What one tier unlocks, in short lines. */
export function tierPerks(r: TierRules): string[] {
  return [
    `${r.builders} Builder Mo${r.builders === 1 ? '' : 's'} racing each feature`,
    `${r.families} model ${r.families === 1 ? 'family' : 'families'}`,
    r.modes.includes('BUILD_BETTER') ? 'Build Better and Takeover Kit' : 'Idea to Live and Fork & Flip',
    r.runModeHoursPerDay ? `Run Mode up to ${r.runModeHoursPerDay} h a day` : 'No Run Mode',
    ...(r.recipeSelling ? ['Sell your Recipes'] : []),
    ...(r.sealedRoutes ? ['Sealed routes for the crew'] : []),
    ...(r.apiAndMcp ? ['API and MCP access'] : []),
  ];
}

// ---- the modes the launcher offers ------------------------------------------------------------------------------

export type ModeField = 'brief' | 'target_url' | 'rival' | 'repo_url' | 'brand';
export type ModeInfo = {
  mode: Exclude<VentureMode, 'RUN'>;
  title: string;
  usd: number;
  pitch: string;
  includes: string[];
  needs: ModeField[];
  optional: ModeField[];
  soon?: boolean;
};

export const MODES: readonly ModeInfo[] = [
  {
    mode: 'IDEA_TO_LIVE',
    title: 'Idea to Live',
    usd: 79,
    pitch: 'One sentence in. A working MVP, a landing page and a launch plan out.',
    includes: ['MVP repo with tests', 'Landing page', 'Ad kit: 12 ads, 5 posts, 4 emails', '14-day launch plan'],
    needs: ['brief'],
    optional: ['brand'],
  },
  {
    mode: 'BUILD_BETTER',
    title: 'Build Better',
    usd: 149,
    pitch: 'Point the crew at a rival. Get their features, their gaps filled, and your version shipped.',
    includes: ['Parity+ matrix', 'Rebuilt core flows', 'Original design and landing page', 'Comparison page with dated facts'],
    needs: ['target_url'],
    optional: ['brief', 'brand'],
  },
  {
    mode: 'TAKEOVER',
    title: 'Takeover Kit',
    usd: 49,
    pitch: 'Win their unhappy customers: comparison pages, a switch offer and a one-click import.',
    includes: ['Comparison and switch pages', 'Switch offer', 'Import tool for their exports', '30 ads aimed at their complaints'],
    needs: ['target_url', 'rival'],
    optional: ['brand'],
  },
  {
    mode: 'FORK_FLIP',
    title: 'Fork & Flip',
    usd: 79,
    pitch: 'Start from an open-source repo. The crew checks the licence, rebrands it and plans the first wins.',
    includes: ['Licence report and verdict', 'Rebranded fork or clean-room plan', 'Landing page', 'Repo you can export'],
    needs: ['repo_url'],
    optional: ['brief', 'brand'],
  },
  {
    mode: 'DUPE_DROP',
    title: 'Dupe Drop',
    usd: 99,
    pitch: 'Dupe the bestseller. Keep your brand. One store, up to 25 products.',
    includes: ['1 store', 'Up to 25 products', 'Ad kit'],
    needs: ['brief'],
    optional: [],
    soon: true,
  },
];

export const modeInfo = (mode: VentureMode): ModeInfo | null => MODES.find((m) => m.mode === mode) ?? null;
export const modeTitle = (mode: VentureMode) => (mode === 'RUN' ? 'Run Mode' : (modeInfo(mode)?.title ?? mode));
export const priceOf = (mode: VentureMode) => (mode === 'RUN' ? RUN_MODE.dailyFeeUsd : (modeInfo(mode)?.usd ?? 0));
/** The same run paid in $NYMO (shown as information only). */
export const nymoPrice = (usd: number) => Math.round(usd * (100 - NYMO_DISCOUNT_PCT)) / 100;

/** A Recipe's maker is credited this share of its price on every run (gateway recipes.ts CREATOR_SHARE_BPS = 8000). */
export const RECIPE_MAKER_SHARE = 0.8;

/** Whole dollars stay whole ("$149"); anything else gets cents ("$111.75"). */
export function usd(amount: number, cents = false): string {
  if (!Number.isFinite(amount)) return '—';
  const whole = Number.isInteger(amount) && !cents;
  const text = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  return `${amount < 0 ? '−' : ''}$${text}`;
}

/** The line shown on the start button's side, before anything is spent. */
export function priceLine(mode: VentureMode, recipeUsd = 0): string {
  const base = priceOf(mode);
  const total = Math.round((base + recipeUsd) * 100) / 100;
  return `${usd(total)} all-in${recipeUsd ? ` (${usd(base)} run + ${usd(recipeUsd)} recipe)` : ''}, refused attempts free`;
}

// ---- the brief form ---------------------------------------------------------------------------------------------

export type BriefForm = { brief: string; target_url: string; rival: string; repo_url: string; brand: string };
export const EMPTY_BRIEF: BriefForm = { brief: '', target_url: '', rival: '', repo_url: '', brand: '' };

const PRIVATE_HOST =
  /^(?:localhost|.*\.local|.*\.internal|.*\.localhost|0\.0\.0\.0|\[?::1\]?|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?f[cd][0-9a-f]{2}:.*|\[?fe80:.*)$/i;

/** The gateway's targetProblem(): a public http(s) url with no credentials. */
export function urlProblem(raw: string, what = 'The address'): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return `${what} is not a web address. Start it with https://`;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${what} must start with https:// or http://`;
  if (u.username || u.password) return `${what} must not carry a username or password.`;
  if (PRIVATE_HOST.test(u.hostname)) return `${what} must be a public site.`;
  return null;
}

/** Why a brief can't start yet, or null when it can. Mirrors the gateway's checks in startVenture(). */
export function briefProblem(mode: VentureMode, f: BriefForm): string | null {
  const info = modeInfo(mode);
  if (!info || info.soon) return 'Dupe Drop is coming soon.';
  if (mode === 'IDEA_TO_LIVE' && f.brief.trim().length < 10) return 'Describe the idea in a sentence (at least 10 characters).';
  if (f.brief.length > 4000) return 'Keep the brief under 4,000 characters.';
  if (mode === 'BUILD_BETTER' || mode === 'TAKEOVER') {
    if (!f.target_url.trim()) return 'Add the competitor’s public web address.';
    const p = urlProblem(f.target_url, 'The competitor address');
    if (p) return p;
  }
  if (mode === 'TAKEOVER' && !f.rival.trim()) return 'Name the rival, as their customers know it.';
  if (mode === 'FORK_FLIP') {
    if (!f.repo_url.trim()) return 'Add the open-source repo’s address.';
    const p = urlProblem(f.repo_url, 'The repo address');
    if (p) return p;
  }
  if (f.brand.trim().length > 60 || f.rival.trim().length > 60) return 'Keep names under 60 characters.';
  return null;
}

/** The POST /v1/ventures body: only the fields this mode reads. */
export function createBody(mode: VentureMode, f: BriefForm, recipeId?: string | null): CreateVentureBody {
  const body: CreateVentureBody = { mode, brief: f.brief.trim() };
  if (mode === 'BUILD_BETTER' || mode === 'TAKEOVER') body.target_url = f.target_url.trim();
  if (mode === 'TAKEOVER' && f.rival.trim()) body.rival = f.rival.trim();
  if (mode === 'FORK_FLIP') body.repo_url = f.repo_url.trim();
  if (f.brand.trim()) body.brand = f.brand.trim();
  if (recipeId) body.recipe_id = recipeId;
  return body;
}

// ---- the crew -----------------------------------------------------------------------------------------------------

/** A drawn piece the plush artwork has no part for, sewn on top in felt. */
export type Badge = 'cape' | 'hoodie' | 'scarf' | 'peeker' | null;
export type Mo = {
  role: Role;
  name: string;
  /** What gives the Mo away at a glance, for alt text and captions. */
  look: string;
  job: string;
  /** The plush to render, or null for the mascot photo in headphones. */
  plush: Plush | null;
  badge: Badge;
};

const plush = (p: Partial<Plush>): Plush => ({
  outfit: 'Captain',
  hat: 'None',
  glasses: 'None',
  shape: 'Round',
  mouth: 'Classic',
  marks: 'Plain',
  mask: 'Plum',
  coat: 'Teal',
  thread: 'Gold',
  felt: 'Oat',
  ...p,
});

export const CREW: Record<Role, Mo> = {
  boss: { role: 'boss', name: 'Boss Mo', look: 'a felt crown', job: 'Plans the run and splits the budget', plush: plush({ hat: 'Crown', coat: 'Plum', mask: 'Ink' }), badge: null },
  scout: { role: 'scout', name: 'Scout Mo', look: 'a fedora', job: 'Reads the competitor, logged out', plush: plush({ outfit: 'Explorer', hat: 'Western', mask: 'Cocoa' }), badge: null },
  'spec-filter': { role: 'spec-filter', name: 'Filter Mo', look: 'square glasses', job: 'Turns what Scout saw into a functional Spec', plush: plush({ outfit: 'Astronaut', glasses: 'Square', mask: 'Slate' }), badge: null },
  strategist: { role: 'strategist', name: 'Strategist Mo', look: 'a cape', job: 'Writes the plan and the Parity+ matrix', plush: plush({ outfit: 'Stargazer', glasses: 'Round', mask: 'Iris' }), badge: 'cape' },
  builder: { role: 'builder', name: 'Builder Mo', look: 'a hoodie', job: 'Builds the same feature in parallel sandboxes', plush: plush({ outfit: 'Knit', hat: 'Ballcap', coat: 'Cobalt', mask: 'Ink' }), badge: 'hoodie' },
  tester: { role: 'tester', name: 'Tester Mo', look: 'headphones', job: 'Runs every candidate and keeps the one that passes most', plush: null, badge: null },
  designer: { role: 'designer', name: 'Designer Mo', look: 'a beanie', job: 'Makes an original look', plush: plush({ outfit: 'Artist', hat: 'Beanie', mask: 'Teal', coat: 'Rose' }), badge: null },
  merchant: { role: 'merchant', name: 'Merchant Mo', look: 'a skipper cap', job: 'Stocks the store', plush: plush({ hat: 'Skipper', coat: 'Moss' }), badge: null },
  adman: { role: 'adman', name: 'Adman Mo', look: 'a scarf', job: 'Writes ads and comparison pages', plush: plush({ outfit: 'Tuxedo', glasses: 'Aviator', mask: 'Rose' }), badge: 'scarf' },
  'red-team': { role: 'red-team', name: 'Red Team Mo', look: 'peeking over the wall', job: 'Attacks the build before anyone else can', plush: plush({ outfit: 'Racer', glasses: 'Visor', mask: 'Ruby', coat: 'Ink' }), badge: 'peeker' },
  licence: { role: 'licence', name: 'Licence Mo', look: 'round glasses', job: 'Checks every licence the build touches', plush: plush({ outfit: 'Captain', hat: 'Beret', glasses: 'Round', coat: 'Moss', mask: 'Cocoa' }), badge: null },
  deployer: { role: 'deployer', name: 'Pilot Mo', look: 'a flight helmet', job: 'Ships the clean build', plush: plush({ outfit: 'Pilot', hat: 'Flight helmet' }), badge: null },
};

/** The order the crew lines up in on the launcher. */
export const LINEUP: readonly Role[] = ['boss', 'scout', 'strategist', 'builder', 'tester', 'designer', 'adman', 'red-team'];

/** Builder Mos wear a hoodie in the colour of their model family. */
export const FAMILY_DYES = ['Cobalt', 'Apricot', 'Mint', 'Lilac', 'Honey', 'Sky', 'Peach', 'Moss'] as const;
export function familyDye(family: string): (typeof FAMILY_DYES)[number] {
  let h = 0;
  for (const c of family) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FAMILY_DYES[h % FAMILY_DYES.length];
}

/** Which of the six faces on a plush sheet a Mo wears for a state (0 calm, 1 laughing, 2 sad, 3 focused, 4 surprised, 5 pleased). */
export function moodFor(state: StepState | 'idle', chosen = false): number {
  if (chosen) return 5;
  switch (state) {
    case 'RUNNING':
      return 3;
    case 'DONE':
      return 1;
    case 'FAILED':
      return 2;
    case 'SKIPPED':
      return 4;
    default:
      return 0;
  }
}

/** What a step is called on its card. */
const STEP_TITLES: Record<string, string> = {
  scout: 'Read the rival',
  spec: 'Write the Spec',
  research: 'Research demand',
  plan: 'Write the plan',
  parity: 'Parity+ matrix',
  design: 'Design system',
  copy: 'Landing copy',
  landing: 'Landing page',
  ads: 'Ad kit',
  launch: 'Launch plan',
  comparison: 'Comparison page',
  switch: 'Switch offer',
  tests: 'Write the tests',
  build: 'Build race',
  rebrand: 'Rebrand the fork',
  redteam: 'Red team',
  licence: 'Licence scan',
  fork: 'Licence check',
  repo: 'Commit the repo',
  deploy: 'Ship it',
};
export function stepTitle(key: string): string {
  const bare = key.replace(/^t\d+-/, '');
  // A Run Mode tick's own tasks are named as the Run Mode panel names them ("Fresh ads", not the launch kit's "Ad kit").
  if (bare !== key && bare in RUN_TASK_LABELS) return RUN_TASK_LABELS[bare as RunTask].title;
  return STEP_TITLES[bare] ?? bare.charAt(0).toUpperCase() + bare.slice(1);
}

// ---- the board: waves, the firewall, meters ---------------------------------------------------------------------

/** Steps grouped into waves: a step sits one wave after the latest of the steps it needs, so a wave runs side by side. */
export function waves<S extends { key: string; needs: string[] }>(steps: readonly S[]): S[][] {
  const by = new Map(steps.map((s) => [s.key, s]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    const s = by.get(key);
    if (!s || visiting.has(key)) return 0;
    visiting.add(key);
    const d = s.needs.filter((n) => by.has(n)).reduce((m, n) => Math.max(m, depthOf(n) + 1), 0);
    visiting.delete(key);
    depth.set(key, d);
    return d;
  };
  const out: S[][] = [];
  for (const s of steps) (out[depthOf(s.key)] ??= []).push(s);
  return out.filter(Boolean);
}

/**
 * Where the firewall line goes: after the last wave that holds a SCOUT step, or -1 when the run never saw a target.
 * Every later wave must be all CLEAN; a run that interleaves them (it can't, the gateway refuses such a DAG) gets -1.
 */
export function firewallAfter(ws: readonly (readonly { zone: Zone }[])[]): number {
  let last = -1;
  ws.forEach((w, i) => {
    if (w.some((s) => s.zone === 'SCOUT')) last = i;
  });
  if (last < 0) return -1;
  return ws.slice(0, last + 1).every((w) => w.every((s) => s.zone === 'SCOUT')) ? last : -1;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'none' | 'live';

/** A cost against its cap, 0..1, and how close it is to the cap. */
export function meter(cost: number, cap: number): { fraction: number; tone: Tone } {
  if (!(cap > 0) || !Number.isFinite(cost)) return { fraction: 0, tone: 'none' };
  const fraction = Math.min(1, Math.max(0, cost / cap));
  return { fraction, tone: fraction >= 0.9 ? 'bad' : fraction >= 0.7 ? 'warn' : 'ok' };
}

export const isTerminal = (s: VentureStatus) => s === 'DONE' || s === 'FAILED' || s === 'CAPPED' || s === 'CANCELLED';

export function statusTone(s: VentureStatus | StepState): Tone {
  switch (s) {
    case 'DONE':
      return 'ok';
    case 'RUNNING':
      return 'live';
    case 'FAILED':
    case 'CAPPED':
      return 'bad';
    case 'CANCELLED':
    case 'SKIPPED':
      return 'warn';
    default:
      return 'none';
  }
}

export const statusLabel = (s: VentureStatus | StepState) =>
  ({ QUEUED: 'Queued', RUNNING: 'Running', DONE: 'Done', FAILED: 'Failed', CAPPED: 'Hit its cap', CANCELLED: 'Cancelled', SKIPPED: 'Skipped' })[s] ?? s;

export function progress(steps: readonly { state: StepState }[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.state === 'DONE' || s.state === 'SKIPPED' || s.state === 'FAILED').length, total: steps.length };
}

export type Lane = { family: string; model: string; passRate: number | null; state: 'racing' | 'finished' | 'refused' | 'failed'; chosen: boolean; note: string };

/** The build race: one lane per model family, the winner first once it is known, refused lanes last. */
export function lanes(step: Pick<VentureStep, 'candidates' | 'state'>): Lane[] {
  const finished = step.state === 'DONE' || step.state === 'FAILED' || step.candidates.some((c) => c.chosen);
  const out = step.candidates.map((c): Lane => {
    const state = c.refused ? 'refused' : c.error ? 'failed' : finished || c.chosen ? 'finished' : 'racing';
    const note = c.refused ? 'Refused: rerouted to another family, billed $0' : c.error ? c.error : c.pass_rate === null ? 'Building…' : `${Math.round(c.pass_rate * 100)}% of tests pass`;
    return { family: c.family, model: c.model, passRate: c.pass_rate, state, chosen: c.chosen, note };
  });
  const rank = (l: Lane) => (l.chosen ? 0 : l.state === 'refused' ? 3 : l.state === 'failed' ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (b.passRate ?? -1) - (a.passRate ?? -1));
}

// ---- events -----------------------------------------------------------------------------------------------------

/** A run with nothing done yet: what the board shows from POST /v1/ventures before the first GET answers. */
export function emptySnapshot(c: CreatedVenture, input: VentureSnapshot['input'] = null): VentureSnapshot {
  return {
    id: c.id,
    mode: c.mode,
    status: 'QUEUED',
    tier: c.tier,
    caps: { total: c.price_usd, perStep: c.price_usd * 0.35 },
    price_usd: c.price_usd,
    cost_usd: 0,
    target_commit: c.target_commit ?? null,
    recipe_id: null,
    error: null,
    created_at: new Date().toISOString(),
    input,
    steps: [],
    run_mode: null,
  };
}

/** Folds one event into a run. Unknown steps are ignored (the next GET brings them). Returns a new object. */
export function applyEvent(v: VentureSnapshot, e: VentureEvent): VentureSnapshot {
  if (e.type === 'venture') return { ...v, status: e.status, cost_usd: Math.max(v.cost_usd, e.costUsd) };
  if (e.type === 'log') return v;
  const i = v.steps.findIndex((s) => s.key === e.step);
  if (i < 0) return v;
  const s = v.steps[i];
  let next: VentureStep = s;
  if (e.type === 'step') {
    next = { ...s, state: e.state, cost_usd: Math.max(s.cost_usd, e.costUsd), error: e.error ?? (e.state === 'FAILED' ? s.error : null) };
  } else if (e.type === 'candidate') {
    const c: Candidate = { family: e.family, model: e.model, pass_rate: e.passRate, refused: e.refused, chosen: e.chosen };
    const at = s.candidates.findIndex((x) => x.family === e.family);
    const candidates = at < 0 ? [...s.candidates, c] : s.candidates.map((x, j) => (j === at ? { ...x, ...c } : x));
    next = { ...s, candidates: e.chosen ? candidates.map((x) => ({ ...x, chosen: x.family === e.family })) : candidates };
  } else if (e.type === 'artifact') {
    if (s.outputs.some((o) => o.sha256 === e.artifact.sha256)) return v;
    next = { ...s, outputs: [...s.outputs, e.artifact] };
  }
  const steps = v.steps.slice();
  steps[i] = next;
  const stepCost = steps.reduce((sum, x) => sum + x.cost_usd, 0);
  return { ...v, steps, cost_usd: Math.max(v.cost_usd, Math.round(stepCost * 1e6) / 1e6) };
}

export type FeedLine = { id: number; at: string; role: Role | null; text: string; tone: Tone };

/** The line an event adds to the live log, or null for events the log leaves out. */
export function feedLine(id: number, e: VentureEvent): FeedLine | null {
  const name = (r: Role) => CREW[r]?.name ?? r;
  switch (e.type) {
    case 'log':
      return e.message === '__end__' ? null : { id, at: e.at, role: e.role, text: `${name(e.role)}: ${e.message}`, tone: 'none' };
    case 'step':
      if (e.state === 'RUNNING') return { id, at: e.at, role: e.role, text: `${name(e.role)} started ${stepTitle(e.step).toLowerCase()}`, tone: 'live' };
      if (e.state === 'DONE') return { id, at: e.at, role: e.role, text: `${stepTitle(e.step)} done · ${usd(e.costUsd, true)}`, tone: 'ok' };
      if (e.state === 'FAILED') return { id, at: e.at, role: e.role, text: `${stepTitle(e.step)} failed${e.error ? `: ${e.error}` : ''}`, tone: 'bad' };
      if (e.state === 'SKIPPED') return { id, at: e.at, role: e.role, text: `${stepTitle(e.step)} skipped`, tone: 'warn' };
      return null;
    case 'candidate':
      if (e.refused) return { id, at: e.at, role: 'builder', text: `${e.family} refused: rerouted, billed $0`, tone: 'warn' };
      if (e.chosen) return { id, at: e.at, role: 'tester', text: `Tester Mo keeps ${e.family}: ${Math.round((e.passRate ?? 0) * 100)}% of tests pass`, tone: 'ok' };
      return null;
    case 'venture':
      // Cost updates while running are the ticker's job; the log only notes how a run ends.
      if (e.status === 'RUNNING' || e.status === 'QUEUED') return null;
      return { id, at: e.at, role: null, text: `Run ${statusLabel(e.status).toLowerCase()} · ${usd(e.costUsd, true)} used`, tone: statusTone(e.status) };
    default:
      return null;
  }
}

export type SseFrame = { id: number | null; event: string; data: string };

/** Splits an SSE buffer into whole frames and the unfinished rest. Comment lines (": ping") are dropped. */
export function readSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let cut: number;
  while ((cut = rest.search(/\r?\n\r?\n/)) !== -1) {
    const block = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\r?\n\r?\n/, '');
    let id: number | null = null;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id' && /^\d+$/.test(value)) id = Number(value);
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length || event !== 'message') frames.push({ id, event, data: data.join('\n') });
  }
  return { frames, rest };
}

/** A frame's event, or null when it is the end marker or not an event the board knows. */
export function eventOf(frame: SseFrame): VentureEvent | null {
  if (frame.event === 'end') return null;
  try {
    const e = JSON.parse(frame.data) as VentureEvent;
    return e && typeof e === 'object' && ['venture', 'step', 'candidate', 'artifact', 'log'].includes(e.type) ? e : null;
  } catch {
    return null;
  }
}

// ---- the results tabs -------------------------------------------------------------------------------------------

export type ResultTab = 'plan' | 'design' | 'landing' | 'comparison' | 'ads' | 'code' | 'receipt' | 'licence';
export const TAB_LABELS: Record<ResultTab, string> = {
  plan: 'Plan',
  design: 'Design',
  landing: 'Landing page',
  comparison: 'Comparison',
  ads: 'Ads',
  code: 'Code',
  receipt: 'Receipt',
  licence: 'Licence',
};

/** The newest CLEAN artifact with this name (SCOUT bodies are never fetched). */
export function findArtifact(list: readonly ArtifactInfo[], name: string): ArtifactInfo | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].name === name && list[i].zone === 'CLEAN') return list[i];
  return null;
}

/** The tabs a run has something for, in order. The receipt is always there. */
export function resultTabs(mode: VentureMode, list: readonly ArtifactInfo[]): ResultTab[] {
  const has = (...names: string[]) => names.some((n) => findArtifact(list, n));
  const tabs: ResultTab[] = [];
  if (has('plan')) tabs.push('plan');
  if (has('preview')) tabs.push('design');
  if (has('landing')) tabs.push('landing');
  if ((mode === 'BUILD_BETTER' || mode === 'TAKEOVER') && has('comparison', 'alternative')) tabs.push('comparison');
  if (has('adkit', 'ads')) tabs.push('ads');
  if (has('repo', 'test-report', 'code')) tabs.push('code');
  tabs.push('receipt');
  if (has('licence', 'fork')) tabs.push('licence');
  return tabs;
}

const str = (v: unknown, max = 400) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export type ParityRow = { feature: string; theirs: boolean; ours: 'parity' | 'better' | 'new'; note: string };
export type PlanView = {
  name: string;
  positioning: string;
  audience: string;
  problem: string;
  features: { id: string; title: string; description: string; acceptance: string[] }[];
  pricing: { name: string; price: number | null; features: string[] }[];
  parity: ParityRow[];
  gaps: string[];
  priceUnder: { theirs: number | null; ours: number | null; note: string } | null;
  launch: string[];
  improvements: string[];
};

/** Reads the `plan` artifact (mos/strategist.ts VenturePlan) defensively: a model wrote it. */
export function readPlan(raw: unknown): PlanView {
  const p = obj(raw);
  const pu = obj(p.priceUnder);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    name: str(p.name, 80),
    positioning: str(p.positioning),
    audience: str(p.audience),
    problem: str(p.problem),
    features: arr(p.mvpFeatures).slice(0, 8).map((f, i) => {
      const o = obj(f);
      return { id: str(o.id, 40) || `feature-${i + 1}`, title: str(o.title, 80), description: str(o.description), acceptance: arr(o.acceptance).slice(0, 6).map((a) => str(a, 300)) };
    }),
    pricing: arr(p.pricing).slice(0, 6).map((x) => {
      const o = obj(x);
      return { name: str(o.name, 40), price: num(o.priceUsdMonthly), features: arr(o.features).slice(0, 8).map((f) => str(f, 120)) };
    }),
    parity: arr(p.parity).slice(0, 40).map((r) => {
      const o = obj(r);
      return { feature: str(o.feature, 80), theirs: o.theirs === true, ours: o.ours === 'better' || o.ours === 'new' ? o.ours : 'parity', note: str(o.note, 200) };
    }),
    gaps: arr(p.gaps).slice(0, 12).map((g) => str(g, 200)),
    priceUnder: Object.keys(pu).length ? { theirs: num(pu.theirTopUsd), ours: num(pu.ourTopUsd), note: str(pu.note, 200) } : null,
    launch: arr(p.launch).slice(0, 14).map((l) => str(l, 200)),
    improvements: arr(p.improvements).slice(0, 10).map((l) => str(l, 200)),
  };
}

/** The Parity+ counts the matrix header shows. */
export function parityCounts(rows: readonly ParityRow[]) {
  return { parity: rows.filter((r) => r.ours === 'parity').length, better: rows.filter((r) => r.ours === 'better').length, added: rows.filter((r) => r.ours === 'new').length };
}

export type AdCard = { channel: string; headline: string; body: string; cta: string; angle: string };
export type AdsView = { hooks: string[]; ads: AdCard[]; posts: { channel: string; text: string }[]; emails: { subject: string; body: string; day: number }[] };

/** Reads `adkit` (hooks, ads, posts, emails) or `ads` ({ ads }). */
export function readAds(raw: unknown): AdsView {
  const p = obj(raw);
  return {
    hooks: arr(p.hooks).slice(0, 20).map((h) => str(h, 200)).filter(Boolean),
    ads: arr(p.ads)
      .slice(0, 40)
      .map((a) => {
        const o = obj(a);
        return { channel: str(o.channel, 20) || 'ad', headline: str(o.headline, 140), body: str(o.body, 600), cta: str(o.cta, 60), angle: str(o.angle, 120) };
      })
      .filter((a) => a.headline || a.body),
    posts: arr(p.posts).slice(0, 10).map((x) => ({ channel: str(obj(x).channel, 20), text: str(obj(x).text, 800) })),
    emails: arr(p.emails).slice(0, 10).map((x) => ({ subject: str(obj(x).subject, 140), body: str(obj(x).body, 1200), day: Number(obj(x).sendDay) || 0 })),
  };
}

export type TestReport = {
  winner: { family: string; model: string; passed: number; total: number } | null;
  candidates: { family: string; model: string; passed: number; total: number; passRate: number | null; refused: boolean; lintErrors: number | null; bundleBytes: number | null; error: string | null }[];
};

export function readTestReport(raw: unknown): TestReport {
  const p = obj(raw);
  const w = obj(p.winner);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const nn = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    winner: Object.keys(w).length ? { family: str(w.family, 40), model: str(w.model, 80), passed: n(w.passed), total: n(w.total) } : null,
    candidates: arr(p.candidates).map((c) => {
      const o = obj(c);
      return { family: str(o.family, 40), model: str(o.model, 80), passed: n(o.passed), total: n(o.total), passRate: nn(o.passRate), refused: o.refused === true, lintErrors: nn(o.lintErrors), bundleBytes: nn(o.bundleBytes), error: str(o.error, 200) || null };
    }),
  };
}

export type LicenceView = {
  verdict: string;
  tool: string;
  obligations: string[];
  reasons: string[];
  components: { name: string; spdx: string | null; verdict: string }[];
  project: { name: string; spdx: string | null } | null;
  sha256: string | null;
};

/** Reads the `licence` report ({ report, decision }) or Fork & Flip's `fork` report ({ project, plan, decision, report }). */
export function readLicence(raw: unknown): LicenceView {
  const p = obj(raw);
  const d = obj(p.decision);
  const r = obj(p.report);
  const proj = obj(p.project);
  const comps = arr(d.components).length ? arr(d.components) : arr(r.components);
  return {
    verdict: str(d.verdict, 40) || 'manual',
    tool: str(r.tool, 20) || 'builtin',
    obligations: arr(d.obligations).slice(0, 12).map((o) => str(o, 300)),
    reasons: arr(d.reasons).slice(0, 12).map((o) => str(o, 300)),
    components: comps.slice(0, 60).map((c) => {
      const o = obj(c);
      return { name: str(o.name, 80), spdx: str(o.spdx, 80) || null, verdict: str(o.verdict, 40) };
    }),
    project: Object.keys(proj).length ? { name: str(proj.name, 80), spdx: str(proj.spdx, 80) || null } : null,
    sha256: str(r.sha256, 80) || null,
  };
}

export const VERDICT_LABELS: Record<string, string> = {
  allow: 'Clear to ship',
  'allow-with-obligations': 'Clear, with notices to keep',
  'needs-gpl-repo': 'Ship it as a GPL repo',
  'needs-publish-source': 'Publish the source',
  manual: 'Needs a person to look',
  'clean-room': 'Rebuild it clean-room',
};

// ---- follow-ons ---------------------------------------------------------------------------------------------------

export const RUN_TASK_LABELS: Record<RunTask, { title: string; body: string }> = {
  watch: { title: 'Watch the rival', body: 'Scout Mo checks their public site each day for new features and prices.' },
  improve: { title: 'Improve', body: 'Strategist Mo proposes the next feature from what changed.' },
  ads: { title: 'Fresh ads', body: 'Adman Mo writes new ads from the plan.' },
  brief: { title: 'Monday brief', body: 'Boss Mo sums up the week in one page.' },
};

export function runModeProblem(b: { daily_cap_usd: number; tasks: readonly string[]; target_url?: string }): string | null {
  if (!(b.daily_cap_usd >= RUN_MODE.minDailyCapUsd && b.daily_cap_usd <= RUN_MODE.maxDailyCapUsd)) return `Set a daily cap between $${RUN_MODE.minDailyCapUsd} and $${RUN_MODE.maxDailyCapUsd}.`;
  if (!b.tasks.length) return 'Pick at least one task.';
  if (b.tasks.includes('watch')) {
    if (!b.target_url?.trim()) return 'Watching needs the rival’s address again: it is kept encrypted only while Run Mode is on.';
    return urlProblem(b.target_url, 'The rival address');
  }
  return null;
}

/** Most of the daily cap goes to work: the fee comes off the top. */
export const runModeUsage = (cap: number) => Math.max(0, cap - RUN_MODE.dailyFeeUsd);

export function recipeProblem(b: RecipeBody, tier: Tier): string | null {
  if (!b.title.trim()) return 'Give the Recipe a title.';
  if (b.title.length > 80) return 'Keep the title under 80 characters.';
  if (!(b.price_usd >= 0 && b.price_usd <= RECIPE_MAX_USD)) return `Set a price from $0 to $${RECIPE_MAX_USD}.`;
  if (b.price_usd > 0 && !TIER_RULES[tier].recipeSelling) return 'Selling Recipes needs the Gang tier or above. Share it for free instead.';
  return null;
}

/** Short relative time ("in 3 h", "4 min ago") from a fixed clock. */
export function relTime(iso: string | null, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = t - now;
  const abs = Math.abs(diff);
  const [n, unit] = abs < 60_000 ? [Math.round(abs / 1000), 's'] : abs < 3_600_000 ? [Math.round(abs / 60_000), 'min'] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), 'h'] : [Math.round(abs / 86_400_000), 'd'];
  return diff >= 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}

/** Elapsed run time as m:ss. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const shortHash = (h: string | null | undefined, n = 10) => (h ? `${h.replace(/^0x/, '').slice(0, n)}…` : '—');

/** Words the Ventures pages never use (Overview §11), checked against every string these pages ship. */
export const NEVER_SAY = [/\bearn(?:s|ed|ing|ings)?\b/i, /\byields?\b/i, /\bapy\b/i, /\bguarantee(?:d|s)?\b/i, /\bbet(?:s|ting)?\b/i, /\bodds\b/i, /\bgambl(?:e|es|ed|ing)\b/i, /\bpartner(?:s|ed|ship|ships)?\b/i, /\bofficial(?:ly)?\b/i, /\baudit(?:ed)?\b/i, /\bclone\s+any\s+site\b/i, /\bcopy\s+their\s+code\b/i, /\bsteal\s+their\s+store\b/i];
export const copyProblems = (text: string) => NEVER_SAY.filter((re) => re.test(text)).map((re) => re.source);
