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
test('every Second Look tool remains held in the source and release manifest', () => {
  assert.equal(FEATURE_SWITCHES.secondLook, false);
  assert.deepEqual(checkSecondLookReleaseFiles().approved, []);
  for (const key of Object.keys(paths))
    assert.equal(secondLookToolOn(key), false);
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
  const source = readFileSync(
    new URL('../lib/second-look/releases.ts', import.meta.url),
    'utf8',
  );
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
  for (const path of Object.values(paths))
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

test('held notifications and Telegram workers do no database or network work', async () => {
  const { sendSecondLookPush, runSecondLookPushOnce } =
    await import('../server/second-look/push-worker.ts');
  const { processNextTelegramUpdate, deliverNextTelegramMessage } =
    await import('../server/second-look/telegram.ts');
  const { createTelegramServices } =
    await import('../server/second-look/telegram-services.ts');
  const pool = new Proxy(
    {},
    {
      get() {
        throw Error('Unexpected database access');
      },
    },
  );
  const noNetwork = async () => {
    throw Error('Unexpected network access');
  };
  assert.deepEqual(await runSecondLookPushOnce(pool), {
    state: 'held',
    inserted: 0,
  });
  assert.deepEqual(await sendSecondLookPush(null, '', {}, noNetwork), {
    kind: 'rejected',
  });
  const held = (e) => e.code === 'FEATURE_UNAVAILABLE';
  await assert.rejects(processNextTelegramUpdate(pool, {}, {}, {}), held);
  await assert.rejects(
    deliverNextTelegramMessage(pool, {}, {}, noNetwork),
    held,
  );
  await assert.rejects(createTelegramServices().token('fixture', {}), held);
  await assert.rejects(createTelegramServices().firewall('fixture'), held);
});
