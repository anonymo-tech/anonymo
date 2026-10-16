import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEATURE_SWITCHES } from '../components/dashboard/feature-switches.ts';
import {
  SECOND_LOOK_SWITCHES,
  secondLookPathOn,
  secondLookToolOn,
} from '../lib/second-look/releases.ts';
import {
  checkSecondLookRelease,
  checkSecondLookReleaseFiles,
} from './check-second-look-release.mjs';
import { dispatch } from '../server/routes/dispatch.ts';
const paths = {
  fomo: 'fomo/analyze',
  token: 'tokens/check',
  wallet: 'wallets',
  signature: 'signature/inspect',
  follow: 'follow/traders',
  plan: 'planning',
  movement: 'why-moved',
  tax: 'tax/fixture/export',
  inbox: 'alerts',
  steady: 'steady/purchase',
  guarded: 'guarded/buy',
  rooms: 'rooms/calls',
  networks: 'networks/robinhood/receipt',
  telegram: 'telegram/link',
  mcp: 'mcp',
  stockToken: 'stock-tokens/check',
  perp: 'perp/check',
  perpPlan: 'perp-plan/check',
};
// Released Second Look tools, in approval order. Every other tool must stay held.
const released = ['fomo', 'stockToken', 'perp'];
test('only explicitly released Second Look tools are on; every other tool remains held', () => {
  assert.equal(FEATURE_SWITCHES.secondLook, true);
  assert.deepEqual(checkSecondLookReleaseFiles().approved, released);
  for (const key of Object.keys(paths))
    assert.equal(secondLookToolOn(key), released.includes(key));
});
test('one tool switch cannot expose another tool or shared purchase route', () => {
  const saved = { ...SECOND_LOOK_SWITCHES },
    outer = FEATURE_SWITCHES.secondLook;
  try {
    FEATURE_SWITCHES.secondLook = true;
    for (const enabled of Object.keys(paths)) {
      for (const key of Object.keys(paths))
        SECOND_LOOK_SWITCHES[key] = key === enabled;
      for (const [key, path] of Object.entries(paths))
        assert.equal(
          secondLookPathOn('second-look/' + path, 'POST'),
          key === enabled,
          enabled + ' must isolate ' + key,
        );
    }
    SECOND_LOOK_SWITCHES.steady = false;
    SECOND_LOOK_SWITCHES.tax = true;
    assert.equal(secondLookPathOn('second-look/steady', 'GET'), true);
    assert.equal(
      secondLookPathOn('second-look/steady/purchase', 'POST'),
      false,
    );
    assert.equal(secondLookPathOn('second-look/unknown', 'GET'), false);
  } finally {
    Object.assign(SECOND_LOOK_SWITCHES, saved);
    FEATURE_SWITCHES.secondLook = outer;
  }
});
test('build rejects unapproved switches umbrella-only release and missing dependencies', () => {
  // Start from a source with every released tool turned off, so each case below controls approvals alone.
  let source = readFileSync(
    new URL('../lib/second-look/releases.ts', import.meta.url),
    'utf8',
  );
  for (const tool of released)
    source = source.replace(`  ${tool}: true,`, `  ${tool}: false,`);
  assert.throws(() =>
    checkSecondLookRelease(
      source.replace('token: false', 'token: true'),
      { schemaVersion: 1, approved: [] },
      { approved: [] },
    ),
  );
  assert.throws(() =>
    checkSecondLookRelease(
      source,
      { schemaVersion: 1, approved: [] },
      { approved: ['secondLook'] },
    ),
  );
  assert.throws(() =>
    checkSecondLookRelease(
      source.replace('plan: false', 'plan: true'),
      { schemaVersion: 1, approved: ['plan'] },
      { approved: ['secondLook'] },
    ),
  );
  assert.deepEqual(
    checkSecondLookRelease(
      source.replace('token: false', 'token: true'),
      { schemaVersion: 1, approved: ['token'] },
      { approved: ['secondLook'] },
    ).approved,
    ['token'],
  );
});
test('actual dispatcher blocks held tool endpoints before configuration or database access', async () => {
  for (const [tool,path] of Object.entries(paths).filter(([key]) => !released.includes(key)))
    for (const method of ['GET', 'POST']) {
      const r = await dispatch(
        new Request('https://conclave.example/api/second-look/' + path, {
          method,
        }),
      );
      assert.equal(r.status, 404);
      assert.equal((await r.json()).error.code, 'FEATURE_UNAVAILABLE');
    }
});

