import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFomoInput, fomoAnalysisPrompt } from '../lib/second-look/fomo.ts';
import { fomoAnalysisResponse } from '../lib/client/fomo-contracts.ts';
import {
  collectFomoAnalysis,
  fomoReadJson,
  fomoRoutes,
} from '../server/second-look/fomo.ts';
import { prepareFomoComparison } from '../components/dashboard/use-live-workspace.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { scanPrompt } from '../lib/guards/index.ts';
const mint = 'So11111111111111111111111111111111111111112';
const link = 'https://fomo.family/tokens/solana/' + mint + '?thesisId=call-1';
const now = new Date('2026-10-15T16:00:00Z');
const profile = {
  id: 'profile-1',
  handle: 'tester',
  name: 'Synthetic test trader',
  bio: null,
  solanaAddress: null,
  evmAddress: null,
};
const thesis = {
  id: 'call-1',
  tokenAddress: mint,
  tokenNetwork: '1399811149',
  authorHandle: 'tester',
  thesis: 'Synthetic test claim',
  fomoCreatedAt: now.getTime(),
};
const reader = async (url) => ({
  stale: false,
  data: url.includes('/pnl')
    ? { handle: 'tester', windows: { all: null }, updatedAt: null }
    : url.includes('/theses')
      ? { items: [thesis], hasMore: true, updatedAt: now.getTime() }
      : url.includes('dexscreener')
        ? [
            {
              chainId: 'solana',
              baseToken: { address: mint, symbol: 'TEST' },
              priceUsd: '1',
            },
          ]
        : profile,
});
test('classifies canonical profile, @handle, and exact callout and removes tracking', () => {
  assert.equal(parseFomoInput('@tester').kind, 'profile');
  assert.equal(
    parseFomoInput('https://fomo.family/profile/tester?utm_source=x').url,
    'https://fomo.family/profile/tester',
  );
  assert.equal(parseFomoInput(link).calloutId, 'call-1');
  for (const value of [
    'http://fomo.family/profile/tester',
    'https://fomo.family.evil.test/profile/tester',
    'https://fomo.family@evil.test/profile/tester',
    'https://fomo.family:8443/profile/tester',
    'https://fomo.family/profile/%74ester',
    'https://fomo.family/a/../profile/tester',
    'https://fomo.family/tokens/solana/' + mint,
    link + '&thesisId=call-2',
    link + '#extra',
    'https://127.0.0.1/profile/tester',
  ])
    assert.throws(() => parseFomoInput(value), value);
});
test('profile sources preserve unknown values and incomplete history', async () => {
  const a = await collectFomoAnalysis('@tester', { read: reader, now });
  assert.equal(a.state, 'partial');
  assert.equal(a.sources.length, 3);
  assert.equal(a.callout, null);
  assert.equal(
    a.sources.find((s) => s.id === 'performance').data.windows.all,
    null,
  );
  assert.ok(fomoAnalysisResponse({ analysis: a }));
  assert.match(fomoAnalysisPrompt(a), /not realized profit/);
});
test('callout matches exact ID, address and chain before attributing author', async () => {
  const a = await collectFomoAnalysis(link, { read: reader, now });
  assert.equal(a.callout.author, 'tester');
  assert.equal(a.callout.verified, true);
  assert.equal(a.sources.find((s) => s.id === 'market').data.pairs.length, 1);
  assert.ok(fomoAnalysisResponse({ analysis: a }));
});
test('wrong callout is not silently substituted or analyzed as a complete result', async () => {
  const a = await collectFomoAnalysis(link.replace('call-1', 'other'), {
    read: reader,
    now,
  });
  assert.equal(a.callout, null);
  assert.equal(a.state, 'unavailable');
  assert.ok(!a.sources.some((s) => s.id === 'profile'));
});
test('wrong-chain thesis and unrelated pair do not become evidence', async () => {
  const a = await collectFomoAnalysis(link, {
    read: async (url) => {
      if (url.includes('/theses'))
        return {
          data: { items: [{ ...thesis, tokenNetwork: '1' }], hasMore: false },
          stale: false,
        };
      if (url.includes('dexscreener'))
        return {
          data: [{ chainId: 'base', baseToken: { address: mint } }],
          stale: false,
        };
      return reader(url);
    },
    now,
  });
  assert.equal(a.callout, null);
  assert.equal(a.sources.find((s) => s.id === 'market').state, 'unavailable');
});
test('partial failures preserve working evidence and unavailable sources do not invent zeroes', async () => {
  const a = await collectFomoAnalysis('@tester', {
    read: async (url) =>
      url.includes('/pnl')
        ? Promise.reject(Error('provider secret'))
        : reader(url),
    now,
  });
  assert.equal(a.state, 'partial');
  assert.equal(a.sources.find((s) => s.id === 'performance').data, null);
  assert.ok(!JSON.stringify(a).includes('provider secret'));
});
test('complete outage is explicit and no model run occurs in evidence collection', async () => {
  const a = await collectFomoAnalysis('@tester', {
    read: async () => {
      throw Error('offline');
    },
    now,
  });
  assert.equal(a.state, 'unavailable');
  assert.ok(a.sources.every((s) => s.data === null));
});
test('supplied callout is clearly unverified, not attributed to another trader', async () => {
  const a = await collectFomoAnalysis(link, {
    read: async () => {
      throw Error('offline');
    },
    context: 'A claim pasted by the user',
    now,
  });
  assert.equal(a.state, 'partial');
  assert.equal(a.callout.verified, false);
  assert.equal(a.callout.author, null);
});
test('stale data, exact saved token evidence and source timestamps survive', async () => {
  const a = await collectFomoAnalysis(link, {
    read: async (url) => ({ ...(await reader(url)), stale: true }),
    tokenEvidence: async () => ({
      mint, expiresAt: new Date(now.getTime()+60000).toISOString(),
      updatedAt: now.toISOString(),
      checks: [{ id: 1, status: 'partial' }],
    }),
    now,
  });
  assert.ok(a.sources.find((s) => s.id === 'calls').note.includes('stale'));
  assert.equal(
    a.sources.find((s) => s.id === 'token-check').observedAt,
    now.toISOString(),
  );
});
test('response validator rejects malformed state and unsafe source URLs', async () => {
  const a = await collectFomoAnalysis('@tester', { read: reader, now });
  for (const mutate of [
    (v) => (v.analysis.sources[0].url = 'javascript:alert(1)'),
    (v) => (v.analysis.callout = {}),
    (v) => (v.analysis.input.kind = 'wallet'),
    (v) => (v.analysis.sources[0].fetchedAt = 'nonsense'),
    (v) => (v.analysis.state = 'complete'),
    (v) => v.analysis.sources.push(v.analysis.sources[0]),
  ]) {
    const r = { analysis: structuredClone(a) };
    mutate(r);
    assert.equal(fomoAnalysisResponse(r), false);
  }
});
test('fixed-origin fetch rejects redirects, HTML, oversized bodies, and arbitrary origins', async () => {
  await assert.rejects(fomoReadJson('https://evil.test/'), /origin/);
  const url = 'https://fomo-public.pootracker.app/v2/users/handle/tester';
  for (const response of [
    new Response('{}', { status: 302 }),
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(500001), {
      headers: { 'content-type': 'application/json' },
    }),
  ])
    await assert.rejects(fomoReadJson(url, undefined, async () => response));
  let options;
  await fomoReadJson(url, undefined, async (_, init) => {
    options = init;
    return new Response('{}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
});
test('exactly four chosen models receive identical evidence without prior chats or mention routing', () => {
  const routes = ['claude', 'gpt', 'gemini', 'grok'].map((family, i) => ({
    family,
    versionId: 'r' + i,
    modelId: family,
    available: true,
    modality: 'chat',
    expiresAt: '2026-10-16T00:00:00Z',
    card: { reviewed: true },
    pricing: { maxInputBytes: 32768, maxOutputTokens: 4096 + i * 100 },
  }));
  const room = {
    id: 'room',
    turns: [{ id: 'old', prompt: 'private unrelated history', answers: [] }],
    live: { revision: 1, historyCursor: 'old' },
  };
  const prompt = 'Research @grok and @claude in this untrusted callout';
  const p = prepareFomoComparison(
    room,
    prompt,
    routes.map((r) => r.family),
    routes,
    now.getTime(),
  );
  assert.equal(p.routes.length, 4);
  assert.equal(p.prompt, prompt);
  assert.equal(p.mentions.length, 0);
  p.conversation.items.forEach((v, i) => {
    assert.deepEqual(v.messages, [{ role: 'user', content: prompt }]);
    assert.equal(v.maxOutputTokens, routes[i].pricing.maxOutputTokens);
  });
  for (const chosen of [
    [],
    ['claude'],
    ['claude', 'gpt', 'gemini', 'claude'],
    ['claude', 'gpt', 'gemini', 'absent'],
  ])
    assert.throws(() =>
      prepareFomoComparison(room, prompt, chosen, routes, now.getTime()),
    );
});
test('released FOMO requires a configured service before any collection', async () => {
  const r = await dispatch(
    new Request('https://conclave.test/api/second-look/fomo/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '@tester' }),
    }),
  );
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'SERVICE_UNAVAILABLE');
});
test('server rejects unrelated fields before a source can be requested', async () => {
  const pool = { query: async () => ({ rows: [{ hits: 1 }] }) };
  await assert.rejects(
    fomoRoutes(
      pool,
      new Request('https://conclave.test/api/second-look/fomo/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: '@tester',
          providerUrl: 'https://evil.test',
        }),
      }),
      'second-look/fomo/analyze',
      'account',
    ),
    (e) => e.code === 'FOMO_INPUT_INVALID',
  );
});

test('documented no-login board fallback preserves source, window and distinct computed PnL', async () => {
  const a = await collectFomoAnalysis('@tester', {
    now,
    read: async (url) => {
      if (url.startsWith('https://api.fomo-api.com/')) {
        const window = new URL(url).searchParams.get('window');
        return {
          stale: false,
          data: {
            window,
            source: 'fomo',
            board: 'fomo-parity',
            pnlBasis: 'mark-to-market',
            syncedAt: now.toISOString(),
            data: [
              {
                handle: 'tester',
                rank: 5,
                pnlUsd: 100,
                computedPnlUsd: 30,
                realizedPnlUsd: 10,
                unrealizedPnlUsd: 20,
                wallets: [],
              },
            ],
          },
        };
      }
      if (url.startsWith('https://fomolens.app/'))
        return {
          stale: false,
          data: { rows: [], refreshedAt: now.toISOString() },
        };
      throw Error('Primary index down');
    },
  });
  assert.equal(a.state, 'partial');
  assert.equal(
    a.sources.filter((s) => s.id.startsWith('public-profile-')).length,
    3,
  );
  const board = a.sources.find((s) => s.id === 'public-profile-24h');
  assert.equal(board.data.source, 'fomo');
  assert.equal(board.data.trader.pnlUsd, 100);
  assert.equal(board.data.trader.computedPnlUsd, 30);
  assert.match(board.note, /30-day/);
  assert.equal(
    a.sources.find((s) => s.id === 'public-calls').data.items.length,
    0,
  );
  assert.ok(fomoAnalysisResponse({ analysis: a }));
});
test('public fallback never substitutes another trader or turns recent feed IDs into FOMO IDs', async () => {
  const read = async (url) =>
    url.startsWith('https://api.fomo-api.com/')
      ? {
          stale: false,
          data: {
            window: new URL(url).searchParams.get('window'),
            board: 'fomo-parity',
            source: 'computed',
            data: [{ handle: 'someone_else', rank: 5 }],
          },
        }
      : url.startsWith('https://fomolens.app/')
        ? {
            stale: false,
            data: {
              rows: [
                {
                  callId: 'different-provider-id',
                  text: 'Unrelated thesis',
                  network: 'solana',
                  token: { address: mint },
                  author: { userHandle: 'someone_else' },
                },
              ],
            },
          }
        : Promise.reject(Error('Unavailable'));
  const profile = await collectFomoAnalysis('@tester', { read, now });
  assert.equal(profile.state, 'unavailable');
  assert.equal(
    profile.sources.find((s) => s.id === 'public-calls').data.items.length,
    0,
  );
  const call = await collectFomoAnalysis(link, { read, now });
  assert.equal(call.state, 'unavailable');
  assert.equal(call.callout, null);
});
test('new public origins allow only documented unauthenticated paths', async () => {
  for (const url of [
    'https://fomolens.app/api/public/lookup',
    'https://fomolens.app/api/v1/users/tester',
    'https://fomolens.app/api/public/calls?handle=tester',
    'https://api.fomo-api.com/v1/wallet/tester',
    'https://api.fomo-api.com/v1/leaderboard?window=24h&limit=200',
  ]) {
    let called = false;
    await assert.rejects(() =>
      fomoReadJson(url, undefined, async () => {
        called = true;
        throw Error('Should not fetch');
      }),
    );
    assert.equal(called, false);
  }
});

test('optional saved token-tool failure does not discard retrieved callout evidence', async () => {
  const a = await collectFomoAnalysis(link, {
    read: reader,
    now,
    tokenEvidence: async () => {
      throw Error('Store unavailable');
    },
  });
  assert.equal(a.callout.verified, true);
  assert.equal(
    a.sources.find((s) => s.id === 'token-check').state,
    'unavailable',
  );
  assert.equal(a.state, 'partial');
});

test('public top-100 fallback preserves sample time separately from ranking retrieval and FOMO rank', async () => {
  const a = await collectFomoAnalysis('@tester', {
    now,
    read: async (url) => {
      if (url.startsWith('https://fomolens.app/api/public/leaderboard')) return {
        stale: false,
        data: {
          window: new URL(url).searchParams.get('window'), coverage: 'sampled', hasMore: true,
          retrievedAt: now.toISOString(), rows: [{ position: 36, userHandle: 'Tester',
            displayName: 'Synthetic trader', pnl: 100, fetchedAt: '2026-10-14T00:00:00Z',
            profileObservedAt: '2026-10-13T00:00:00Z' }],
        },
      };
      if (url.startsWith('https://fomolens.app/api/public/calls')) return { stale: false, data: { rows: [] } };
      throw Error('Unavailable');
    },
  });
  assert.equal(a.state, 'partial');
  const sampled = a.sources.find((s) => s.id === 'public-profile-sampled-24h');
  assert.equal(sampled.observedAt, '2026-10-14T00:00:00.000Z');
  assert.equal(sampled.data.retrievedAt, now.toISOString());
  assert.equal(sampled.data.trader.position, 36);
  assert.equal(sampled.data.trader.rank, undefined);
  assert.match(sampled.note, /not FOMO leaderboard rank/);
  assert.ok(fomoAnalysisResponse({ analysis: a }));
});

test('recent exact-author calls permit a limited profile report without inventing profile totals', async () => {
  const a = await collectFomoAnalysis('@tester', {
    now, context: 'Additional public context',
    read: async (url) => {
      if (url === 'https://fomolens.app/api/public/calls') return { stale: false, data: {
        rows: [{ callId: 'provider-call-2', text: 'Synthetic call', createdAt: now.toISOString(),
          network: 'solana', token: { address: mint }, author: { userHandle: 'tester', displayName: 'Test' } },
          { callId: 'other', text: 'Other author', author: { userHandle: 'tester_extra' } }],
        refreshedAt: now.toISOString(),
      } };
      throw Error('Unavailable');
    },
  });
  assert.equal(a.state, 'partial');
  assert.equal(a.sources.find((s) => s.id === 'public-calls').data.items.length, 1);
  assert.ok(a.limitations.some((s) => s.includes('Profile totals, wallet attribution and performance are unknown')));
  assert.ok(fomoAnalysisResponse({ analysis: a }));
});

test('sampled board cannot substitute prefix matches or malformed PnL', async () => {
  for (const row of [{ userHandle: 'tester_extra', position: 36, pnl: 3 },
    { userHandle: 'tester', position: 36, pnl: '100' },
    { userHandle: 'tester', position: 101, pnl: 3 }]) {
    const a = await collectFomoAnalysis('@tester', { now, read: async (url) => {
      if (url.includes('/api/public/leaderboard')) return { stale: false, data: {
        window: new URL(url).searchParams.get('window'), coverage: 'sampled', hasMore: true, rows: [row],
      } };
      throw Error('Unavailable');
    } });
    assert.equal(a.state, 'unavailable');
    assert.ok(a.limitations.some((s) => s.includes('does not establish')));
  }
});

test('sampled-board origin restrictions reject pagination and browser-only search', async () => {
  for (const url of ['https://fomolens.app/api/public/leaderboard?window=24h&cursor=1',
    'https://fomolens.app/api/public/leaderboard?window=24h&window=7d',
    'https://fomolens.app/api/public/search?q=tester']) {
    let called = false;
    await assert.rejects(fomoReadJson(url, undefined, async () => { called = true; throw Error('Should not run'); }));
    assert.equal(called, false);
  }
});


test('real dossier prompts pass credential guard without changing evidence or weakening secret detection', async () => {
  for (const input of ['@tester', link]) {
    const a = await collectFomoAnalysis(input, { read: reader, now });
    a.sources.push({ id: 'test-public-schema', label: 'Schema test', url: 'https://fomolens.app/api/public/calls',
      fetchedAt: now.toISOString(), observedAt: null, state: 'partial', note: '',
      data: { token: { address: mint }, baseToken: { address: mint }, quoteToken: { symbol: 'USD' },
        tokenAmount: 4, tokenSymbol: 'SYNTHETIC', tokenNetwork: 'solana', tokenAddress: mint,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', token2022TransferFeesVerified: false } });
    const before = JSON.stringify(a);
    const prompt = fomoAnalysisPrompt(a);
    assert.deepEqual(scanPrompt(prompt).findings.filter((f) => f.severity === 'block'), []);
    assert.equal(JSON.stringify(a), before);
    assert.ok(prompt.includes(mint));
    a.sources.at(-1).data.API_KEY = 'synthetic-test-secret-value';
    assert.ok(scanPrompt(fomoAnalysisPrompt(a)).findings.some((f) => f.rule === 'secret.assignment' || f.severity === 'block'));
  }
});

test('trade IDs are not mistaken for native thesis IDs in the public index', async () => {
  const a = await collectFomoAnalysis(link.replace('thesisId=', 'tradeId='), { read: reader, now });
  assert.equal(a.callout, null);
  assert.equal(a.state, 'unavailable');
});


test('malformed public calls cannot establish a profile just from a matching author handle', async () => {
  const a = await collectFomoAnalysis('@tester', { now, read: async (url) => {
    if (url === 'https://fomolens.app/api/public/calls') return { stale: false, data: {
      rows: [{ author: { userHandle: 'tester' }, callId: 'bad', text: 'Text without a valid token and time' }],
    } };
    throw Error('Unavailable');
  } });
  assert.equal(a.state, 'unavailable');
  assert.equal(a.sources.find((s) => s.id === 'public-calls').data.items.length, 0);
});


const evidenceFromPrompt = (a) => JSON.parse(fomoAnalysisPrompt(a)
  .split('BEGIN UNTRUSTED EVIDENCE JSON')[1].split('END UNTRUSTED EVIDENCE JSON')[0].trim());

test('prompt separates requested-window, computed30d, lifetime and listed-position metrics', async () => {
  const a = await collectFomoAnalysis('@tester', { read: reader, now });
  a.sources = [{ id: 'public-profile-24h', label: '24-hour board', url: 'https://api.fomo-api.com/v1/leaderboard?window=24h&limit=10&board=fomo-parity',
    fetchedAt: now.toISOString(), observedAt: now.toISOString(), state: 'partial', note: '', data: {
      window: '24h', source: 'fomo', pnlBasis: 'mark-to-market', stale: true, syncedAt: now.toISOString(), trader: {
        handle: 'tester', rank: 5, pnlUsd: 100, reportedPnlUsd: 100, computedPnlUsd: 30,
        realizedPnlUsd: -10, unrealizedPnlUsd: 40, volumeUsd: 200, trades: 92,
        allTimePnlUsd: 700, allTimeRank: 3, fomoLifetimeVolumeUsd: 3000, fomoNumTrades: 800, fomoSwapCount: 600,
        lowCoverage: true, pricedSharePct: 99, divergesFromFomo: true, networks: { solana: { netUsd: 987654321, trades: 87654321 } },
        topHoldings: [{ tokenAddress: mint, symbol: 'TEST', valueUsd: 500, lifetimePnlUsd: 10, pnlUsd: 10 }],
      },
    } }];
  const before = JSON.stringify(a);
  const data = evidenceFromPrompt(a).sources[0].data;
  assert.equal(data.reportedWindow.period, '24h');
  assert.equal(data.reportedWindow.pnlUsdForRequestedPeriod, 100);
  assert.equal(data.computed30d.period, '30d');
  assert.equal(data.computed30d.providerReportsLowPriceCoverage, true);
  assert.equal(data.snapshotMetadata.sourceMarksSnapshotStale, true);
  assert.equal(data.computed30d.computedTotalPnlUsdOver30d, 30);
  assert.equal(data.computed30d.computedRealizedPnlUsdOver30d, -10);
  assert.equal(data.computed30d.computedUnrealizedPnlUsdOn30dCalculationBasis, 40);
  assert.equal(data.computed30d.computedTradedVolumeUsdOver30d, 200);
  assert.equal(data.computed30d.computedTradeCountOver30d, 92);
  assert.equal(data.profileLifetime.reportedLifetimeTradeCount, 800);
  assert.equal(data.profileLifetime.reportedLifetimeSwapCount, 600);
  assert.equal(data.holdingsSnapshot.completePortfolio, false);
  assert.equal(data.holdingsSnapshot.positions[0].sourceReportedPnlUsdSincePositionOpened, 10);
  assert.ok(!JSON.stringify(data).includes('987654321'));
  assert.ok(!JSON.stringify(data).includes('87654321'));
  for (const key of ['computedPnlUsd', 'realizedPnlUsd', 'unrealizedPnlUsd', 'volumeUsd', 'trades', 'networks', 'divergesFromFomo', 'reportedPnlUsd'])
    assert.ok(!JSON.stringify(data).includes('"' + key + '":'), key);
  assert.equal(JSON.stringify(a), before);
  assert.deepEqual(scanPrompt(fomoAnalysisPrompt(a)).findings.filter((f) => f.severity === 'block'), []);
  assert.match(fomoAnalysisPrompt(a), /Never calculate a gap/);
  assert.match(fomoAnalysisPrompt(a), /Do not infer net worth/);
  assert.match(fomoAnalysisPrompt(a), /deanonymization/);
});

test('sampled leaderboard prompts separate lifetime profile counters from requested period', async () => {
  const a = await collectFomoAnalysis('@tester', { read: reader, now });
  a.sources = [{ id: 'public-profile-sampled-7d', label: 'Sampled7d', url: 'https://fomolens.app/api/public/leaderboard?window=7d',
    fetchedAt: now.toISOString(), observedAt: now.toISOString(), state: 'partial', note: '', data: {
      window: '7d', retrievedAt: now.toISOString(), trader: { handle: 'tester', pnl: 300, position: 36,
        numTrades: 700, followers: 40, fetchedAt: '2026-10-14T00:00:00Z', profileObservedAt: '2026-10-13T00:00:00Z' },
    } }];
  const data = evidenceFromPrompt(a).sources[0].data;
  assert.equal(data.reportedWindow.period, '7d');
  assert.equal(data.reportedWindow.sampledPnlUsdForRequestedPeriod, 300);
  assert.equal(data.reportedWindow.observedAt, '2026-10-14T00:00:00Z');
  assert.equal(data.profileLifetime.storedProfileTradeCount, 700);
  assert.equal(data.profileLifetime.observedAt, '2026-10-13T00:00:00Z');
  assert.equal(data.reportedWindow.numTrades, undefined);
});
