import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { deriveTokenCalibration } from '../server/second-look/token-calibration.ts';
import {
  calibrationState,
  evaluateTokenFacts,
} from '../server/second-look/token-rules.ts';
import {
  blankChecks,
  fact,
  source,
} from '../server/second-look/token-facts.ts';
import {
  forkProbeConfig,
  parseForkProbe,
  runForkProbe,
} from '../server/second-look/providers-simulation.ts';
import {
  deepProducerConfig,
  requestDeepProducer,
  parseDeepProducerResult,
} from '../server/second-look/deep-producer.ts';
import { SOLANA_NETWORKS } from '../server/solana/validation.ts';
import {
  createSourceSnapshot,
  prepareCrossCheck,
} from '../server/crosscheck/core.ts';

const mint = bs58.encode(new Uint8Array(32).fill(72));
const now = Date.now();
function snapshot(at, i) {
  const checks = blankChecks().map((c) => ({
    ...c,
    status: 'complete',
    facts: [],
    sources: [source('reviewed-index', at)],
  }));
  const crashed = Math.floor(i / 3) % 2 === 0;
  if (crashed)
    checks[0].facts.push(fact('mintAuthority', 'Mint authority', mint));
  return {
    mint,
    observedAt: new Date(at).toISOString(),
    ageSeconds: [100, 7200, 172800][i % 3],
    checks,
  };
}
function observation(i, cohort = 'historical') {
  const at = now - 65 * 86400000 + i * 265000;
  return {
    id: `synthetic-${i}`,
    cohort,
    buyAt: new Date(at).toISOString(),
    outcomeThrough: new Date(at + 86400000).toISOString(),
    outcomeCoverageComplete: true,
    buyPriceUsd12: '1000000000000',
    minimumPrice24hUsd12:
      Math.floor(i / 3) % 2 === 0 ? '10000000000' : '900000000000',
    facts: snapshot(at, i),
  };
}
void test('computed buy-time acceptance covers 20k observations, 60 days and 30 live days', () => {
  const observations = Array.from({ length: 20004 }, (_, i) => observation(i));
  for (let i = 0; i < 96; i++) {
    const item = observation(i * 190 + 1, 'live');
    item.id = `live-${i}`;
    // The same buy must never be counted twice, even across cohorts.
    item.buyAt = new Date(Date.parse(item.buyAt) + 1).toISOString();
    item.outcomeThrough = new Date(
      Date.parse(item.outcomeThrough) + 1,
    ).toISOString();
    item.facts = snapshot(Date.parse(item.buyAt), i);
    item.minimumPrice24hUsd12 =
      Math.floor(i / 3) % 2 === 0 ? '10000000000' : '900000000000';
    observations.push(item);
  }
  const result = deriveTokenCalibration(
    {
      version: 1,
      evidenceUrl: 'https://research.example/synthetic-cohort',
      observations,
    },
    now,
  );
  assert.equal(result.accepted, true, result.failures.join('; '));
  assert.equal(result.artifact.redRecall, 1);
  assert.equal(result.artifact.observations, 20004);
  assert.equal(result.artifact.liveSummary.observations, 96);
  assert.equal(result.artifact.liveSummary.redRecall, 1);
  assert.equal(result.artifact.derivation, 'buy-time-v1');
  assert.match(result.artifact.datasetHash, /^[a-f0-9]{64}$/);
  assert.equal(calibrationState(result.artifact, 100, now).status, 'valid');
  assert.ok(result.artifact.bands.every((b) => b.greenCrashRate === 0));
});
void test('live-only simulation/depth and live outcomes cannot improve historical acceptance', () => {
  const historic = observation(1);
  historic.minimumPrice24hUsd12 = '10000000000';
  historic.facts.checks[0].facts = [];
  historic.facts.checks[3].facts = [
    fact('roundtripSucceeded', 'Fork result', false),
  ];
  historic.facts.checks[8].facts = [
    fact('impact1000Percent', 'Depth impact', 99),
  ];
  const live = structuredClone(historic);
  live.id = 'separate-live-buy';
  live.cohort = 'live';
  live.buyAt = new Date(Date.parse(live.buyAt) + 1).toISOString();
  live.outcomeThrough = new Date(
    Date.parse(live.outcomeThrough) + 1,
  ).toISOString();
  const result = deriveTokenCalibration(
    {
      version: 1,
      evidenceUrl: 'https://research.example/separate-cohorts',
      observations: [historic, live],
    },
    now,
  );
  assert.equal(result.artifact.redRecall, 0);
  assert.equal(result.artifact.liveSummary.redRecall, 1);
  assert.equal(result.artifact.observations, 1);
  const band = result.artifact.bands.find((b) => b.band === '1h-24h');
  assert.equal(band.greenCrashRate, 1);
  assert.equal(band.greenObservations, 1);
  assert.equal(result.accepted, false);
});
void test('missing production dataset and asserted metrics cannot activate calibration', () => {
  assert.throws(() =>
    deriveTokenCalibration({ version: 1, observations: [] }, now),
  );
  const result = deriveTokenCalibration(
    {
      version: 1,
      evidenceUrl: 'https://research.example/small',
      observations: [observation(0)],
    },
    now,
  );
  assert.equal(result.accepted, false);
  assert.ok(result.failures.length >= 3);
  assert.equal(
    calibrationState({ ...result.artifact, derivation: undefined }, 100, now)
      .status,
    'failed',
  );
  assert.equal(
    evaluateTokenFacts(snapshot(now, 1), null, now).verdict,
    'withheld',
  );
});
void test('buy-time harness rejects future leakage, duplicate buys and incomplete outcomes', () => {
  const item = observation(0);
  const dataset = (observations) => ({
    version: 1,
    evidenceUrl: 'https://research.example/cohort',
    observations,
  });
  assert.throws(() =>
    deriveTokenCalibration(
      dataset([item, { ...item, id: 'different-id' }]),
      now,
    ),
  );
  const future = structuredClone(item);
  future.facts.checks[0].sources[0].observedAt = new Date(
    Date.parse(item.buyAt) + 1,
  ).toISOString();
  assert.throws(() => deriveTokenCalibration(dataset([future]), now));
  assert.throws(() =>
    deriveTokenCalibration(
      dataset([{ ...item, outcomeCoverageComplete: false }]),
      now,
    ),
  );
});
function probe() {
  return {
    version: 1,
    method: 'mainnet-fork',
    cluster: 'mainnet-beta',
    genesisHash: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
    mint,
    simulationOnly: true,
    broadcast: false,
    quoteMint: SOLANA_NETWORKS['mainnet-beta'].usdcMint,
    quoteDecimals: 6,
    observedAt: new Date().toISOString(),
    contextSlot: 123,
    inputQuoteRaw: '20000000',
    returnedQuoteRaw: '19000000',
    networkFeeQuoteUsd6: '10000',
    feeValuationSource: 'fork-quote-snapshot',
    probeId: 'a'.repeat(64),
    buy: { success: true, minimumOutputRaw: '1000', receivedRaw: '1100' },
    sell: { success: true, inputRaw: '1000', errorCode: null },
  };
}
void test('fork adapter submits explicit no-broadcast buy-minimum-output probe and computes cost', async () => {
  const check = await runForkProbe(mint, {
    endpoint: 'https://fork.example/v1/token-roundtrip',
    fetch: async (url, init) => {
      assert.equal(url, 'https://fork.example/v1/token-roundtrip');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      const body = JSON.parse(init.body);
      assert.equal(body.neverBroadcast, true);
      assert.equal(body.sellSizing, 'buy-minimum-output');
      assert.equal(body.notionalUsd6, '20000000');
      assert.equal('transaction' in body, false);
      return Response.json(probe());
    },
  });
  assert.equal(check.status, 'complete');
  assert.equal(
    check.facts.find((f) => f.key === 'roundtripCostPercent').value,
    5.05,
  );
});
void test('fork evidence rejects quotes, mismatched balances, chain and broadcast assertions', () => {
  for (const patch of [
    { method: 'swap-quote' },
    { broadcast: true },
    { genesisHash: 'wrong' },
    { mint: bs58.encode(new Uint8Array(32).fill(73)) },
    { inputQuoteRaw: '100' },
  ])
    assert.throws(() => parseForkProbe({ ...probe(), ...patch }, mint));
  const wrongSell = probe();
  wrongSell.sell.inputRaw = '1100';
  assert.throws(() => parseForkProbe(wrongSell, mint));
  assert.equal(
    forkProbeConfig({
      CONCLAVE_SECOND_LOOK_SIMULATION_ENABLED: 'true',
      CONCLAVE_SECOND_LOOK_FORK_URL: 'http://public.example/v1/token-roundtrip',
    }),
    null,
  );
});
void test('fork adapter abort cancels stalled body and returns a static error', async () => {
  let cancelled = false;
  const abort = new AbortController();
  const pending = runForkProbe(
    mint,
    {
      endpoint: 'https://fork.example/v1/token-roundtrip',
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    },
    abort.signal,
  );
  setTimeout(() => abort.abort(), 5);
  await assert.rejects(
    pending,
    (e) =>
      e.code === 'TOKEN_SIMULATION_UNAVAILABLE' && !e.message.includes('https'),
  );
  assert.equal(cancelled, true);
});
const marker = {
  endpoint: 'https://claims.example/v1/token-claims',
  requestId: '11111111-1111-4111-8111-111111111111',
  mint,
  startedAt: new Date(now - 1000).toISOString(),
  evidenceId: '22222222-2222-4222-8222-222222222222',
  maximumUsd6: '100000',
};
const envelope = (state) => ({
  version: 1,
  requestId: marker.requestId,
  mint,
  maximumUsd6: '100000',
  cluster: 'mainnet-beta',
  state,
});
void test('fresh producer uses one stable submission contract and read-only recovery', async () => {
  const calls = [];
  const config = {
    endpoint: marker.endpoint,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json(envelope('running'));
    },
  };
  await requestDeepProducer(marker, 'POST', config);
  await requestDeepProducer(marker, 'GET', config);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.idempotencyKey, marker.requestId);
  assert.equal(body.maximumUsd6, '100000');
  assert.equal(body.noAdditionalAccountCharge, true);
  assert.equal(calls[1].url, `${marker.endpoint}/${marker.requestId}`);
  assert.equal(calls[1].init.body, undefined);
  assert.deepEqual(
    await parseDeepProducerResult(envelope('unknown'), marker, null),
    { state: 'pending' },
  );
  assert.equal(
    deepProducerConfig({
      CONCLAVE_SECOND_LOOK_CLAIMS_ENABLED: 'true',
      CONCLAVE_SECOND_LOOK_CLAIMS_PRODUCER_URL: 'https://claims.example/other',
    }),
    null,
  );
});
async function completed() {
  const at = Date.now(),
    text = 'The token has a bounded supply.';
  const scope = {
    accountId: 'reviewed-producer',
    scopeId: mint,
    revision: '1',
  };
  const src = await createSourceSnapshot(
    {
      id: 's1',
      title: 'Public evidence',
      uri: 'https://evidence.example/token',
      text,
      scope,
      visibility: 'public',
      capturedAtMs: at,
    },
    at,
  );
  const reviewers = ['a', 'b', 'c'].map((id, i) => ({
    id,
    family: id,
    modelId: id,
    version: '1',
    distribution: i === 2 ? 'open-weight' : 'proprietary',
  }));
  const plan = await prepareCrossCheck({
    scope,
    claims: [{ id: 'c1', text }],
    sources: [src],
    reviewers,
    now: at,
  });
  return {
    ...envelope('completed'),
    definitive: true,
    chargedUsd6: '80000',
    completedAt: new Date(at).toISOString(),
    claimReview: {
      plan,
      submissions: reviewers.map((r) => ({
        claimId: 'c1',
        reviewerId: r.id,
        content: JSON.stringify({
          verdict: 'supported',
          rationale: 'The source supports the quoted wording.',
          quotes: [
            { sourceId: 's1', sourceHash: src.snapshotHash, quote: text },
          ],
        }),
      })),
      finishedAtMs: at,
    },
  };
}
const launchArtifact = {
  version: 1,
  mint,
  observedAt: marker.startedAt,
  expiresAt: new Date(now + 60000).toISOString(),
  reference: 'https://index.example/launch',
  ageSeconds: 100,
  checks: [],
  deep: {
    launch: {
      createSlot: 1,
      throughSlot: 100,
      coverageComplete: true,
      events: [],
    },
  },
};
void test('fresh producer output is independently re-evaluated and must bind fresh sources, mint and budget', async () => {
  const value = await completed();
  const result = await parseDeepProducerResult(value, marker, launchArtifact);
  assert.equal(result.state, 'completed');
  assert.equal(result.deep.claims[0].outcome, 'HOLDS');
  for (const patch of [
    { mint: 'different' },
    { chargedUsd6: '100001' },
    { definitive: false },
  ])
    await assert.rejects(
      parseDeepProducerResult({ ...value, ...patch }, marker, launchArtifact),
    );
  const old = structuredClone(value);
  old.claimReview.plan.sources[0].capturedAtMs =
    Date.parse(marker.startedAt) - 1;
  await assert.rejects(parseDeepProducerResult(old, marker, launchArtifact));
  const missing = structuredClone(value);
  missing.claimReview.submissions[0].content = JSON.stringify({
    verdict: 'insufficient_evidence',
    rationale: 'No support.',
    quotes: [],
  });
  assert.equal(
    (await parseDeepProducerResult(missing, marker, launchArtifact)).deep
      .claims[0].outcome,
    'NO_CONSENSUS',
  );
});
void test('a producer rejection releases only with definitive zero-charge evidence', async () => {
  assert.deepEqual(
    await parseDeepProducerResult(
      { ...envelope('rejected'), definitive: true, chargedUsd6: '0' },
      marker,
      null,
    ),
    { state: 'rejected' },
  );
  await assert.rejects(
    parseDeepProducerResult(
      { ...envelope('rejected'), definitive: true, chargedUsd6: '1' },
      marker,
      null,
    ),
  );
});
