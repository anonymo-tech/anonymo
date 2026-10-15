import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveCoolHeadPopulation,
  loadCoolHeadPopulation,
} from '../server/second-look/cool-head-population.ts';
import { evaluateCoolHead } from '../server/second-look/cool-head.ts';
import { defaultCoolHeadRules } from '../lib/second-look/cool-head.ts';

const DAY = 86400000;
const asOf = '2026-10-12T12:00:00.000Z';
const settings = { enabled: true, timezone: 'UTC', dailyBudgetUsd6: null };
const mint = 'So11111111111111111111111111111111111111112';
const digest = (v) => createHash('sha256').update(v).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
function artifact(count = 12) {
  const through = '2026-10-12T11:00:00.000Z';
  return {
    version: 1,
    sourceId: 'synthetic-unit-fixture',
    evidenceUrl: 'https://example.com/calibration-source',
    evidenceSha256: digest('source'),
    through,
    reviewedAt: '2026-10-12T11:15:00.000Z',
    timezone: 'UTC',
    rules: { ...defaultCoolHeadRules },
    subjects: Array.from({ length: count }, (_, i) => {
      const at = Date.parse('2026-10-10T12:00:00.000Z') + i * 1000;
      return {
        id: digest(`subject-${i}`),
        coverageFrom: iso(Date.parse(through) - 90 * DAY),
        coverageThrough: through,
        evidenceSha256: digest(`coverage-${i}`),
        buys: [
          {
            id: digest(`buy-${i}`),
            mint,
            at: iso(at),
            amountAtoms: '1000',
            grossUsd6: '100000000',
            price: {
              usd: '3',
              at: iso(at),
              evidenceSha256: digest(`price-${i}`),
            },
            hourAgoPrice: {
              usd: '1',
              at: iso(at - 3600000),
              evidenceSha256: digest(`old-price-${i}`),
            },
            evidenceSha256: digest(`buy-evidence-${i}`),
          },
        ],
        closes: [
          {
            id: digest(`close-${i}`),
            buyId: digest(`buy-${i}`),
            at: iso(at + 3600000),
            amountAtoms: '1000',
            proceedsUsd6: i < 8 ? '99000000' : '101000000',
            feesUsd6: '1000000',
            evidenceSha256: digest(`close-evidence-${i}`),
          },
        ],
      };
    }),
  };
}
const derive = (a = artifact(), s = settings, at = asOf) =>
  deriveCoolHeadPopulation(a, s, at);
const chase = (result) => result.rates.find((r) => r.signal === 'chase');
test('derives recent resolved sample and losses from proceeds, costs and fees', () => {
  const result = derive();
  assert.equal(result.status, 'ready');
  assert.deepEqual(chase(result), {
    signal: 'chase',
    sample: 12,
    losses: 8,
    through: '2026-10-12T11:00:00.000Z',
    availableAt: '2026-10-12T11:15:00.000Z',
    sourceId: 'synthetic-unit-fixture',
    verified: true,
  });
  const feeLoss = artifact();
  feeLoss.subjects[11].closes[0].feesUsd6 = '1000001';
  assert.equal(chase(derive(feeLoss)).losses, 9);
  assert(!result.rates.some((r) => r.signal === 'budget'));
});
test('rejects asserted totals, labels, unknown fields and missing evidence', () => {
  assert.equal(derive({ ...artifact(), losses: 12 }).status, 'invalid');
  const a = artifact();
  a.subjects[0].buys[0].signal = 'chase';
  assert.equal(derive(a).status, 'invalid');
  const b = artifact();
  b.subjects[0].closes[0].evidenceSha256 = '';
  assert.equal(derive(b).status, 'invalid');
  assert.equal(
    derive({ ...artifact(), evidenceUrl: 'https://example.com/?token=secret' })
      .status,
    'invalid',
  );
});
test('full custom rules and timezone must match; signals are recalculated', () => {
  const changed = { ...defaultCoolHeadRules, chaseMultiple: 4 };
  assert.equal(
    derive(artifact(), { ...settings, rules: changed }).status,
    'rules_mismatch',
  );
  const a = artifact();
  a.rules = changed;
  assert.equal(
    derive(a, { ...settings, rules: changed }).status,
    'insufficient_samples',
  );
  for (const s of a.subjects) s.buys[0].price.usd = '4';
  assert.equal(chase(derive(a, { ...settings, rules: changed })).sample, 12);
  assert.equal(
    derive(artifact(), { ...settings, timezone: 'America/New_York' }).status,
    'rules_mismatch',
  );
  assert.equal(
    derive(artifact(), {
      ...settings,
      rules: { ...defaultCoolHeadRules, losingStreak: 6 },
    }).status,
    'rules_mismatch',
  );
});
test('minimum 10 unique closed observations; open or old buys never inflate sample', () => {
  assert.equal(derive(artifact(9)).status, 'insufficient_samples');
  const open = artifact();
  for (const s of open.subjects.slice(0, 3)) s.closes = [];
  assert.equal(derive(open).status, 'insufficient_samples');
  const old = artifact();
  for (const s of old.subjects) {
    const at = Date.parse(asOf) - 8 * DAY - 1;
    s.buys[0].at = iso(at);
    s.buys[0].price.at = iso(at);
    s.buys[0].hourAgoPrice.at = iso(at - 3600000);
  }
  assert.equal(derive(old).status, 'insufficient_samples');
});
test('rejects duplicate identities and renamed copies of the same source evidence', () => {
  const id = artifact();
  id.subjects[1].buys[0].id = id.subjects[0].buys[0].id;
  assert.equal(derive(id).status, 'invalid');
  const evidence = artifact();
  evidence.subjects[1].buys[0].evidenceSha256 =
    evidence.subjects[0].buys[0].evidenceSha256;
  assert.equal(derive(evidence).status, 'invalid');
  const close = artifact();
  close.subjects[0].closes.push({
    ...close.subjects[0].closes[0],
    id: digest('other-close'),
    evidenceSha256: digest('other-close-evidence'),
  });
  assert.equal(derive(close).status, 'invalid');
});
test('stale, future, unreviewed and forward-looking price data fail closed', () => {
  assert.equal(
    derive(artifact(), settings, '2026-10-21T12:00:00.000Z').status,
    'stale',
  );
  assert.equal(
    derive({ ...artifact(), through: '2026-10-13T12:00:00.000Z' }).status,
    'invalid',
  );
  assert.equal(
    derive({ ...artifact(), reviewedAt: '2026-10-13T12:00:00.000Z' }).status,
    'invalid',
  );
  assert.equal(
    derive({ ...artifact(), reviewedAt: '2026-10-11T12:00:00.000Z' }).status,
    'invalid',
  );
  const quote = artifact();
  quote.subjects[0].buys[0].hourAgoPrice.at = '2026-10-10T11:00:00.001Z';
  assert.equal(derive(quote).status, 'invalid');
  const close = artifact();
  close.subjects[0].closes[0].at = '2026-10-12T11:00:00.001Z';
  assert.equal(derive(close).status, 'invalid');
});
test('full quantity, bounded values and complete source windows are required', () => {
  const partial = artifact();
  partial.subjects[0].closes[0].amountAtoms = '999';
  assert.equal(derive(partial).status, 'invalid');
  const huge = artifact();
  huge.subjects[0].buys[0].grossUsd6 = '1'.repeat(5000);
  assert.equal(derive(huge).status, 'invalid');
  const coverage = artifact();
  coverage.subjects[0].coverageFrom = '2026-10-01T00:00:00.000Z';
  assert.equal(derive(coverage).status, 'invalid');
  assert.equal(derive(artifact(101)).status, 'invalid');
});
test('future review/cutoff cannot be attached retroactively to a past nudge', () => {
  const population = derive().rates;
  function run(at, rates = population) {
    return evaluateCoolHead({
      settings,
      asOf,
      coverage: false,
      closes: [],
      population: rates,
      buys: [
        {
          id: 'current-buy',
          walletId: 'wallet',
          mint,
          at,
          grossUsd6: '1',
          priceUsd: '3',
          hourAgoPriceUsd: '1',
          outcome: null,
        },
      ],
    }).nudges.find((n) => n.signal === 'chase').baseRate;
  }
  assert.equal(run('2026-10-12T11:10:00.000Z'), null);
  assert.equal(
    run(
      '2026-10-12T10:59:59.000Z',
      population.map((r) => ({ ...r, availableAt: r.through })),
    ),
    null,
  );
  assert.equal(run('2026-10-12T11:15:00.000Z').sample, 12);
});
test('shared signal classifier does not use a later closing loss for revenge', () => {
  const a = artifact();
  for (const s of a.subjects) {
    s.buys[0].price = null;
    s.buys[0].hourAgoPrice = null;
  }
  assert.equal(derive(a).status, 'insufficient_samples');
});
test('loader requires a matching approved hash and refuses unsafe files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conclave-population-test-'));
  try {
    const path = join(dir, 'reviewed.json'),
      data = JSON.stringify(artifact());
    await writeFile(path, data, { mode: 0o600 });
    const env = {
      CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_FILE: path,
      CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_SHA256: digest(data),
    };
    assert.equal(
      (await loadCoolHeadPopulation(settings, asOf, {})).status,
      'not_configured',
    );
    assert.equal(
      (await loadCoolHeadPopulation(settings, asOf, env)).status,
      'ready',
    );
    assert.equal(
      (
        await loadCoolHeadPopulation(settings, asOf, {
          ...env,
          CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_SHA256:
            digest('unreviewed'),
        })
      ).status,
      'invalid',
    );
    const link = join(dir, 'symlink.json');
    await symlink(path, link);
    assert.equal(
      (
        await loadCoolHeadPopulation(settings, asOf, {
          ...env,
          CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_FILE: link,
        })
      ).status,
      'invalid',
    );
    await chmod(path, 0o666);
    assert.equal(
      (await loadCoolHeadPopulation(settings, asOf, env)).status,
      'invalid',
    );
    await chmod(path, 0o600);
    await writeFile(path, ' '.repeat(4 * 1024 * 1024 + 1));
    assert.equal(
      (await loadCoolHeadPopulation(settings, asOf, env)).status,
      'invalid',
    );
    assert.equal(
      (
        await loadCoolHeadPopulation(settings, asOf, {
          ...env,
          CONCLAVE_SECOND_LOOK_COOL_HEAD_POPULATION_FILE: dir,
        })
      ).status,
      'invalid',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
