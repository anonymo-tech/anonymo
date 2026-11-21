// Update "ventures": the switch, the prices and what each tier allows, the brief checks, the DAG laid out in waves and
// the firewall, events folded into a run, the SSE reader, the artifact readers, the copy rules, and the demo crew
// playing a whole run through the same client the pages use.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { createMockGateway } from '../lib/anonymo/mock/gateway.ts';
import { planSteps } from '../lib/anonymo/mock/ventures.ts';
import { RELEASED, parseUpdates, updateOn } from '../lib/anonymo/updates.ts';
import {
  CREW, EMPTY_BRIEF, LINEUP, MODES, TIER_RULES, applyEvent, briefProblem, copyProblems, createBody, eventOf, familyDye, feedLine,
  findArtifact, firewallAfter, isTerminal, lanes, meter, moodFor, nymoPrice, priceLine, priceOf, readAds, readLicence, readPlan, readSse,
  readTestReport, recipeProblem, relTime, resultTabs, runModeProblem, tierAllows, tierFor, tierPerks, urlProblem, waves,
} from '../lib/anonymo/ventures.ts';

const BASE = 'https://demo.anonymo.invalid';

async function funded(usd = 500, o = {}) {
  let now = Date.parse('2026-11-21T12:00:00Z');
  const mock = createMockGateway({ venturesEnabled: true, delayMs: 0, venturesNow: () => now, ventureRunMs: 25_000, ...o });
  const { key } = await createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key });
  if (usd) await mock.simulateDeposit(key, 'rhc', 'USDG', usd * 1_000_000);
  return { mock, client, key, tick: (ms) => (now += ms) };
}

test('ventures has its own switch, requires explicit opt-in even in demo mode', () => {
  assert.equal(parseUpdates().has('ventures'), false);
  assert.equal(parseUpdates('sidebyside,tickets').has('ventures'), false);
  assert.equal(parseUpdates('ventures').has('ventures'), true);
  assert.equal(parseUpdates('all').has('ventures'), false);
  assert.equal(RELEASED.has('ventures'), false);
  assert.equal(updateOn('ventures', true), false);
});

test('prices match the gateway, $NYMO is 25% less, and the line says all-in', () => {
  assert.deepEqual(Object.fromEntries(MODES.map((m) => [m.mode, m.usd])), { IDEA_TO_LIVE: 79, BUILD_BETTER: 149, TAKEOVER: 49, FORK_FLIP: 79, DUPE_DROP: 99 });
  assert.equal(nymoPrice(149), 111.75);
  assert.equal(nymoPrice(49), 36.75);
  assert.equal(priceLine('BUILD_BETTER'), '$149 all-in, refused attempts free');
  assert.equal(priceLine('IDEA_TO_LIVE', 4), '$83 all-in ($79 run + $4 recipe), refused attempts free');
  assert.equal(priceOf('RUN'), 5);
  assert.equal(MODES.find((m) => m.mode === 'DUPE_DROP').soon, true);
});

test('tiers: what each unlocks, and which modes need Crew', () => {
  assert.equal(tierFor('BUILD_BETTER'), 'crew');
  assert.equal(tierFor('TAKEOVER'), 'crew');
  assert.equal(tierFor('IDEA_TO_LIVE'), 'solo');
  assert.equal(tierAllows('solo', 'BUILD_BETTER'), false);
  assert.deepEqual([TIER_RULES.solo, TIER_RULES.crew, TIER_RULES.gang, TIER_RULES.syndicate].map((r) => r.builders), [1, 3, 5, 8]);
  assert.match(tierPerks(TIER_RULES.gang).join(' | '), /5 Builder Mos.*Run Mode up to 12 h.*Sell your Recipes/);
  assert.match(tierPerks(TIER_RULES.solo).join(' | '), /1 Builder Mo racing.*No Run Mode/);
});

test('the brief: each mode asks for what the gateway needs', () => {
  const f = (o) => ({ ...EMPTY_BRIEF, ...o });
  assert.match(briefProblem('IDEA_TO_LIVE', f({ brief: 'short' })), /at least 10/);
  assert.equal(briefProblem('IDEA_TO_LIVE', f({ brief: 'Plant-care reminders for renters.' })), null);
  assert.match(briefProblem('BUILD_BETTER', f({})), /competitor/);
  assert.match(briefProblem('BUILD_BETTER', f({ target_url: 'http://localhost:3000' })), /public site/);
  assert.match(briefProblem('BUILD_BETTER', f({ target_url: 'https://user:pw@rival.example' })), /username or password/);
  assert.match(briefProblem('BUILD_BETTER', f({ target_url: 'ftp://rival.example' })), /https/);
  assert.equal(briefProblem('BUILD_BETTER', f({ target_url: 'https://rival.example' })), null);
  assert.match(briefProblem('TAKEOVER', f({ target_url: 'https://rival.example' })), /Name the rival/);
  assert.equal(briefProblem('TAKEOVER', f({ target_url: 'https://rival.example', rival: 'Rival' })), null);
  assert.match(briefProblem('FORK_FLIP', f({})), /repo/);
  assert.match(briefProblem('DUPE_DROP', f({ brief: 'anything at all here' })), /coming soon/);
  // The body carries only the fields the mode reads.
  assert.deepEqual(createBody('IDEA_TO_LIVE', f({ brief: ' An idea ', target_url: 'https://x.example', brand: ' Leaflog ' })), { mode: 'IDEA_TO_LIVE', brief: 'An idea', brand: 'Leaflog' });
  assert.deepEqual(createBody('TAKEOVER', f({ target_url: 'https://x.example', rival: 'X', repo_url: 'https://git.example/a' }), 'rc_1'), { mode: 'TAKEOVER', brief: '', target_url: 'https://x.example', rival: 'X', recipe_id: 'rc_1' });
  // Private and loopback hosts are refused, whatever the spelling.
  for (const host of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.1.1', 'printer.local', 'db.internal', '[::1]']) assert.ok(urlProblem(`https://${host}/`), host);
});

test('waves: a step sits one wave after the latest step it needs', () => {
  for (const mode of ['BUILD_BETTER', 'TAKEOVER', 'IDEA_TO_LIVE', 'FORK_FLIP']) {
    const steps = planSteps(mode, 'gang');
    const ws = waves(steps);
    assert.equal(ws.flat().length, steps.length, mode);
    const waveOf = new Map(ws.flatMap((w, i) => w.map((s) => [s.key, i])));
    for (const s of steps) for (const n of s.needs) assert.ok(waveOf.get(n) < waveOf.get(s.key), `${mode}: ${n} before ${s.key}`);
    for (const s of steps) assert.ok(s.needs.length === 0 || s.needs.some((n) => waveOf.get(n) === waveOf.get(s.key) - 1), `${mode}: ${s.key} waits no longer than it must`);
  }
  // A cycle (the gateway refuses one) does not hang.
  assert.equal(waves([{ key: 'a', needs: ['b'] }, { key: 'b', needs: ['a'] }]).flat().length, 2);
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 12 }), (parents) => {
      const steps = parents.map((p, i) => ({ key: `s${i}`, needs: i && p < i ? [`s${p}`] : [] }));
      const ws = waves(steps);
      return ws.flat().length === steps.length && ws.every((w) => w.length > 0);
    }),
  );
});

test('the firewall sits after the scout side, and only target modes have one', () => {
  assert.equal(firewallAfter(waves(planSteps('BUILD_BETTER', 'gang'))), 1);
  assert.equal(firewallAfter(waves(planSteps('TAKEOVER', 'crew'))), 1);
  assert.equal(firewallAfter(waves(planSteps('IDEA_TO_LIVE', 'gang'))), -1);
  assert.equal(firewallAfter(waves(planSteps('FORK_FLIP', 'gang'))), -1);
  // A CLEAN step beside a SCOUT one gets no line: the board never claims a firewall it can't draw.
  assert.equal(firewallAfter([[{ zone: 'SCOUT' }, { zone: 'CLEAN' }], [{ zone: 'CLEAN' }]]), -1);
  // Every step after the line is CLEAN.
  const ws = waves(planSteps('BUILD_BETTER', 'gang'));
  assert.ok(ws.slice(2).flat().every((s) => s.zone === 'CLEAN'));
});

test('meters, moods, lanes and the crew', () => {
  assert.deepEqual(meter(0, 10), { fraction: 0, tone: 'ok' });
  assert.deepEqual(meter(8, 10), { fraction: 0.8, tone: 'warn' });
  assert.deepEqual(meter(20, 10), { fraction: 1, tone: 'bad' });
  assert.deepEqual(meter(1, 0), { fraction: 0, tone: 'none' });
  assert.deepEqual(['QUEUED', 'RUNNING', 'DONE', 'FAILED'].map((s) => moodFor(s)), [0, 3, 1, 2]);
  assert.equal(moodFor('DONE', true), 5);
  const ls = lanes({
    state: 'RUNNING',
    candidates: [
      { family: 'a', model: 'a1', pass_rate: 0.5, refused: false, chosen: false },
      { family: 'b', model: 'b1', pass_rate: null, refused: true, chosen: false },
      { family: 'c', model: 'c1', pass_rate: 0.9, refused: false, chosen: false },
    ],
  });
  assert.deepEqual(ls.map((l) => [l.family, l.state]), [['c', 'racing'], ['a', 'racing'], ['b', 'refused']]);
  assert.match(ls[2].note, /rerouted.*\$0/);
  // Every role has a plush Mo (or the headphones photo), and the line-up names each once.
  for (const mo of Object.values(CREW)) assert.ok(mo.name.endsWith('Mo') && mo.look && mo.job, mo.role);
  assert.equal(new Set(LINEUP).size, LINEUP.length);
  assert.equal(familyDye('deepseek'), familyDye('deepseek'));
});

test('events fold into a run; candidates upsert by family and one winner is kept', () => {
  const step = (key, extra = {}) => ({ key, task: 't', role: 'builder', kind: 'code', zone: 'CLEAN', fanout: 3, select: 'tests', needs: [], state: 'QUEUED', cost_usd: 0, cap_usd: 10, receipts: [], outputs: [], error: null, candidates: [], ...extra });
  let v = { id: 'v1', mode: 'BUILD_BETTER', status: 'QUEUED', tier: 'gang', caps: null, price_usd: 149, cost_usd: 0, target_commit: null, recipe_id: null, error: null, created_at: '', input: null, steps: [step('build')], run_mode: null };
  const e = (o) => ({ ventureId: 'v1', at: '2026-11-21T12:00:00Z', ...o });
  v = applyEvent(v, e({ type: 'venture', status: 'RUNNING', costUsd: 0 }));
  v = applyEvent(v, e({ type: 'step', step: 'build', role: 'builder', state: 'RUNNING', costUsd: 0 }));
  v = applyEvent(v, e({ type: 'candidate', step: 'build', family: 'a', model: 'a1', passRate: 0.3, chosen: false, refused: false }));
  v = applyEvent(v, e({ type: 'candidate', step: 'build', family: 'b', model: 'b1', passRate: 0.4, chosen: false, refused: false }));
  v = applyEvent(v, e({ type: 'candidate', step: 'build', family: 'a', model: 'a1', passRate: 0.9, chosen: true, refused: false }));
  v = applyEvent(v, e({ type: 'artifact', step: 'build', artifact: { sha256: 'ab', kind: 'code', zone: 'CLEAN', name: 'code' } }));
  v = applyEvent(v, e({ type: 'artifact', step: 'build', artifact: { sha256: 'ab', kind: 'code', zone: 'CLEAN', name: 'code' } }));
  v = applyEvent(v, e({ type: 'step', step: 'build', role: 'builder', state: 'DONE', costUsd: 4.5 }));
  v = applyEvent(v, e({ type: 'step', step: 'nope', role: 'builder', state: 'DONE', costUsd: 99 }));
  assert.equal(v.status, 'RUNNING');
  assert.equal(v.steps[0].state, 'DONE');
  assert.deepEqual(v.steps[0].candidates.map((c) => [c.family, c.pass_rate, c.chosen]), [['a', 0.9, true], ['b', 0.4, false]]);
  assert.equal(v.steps[0].outputs.length, 1);
  assert.equal(v.cost_usd, 4.5);
  // Cost never goes backwards, whatever order the events arrive in.
  fc.assert(
    fc.property(fc.array(fc.float({ min: 0, max: 100, noNaN: true }), { maxLength: 20 }), (costs) => {
      let w = v;
      let last = w.cost_usd;
      for (const c of costs) {
        w = applyEvent(w, e({ type: 'venture', status: 'RUNNING', costUsd: c }));
        if (w.cost_usd < last) return false;
        last = w.cost_usd;
      }
      return true;
    }),
  );
  assert.ok(isTerminal('CANCELLED') && isTerminal('CAPPED') && !isTerminal('RUNNING'));
  assert.match(feedLine(1, e({ type: 'candidate', step: 'build', family: 'x', model: 'x', passRate: null, chosen: false, refused: true })).text, /billed \$0/);
  assert.equal(feedLine(2, e({ type: 'log', step: 'x', role: 'boss', message: '__end__' })), null);
});

test('the SSE reader splits whole frames, keeps the rest, and drops pings', () => {
  const { frames, rest } = readSse(': ping\n\nid: 3\nevent: step\ndata: {"type":"step"}\n\nid: 4\r\nevent: log\r\ndata: {"a":\r\n\r\nid: 5\nda');
  assert.deepEqual(frames, [{ id: 3, event: 'step', data: '{"type":"step"}' }, { id: 4, event: 'log', data: '{"a":' }]);
  assert.equal(rest, 'id: 5\nda');
  assert.equal(eventOf(frames[1]), null);
  assert.equal(eventOf({ id: null, event: 'end', data: '{}' }), null);
  assert.equal(eventOf({ id: 1, event: 'x', data: '{"type":"nope"}' }), null);
  // Any split of a stream gives the same frames.
  const whole = 'id: 1\nevent: venture\ndata: {"type":"venture"}\n\nid: 2\nevent: step\ndata: {"type":"step"}\n\nevent: end\ndata: {}\n\n';
  fc.assert(
    fc.property(fc.integer({ min: 0, max: whole.length }), (cut) => {
      const a = readSse(whole.slice(0, cut));
      const b = readSse(a.rest + whole.slice(cut));
      return JSON.stringify([...a.frames, ...b.frames]) === JSON.stringify(readSse(whole).frames);
    }),
  );
});

test('artifact readers survive whatever a model wrote', () => {
  for (const junk of [null, 7, 'text', [], { parity: 'no', mvpFeatures: {} }]) {
    assert.doesNotThrow(() => readPlan(junk));
    assert.doesNotThrow(() => readAds(junk));
    assert.doesNotThrow(() => readTestReport(junk));
    assert.doesNotThrow(() => readLicence(junk));
  }
  const p = readPlan({ parity: [{ feature: 'Waitlist', theirs: false, ours: 'new' }, { feature: 'X', theirs: 'yes', ours: 'bogus' }], priceUnder: { theirTopUsd: 39, ourTopUsd: 31 } });
  assert.deepEqual(p.parity.map((r) => [r.theirs, r.ours]), [[false, 'new'], [false, 'parity']]);
  assert.deepEqual(p.priceUnder, { theirs: 39, ours: 31, note: '' });
  assert.equal(readAds({ ads: [{ headline: '' , body: '' }, { headline: 'H' }] }).ads.length, 1);
  const list = [
    { sha256: 'a', name: 'plan', zone: 'CLEAN' },
    { sha256: 'b', name: 'manifest', zone: 'SCOUT' },
    { sha256: 'c', name: 'plan', zone: 'CLEAN' },
    { sha256: 'd', name: 'preview', zone: 'CLEAN' },
  ];
  assert.equal(findArtifact(list, 'plan').sha256, 'c');
  assert.equal(findArtifact(list, 'manifest'), null, 'SCOUT bodies are never fetched');
  assert.deepEqual(resultTabs('BUILD_BETTER', list), ['plan', 'design', 'receipt']);
  assert.deepEqual(resultTabs('IDEA_TO_LIVE', []), ['receipt']);
});

test('Run Mode and Recipe checks', () => {
  assert.match(runModeProblem({ daily_cap_usd: 5, tasks: ['ads'] }), /between \$6 and \$500/);
  assert.match(runModeProblem({ daily_cap_usd: 501, tasks: ['ads'] }), /between/);
  assert.match(runModeProblem({ daily_cap_usd: 20, tasks: [] }), /at least one/);
  assert.match(runModeProblem({ daily_cap_usd: 20, tasks: ['watch'] }), /address/);
  assert.equal(runModeProblem({ daily_cap_usd: 20, tasks: ['watch'], target_url: 'https://rival.example' }), null);
  assert.equal(runModeProblem({ daily_cap_usd: 6, tasks: ['brief'] }), null);
  assert.match(recipeProblem({ title: '', summary: '', price_usd: 0 }, 'gang'), /title/);
  assert.match(recipeProblem({ title: 'T', summary: '', price_usd: 9 }, 'crew'), /Gang/);
  assert.equal(recipeProblem({ title: 'T', summary: '', price_usd: 9 }, 'gang'), null);
  assert.match(recipeProblem({ title: 'T', summary: '', price_usd: 501 }, 'syndicate'), /\$500/);
  const now = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(relTime('2026-11-21T14:00:00Z', now), 'in 2 h');
  assert.equal(relTime('2026-11-21T11:56:00Z', now), '4 min ago');
});

test('the Ventures pages never use the words Overview §11 rules out', () => {
  const files = ['lib/anonymo/ventures.ts', 'lib/anonymo/mock/ventures.ts', 'components/dashboard/ventures.tsx', 'components/dashboard/venture-board.tsx', 'components/dashboard/mo.tsx', 'app/dashboard/ventures/page.tsx', 'app/dashboard/ventures/[id]/page.tsx'];
  const found = [];
  for (const f of files) {
    const lines = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/NEVER_SAY/.test(line)) return;
      for (const p of copyProblems(line)) found.push(`${f}:${i + 1} ${p}`);
    });
  }
  assert.deepEqual(found, []);
  assert.deepEqual(copyProblems('Build the better version, parity plus.'), []);
  assert.equal(copyProblems('Guaranteed to earn a yield').length, 3);
});

test('demo crew: a whole Build Better run plays through the client, then its results and receipt', async () => {
  const { client, tick } = await funded(500);
  assert.equal((await client.ventureTier()).tier, 'gang');
  const seeded = await client.ventures();
  assert.equal(seeded.length, 3, 'three earlier runs to look at');
  assert.deepEqual(seeded.map((r) => r.status).sort(), ['CANCELLED', 'DONE', 'DONE']);

  await assert.rejects(client.startVenture({ mode: 'DUPE_DROP', brief: 'x' }), (e) => e.status === 501);
  await assert.rejects(client.startVenture({ mode: 'BUILD_BETTER', brief: '', target_url: 'http://localhost' }), (e) => e.status === 400);
  const made = await client.startVenture(createBody('BUILD_BETTER', { ...EMPTY_BRIEF, target_url: 'https://slotharbor.example', brand: 'Quayside' }));
  assert.equal(made.price_usd, 149);
  assert.ok(made.target_commit?.startsWith('0x'));
  const bal = await client.balance();
  assert.equal(Number(bal.available_usd), 351, 'the price is charged up front');

  let v = await client.venture(made.id);
  assert.equal(v.status, 'QUEUED');
  assert.ok(v.steps.every((s) => s.state === 'QUEUED'));
  assert.deepEqual(await client.ventureArtifacts(made.id), []);
  tick(9_000);
  v = await client.venture(made.id);
  assert.equal(v.status, 'RUNNING');
  assert.equal(v.steps.find((s) => s.key === 'scout').state, 'DONE');
  const scoutArts = (await client.ventureArtifacts(made.id)).filter((a) => a.zone === 'SCOUT');
  assert.ok(scoutArts.length);
  await assert.rejects(client.ventureArtifact(made.id, scoutArts[0].sha256), (e) => e.status === 403 && e.code === 'scout_zone');
  await assert.rejects(client.ventureExport(made.id), (e) => e.status === 404);

  tick(20_000);
  v = await client.venture(made.id);
  assert.equal(v.status, 'DONE');
  assert.ok(v.steps.every((s) => s.state === 'DONE'));
  assert.ok(v.cost_usd > 0 && v.cost_usd < v.price_usd, 'the crew stays under the price');
  const build = v.steps.find((s) => s.key === 'build');
  assert.equal(build.candidates.filter((c) => c.chosen).length, 1);
  assert.ok(build.candidates.some((c) => c.refused && c.cost_usd === 0), 'a refused builder is shown, billed nothing');

  const arts = await client.ventureArtifacts(made.id);
  assert.deepEqual(resultTabs(v.mode, arts), ['plan', 'design', 'landing', 'comparison', 'code', 'receipt', 'licence']);
  const plan = readPlan(JSON.parse(await client.ventureArtifact(made.id, findArtifact(arts, 'plan').sha256)));
  assert.ok(plan.parity.length >= 8 && plan.gaps.length >= 1);
  const landing = await client.ventureArtifact(made.id, findArtifact(arts, 'landing').sha256);
  assert.match(landing, /<!doctype html>/);
  assert.doesNotMatch(landing, /<script/i, 'crew pages carry no scripts');
  const report = readTestReport(JSON.parse(await client.ventureArtifact(made.id, findArtifact(arts, 'test-report').sha256)));
  assert.equal(report.winner.family, build.candidates.find((c) => c.chosen).family);
  assert.equal(readLicence(JSON.parse(await client.ventureArtifact(made.id, findArtifact(arts, 'licence').sha256))).verdict, 'allow-with-obligations');

  const receipt = await client.ventureReceipt(made.id);
  assert.match(receipt.clean_room.root, /^0x[0-9a-f]{64}$/);
  assert.ok(receipt.clean_room.scoutArtifactHashes.length && receipt.clean_room.specHash);
  assert.ok(receipt.candidates.length >= 5);

  const tar = new Uint8Array(await (await client.ventureExport(made.id)).arrayBuffer());
  assert.deepEqual([tar[0], tar[1]], [0x1f, 0x8b], 'a gzip file');

  // Run Mode and Recipes on the finished run.
  await assert.rejects(client.startRunMode(made.id, { daily_cap_usd: 3, tasks: ['ads'] }), (e) => e.status === 400);
  const rm = await client.startRunMode(made.id, { daily_cap_usd: 25, tasks: ['improve', 'ads', 'brief'] });
  const rv = await client.venture(rm.id);
  assert.equal(rv.mode, 'RUN');
  assert.equal(rv.run_mode.enabled, true);
  assert.equal(rv.run_mode.daily_cap_usd, 25);
  assert.ok(rv.run_mode.last_brief);
  await client.stopRunMode(rm.id);
  assert.equal((await client.venture(rm.id)).run_mode.enabled, false);

  const before = (await client.recipes()).length;
  const saved = await client.saveRecipe(made.id, { title: 'Booking, better', summary: 'Waitlists first.', price_usd: 5 });
  assert.match(saved.recipeHash, /^0x/);
  assert.equal((await client.recipes()).length, before + 1);
  await assert.rejects(client.saveRecipe(made.id, { title: 'Again', summary: '', price_usd: 0 }), (e) => e.status === 409);
  // Running someone's Recipe charges the mode's price plus the Recipe's.
  const recipe = (await client.recipes()).find((r) => r.mode === 'IDEA_TO_LIVE');
  const viaRecipe = await client.startVenture({ mode: 'IDEA_TO_LIVE', brief: 'A weekend MVP for a tiny idea.', recipe_id: recipe.id });
  assert.equal(viaRecipe.recipe_price_usd, recipe.price_usd);
});

test('demo crew: the event stream plays the run, resumes after Last-Event-ID, and ends', async () => {
  const mock = createMockGateway({ venturesEnabled: true, delayMs: 0, ventureRunMs: 600 });
  const { key } = await createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch }).createKey();
  const client = createAnonymoClient({ baseUrl: BASE, fetch: mock.fetch, key });
  await mock.simulateDeposit(key, 'rhc', 'USDG', 200_000_000);
  const made = await client.startVenture({ mode: 'IDEA_TO_LIVE', brief: 'Plant-care reminders for renters.' });
  const read = async (after) => {
    const body = await client.ventureEvents(made.id, after);
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    const frames = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const r = readSse(buf + value);
      buf = r.rest;
      frames.push(...r.frames);
    }
    return frames;
  };
  const all = await read(0);
  assert.equal(all.at(-1).event, 'end');
  const events = all.map(eventOf).filter(Boolean);
  assert.equal(events.at(-1).type, 'venture');
  assert.equal(events.at(-1).status, 'DONE');
  assert.deepEqual(all.filter((f) => f.id !== null).map((f) => f.id), events.map((_, i) => i + 1), 'ids count up from 1');
  const resumed = await read(10);
  assert.equal(resumed.filter((f) => f.id !== null)[0].id, 11);
  // Folding the stream gives the same run as GET.
  let v = await client.venture(made.id);
  const folded = events.reduce(applyEvent, { ...v, status: 'QUEUED', cost_usd: 0, steps: v.steps.map((s) => ({ ...s, state: 'QUEUED', cost_usd: 0, candidates: [], outputs: [] })) });
  assert.equal(folded.status, v.status);
  assert.deepEqual(folded.steps.map((s) => s.state), v.steps.map((s) => s.state));
});

test('demo crew: cancel stops a run mid-way and skips what had not finished', async () => {
  const { client, tick } = await funded(200);
  const made = await client.startVenture({ mode: 'TAKEOVER', brief: '', target_url: 'https://invoicemule.example', rival: 'InvoiceMule' });
  tick(6_000);
  await client.cancelVenture(made.id);
  tick(2_000);
  const v = await client.venture(made.id);
  assert.equal(v.status, 'CANCELLED');
  assert.ok(v.steps.some((s) => s.state === 'DONE'));
  assert.ok(v.steps.some((s) => s.state === 'SKIPPED'));
  assert.ok(v.steps.every((s) => s.state === 'DONE' || s.state === 'SKIPPED'));
  tick(60_000);
  assert.equal((await client.venture(made.id)).status, 'CANCELLED', 'a cancelled run stays cancelled');
});

test('demo crew: not enough credit is a 402 and nothing starts', async () => {
  const { client } = await funded(20);
  const before = (await client.ventures()).length;
  await assert.rejects(client.startVenture({ mode: 'BUILD_BETTER', brief: '', target_url: 'https://rival.example' }), (e) => e.status === 402);
  assert.equal((await client.ventures()).length, before);
  await assert.rejects(createAnonymoClient({ baseUrl: BASE, fetch: createMockGateway({ venturesEnabled: true }).fetch }).ventures(), (e) => e.status === 401);
});

test('demo crew: runs survive a reload of the demo gateway, and the rival url is kept only as its hash', async () => {
  const kept = new Map();
  const storage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
  let now = Date.parse('2026-11-21T12:00:00Z');
  const first = createMockGateway({ venturesEnabled: true, storage, delayMs: 0, venturesNow: () => now });
  const { key } = await createAnonymoClient({ baseUrl: BASE, fetch: first.fetch }).createKey();
  await first.simulateDeposit(key, 'rhc', 'USDG', 300_000_000);
  const made = await createAnonymoClient({ baseUrl: BASE, fetch: first.fetch, key }).startVenture({ mode: 'BUILD_BETTER', brief: '', target_url: 'https://slotharbor.example', brand: 'Quayside' });
  now += 30_000;
  const again = createAnonymoClient({ baseUrl: BASE, fetch: createMockGateway({ venturesEnabled: true, storage, delayMs: 0, venturesNow: () => now }).fetch, key });
  const v = await again.venture(made.id);
  assert.equal(v.status, 'DONE');
  assert.equal((await again.ventures()).length, 4);
  assert.doesNotMatch(kept.get('anonymo.demo.ventures.v1'), /slotharbor\.example/);
});
