// Update "ventures": the demo gateway's crew. It answers every /v1/ventures path the dashboard calls with the gateway's
// shapes (gateway/src/anonymo/ventures/routes.ts) and plays a whole run as a timed script of step, candidate, artifact
// and log events, so a run can be watched (and filmed) end to end with no key and no gateway. A run takes `runMs`
// (about 25 seconds by default); GET /v1/ventures/{id} folds the events that are due by now, and the event stream
// sends each one when it falls due, resuming after Last-Event-ID. The DAGs mirror boss.ts planVenture() at the Gang
// tier. Every business, brand, rival and address here is made up (.example hosts).

import { hashPair, keccakHex } from '../proof.ts';
import { generateDesignSystem, moodFor, type DesignSystem, type Mood } from './design/tokens.ts';
import { ensureUnique } from './design/uniqueness.ts';
import {
  TIER_RULES,
  applyEvent,
  isTerminal,
  modeInfo,
  priceOf,
  runModeProblem,
  recipeProblem,
  urlProblem,
  type ArtifactInfo,
  type ArtifactRef,
  type Candidate,
  type CreateVentureBody,
  type Recipe,
  type Role,
  type RunTask,
  type Tier,
  type VentureEvent,
  type VentureMode,
  type VentureSnapshot,
  type VentureStatus,
  type VentureSummary,
  type Zone,
} from '../ventures.ts';

const enc = new TextEncoder();
const hex = (s: string) => keccakHex(enc.encode(s)).slice(2);
const id8 = (s: string) => hex(s).slice(0, 12);

type StepTemplate = { key: string; task: string; role: Role; kind: string; zone: Zone; fanout: number; select: string; needs: string[]; share: number };
const t = (s: Omit<StepTemplate, 'fanout' | 'select' | 'zone' | 'share'> & Partial<StepTemplate>): StepTemplate => ({ fanout: 1, select: 'single', zone: 'CLEAN', share: 0.08, ...s });

/** boss.ts planVenture(), at a tier. */
export function planSteps(mode: VentureMode, tier: Tier): StepTemplate[] {
  const rules = TIER_RULES[tier];
  const council = Math.min(3, rules.families);
  const builders = rules.builders;
  const merge = council > 1 ? 'council-merge' : 'single';
  const select = council > 1 ? 'council-select' : 'single';
  const loop = (needs: string[], brief: string): StepTemplate[] => [
    t({ key: 'tests', task: 'tester.tests', role: 'tester', kind: 'code', needs, share: 0.1 }),
    t({ key: 'build', task: 'builder.app', role: 'builder', kind: 'code', fanout: builders, select: 'tests', needs: ['tests', brief], share: 0.3 }),
    t({ key: 'redteam', task: 'redteam.scan', role: 'red-team', kind: 'scan', needs: ['build'], share: 0.05 }),
    t({ key: 'licence', task: 'licence.scan', role: 'licence', kind: 'scan', needs: ['build'], share: 0.01 }),
  ];
  switch (mode) {
    case 'IDEA_TO_LIVE':
      return [
        t({ key: 'research', task: 'strategist.research', role: 'strategist', kind: 'research', fanout: council, select: merge, needs: [] }),
        t({ key: 'plan', task: 'strategist.plan', role: 'strategist', kind: 'plan', fanout: council, select: merge, needs: ['research'] }),
        t({ key: 'design', task: 'designer.system', role: 'designer', kind: 'design', needs: ['plan'], share: 0.03 }),
        t({ key: 'copy', task: 'adman.landing', role: 'adman', kind: 'copy', fanout: council, select, needs: ['plan'], share: 0.06 }),
        t({ key: 'landing', task: 'designer.landing', role: 'designer', kind: 'design', needs: ['design', 'copy'], share: 0.01 }),
        t({ key: 'ads', task: 'adman.adkit', role: 'adman', kind: 'copy', fanout: council, select, needs: ['plan'], share: 0.06 }),
        t({ key: 'launch', task: 'strategist.launch', role: 'strategist', kind: 'plan', needs: ['plan', 'ads'], share: 0.04 }),
        ...loop(['plan'], 'plan'),
        t({ key: 'repo', task: 'repo.commit', role: 'boss', kind: 'code', needs: ['build', 'redteam', 'landing', 'licence', 'design', 'plan', 'ads'], share: 0.01 }),
      ];
    case 'BUILD_BETTER':
      return [
        t({ key: 'scout', task: 'scout.site', role: 'scout', kind: 'research', zone: 'SCOUT', needs: [], share: 0.06 }),
        t({ key: 'spec', task: 'spec.filter', role: 'spec-filter', kind: 'spec', zone: 'SCOUT', needs: ['scout'], share: 0.04 }),
        t({ key: 'parity', task: 'strategist.parity', role: 'strategist', kind: 'plan', fanout: council, select: merge, needs: ['spec'], share: 0.1 }),
        t({ key: 'design', task: 'designer.system', role: 'designer', kind: 'design', needs: ['parity'], share: 0.03 }),
        t({ key: 'copy', task: 'adman.landing', role: 'adman', kind: 'copy', fanout: council, select, needs: ['parity'], share: 0.05 }),
        t({ key: 'landing', task: 'designer.landing', role: 'designer', kind: 'design', needs: ['design', 'copy'], share: 0.01 }),
        t({ key: 'comparison', task: 'adman.comparison', role: 'adman', kind: 'copy', fanout: council, select, needs: ['spec', 'parity', 'design'], share: 0.05 }),
        ...loop(['parity'], 'parity'),
        t({ key: 'repo', task: 'repo.commit', role: 'boss', kind: 'code', needs: ['build', 'redteam', 'landing', 'licence', 'design', 'comparison', 'parity'], share: 0.01 }),
      ];
    case 'TAKEOVER':
      return [
        t({ key: 'scout', task: 'scout.site', role: 'scout', kind: 'research', zone: 'SCOUT', needs: [], share: 0.08 }),
        t({ key: 'spec', task: 'spec.filter', role: 'spec-filter', kind: 'spec', zone: 'SCOUT', needs: ['scout'], share: 0.04 }),
        t({ key: 'parity', task: 'strategist.parity', role: 'strategist', kind: 'plan', fanout: council, select: merge, needs: ['spec'], share: 0.1 }),
        t({ key: 'design', task: 'designer.system', role: 'designer', kind: 'design', needs: ['parity'], share: 0.03 }),
        t({ key: 'comparison', task: 'adman.comparison', role: 'adman', kind: 'copy', fanout: council, select, needs: ['spec', 'parity', 'design'], share: 0.08 }),
        t({ key: 'switch', task: 'adman.switch', role: 'adman', kind: 'copy', fanout: council, select, needs: ['spec', 'parity', 'design'], share: 0.08 }),
        t({ key: 'ads', task: 'adman.takeover-ads', role: 'adman', kind: 'copy', fanout: council, select, needs: ['spec', 'parity'], share: 0.12 }),
        t({ key: 'tests', task: 'tester.import', role: 'tester', kind: 'code', needs: ['spec'], share: 0.08 }),
        t({ key: 'build', task: 'builder.import', role: 'builder', kind: 'code', fanout: builders, select: 'tests', needs: ['tests', 'spec'], share: 0.25 }),
        t({ key: 'redteam', task: 'redteam.scan', role: 'red-team', kind: 'scan', needs: ['build'], share: 0.03 }),
        t({ key: 'licence', task: 'licence.scan', role: 'licence', kind: 'scan', needs: ['build'], share: 0.01 }),
        t({ key: 'repo', task: 'repo.commit', role: 'boss', kind: 'code', needs: ['build', 'redteam', 'licence', 'comparison', 'switch', 'ads', 'design', 'parity'], share: 0.01 }),
      ];
    case 'FORK_FLIP':
      return [
        t({ key: 'fork', task: 'licence.fork', role: 'licence', kind: 'scan', needs: [], share: 0.02 }),
        t({ key: 'plan', task: 'strategist.fork-plan', role: 'strategist', kind: 'plan', fanout: council, select: merge, needs: ['fork'], share: 0.15 }),
        t({ key: 'design', task: 'designer.system', role: 'designer', kind: 'design', needs: ['plan'], share: 0.03 }),
        t({ key: 'copy', task: 'adman.landing', role: 'adman', kind: 'copy', fanout: council, select, needs: ['plan'], share: 0.06 }),
        t({ key: 'landing', task: 'designer.landing', role: 'designer', kind: 'design', needs: ['design', 'copy'], share: 0.01 }),
        t({ key: 'rebrand', task: 'builder.rebrand', role: 'builder', kind: 'code', needs: ['fork', 'design', 'plan'], share: 0.05 }),
        t({ key: 'redteam', task: 'redteam.scan', role: 'red-team', kind: 'scan', needs: ['rebrand'], share: 0.03 }),
        t({ key: 'repo', task: 'repo.commit', role: 'boss', kind: 'code', needs: ['rebrand', 'redteam', 'landing', 'design', 'plan'], share: 0.01 }),
      ];
    default:
      return [];
  }
}

/** Run Mode's first tick (boss.ts runTickPlan). */
function tickSteps(tasks: readonly RunTask[]): StepTemplate[] {
  const out: StepTemplate[] = [];
  if (tasks.includes('watch')) {
    out.push(t({ key: 't1-scout', task: 'scout.site', role: 'scout', kind: 'research', zone: 'SCOUT', needs: [], share: 0.3 }));
    out.push(t({ key: 't1-spec', task: 'spec.filter', role: 'spec-filter', kind: 'spec', zone: 'SCOUT', needs: ['t1-scout'], share: 0.1 }));
    out.push(t({ key: 't1-watch', task: 'run.watch', role: 'strategist', kind: 'plan', needs: ['t1-spec'], share: 0.1 }));
  }
  if (tasks.includes('improve')) out.push(t({ key: 't1-improve', task: 'run.improve', role: 'strategist', kind: 'plan', needs: [], share: 0.2 }));
  if (tasks.includes('ads')) out.push(t({ key: 't1-ads', task: 'run.ads', role: 'adman', kind: 'copy', needs: [], share: 0.15 }));
  if (tasks.includes('brief')) out.push(t({ key: 't1-brief', task: 'run.brief', role: 'boss', kind: 'plan', needs: out.filter((s) => s.key.endsWith('watch')).map((s) => s.key), share: 0.1 }));
  return out;
}

// ---- the made-up businesses ---------------------------------------------------------------------------------------

type Palette = { ink: string; paper: string; accent: string; soft: string; font: string; head?: string; onAccent?: string; radius?: { button: string; card: string } };
/** A run's own look, made the way the product makes it (gateway design/: a system seeded by the run, re-seeded until it
 *  differs from the earlier looks). */
type Look = { palette: Palette; mood: Mood; attempts: number; distance: number; hueGap: number; unique: boolean };
type Scenario = {
  brand: string;
  rival: string | null;
  tagline: string;
  subhead: string;
  eyebrow: string;
  palette: Palette;
  features: { title: string; body: string }[];
  pricing: { name: string; price: number | null; features: string[] }[];
  plan: Record<string, unknown>;
  rows: { feature: string; us: string; them: string; seen: string }[];
  ads: { channel: string; headline: string; body: string; cta: string; angle: string }[];
  /** The ad kit's launch posts and welcome emails (Idea to Live), as many as the real Adman Mo is asked for (5 and 4). */
  posts?: { channel: string; text: string }[];
  emails?: { subject: string; body: string; sendDay: number }[];
  files: string[];
  look?: Look;
};

const SEEN = '2026-11-18';

function scenario(mode: VentureMode, brand?: string | null, rival?: string | null): Scenario {
  if (mode === 'IDEA_TO_LIVE') {
    const b = brand || 'Leaflog';
    return {
      brand: b,
      rival: null,
      eyebrow: 'Plant care for busy renters',
      tagline: 'Every plant watered. Nothing to remember.',
      subhead: `${b} learns each plant from one photo and nudges you on the right day, by text or by push.`,
      palette: { ink: '#1f3324', paper: '#f5f1e6', accent: '#3f8a4e', soft: '#dfe9d5', font: 'Georgia, "Times New Roman", serif' },
      features: [
        { title: 'One photo per plant', body: 'Snap it once. The schedule fits its species, pot and window.' },
        { title: 'Nudges that fit your week', body: 'Quiet hours, travel mode and a friend who can cover.' },
        { title: 'A log you can share', body: 'Hand the plant sitter one link with everything they need.' },
      ],
      pricing: [
        { name: 'Sprout', price: 0, features: ['Up to 5 plants', 'Push nudges'] },
        { name: 'Grove', price: 4, features: ['Unlimited plants', 'Text nudges', 'Sitter link'] },
        { name: 'Household', price: 9, features: ['Shared home', '5 people', 'Travel mode'] },
      ],
      plan: {
        name: b,
        positioning: 'The plant-care reminder that needs one photo and nothing else.',
        audience: 'Renters with 5 to 30 houseplants and an irregular week.',
        problem: 'Plants die from guesswork: too much water, then none at all.',
        mvpFeatures: [
          { id: 'plant-profile', title: 'Plant profile from a photo', description: 'Create a plant with species, pot size and light.', acceptance: ['POST /plants with a name returns 201 and an id', 'GET /plants/{id} returns the schedule in days'] },
          { id: 'nudges', title: 'Watering nudges', description: 'A due list ordered by urgency.', acceptance: ['GET /due returns plants due today first', 'POST /plants/{id}/watered resets the countdown'] },
          { id: 'sitter-link', title: 'Sitter link', description: 'A read-only link for someone covering.', acceptance: ['POST /share returns a token', 'GET /share/{token} lists plants without owner details'] },
        ],
        pricing: [
          { name: 'Sprout', priceUsdMonthly: 0, features: ['Up to 5 plants'] },
          { name: 'Grove', priceUsdMonthly: 4, features: ['Unlimited plants', 'Text nudges'] },
          { name: 'Household', priceUsdMonthly: 9, features: ['Shared home'] },
        ],
        launch: ['Day 1: post the before and after of a rescued fern', 'Day 3: plant-swap meetups in two cities', 'Day 7: sitter link as a referral'],
      },
      rows: [],
      ads: [
        { channel: 'meta', headline: 'Your fern called. It is thirsty.', body: 'One photo, and Leaflog knows when. No spreadsheets, no guilt.', cta: 'Start free', angle: 'guilt-free care' },
        { channel: 'tiktok', headline: 'POV: you finally stopped overwatering', body: 'The schedule fits each pot and window. Five plants free.', cta: 'Try it', angle: 'overwatering' },
        { channel: 'reddit', headline: 'Going away for a week?', body: 'Send your plant sitter one link with every plant and when to water it.', cta: 'Make a sitter link', angle: 'travel' },
        { channel: 'google', headline: 'Houseplant watering reminders', body: 'Schedules by species, pot and light. Free for 5 plants.', cta: 'Get started', angle: 'search' },
        { channel: 'x', headline: '30 plants, zero memory required', body: 'Leaflog does the remembering. You do the admiring.', cta: 'Start free', angle: 'collectors' },
        { channel: 'meta', headline: 'Quiet hours included', body: 'Nudges arrive when you are home, never at 3 am.', cta: 'Start free', angle: 'calm' },
        { channel: 'google', headline: 'Plant watering schedule app', body: 'One photo per plant. Reminders by species, pot and light.', cta: 'Start free', angle: 'search' },
        { channel: 'reddit', headline: 'Lost another pothos to guesswork?', body: `${b} learns each plant from one photo and says when it is thirsty.`, cta: 'Try free', angle: 'plant loss' },
        { channel: 'tiktok', headline: 'My plants have better routines than me', body: `${b} nudges me on the right day for each one.`, cta: 'Try it', angle: 'humour' },
        { channel: 'x', headline: 'Watering by the calendar drowns plants.', body: `${b} times each plant by its species, pot and window.`, cta: 'Start free', angle: 'overwatering' },
        { channel: 'meta', headline: 'Hand the plants over with one link', body: 'Your sitter sees every plant and when to water it. Nothing to explain.', cta: 'Make a sitter link', angle: 'travel' },
        { channel: 'google', headline: 'Text reminders for houseplants', body: `Get the nudge by text or push. Unlimited plants on ${b} Grove.`, cta: 'See plans', angle: 'search' },
      ],
      posts: [
        { channel: 'producthunt', text: `${b} is live: every plant watered, nothing to remember. One photo per plant, a nudge on the right day.` },
        { channel: 'x', text: `We built ${b} for one reason: plants die from guesswork. One photo, and it knows when each one needs water.` },
        { channel: 'reddit', text: `I made a plant-care reminder for renters with too many houseplants. One photo per plant, quiet hours, a sitter link.` },
        { channel: 'hn', text: `Show HN: ${b}, watering reminders timed by species, pot and light` },
        { channel: 'x', text: `Going away? ${b} makes one link your plant sitter can open. Every plant, and when to water it.` },
      ],
      emails: [
        { subject: `Welcome to ${b}`, body: 'Here is how to start in two minutes: one photo of your first plant.', sendDay: 0 },
        { subject: 'Add the rest of the shelf', body: 'Each plant gets its own schedule from one photo.', sendDay: 1 },
        { subject: 'One tip most people miss', body: 'Turn on quiet hours.', sendDay: 3 },
        { subject: 'Going away soon?', body: 'Make a sitter link before you pack.', sendDay: 7 },
      ],
      files: ['README.md', 'package.json', 'src/app.ts', 'src/plants.ts', 'src/due.ts', 'src/share.ts', 'test/plants.test.ts', 'test/due.test.ts', 'public/index.html', 'LICENSE', 'NOTICE'],
    };
  }
  if (mode === 'TAKEOVER') {
    const b = brand || 'Ledgerlark';
    const r = rival || 'InvoiceMule';
    return {
      brand: b,
      rival: r,
      eyebrow: `The ${r} alternative`,
      tagline: 'Invoices that get paid, not chased.',
      subhead: `Move from ${r} in one import. Your clients, items and history come with you.`,
      palette: { ink: '#251b3d', paper: '#fbf8ff', accent: '#6b4fd8', soft: '#ece6ff', font: '"Helvetica Neue", Arial, sans-serif' },
      features: [
        { title: 'One-click import', body: `Bring your ${r} CSV export: clients, items, invoices and payments.` },
        { title: 'Reminders that sound human', body: 'Polite nudges on day 3, 7 and 14, in your own words.' },
        { title: 'Flat price', body: 'No per-invoice fees. No seat limits for a team of five.' },
      ],
      pricing: [
        { name: 'Solo', price: 0, features: ['10 invoices a month'] },
        { name: 'Studio', price: 12, features: ['Unlimited invoices', 'Reminders'] },
        { name: 'Team', price: 24, features: ['5 seats', 'Approvals'] },
      ],
      plan: parityPlan(b, r, 'freelancers and small studios who invoice every week', [
        ['Recurring invoices', true, 'parity', 'Same schedules, plus pause and resume'],
        ['Payment reminders', true, 'better', 'Editable tone, sent on day 3, 7 and 14'],
        ['CSV import', false, 'new', `Reads the ${r} export as is`],
        ['Multi-currency', true, 'parity', '32 currencies'],
        ['Client portal', true, 'better', 'No login needed: a signed link per client'],
        ['Late fees', false, 'new', 'Optional, off by default'],
        ['Team seats', true, 'better', '5 seats on the Team plan, not 2'],
      ], 29, 24),
      rows: [
        { feature: 'Import from the other tool', us: 'One click', them: 'Not offered', seen: SEEN },
        { feature: 'Per-invoice fee', us: 'None', them: '$0.50 above 20 a month', seen: SEEN },
        { feature: 'Seats on the team plan', us: '5', them: '2', seen: SEEN },
        { feature: 'Reminder schedule', us: 'Day 3, 7, 14, editable', them: 'Day 7 only', seen: SEEN },
        { feature: 'Top plan price', us: '$24 a month', them: '$29 a month', seen: SEEN },
      ],
      // 30 ads, five per complaint theme, one per channel: what the real Adman Mo is asked for (mos/adman.ts takeoverAds).
      // Listed theme by theme in turn, so the grid reads as a mix. Every claim is one the plan delivers.
      ads: interleave([
        [
          { channel: 'google', headline: `Leaving ${r}? Bring everything.`, body: 'Clients, items and history in one import. Flat price, no per-invoice fees.', cta: 'Import now', angle: 'switching cost' },
          { channel: 'x', headline: `Your ${r} export already fits.`, body: `${b} reads their CSV as is. Clients and history come straight across.`, cta: 'Bring it over', angle: 'switching cost' },
          { channel: 'reddit', headline: `Staying on ${r} because moving is a pain?`, body: `Drop in their CSV export. ${b} maps clients, items and payments for you.`, cta: 'Try the import', angle: 'switching cost' },
          { channel: 'meta', headline: 'Switch tools without retyping a thing.', body: `One import brings your ${r} clients, invoices and payments.`, cta: 'Import now', angle: 'switching cost' },
          { channel: 'tiktok', headline: 'POV: you moved invoicing apps in one upload', body: `Export from ${r}, drop the file into ${b}, keep working.`, cta: 'Start free', angle: 'switching cost' },
        ],
        [
          { channel: 'x', headline: 'No fee per invoice. Ever.', body: `Send as many as you need. ${b} charges a flat monthly price.`, cta: 'Start free', angle: 'fees' },
          { channel: 'google', headline: 'Invoicing with no per-invoice fees', body: 'One flat monthly price, however many invoices you send.', cta: 'See pricing', angle: 'fees' },
          { channel: 'reddit', headline: 'Paying extra after your 20th invoice?', body: `${r} charges per invoice past 20 a month. ${b} doesn't.`, cta: 'Compare plans', angle: 'fees' },
          { channel: 'meta', headline: 'Busy month? Same price.', body: `${b} never charges per invoice, so a good month costs what a slow one does.`, cta: 'See plans', angle: 'fees' },
          { channel: 'tiktok', headline: 'When the invoice app charges you for invoicing', body: `${b} is one flat price. Send all you like.`, cta: 'Try free', angle: 'fees' },
        ],
        [
          { channel: 'meta', headline: 'Five seats. One flat price.', body: 'Your whole studio on one plan, without paying per person.', cta: 'See plans', angle: 'seat limits' },
          { channel: 'reddit', headline: "Two seats isn't a team.", body: `${b}'s Team plan has 5 seats for one price.`, cta: 'See the Team plan', angle: 'seat limits' },
          { channel: 'google', headline: 'Invoicing for small studios, 5 seats', body: 'Bring the whole team onto one plan.', cta: 'See plans', angle: 'seat limits' },
          { channel: 'x', headline: 'Stop sharing one login.', body: `${b} gives a team of five their own seats on one plan.`, cta: 'Add your team', angle: 'seat limits' },
          { channel: 'tiktok', headline: 'Our studio of five, one invoicing plan', body: `No per-person pricing on ${b}'s Team plan.`, cta: 'See plans', angle: 'seat limits' },
        ],
        [
          { channel: 'reddit', headline: 'Chasing invoices again this month?', body: `${b} sends polite reminders on day 3, 7 and 14 so you don't have to.`, cta: 'Try free', angle: 'late payments' },
          { channel: 'google', headline: 'Automatic payment reminders', body: 'Day 3, 7 and 14, in your own words. Set it once.', cta: 'Start free', angle: 'late payments' },
          { channel: 'meta', headline: 'Get paid without the awkward email.', body: `${b} nudges clients for you, on a schedule you choose.`, cta: 'Try free', angle: 'late payments' },
          { channel: 'x', headline: "One reminder on day 7 isn't a system.", body: `${b} follows up on day 3, 7 and 14, and you can edit every word.`, cta: 'Start free', angle: 'late payments' },
          { channel: 'tiktok', headline: `Me watching ${b} chase my late invoices`, body: 'Reminders go out on day 3, 7 and 14. I just get paid.', cta: 'Try free', angle: 'late payments' },
        ],
        [
          { channel: 'meta', headline: 'Clients pay without making an account.', body: 'Each client gets a signed link to their invoices. No login.', cta: 'Start free', angle: 'client logins' },
          { channel: 'google', headline: 'Client portal, no login needed', body: 'Send a secure link. Clients see and pay their invoices.', cta: 'Try free', angle: 'client logins' },
          { channel: 'reddit', headline: 'Clients keep losing their invoice-app password?', body: `${b} sends each client a signed link instead. Nothing to remember.`, cta: 'See how', angle: 'client logins' },
          { channel: 'x', headline: "Your clients shouldn't need a password to pay you.", body: `${b} gives each one a private link to their invoices.`, cta: 'Start free', angle: 'client logins' },
          { channel: 'tiktok', headline: 'My client paid without making an account', body: `${b} sends a signed link. They open it and pay.`, cta: 'Try free', angle: 'client logins' },
        ],
        [
          { channel: 'google', headline: `Less than ${r}'s top plan`, body: `${b} Team is $24 a month. Theirs is $29.`, cta: 'Compare prices', angle: 'price' },
          { channel: 'x', headline: `$5 a month under ${r}.`, body: `Recurring invoices, reminders and 5 seats on ${b} Team for $24.`, cta: 'See pricing', angle: 'price' },
          { channel: 'reddit', headline: `Is a $29 top plan worth it?`, body: `${b} Team does recurring invoices, reminders and 5 seats for $24.`, cta: 'See pricing', angle: 'price' },
          { channel: 'meta', headline: 'Top plan, lower price.', body: `${b} Team: $24 a month, with 5 seats and editable reminders.`, cta: 'See plans', angle: 'price' },
          { channel: 'tiktok', headline: 'Switched invoicing apps and saved $5 a month', body: `${b} Team is $24. No per-invoice fees.`, cta: 'Start free', angle: 'price' },
        ],
      ]),
      files: ['README.md', 'package.json', 'src/app.ts', 'src/import/csv.ts', 'src/import/map.ts', 'src/invoices.ts', 'test/import.test.ts', 'test/invoices.test.ts', 'LICENSE', 'NOTICE'],
    };
  }
  if (mode === 'FORK_FLIP') {
    const b = brand || 'Quillpad';
    return {
      brand: b,
      rival: null,
      eyebrow: 'Notes, rebuilt in the open',
      tagline: 'Fast notes that stay on your device.',
      subhead: `${b} starts from a well-loved MIT notes app and adds sync you host yourself.`,
      palette: { ink: '#2b2118', paper: '#fffaf2', accent: '#c4622d', soft: '#f6e3d3', font: 'Georgia, "Times New Roman", serif' },
      features: [
        { title: 'Local first', body: 'Every note lives on your device. Sync is optional and yours.' },
        { title: 'Markdown, plain files', body: 'Open your notes in any editor, any time.' },
        { title: 'Self-hosted sync', body: 'One small server, end-to-end encrypted.' },
      ],
      pricing: [
        { name: 'Free', price: 0, features: ['Every feature', 'Self-host sync'] },
        { name: 'Hosted', price: 5, features: ['We run sync for you'] },
      ],
      plan: {
        name: b,
        positioning: 'The notes app that keeps the upstream licence and adds what its users ask for.',
        audience: 'People who want plain-file notes with sync they control.',
        problem: 'Good open notes apps lack easy, private sync.',
        improvements: ['Self-hosted sync server', 'Quick capture from the share sheet', 'Daily notes template'],
        mvpFeatures: [
          { id: 'sync', title: 'Self-hosted sync', description: 'Encrypted sync to a server you run.', acceptance: ['POST /sync with a note returns 202', 'GET /sync?since= returns changed notes only'] },
          { id: 'capture', title: 'Quick capture', description: 'Add a note from anywhere.', acceptance: ['POST /notes returns 201 with an id'] },
        ],
        pricing: [
          { name: 'Free', priceUsdMonthly: 0, features: ['Everything'] },
          { name: 'Hosted', priceUsdMonthly: 5, features: ['Managed sync'] },
        ],
      },
      rows: [],
      ads: [],
      files: ['README.md', 'package.json', 'LICENSE', 'NOTICE', 'src/app.ts', 'src/sync/server.ts', 'src/sync/client.ts', 'src/capture.ts', 'test/sync.test.ts'],
    };
  }
  const b = brand || 'Quayside';
  const r = rival || 'SlotHarbor';
  return {
    brand: b,
    rival: r,
    eyebrow: 'Booking for small studios',
    tagline: 'Fill every slot. Skip the back-and-forth.',
    subhead: `${b} does what ${r} does, plus waitlists, deposits and a price that fits a studio of one.`,
    palette: { ink: '#0f3b47', paper: '#f6efe4', accent: '#ff7a59', soft: '#ffe2d8', font: '"Avenir Next", "Segoe UI", sans-serif' },
    features: [
      { title: 'Smart waitlist', body: 'A cancelled slot goes to the next person on the list within a minute.' },
      { title: 'Deposits that stick', body: 'Take a small deposit at booking. No-shows drop by half.' },
      { title: 'Your own page', body: 'A booking page in your colours, on your own domain.' },
    ],
    pricing: [
      { name: 'Solo', price: 0, features: ['1 calendar', '50 bookings a month'] },
      { name: 'Studio', price: 15, features: ['3 calendars', 'Waitlist', 'Deposits'] },
      { name: 'Team', price: 31, features: ['10 calendars', 'Your own domain'] },
    ],
    plan: parityPlan(b, r, 'yoga, tattoo and hair studios with 1 to 10 people', [
      ['Online booking page', true, 'parity', 'Same flow: service, time, details, confirm'],
      ['Calendar sync', true, 'parity', 'Google and iCal both ways'],
      ['Reminders', true, 'better', 'Text and email, with one-tap reschedule'],
      ['Waitlist', false, 'new', 'Most-asked gap in their reviews'],
      ['Deposits', false, 'new', 'Cuts no-shows; refunds on time'],
      ['Staff rotas', true, 'parity', 'Weekly patterns and exceptions'],
      ['Intake forms', true, 'better', 'Conditional questions, saved per client'],
      ['Custom domain', true, 'better', 'On the Team plan, not only Enterprise'],
      ['Group classes', true, 'parity', 'Capacity and a class list'],
      ['Gift cards', false, 'new', 'Sold from the booking page'],
    ], 39, 31),
    rows: [
      { feature: 'Waitlist for cancelled slots', us: 'Yes', them: 'No', seen: SEEN },
      { feature: 'Deposits at booking', us: 'Yes', them: 'No', seen: SEEN },
      { feature: 'Custom domain', us: 'Team plan', them: 'Enterprise only', seen: SEEN },
      { feature: 'Calendars on the middle plan', us: '3', them: '1', seen: SEEN },
      { feature: 'Reschedule from a reminder', us: 'One tap', them: 'Log in first', seen: SEEN },
      { feature: 'Top plan price', us: '$31 a month', them: '$39 a month', seen: SEEN },
    ],
    ads: [],
    files: ['README.md', 'package.json', 'src/app.ts', 'src/bookings.ts', 'src/waitlist.ts', 'src/deposits.ts', 'src/calendar.ts', 'test/bookings.test.ts', 'test/waitlist.test.ts', 'test/deposits.test.ts', 'public/index.html', 'LICENSE', 'NOTICE'],
  };
}

/** Theme by theme in turn: the first of each, then the second of each, and so on. */
function interleave<T>(groups: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(...groups.map((g) => g.length)); i++) for (const g of groups) if (g[i]) out.push(g[i]!);
  return out;
}

function parityPlan(brand: string, rival: string, audience: string, rows: [string, boolean, string, string][], theirTop: number, ourTop: number) {
  return {
    name: brand,
    positioning: `Everything ${rival} does for the people who use it most, with the gaps their users ask about filled in.`,
    audience: audience.charAt(0).toUpperCase() + audience.slice(1) + '.',
    problem: `${rival} users keep asking for the same missing pieces, and pay more than a small team should.`,
    parity: rows.map(([feature, theirs, ours, note]) => ({ feature, theirs, ours, note })),
    gaps: rows.filter((r) => !r[1]).map((r) => r[0]),
    mvpFeatures: rows.slice(0, 4).map(([feature, , , note], i) => ({ id: `feature-${i + 1}`, title: feature, description: note, acceptance: [`POST /${feature.toLowerCase().replace(/[^a-z]+/g, '-')} returns 201`, 'GET returns the saved record as JSON'] })),
    pricing: [
      { name: 'Solo', priceUsdMonthly: 0, features: ['Start free'] },
      { name: 'Studio', priceUsdMonthly: Math.round(ourTop / 2), features: ['Most teams'] },
      { name: 'Team', priceUsdMonthly: ourTop, features: ['Everything'] },
    ],
    priceUnder: { theirTopUsd: theirTop, ourTopUsd: ourTop, note: `Top plan $${theirTop - ourTop} a month under theirs.` },
  };
}

// ---- the crew's pages (no scripts; the dashboard shows them in a sandboxed iframe) ------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(p: Palette, title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:${p.paper};color:${p.ink};font:16px/1.55 ${p.font}}h1,h2,h3,.logo{font-family:${p.head ?? p.font}}
.wrap{max-width:980px;margin:0 auto;padding:28px 22px}
nav{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 22px;max-width:980px;margin:0 auto}
.logo{font-weight:700;font-size:20px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}.logo i{width:22px;height:22px;border-radius:7px;background:${p.accent};display:inline-block}
.btn{display:inline-block;padding:12px 20px;border-radius:${p.radius?.button ?? '999px'};background:${p.accent};color:${p.onAccent ?? '#fff'};font-weight:600;text-decoration:none}
.btn.ghost{background:transparent;color:${p.ink};border:1.5px solid ${p.ink}}
.eyebrow{display:inline-block;padding:4px 12px;border-radius:999px;background:${p.soft};color:${p.ink};font-size:13px;font-weight:600}
h1{font-size:clamp(32px,6vw,56px);line-height:1.04;letter-spacing:-.02em;margin:16px 0 12px}h2{font-size:clamp(22px,3.4vw,30px);margin:0 0 14px}
.lede{font-size:clamp(16px,2.2vw,19px);max-width:620px;opacity:.85}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.card{background:#fff;border:1px solid ${p.ink}1f;border-radius:${p.radius?.card ?? '18px'};padding:18px}
.card h3{margin:0 0 6px;font-size:18px}.card p{margin:0;opacity:.8}
.price{font-size:34px;font-weight:700}.price small{font-size:14px;font-weight:500;opacity:.7}
section{padding:22px 0}footer{padding:24px 22px;text-align:center;font-size:13px;opacity:.65}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:16px;overflow:hidden}th,td{padding:12px 14px;text-align:left;border-bottom:1px solid ${p.ink}14;font-size:15px}th{background:${p.soft}}
td.us{font-weight:700;color:${p.accent}}small.src{opacity:.6;font-size:12px}
.sw{height:86px;border-radius:14px;display:flex;align-items:flex-end;padding:10px;font:600 12px/1 ui-monospace,monospace}
</style></head><body>${body}</body></html>`;
}

function previewPage(s: Scenario) {
  const p = s.palette;
  const sw = (bg: string, fg: string, name: string) => `<div class="sw" style="background:${bg};color:${fg}">${name} ${bg}</div>`;
  return page(p, `${s.brand} design system`, `<nav><span class="logo"><i></i>${esc(s.brand)}</span><span class="eyebrow">Design system v1</span></nav><div class="wrap">
<h1>${esc(s.brand)}</h1><p class="lede">An original look made for this brand, kept only once it differed from the crew's earlier looks.</p>
<section><h2>Colour</h2><div class="grid">${sw(p.ink, p.paper, 'Ink')}${sw(p.paper, p.ink, 'Paper')}${sw(p.accent, p.onAccent ?? '#fff', 'Accent')}${sw(p.soft, p.ink, 'Soft')}</div></section>
<section><h2>Type</h2><div class="card"><div style="font-size:44px;font-weight:700;line-height:1.05">${esc(s.tagline)}</div><p style="margin-top:10px">${esc(s.subhead)}</p></div></section>
<section><h2>Components</h2><div class="grid"><div class="card"><span class="eyebrow">${esc(s.eyebrow)}</span><h3 style="margin-top:10px">${esc(s.features[0].title)}</h3><p>${esc(s.features[0].body)}</p></div>
<div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><a class="btn">Primary</a><a class="btn ghost">Secondary</a></div></div></section></div>`);
}

function landingPage(s: Scenario, eyebrow = s.eyebrow) {
  const p = s.palette;
  return page(p, s.brand, `<nav><span class="logo"><i></i>${esc(s.brand)}</span><a class="btn">Start free</a></nav><div class="wrap">
<section><span class="eyebrow">${esc(eyebrow)}</span><h1>${esc(s.tagline)}</h1><p class="lede">${esc(s.subhead)}</p><p style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn">Start free</a><a class="btn ghost">See pricing</a></p></section>
<section><div class="grid">${s.features.map((f) => `<div class="card"><h3>${esc(f.title)}</h3><p>${esc(f.body)}</p></div>`).join('')}</div></section>
<section><h2>Pricing</h2><div class="grid">${s.pricing.map((x) => `<div class="card"><h3>${esc(x.name)}</h3><div class="price">${x.price === null ? 'Ask' : `$${x.price}`}<small>${x.price ? ' / month' : ''}</small></div><p>${x.features.map(esc).join(' · ')}</p></div>`).join('')}</div></section>
</div><footer>${esc(s.brand)} · built by the crew, every step receipted</footer>`);
}

function comparisonPage(s: Scenario) {
  const p = s.palette;
  return page(p, `${s.brand} vs ${s.rival}`, `<nav><span class="logo"><i></i>${esc(s.brand)}</span><a class="btn">Switch now</a></nav><div class="wrap">
<span class="eyebrow">Side by side</span><h1>${esc(s.brand)} vs ${esc(s.rival ?? '')}</h1><p class="lede">Every row below is a fact we checked on their public pages, with the date we saw it.</p>
<section><table><thead><tr><th>Feature</th><th>${esc(s.brand)}</th><th>${esc(s.rival ?? '')}</th></tr></thead><tbody>
${s.rows.map((r) => `<tr><td>${esc(r.feature)}<br><small class="src">Seen ${r.seen}</small></td><td class="us">${esc(r.us)}</td><td>${esc(r.them)}</td></tr>`).join('')}
</tbody></table></section>
<section class="card"><h3>Switch offer</h3><p>Two months on us when you import from ${esc(s.rival ?? '')}. Your data comes with you in one step.</p><p style="margin-top:12px"><a class="btn">Import my account</a></p></section></div>
<footer>Prices and features as seen on ${SEEN}. Names belong to their owners.</footer>`);
}

// ---- a run, scripted ---------------------------------------------------------------------------------------------

type Artifact = { sha: string; name: string; kind: string; zone: Zone; mime: string; body: string; step: string; at: number };
type Scheduled = { at: number; event: VentureEvent };
type Run = {
  id: string;
  mode: VentureMode;
  tier: Tier;
  price: number;
  recipePrice: number;
  recipeId: string | null;
  brief: string;
  brand: string | null;
  rival: string | null;
  createdAt: number;
  steps: StepTemplate[];
  script: Scheduled[];
  artifacts: Artifact[];
  cancelledAt: number | null;
  targetCommit: string | null;
  candidates: Record<string, Candidate[]>;
  look?: Look;
  /** Run Mode ventures only. */
  runMode?: { enabled: boolean; cap: number; tasks: RunTask[]; hours: number; parent: string };
};

const DURATIONS: Record<string, number> = { scout: 3.2, spec: 2.2, research: 2.4, plan: 2.6, parity: 3, design: 2, copy: 1.8, landing: 1.4, comparison: 2, switch: 1.8, ads: 2.2, launch: 1.4, tests: 1.8, build: 6.5, rebrand: 3.5, redteam: 1.8, licence: 1.2, fork: 2, repo: 1 };

const LOGS: Record<string, (s: Scenario, mode: VentureMode) => string[]> = {
  scout: (s) => ['Opened 14 public pages, logged out', `Read ${s.rival}'s pricing page: 3 plans`, 'Stopped at the sign-up wall, as the rules say'],
  spec: () => ['Spec: 23 features, 6 flows, 9 data models, 3 plans', 'Leakage scan: 0 sentences of their copy crossed'],
  research: () => ['Mapped 5 rivals and 4 demand checks', 'Council merged 3 drafts'],
  plan: (s) => [`Plan for ${s.brand}: 3 MVP features`, 'Council merged 3 drafts'],
  parity: (s) => {
    const p = s.plan as { parity?: unknown[]; gaps?: unknown[] };
    return [`Parity+: ${p.parity?.length ?? 0} rows, ${p.gaps?.length ?? 0} gaps their users ask for`, 'Priced every plan under theirs'];
  },
  design: (s) =>
    !s.look
      ? ['Original palette and type']
      : [
          `Original palette and type, ${s.look.mood} mood`,
          !Number.isFinite(s.look.distance)
            ? 'No earlier looks to check against yet: kept'
            : `Checked against earlier looks: ${s.look.attempts} re-seed${s.look.attempts === 1 ? '' : 's'}, distance ${s.look.distance.toFixed(1)} from the nearest, main colour ${Math.round(s.look.hueGap)}° from the latest, ${s.look.unique ? 'kept' : 'the closest available kept'}`,
        ],
  copy: () => ['3 drafts, the council kept one'],
  landing: () => ['Landing page built from the design system'],
  comparison: () => ['Every row cites a dated fact', 'Claim checker dropped 2 uncited rows'],
  switch: (s) => [`Switch offer and import steps for the ${s.rival} export`],
  ads: (s, mode) =>
    mode === 'RUN'
      ? [`${Math.min(5, s.ads.length)} fresh ads to rotate in this week`, 'Copy rules removed 1 line']
      : [mode === 'TAKEOVER' ? `${s.ads.length} ads aimed at ${new Set(s.ads.map((a) => a.angle)).size} complaint themes` : `${s.ads.length} ads, ${s.posts?.length ?? 2} posts, ${s.emails?.length ?? 2} emails`, 'Copy rules removed 1 line'],
  launch: () => ['14-day launch plan'],
  improve: () => ['One improvement proposed for this week, with its acceptance tests'],
  brief: () => ['Monday brief written from this week’s steps'],
  tests: () => ['Wrote 24 tests from the acceptance criteria'],
  build: () => ['5 Builder Mos in 5 sandboxes, no network but the gateway'],
  rebrand: (s) => [`Rebranded the ${s.files.length} files of the fork to ${s.brand}, new colours and icon`],
  redteam: () => ['Checked auth, injection, secrets and dependencies: 0 high findings'],
  licence: () => ['All dependencies MIT, Apache-2.0 or ISC'],
  fork: () => ['Upstream is MIT: fork allowed, keep the notice'],
  repo: (s) => [`Committed ${s.files.length} files`],
};

/** The build race: who builds, what they reach, who refuses. */
const RACE = [
  { family: 'kimi', model: 'kimi-k2.7-code', passed: 23 },
  { family: 'deepseek', model: 'deepseek-v4.1-flash-abliterated', passed: 22 },
  { family: 'qwen', model: 'qwen3.5-27b-abliterated', passed: 20 },
  { family: 'gemma', model: 'gemma-4-26b-uncensored', passed: 17 }, // a self-hosted spare: the real crew only uses direct model IDs, never a Venice route
  { family: 'llama', model: 'llama-4-scout-abliterated', passed: 0, refuses: true },
];
const RACE_TOTAL = 24;
const REROUTE = { family: 'glm', model: 'glm-5.2-abliterated', passed: 19 };

function artifactsFor(run: Run, step: StepTemplate, s: Scenario): Omit<Artifact, 'sha' | 'at' | 'step'>[] {
  const j = (name: string, kind: string, body: unknown, zone: Zone = 'CLEAN') => ({ name, kind, zone, mime: 'application/json', body: JSON.stringify(body) });
  const h = (name: string, kind: string, body: string) => ({ name, kind, zone: 'CLEAN' as Zone, mime: 'text/html', body });
  const race = [...RACE.slice(0, TIER_RULES[run.tier].builders - 1), REROUTE];
  switch (step.key) {
    case 'scout':
      return [j('manifest', 'report', { pages: 14, logged_out: true }, 'SCOUT'), j('analysis', 'report', { flows: 6 }, 'SCOUT')];
    case 'spec':
      return [j('spec', 'spec', { features: 23, flows: 6 }), j('leakage', 'report', { sentences: 0 })];
    case 'research':
      return [j('research', 'report', { competitors: 5 })];
    case 'plan':
    case 'parity':
      return [j('plan', 'plan', s.plan)];
    case 'design':
      return [j('design', 'design', s.palette), { name: 'css', kind: 'design', zone: 'CLEAN', mime: 'text/css', body: `:root{--ink:${s.palette.ink};--accent:${s.palette.accent}}` }, h('preview', 'design', previewPage(s)), j('brand', 'design', { name: s.brand })];
    case 'copy':
      return [j('landing-copy', 'copy', { tagline: s.tagline, subhead: s.subhead })];
    case 'landing':
      return [h('landing', 'page', landingPage(s))];
    case 'comparison':
      return [h('comparison', 'page', comparisonPage(s)), j('comparison-claims', 'copy', { rows: s.rows, dropped: 2 })];
    case 'switch':
      return [h('alternative', 'page', landingPage(s, `The ${s.rival} alternative`)), j('switch', 'copy', { offer: { title: 'Two months on us', body: 'Import and keep going.', cta: 'Switch now' }, migration: ['Export a CSV', 'Drop it in', 'Check the preview'] })];
    case 'ads':
      if (run.mode === 'RUN') return [j('ads-rotation', 'copy', { ads: s.ads.slice(0, 5) })]; // Run Mode: 5 fresh ads (runmode.ts adsTask)
      return run.mode === 'TAKEOVER'
        ? [j('ads', 'copy', { ads: s.ads })]
        : [j('adkit', 'copy', { hooks: s.ads.slice(0, 10).map((a) => a.headline), ads: s.ads, posts: s.posts ?? [{ channel: 'producthunt', text: `${s.brand} is live: ${s.tagline}` }, { channel: 'x', text: `We built ${s.brand} for one reason: ${s.subhead}` }], emails: s.emails ?? [{ subject: `Welcome to ${s.brand}`, body: 'Here is how to start in two minutes.', sendDay: 0 }, { subject: 'One tip most people miss', body: 'Turn on quiet hours.', sendDay: 3 }] })];
    case 'launch':
      return [j('launch', 'plan', { days: [{ day: 1, tasks: ['Launch post'] }] })];
    case 'tests':
      return [j('tests', 'test', { total: RACE_TOTAL })];
    case 'build': {
      const winner = race.reduce((a, b) => (b.passed > a.passed ? b : a));
      return [
        j('code', 'code', Object.fromEntries(s.files.map((f) => [f, `// ${f}`]))),
        j('test-report', 'report', {
          winner: { family: winner.family, model: winner.model, passed: winner.passed, total: RACE_TOTAL },
          candidates: [...race, RACE[4]].map((c) => ({ family: c.family, model: c.model, passed: c.passed, total: RACE_TOTAL, passRate: 'refuses' in c ? null : c.passed / RACE_TOTAL, buildErrors: 0, lintErrors: 'refuses' in c ? null : (RACE_TOTAL - c.passed) % 4, bundleBytes: 'refuses' in c ? null : 41_000 + c.passed * 911, refused: 'refuses' in c, error: null })),
        }),
      ];
    }
    case 'rebrand':
      return [j('code', 'code', Object.fromEntries(s.files.map((f) => [f, `// ${f}`])))];
    case 'redteam':
      return [j('redteam', 'report', { findings: [{ severity: 'low', title: 'Rate limit the login route' }], verdict: 'ok' })];
    case 'licence':
      return [
        j('licence', 'report', {
          report: { tool: 'builtin', sha256: hex(`${run.id}:licence`), components: [], files: [], dualLicence: [] },
          decision: {
            verdict: 'allow-with-obligations',
            obligations: ['Keep the MIT and Apache-2.0 notices in NOTICE', 'Ship the NOTICE file with the app'],
            sourceLinkRequired: false,
            reasons: ['Every dependency is permissive', 'No copyleft code in the build'],
            components: [
              { name: 'venture-app', path: '.', spdx: 'MIT', effective: 'MIT', verdict: 'allow' },
              { name: 'hono', path: 'node_modules/hono', spdx: 'MIT', effective: 'MIT', verdict: 'allow' },
              { name: 'zod', path: 'node_modules/zod', spdx: 'MIT', effective: 'MIT', verdict: 'allow' },
              { name: 'date-fns', path: 'node_modules/date-fns', spdx: 'MIT', effective: 'MIT', verdict: 'allow' },
              { name: 'typescript', path: 'node_modules/typescript', spdx: 'Apache-2.0', effective: 'Apache-2.0', verdict: 'allow-with-obligations' },
            ],
          },
        }),
        { name: 'notice', kind: 'code', zone: 'CLEAN', mime: 'text/plain', body: 'NOTICE\n' },
      ];
    case 'fork':
      return [
        j('fork', 'report', {
          project: { name: 'notes-lite', summary: 'A small Markdown notes app', spdx: 'MIT' },
          plan: { action: 'fork', obligations: ['Keep the upstream MIT notice'] },
          decision: { verdict: 'allow-with-obligations', obligations: ['Keep the upstream MIT notice and copyright line', 'Rename the app and its icon'], sourceLinkRequired: false, reasons: ['Upstream is MIT', 'Its dependencies, marked and idb, are permissive'], components: [{ name: 'notes-lite', spdx: 'MIT', verdict: 'allow-with-obligations' }, { name: 'marked', spdx: 'MIT', verdict: 'allow' }, { name: 'idb', spdx: 'ISC', verdict: 'allow' }] },
          report: { sha256: hex(`${run.id}:fork`), tool: 'builtin', components: [] },
        }),
        j('snapshot', 'repo', { files: s.files.length }),
      ];
    case 'repo':
      return [j('repo', 'repo', { commit: hex(`${run.id}:commit`).slice(0, 40), files: [...s.files].sort() })];
    default:
      return [];
  }
}

const MOOD_WORDS: [Mood, RegExp][] = [
  ['technical', /\b(api|sdk|developer|devs?|cli|infra|database|logs?|monitor\w*|deploy\w*|webhooks?|terminal)\b/i],
  ['luxe', /\b(luxury|premium|boutique|bespoke|atelier|jewel\w*|fashion|concierge|wine)\b/i],
  ['playful', /\b(kids?|fun|games?|pets?|party|social|creator|meme|stickers?|quiz)\b/i],
  ['calm', /\b(health|wellness|sleep|therapy|meditat\w*|journal\w*|care|budget\w*|calm|family)\b/i],
  ['bold', /\b(launch|growth|sales|ads?|marketing|fitness|sports?|trading|crypto|payments?)\b/i],
];

/** A run's look, as the product makes one (gateway design/index.ts designVenture): the mood from the brief's words, a
 *  system seeded by the run's id, re-seeded until it sits far enough from every earlier look. Fonts are shown with their
 *  local fallbacks: demo mode loads nothing from outside the browser. */
function lookFor(run: Run, gallery: DesignSystem[]): { look: Look; system: DesignSystem } {
  const mood = MOOD_WORDS.find(([, re]) => re.test(run.brief))?.[0] ?? moodFor(run.id);
  const u = ensureUnique(generateDesignSystem(run.id, mood), [...gallery].reverse()); // newest first, as the product reads it
  const l = u.system.palette.light;
  const palette: Palette = { ink: l.text, paper: l.bg, accent: l.primary, soft: l.surface2, onAccent: l.primaryText, font: u.system.fonts.body.fallback, head: u.system.fonts.display.fallback, radius: { button: u.system.radii.button, card: u.system.radii.lg } };
  return { look: { palette, mood, attempts: u.attempts, distance: u.distance, hueGap: u.hueGap, unique: u.unique }, system: u.system };
}

/** The run's scenario, in the run's own look when it has one. */
function scenarioOf(run: Run): Scenario {
  const s = scenario(run.mode, run.brand, run.rival);
  return run.look ? { ...s, palette: run.look.palette, look: run.look } : s;
}

/** The Monday brief, from only what this run's own tasks produced: the rival only when the run watches one, ads only when
 *  it writes them, and this run's own spend against its own cap. No brief task, no brief. */
function mondayBrief(tasks: readonly RunTask[], hasRival: boolean, spentUsd: number, capUsd: number): string | null {
  if (!tasks.includes('brief')) return null;
  const parts = ['Monday brief:'];
  if (tasks.includes('watch') && hasRival) parts.push('the rival changed one public page this week; the diff is in the watch log.');
  if (tasks.includes('ads')) parts.push('Five fresh ads are ready to rotate in this week.');
  if (tasks.includes('improve')) parts.push('Next: one improvement drafted from the plan, waiting for your review.');
  parts.push(`Spend today: $${spentUsd.toFixed(2)} of a $${capUsd} daily cap.`);
  return parts.join(' ');
}

const RUN_MODE_DAILY_FEE = 5;
/** What a run's steps are costed against: its price, or for a Run Mode tick the day's work budget (the cap less the fee). */
const budgetOf = (run: Run) => (run.runMode ? Math.max(0, run.runMode.cap - RUN_MODE_DAILY_FEE) : run.price);

/** Builds a run's whole timeline once: when each step starts and ends, and every event in between. */
function buildScript(run: Run, totalMs: number) {
  const s = scenarioOf(run);
  const by = new Map(run.steps.map((st) => [st.key, st]));
  const raw = new Map<string, { start: number; end: number }>();
  const timeOf = (key: string): { start: number; end: number } => {
    const known = raw.get(key);
    if (known) return known;
    const st = by.get(key)!;
    const start = st.needs.filter((n) => by.has(n)).reduce((m, n) => Math.max(m, timeOf(n).end + 0.35), 0.5);
    const out = { start, end: start + (DURATIONS[st.key.replace(/^t\d+-/, '')] ?? 1.5) };
    raw.set(key, out);
    return out;
  };
  const last = Math.max(...run.steps.map((st) => timeOf(st.key).end), 1);
  const scale = (totalMs - 900) / last;
  const ms = (sec: number) => Math.round(sec * scale);
  const events: Scheduled[] = [];
  const at = (when: number) => new Date(run.createdAt + when).toISOString();
  // The event minus its run id and timestamp, which every event gets here.
  const push = (when: number, e: { type: VentureEvent['type'] } & Record<string, unknown>) => events.push({ at: when, event: { ...e, ventureId: run.id, at: at(when) } as VentureEvent });
  push(150, { type: 'venture', status: 'RUNNING', costUsd: 0 });

  let total = 0;
  const pending: Omit<Artifact, 'sha'>[] = [];
  run.steps.forEach((st, index) => {
    const { start, end } = timeOf(st.key);
    const a = ms(start);
    const b = ms(end);
    const basis = budgetOf(run);
    const cap = Math.min(basis * 0.35, basis * st.share * 2.5);
    const cost = Math.round(cap * (0.12 + ((index * 37) % 17) / 100) * 1e4) / 1e4;
    push(a, { type: 'step', step: st.key, role: st.role, state: 'RUNNING', costUsd: 0 });
    const lines = (LOGS[st.key.replace(/^t\d+-/, '')] ?? (() => []))(s, run.mode);
    lines.forEach((message, i) => push(a + Math.round(((b - a) * (i + 1)) / (lines.length + 1)), { type: 'log', step: st.key, role: st.role, message } as never));
    if (b - a > 2500) push(Math.round((a + b) / 2), { type: 'step', step: st.key, role: st.role, state: 'RUNNING', costUsd: Math.round(cost * 0.45 * 1e4) / 1e4 });
    if (st.key === 'build') {
      const lanes = [...RACE.slice(0, TIER_RULES[run.tier].builders - 1), RACE[4]];
      const span = b - a;
      const refuseAt = a + Math.round(span * 0.12);
      for (const lane of lanes) {
        if ('refuses' in lane) {
          push(refuseAt, { type: 'candidate', step: st.key, family: lane.family, model: lane.model, passRate: null, chosen: false, refused: true });
          push(refuseAt + 40, { type: 'log', step: st.key, role: 'builder', message: `${lane.family} refused: rerouted to ${REROUTE.family}, billed $0` });
          continue;
        }
        for (const f of [0.18, 0.34, 0.5, 0.66, 0.8]) push(a + Math.round(span * (f + lanes.indexOf(lane) * 0.012)), { type: 'candidate', step: st.key, family: lane.family, model: lane.model, passRate: Math.round(((lane.passed * f * 1.18 + (lanes.indexOf(lane) % 2)) / RACE_TOTAL) * 100) / 100, chosen: false, refused: false });
        push(a + Math.round(span * 0.9), { type: 'candidate', step: st.key, family: lane.family, model: lane.model, passRate: lane.passed / RACE_TOTAL, chosen: false, refused: false });
      }
      for (const f of [0.26, 0.42, 0.58, 0.74]) push(a + Math.round(span * f), { type: 'candidate', step: st.key, family: REROUTE.family, model: REROUTE.model, passRate: Math.round(((REROUTE.passed * (f - 0.08) * 1.15) / RACE_TOTAL) * 100) / 100, chosen: false, refused: false });
      push(a + Math.round(span * 0.92), { type: 'candidate', step: st.key, family: REROUTE.family, model: REROUTE.model, passRate: REROUTE.passed / RACE_TOTAL, chosen: false, refused: false });
      const winner = [...lanes.filter((l) => !('refuses' in l)), REROUTE].reduce((x, y) => (y.passed > x.passed ? y : x));
      push(b - 120, { type: 'candidate', step: st.key, family: winner.family, model: winner.model, passRate: winner.passed / RACE_TOTAL, chosen: true, refused: false });
      run.candidates[st.key] = [...lanes.map((l) => ({ family: l.family, model: l.model, passRate: 'refuses' in l ? null : l.passed / RACE_TOTAL, refused: 'refuses' in l })), { family: REROUTE.family, model: REROUTE.model, passRate: REROUTE.passed / RACE_TOTAL, refused: false }].map((c, i) => ({
        family: c.family,
        model: c.model,
        pass_rate: c.passRate,
        lint_errors: c.refused ? null : i % 3,
        type_errors: c.refused ? null : 0,
        bundle_bytes: c.refused ? null : 41_000 + i * 1733,
        refused: c.refused,
        chosen: c.family === winner.family,
        receipt_id: `req_${id8(`${run.id}:${c.family}`)}`,
        cost_usd: c.refused ? 0 : Math.round((cost / lanes.length) * 1e4) / 1e4,
        error: null,
      }));
    }
    for (const art of artifactsFor(run, st, s)) {
      pending.push({ ...art, step: st.key, at: b - 60 });
    }
    total += cost;
    push(b, { type: 'step', step: st.key, role: st.role, state: 'DONE', costUsd: cost });
    push(b + 5, { type: 'venture', status: 'RUNNING', costUsd: Math.round(total * 1e4) / 1e4 });
  });
  run.artifacts = pending.map((p) => ({ ...p, sha: hex(`${run.id}:${p.step}:${p.name}:${p.body.length}`) }));
  for (const art of run.artifacts) push(art.at, { type: 'artifact', step: art.step, artifact: { sha256: art.sha, kind: art.kind, zone: art.zone, name: art.name } });
  const finish = Math.max(...events.map((e) => e.at)) + 400;
  push(finish, { type: 'venture', status: 'DONE', costUsd: Math.round(total * 1e4) / 1e4 });
  run.script = events.sort((x, y) => x.at - y.at);
}

/** The events a run has, cut at a cancel (running steps are skipped, then the run says CANCELLED). */
function visible(run: Run): Scheduled[] {
  if (run.cancelledAt === null) return run.script;
  const cut = run.cancelledAt;
  const kept = run.script.filter((e) => e.at <= cut);
  const states = new Map<string, string>();
  for (const e of kept) if (e.event.type === 'step') states.set(e.event.step, e.event.state);
  const ts = (when: number) => new Date(run.createdAt + when).toISOString();
  const tail: Scheduled[] = run.steps
    .filter((s) => states.get(s.key) !== 'DONE')
    .map((s, i) => ({ at: cut + 200 + i * 30, event: { type: 'step', ventureId: run.id, step: s.key, role: s.role, state: 'SKIPPED', at: ts(cut + 200 + i * 30), costUsd: 0 } as VentureEvent }));
  const cost = kept.reduce((m, e) => (e.event.type === 'venture' ? Math.max(m, e.event.costUsd) : m), 0);
  const end = cut + 260 + tail.length * 30;
  return [...kept, ...tail, { at: end, event: { type: 'venture', ventureId: run.id, status: 'CANCELLED', at: ts(end), costUsd: cost } }];
}

function initial(run: Run): VentureSnapshot {
  return {
    id: run.id,
    mode: run.mode,
    status: 'QUEUED',
    tier: run.tier,
    caps: { total: run.price, perStep: run.price * 0.35 },
    price_usd: run.price,
    cost_usd: 0,
    target_commit: run.targetCommit,
    recipe_id: run.recipeId,
    error: null,
    created_at: new Date(run.createdAt).toISOString(),
    input: { mode: run.mode, brief: run.brief, brand: run.brand },
    steps: run.steps.map((s) => ({
      key: s.key,
      task: s.task,
      role: s.role,
      kind: s.kind,
      zone: s.zone,
      fanout: s.fanout,
      select: s.select,
      needs: s.needs,
      state: 'QUEUED',
      cost_usd: 0,
      cap_usd: Math.round(Math.min(budgetOf(run) * 0.35, budgetOf(run) * s.share * 2.5) * 100) / 100,
      receipts: [],
      outputs: [],
      error: null,
      candidates: [],
    })),
    run_mode: null,
  };
}

export type DemoVenturesOptions<Key extends object> = {
  now: () => number;
  json: (body: unknown, status?: number) => Response;
  fail: (status: number, type: string, message: string) => Response;
  /** A refusal when the key can't pay `usd`, else null. */
  check: (key: Key, usd: number) => Response | null;
  charge: (key: Key, usd: number, ref: string) => void;
  /** How long a run takes, start to finish (ms). */
  runMs?: number;
  /** The key's tier (the gateway reads it from the CrewTiers contract). */
  tier?: Tier;
  /** Where runs survive a reload (only what rebuilds them: mode, names, times; the rival's url only as its hash). */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** A stable id for a key, to file its runs under. */
  keyId?: (key: Key) => string;
};

const SAMPLE_WALLET = '0xabababababababababababababababababababab';
const STORE = 'anonymo.demo.ventures.v1';

type RunInput = { brief: string; brand?: string | null; rival?: string | null; target?: string | null; targetCommit?: string | null; recipeId?: string | null; recipePrice?: number };
type Seed = {
  id: string;
  mode: VentureMode;
  input: Omit<RunInput, 'target'>;
  createdAt: number;
  cancelledAt: number | null;
  runMode?: Run['runMode'];
};

export function createDemoVentures<Key extends object>(o: DemoVenturesOptions<Key>) {
  /** Every look made so far, oldest first: the gallery a new look must differ from. */
  const looks: DesignSystem[] = [];
  const runMs = o.runMs ?? 25_000;
  const tier = o.tier ?? 'gang';
  const runs = new WeakMap<Key, Map<string, Run>>();
  const recipes: (Recipe & { dagHash: string })[] = seedRecipes(o.now());
  let counter = 0;

  function load(): Record<string, Seed[]> {
    try {
      const raw = o.storage?.getItem(STORE);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, Seed[]>) : {};
    } catch {
      return {};
    }
  }
  function save(key: Key) {
    if (!o.storage || !o.keyId) return;
    const all = load();
    all[o.keyId(key)] = [...(runs.get(key)?.values() ?? [])].map(
      (r): Seed => ({ id: r.id, mode: r.mode, input: { brief: r.brief, brand: r.brand, rival: r.rival, targetCommit: r.targetCommit, recipeId: r.recipeId, recipePrice: r.recipePrice }, createdAt: r.createdAt, cancelledAt: r.cancelledAt, ...(r.runMode ? { runMode: r.runMode } : {}) }),
    );
    try {
      o.storage.setItem(STORE, JSON.stringify(all));
    } catch {
      // storage full or blocked: runs stay in memory
    }
  }
  function fromSeed(s: Seed): Run {
    if (s.runMode) {
      const run: Run = { ...newRun('IDEA_TO_LIVE', s.input, s.createdAt, s.id), mode: 'RUN', price: 0, steps: tickSteps(s.runMode.tasks), runMode: s.runMode, cancelledAt: s.cancelledAt };
      buildScript(run, 1_000);
      return run;
    }
    const run = newRun(s.mode, s.input, s.createdAt, s.id);
    run.cancelledAt = s.cancelledAt;
    return run;
  }

  function newRun(mode: VentureMode, input: RunInput, createdAt: number, known?: string): Run {
    counter += 1;
    const id = known ?? `v_demo${id8(`${createdAt}:${counter}:${mode}:${Math.random()}`)}`;
    const run: Run = {
      id,
      mode,
      tier,
      price: priceOf(mode),
      recipePrice: input.recipePrice ?? 0,
      recipeId: input.recipeId ?? null,
      brief: input.brief,
      brand: input.brand ?? null,
      rival: input.rival ?? null,
      createdAt,
      steps: planSteps(mode, tier),
      script: [],
      artifacts: [],
      cancelledAt: null,
      targetCommit: input.targetCommit ?? (input.target ? keccakHex(enc.encode(`demo-salt:${input.target}`)) : null),
      candidates: {},
    };
    if (!run.brand) run.brand = scenario(mode).brand;
    // Its own look, checked against every earlier run's look in this demo (in the order the runs were made).
    const made = lookFor(run, looks);
    run.look = made.look;
    looks.push(made.system);
    if ((mode === 'TAKEOVER' || mode === 'BUILD_BETTER') && !run.rival && input.target) {
      const host = new URL(input.target).hostname.replace(/^www\./, '').split('.')[0];
      run.rival = host.charAt(0).toUpperCase() + host.slice(1);
    }
    buildScript(run, runMs);
    return run;
  }

  function runsOf(key: Key): Map<string, Run> {
    let mine = runs.get(key);
    if (!mine && o.keyId) {
      const kept = load()[o.keyId(key)];
      if (Array.isArray(kept) && kept.length) {
        mine = new Map();
        for (const s of kept) {
          try {
            const r = fromSeed(s);
            mine.set(r.id, r);
          } catch {
            // a seed from an older demo: skip it
          }
        }
        runs.set(key, mine);
      }
    }
    if (!mine) {
      mine = new Map();
      const now = o.now();
      const day = 86_400_000;
      // Three earlier runs, so the list and the results tabs have something on first visit.
      const seeds: Run[] = [
        newRun('BUILD_BETTER', { brief: 'A calmer booking tool for small studios.', brand: 'Quayside', rival: 'SlotHarbor', target: 'https://slotharbor.example' }, now - 2 * day),
        newRun('IDEA_TO_LIVE', { brief: 'Plant-care reminders for renters with too many houseplants.', brand: 'Leaflog' }, now - 5 * day),
        newRun('TAKEOVER', { brief: '', brand: 'Ledgerlark', rival: 'InvoiceMule', target: 'https://invoicemule.example' }, now - 6 * day),
      ];
      seeds[2].cancelledAt = 9_000;
      for (const r of seeds) mine.set(r.id, r);
      runs.set(key, mine);
      save(key);
    }
    return mine;
  }

  function snapshot(run: Run): VentureSnapshot {
    const elapsed = o.now() - run.createdAt;
    let v = initial(run);
    for (const e of visible(run)) if (e.at <= elapsed) v = applyEvent(v, e.event);
    v = {
      ...v,
      steps: v.steps.map((s) =>
        s.state === 'DONE'
          ? {
              ...s,
              receipts: s.fanout > 1 ? Array.from({ length: s.fanout }, (_, i) => `req_${id8(`${run.id}:${s.key}:${i}`)}`) : [`req_${id8(`${run.id}:${s.key}`)}`],
              candidates: run.candidates[s.key] ?? s.candidates,
            }
          : s,
      ),
    };
    if (run.runMode) {
      const spent = Math.round(Math.min(run.runMode.cap, RUN_MODE_DAILY_FEE + v.cost_usd) * 100) / 100; // the day's fee plus what the tick's steps cost
      v.run_mode = {
        enabled: run.runMode.enabled,
        daily_cap_usd: run.runMode.cap,
        hours_per_day: run.runMode.hours,
        tasks: run.runMode.tasks,
        spent_today_usd: spent,
        ticks_today: 1,
        next_tick_at: run.runMode.enabled ? new Date(o.now() + 2 * 3_600_000 + 14 * 60_000).toISOString() : null,
        last_brief: mondayBrief(run.runMode.tasks, !!run.rival, spent, run.runMode.cap),
      };
    }
    return v;
  }

  const summary = (run: Run): VentureSummary => {
    const v = snapshot(run);
    return { id: run.id, mode: run.mode, status: v.status, tier: run.tier, price_usd: run.price, cost_usd: v.cost_usd, brand: run.brand, brief: run.brief.slice(0, 140) || null, created_at: v.created_at, repo: null };
  };

  const dueArtifacts = (run: Run) => {
    const v = snapshot(run);
    const done = new Set(v.steps.filter((s) => s.state === 'DONE').map((s) => s.key));
    return run.artifacts.filter((a) => done.has(a.step));
  };

  function events(run: Run, after: number, signal: AbortSignal | null): Response {
    let stopped = false;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let i = Math.max(0, after);
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        try {
          while (!stopped && !signal?.aborted) {
            const list = visible(run);
            const next = list[i];
            if (!next) {
              if (isTerminal(snapshot(run).status) || run.runMode) break;
              await sleep(200);
              continue;
            }
            const wait = run.createdAt + next.at - o.now();
            if (wait > 0) {
              await sleep(Math.min(wait, 200));
              continue;
            }
            i += 1;
            controller.enqueue(enc.encode(`id: ${i}\nevent: ${next.event.type}\ndata: ${JSON.stringify(next.event)}\n\n`));
          }
          if (!stopped && !signal?.aborted) controller.enqueue(enc.encode('event: end\ndata: {}\n\n'));
          controller.close();
        } catch {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        stopped = true;
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } });
  }

  async function exportTar(run: Run): Promise<Response> {
    const s = scenarioOf(run);
    const files: Record<string, string> = {
      'README.md': `# ${s.brand}\n\n${s.tagline}\n\nBuilt by the Anonymo Ventures crew (run ${run.id}). Every step is on the run's receipt.\n`,
      'package.json': JSON.stringify({ name: s.brand.toLowerCase(), private: true, type: 'module', license: 'MIT' }, null, 2) + '\n',
      LICENSE: 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n',
      'src/app.ts': `// ${s.brand}: the app the crew built.\nexport const name = ${JSON.stringify(s.brand)};\n`,
    };
    const tar = tarOf(files, Math.floor(run.createdAt / 1000));
    const gz = await new Response(new Blob([tar]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    return new Response(gz, { headers: { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${run.id}.tar.gz"` } });
  }

  async function handle(request: Request, path: string, key: Key | null): Promise<Response | null> {
    const method = request.method.toUpperCase();
    if (method === 'GET' && path === '/v1/recipes') return o.json({ data: recipes.map(({ dagHash: _d, ...r }) => r) });
    if (!path.startsWith('/v1/ventures')) return null;
    if (!key) return o.fail(401, 'unauthorized', 'Missing or malformed API key.');
    const mine = runsOf(key);

    if (method === 'GET' && path === '/v1/ventures/tier') {
      return o.json({ data: { tier, source: 'chain', wallet: SAMPLE_WALLET, twabNymo: 312_400, rules: TIER_RULES[tier] } });
    }
    if (method === 'GET' && path === '/v1/ventures') {
      return o.json({ data: [...mine.values()].sort((a, b) => b.createdAt - a.createdAt).map(summary) });
    }
    if (method === 'POST' && path === '/v1/ventures') {
      const body = (await request.json().catch(() => null)) as CreateVentureBody | null;
      if (!body || typeof body.mode !== 'string') return o.fail(400, 'invalid_request', 'mode: Required');
      if (body.mode === 'DUPE_DROP') return o.fail(501, 'not_built', 'Dupe Drop is not built yet.');
      if (body.mode === 'RUN') return o.fail(400, 'invalid_request', 'Run Mode attaches to a finished run: POST /v1/ventures/{id}/run-mode.');
      const recipe = body.recipe_id ? recipes.find((r) => r.id === body.recipe_id) : null;
      if (body.recipe_id && !recipe) return o.fail(404, 'not_found', 'Recipe not found.');
      const mode = recipe?.mode ?? body.mode;
      if (!modeInfo(mode)) return o.fail(400, 'invalid_request', 'Unknown mode.');
      if (!TIER_RULES[tier].modes.includes(mode)) return o.fail(403, 'tier_required', `${mode} needs a higher tier than ${tier}.`);
      const brief = String(body.brief ?? '').trim();
      if (mode === 'BUILD_BETTER' || mode === 'TAKEOVER') {
        if (!body.target_url) return o.fail(400, 'invalid_request', 'This mode needs target_url.');
        const p = urlProblem(body.target_url, 'target_url');
        if (p) return o.fail(400, 'invalid_request', p);
      }
      if (mode === 'FORK_FLIP' && !body.repo_url) return o.fail(400, 'invalid_request', 'Fork & Flip needs repo_url.');
      if (mode === 'IDEA_TO_LIVE' && brief.length < 10) return o.fail(400, 'invalid_request', 'Describe the idea in brief (at least a sentence).');
      const total = priceOf(mode) + (recipe?.price_usd ?? 0);
      const refusal = o.check(key, total);
      if (refusal) return refusal;
      const run = newRun(mode, { brief, brand: body.brand, rival: body.rival, target: body.target_url, recipeId: recipe?.id ?? null, recipePrice: recipe?.price_usd ?? 0 }, o.now());
      mine.set(run.id, run);
      save(key);
      if (recipe) recipe.runs += 1;
      o.charge(key, total, run.id);
      return o.json(
        {
          data: {
            id: run.id,
            mode,
            tier,
            price_usd: run.price,
            recipe_price_usd: run.recipePrice,
            steps: run.steps.map((s) => ({ key: s.key, role: s.role, fanout: s.fanout })),
            ...(run.targetCommit ? { target_commit: run.targetCommit, target_salt: `0x${hex(run.id)}` } : {}),
            events: `/v1/ventures/${run.id}/events`,
          },
        },
        201,
      );
    }

    const m = /^\/v1\/ventures\/([^/]+)(?:\/([a-z-]+)(?:\/([^/]+))?)?$/.exec(path);
    if (!m) return o.fail(404, 'not_found', `No route for ${method} ${path}.`);
    const run = mine.get(decodeURIComponent(m[1]));
    if (!run) return o.fail(404, 'not_found', 'Venture not found.');
    const sub = m[2] ?? '';
    const status = (): VentureStatus => snapshot(run).status;

    if (method === 'GET' && !sub) return o.json({ data: snapshot(run) });
    if (method === 'GET' && sub === 'events') {
      const after = Number(request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? 0) || 0;
      return events(run, after, request.signal ?? null);
    }
    if (method === 'GET' && sub === 'artifacts' && !m[3]) {
      return o.json({ data: dueArtifacts(run).map((a) => ({ sha256: a.sha, kind: a.kind, zone: a.zone, name: a.name, mime: a.mime, size: a.body.length, purged: false, created_at: new Date(run.createdAt + a.at).toISOString() }) satisfies ArtifactInfo) });
    }
    if (method === 'GET' && sub === 'artifacts' && m[3]) {
      const a = dueArtifacts(run).find((x) => x.sha === m[3]);
      if (!a) return o.fail(404, 'not_found', 'Artifact not found.');
      if (a.zone === 'SCOUT') return o.fail(403, 'scout_zone', 'Scout artifacts are listed by hash only.');
      return new Response(a.body, { headers: { 'content-type': `${a.mime}; charset=utf-8`, 'x-content-type-options': 'nosniff' } });
    }
    if (method === 'GET' && sub === 'receipt') return o.json({ data: receiptOf(run) });
    if (method === 'GET' && sub === 'export') {
      if (!snapshot(run).steps.some((s) => s.key === 'repo' && s.state === 'DONE')) return o.fail(404, 'no_repo', 'This run has no repo yet.');
      return exportTar(run);
    }
    if (method === 'POST' && sub === 'cancel') {
      if (!isTerminal(status()) && run.cancelledAt === null) run.cancelledAt = Math.max(0, o.now() - run.createdAt);
      save(key);
      return o.json({ data: { id: run.id, cancelling: true } });
    }
    if (method === 'POST' && sub === 'run-mode') {
      if (run.mode === 'RUN') return o.fail(400, 'invalid_request', 'This is already a Run Mode venture.');
      if (!TIER_RULES[tier].runModeHoursPerDay) return o.fail(403, 'tier_required', 'Run Mode needs the Crew tier or above.');
      const b = (await request.json().catch(() => ({}))) as { daily_cap_usd?: number; tasks?: RunTask[]; target_url?: string };
      const tasks = [...new Set(b.tasks ?? ['improve', 'ads', 'brief'])] as RunTask[];
      const p = runModeProblem({ daily_cap_usd: Number(b.daily_cap_usd), tasks, target_url: b.target_url });
      if (p) return o.fail(400, 'invalid_request', p);
      const refusal = o.check(key, 5);
      if (refusal) return refusal;
      counter += 1;
      const now = o.now();
      const rm: Run = {
        ...run,
        id: `vr_demo${id8(`${now}:${counter}`)}`,
        mode: 'RUN',
        price: 0,
        recipeId: null,
        recipePrice: 0,
        createdAt: now - 60_000,
        steps: tickSteps(tasks),
        script: [],
        artifacts: [],
        cancelledAt: null,
        candidates: {},
        runMode: { enabled: true, cap: Number(b.daily_cap_usd), tasks, hours: TIER_RULES[tier].runModeHoursPerDay, parent: run.id },
      };
      buildScript(rm, 1_000);
      mine.set(rm.id, rm);
      save(key);
      o.charge(key, 5, rm.id);
      return o.json({ data: { id: rm.id, tasks, available_tasks: ['watch', 'improve', 'ads', 'brief'] } }, 201);
    }
    if (method === 'DELETE' && sub === 'run-mode') {
      if (!run.runMode) return o.fail(404, 'not_found', 'Run Mode venture not found.');
      run.runMode.enabled = false;
      run.cancelledAt = Math.max(0, o.now() - run.createdAt);
      save(key);
      return o.json({ data: { id: run.id, enabled: false } });
    }
    if (method === 'POST' && sub === 'recipe') {
      if (status() !== 'DONE') return o.fail(409, 'venture_not_done', 'Only a finished run can become a Recipe.');
      const b = (await request.json().catch(() => ({}))) as { title?: string; summary?: string; price_usd?: number };
      const body = { title: String(b.title ?? '').trim(), summary: String(b.summary ?? '').slice(0, 400), price_usd: Number(b.price_usd ?? 0) };
      const p = recipeProblem(body, tier);
      if (p) return o.fail(p.includes('Gang') ? 403 : 400, p.includes('Gang') ? 'tier_required' : 'invalid_request', p);
      const dagHash = hex(JSON.stringify(run.steps.map((s) => [s.key, s.task, s.fanout, s.needs])));
      if (recipes.some((r) => r.dagHash === dagHash)) return o.fail(409, 'recipe_exists', 'This pipeline is already a Recipe.');
      const recipe = { id: `rc_${id8(dagHash)}`, title: body.title, summary: body.summary, mode: run.mode, steps: run.steps.map((s) => ({ key: s.key, task: s.task, role: s.role, fanout: s.fanout })), price_usd: body.price_usd, runs: 0, recipe_hash: `0x${dagHash}`, created_at: new Date(o.now()).toISOString(), dagHash };
      recipes.unshift(recipe);
      return o.json({ data: { id: recipe.id, recipeHash: recipe.recipe_hash } }, 201);
    }
    return o.fail(404, 'not_found', `No route for ${method} ${path}.`);
  }

  function receiptOf(run: Run) {
    const v = snapshot(run);
    const done = dueArtifacts(run);
    const scout = done.filter((a) => a.zone === 'SCOUT').map((a) => a.sha);
    const spec = done.find((a) => a.name === 'spec')?.sha ?? null;
    const builder = done.filter((a) => a.step === 'build' || a.step === 'tests' || a.step === 'rebrand').map((a) => a.sha);
    const licence = done.find((a) => a.name === 'licence' || a.name === 'fork')?.sha ?? null;
    const parts = { scoutArtifactHashes: scout, specHash: spec, sandboxPolicyHash: `0x${hex('builder-policy:v1')}`, builderArtifactHashes: builder, gateReportHash: null, licenceReportHash: licence };
    const leaf = (label: string, value: string) => keccakHex(enc.encode(`${label}:${value}`));
    let level = [leaf('scout', [...scout].sort().join(',')), leaf('spec', spec ?? ''), leaf('sandbox', parts.sandboxPolicyHash), leaf('builder', [...builder].sort().join(',')), leaf('gate', ''), leaf('licence', licence ?? '')];
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
      level = next;
    }
    return {
      venture: { id: run.id, mode: run.mode, status: v.status, target_commit: run.targetCommit, price_usd: run.price, cost_usd: v.cost_usd },
      steps: v.steps.map((s) => ({ key: s.key, role: s.role, zone: s.zone, state: s.state, cost_usd: s.cost_usd, receipts: s.receipts, outputs: done.filter((a) => a.step === s.key).map((a): ArtifactRef => ({ sha256: a.sha, kind: a.kind, zone: a.zone, name: a.name })) })),
      candidates: Object.entries(run.candidates).flatMap(([step, list]) =>
        v.steps.find((s) => s.key === step)?.state === 'DONE' ? list.map((c) => ({ step, family: c.family, model: c.model, pass_rate: c.pass_rate, chosen: c.chosen, refused: c.refused, receipt_id: c.receipt_id ?? null, cost_usd: c.cost_usd ?? 0 })) : [],
      ),
      clean_room: { ...parts, root: level[0], anchored: false, note: 'Anchoring on CleanRoomRegistry is a later milestone; recompute the root from these parts with cleanRoomRoot().' },
      receipts_api: '/v1/receipts/{id}',
    };
  }

  return { handle };
}

function seedRecipes(now: number): (Recipe & { dagHash: string })[] {
  const day = 86_400_000;
  const r = (id: string, title: string, summary: string, mode: VentureMode, price: number, runs: number, age: number) => {
    const steps = planSteps(mode, 'gang').map((s) => ({ key: s.key, task: s.task, role: s.role, fanout: s.fanout }));
    const dagHash = hex(`seed:${id}`);
    return { id, title, summary, mode, steps, price_usd: price, runs, recipe_hash: `0x${dagHash}`, created_at: new Date(now - age * day).toISOString(), dagHash };
  };
  return [
    r('rc_studio-booking', 'Studio booking, with waitlists', 'Build Better for booking tools: parity on the booking flow, then waitlists and deposits first.', 'BUILD_BETTER', 9, 214, 12),
    r('rc_invoice-switch', 'Win invoicing switchers', 'Takeover Kit tuned for invoicing apps: CSV import tests first, ads on fees and seat limits.', 'TAKEOVER', 0, 158, 20),
    r('rc_weekend-mvp', 'Weekend MVP, three features', 'Idea to Live with a tight scope: three features, one landing page, a 7-day launch.', 'IDEA_TO_LIVE', 4, 391, 31),
    r('rc_notes-fork', 'Fork a notes app, add sync', 'Fork & Flip for MIT notes apps: licence check, rebrand, then self-hosted sync.', 'FORK_FLIP', 0, 77, 9),
  ];
}

/** A plain ustar archive of small text files. */
function tarOf(files: Record<string, string>, mtime: number): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  const field = (buf: Uint8Array, off: number, len: number, value: string) => buf.set(enc.encode(value).slice(0, len), off);
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const h = new Uint8Array(512);
    field(h, 0, 100, `venture/${name}`);
    field(h, 100, 8, octal(0o644, 8));
    field(h, 108, 8, octal(0, 8));
    field(h, 116, 8, octal(0, 8));
    field(h, 124, 12, octal(data.length, 12));
    field(h, 136, 12, octal(mtime, 12));
    field(h, 148, 8, '        ');
    field(h, 156, 1, '0');
    field(h, 257, 6, 'ustar\0');
    field(h, 263, 2, '00');
    const sum = h.reduce((a, b) => a + b, 0);
    field(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
