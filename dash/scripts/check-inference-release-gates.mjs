import assert from 'node:assert/strict';
import test from 'node:test';
import { FEATURE_SWITCHES } from '../components/dashboard/feature-switches.ts';
import { BASE_CHAT_MODELS, MORE_CHAT_MODELS } from '../lib/model-release.ts';
import {
  endpointFeature,
  assertEndpointReleased,
  releasedChatRoute,
} from '../server/core/feature-release.ts';
import { dispatch } from '../server/routes/dispatch.ts';
import { assertUsableRoute } from '../server/routes/call-contract.ts';
import { modelForFamily } from '../server/ppq/catalog.ts';
import { serviceConfig } from '../server/core/config.ts';
import { assertSameOrigin } from '../server/core/http.ts';
import {
  mediaCapability,
  mediaStorageConfigured,
} from '../server/media/contract.ts';
import { depositCapability } from '../server/solana/deposit-config.ts';
import {
  generateSessionToken,
  hashToken,
  serializeSessionCookie,
  SESSION_COOKIE_NAME,
} from '../server/auth/index.ts';
import { getSession } from '../server/routes/session.ts';
import { signInTestCreditUsd6 } from '../server/ledger/test-credits.ts';

const origin = 'https://conclave.example';
const id = '00000000-0000-4000-8000-000000000001';
const fixtureEnv = {
  NODE_ENV: 'production',
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: origin,
  CONCLAVE_DATABASE_URL:
    'postgresql://fixture@database.example.invalid/fixture?sslmode=verify-full',
  PPQ_API_KEY: 'offline-fixture-only',
  CONCLAVE_INFERENCE_ENABLED: 'true',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    fixture: Buffer.alloc(32, 7).toString('base64'),
  }),
  CONCLAVE_ACTIVE_DATA_KEY: 'fixture',
  CONCLAVE_MEDIA_ENABLED: 'true',
  CONCLAVE_PASSKEYS_ENABLED: 'true',
  CONCLAVE_SOLANA_CLUSTER: 'mainnet-beta',
  CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example.invalid/',
  CONCLAVE_TREASURY_WALLET: '11111111111111111111111111111111',
  CONCLAVE_TREASURY_TOKEN_ACCOUNT:
    'So11111111111111111111111111111111111111112',
  CONCLAVE_MAX_DEPOSIT_USD6: '10000000',
  CONCLAVE_DEPOSITS_ENABLED: 'true',
  CONCLAVE_DEPOSIT_RECOVERY_ENABLED: 'true',
  CONCLAVE_DEPOSIT_PAYMENTS_ENABLED: 'true',
};

// This dedicated test process uses synthetic values only. No .env file is read,
// no original environment value is copied, and no provider or DB request runs.
function configure(values = {}) {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CONCLAVE_') || name === 'PPQ_API_KEY')
      delete process.env[name];
  }
  Object.assign(process.env, fixtureEnv, values);
}
globalThis.fetch = async () => {
  throw new Error('Network access is forbidden in release-gate tests.');
};

const held = {
  secondLook: [
    'second-look',
    'second-look/capabilities',
    'second-look/tokens/check',
    'second-look/telegram/webhook',
  ],
  studio: [
    'media/capabilities',
    'media/routes',
    'media/quotes',
    'media/jobs',
    `media/jobs/${id}/recover`,
    `media/assets/${id}/content`,
  ],
  crosscheck: [
    'crosscheck',
    'crosscheck/rosters',
    'crosscheck/sources',
    `crosscheck/${id}`,
  ],
  receipts: ['receipts', `receipts/${id}`, `receipts/${id}/proof`],
  routes: ['auto-route-quotes'],
  purse: [
    'ledger',
    'deposits',
    'deposits/capabilities',
    `deposits/${id}/reconcile`,
    `deposits/${id}/payment`,
  ],
  tokenFunding: [
    'token/deposits',
    'token/deposits/capabilities',
    'token/burn-reserve',
    'token/burns',
  ],
  synthesis: [
    'briefs/synthesis/capabilities',
    `briefs/${id}/synthesis/quote`,
    `briefs/${id}/syntheses`,
    `briefs/${id}/synthesis/selection`,
    `brief-syntheses/${id}/approve`,
    `brief-syntheses/${id}/evaluate`,
  ],
  explainer: ['pre-sign-inspections', 'program-inspections', 'explanations'],
  chapters: ['chapters', `chapters/${id}`],
  agents: ['agents', `agents/${id}`],
  connections: ['connections', `connections/${id}`],
};

for (const [feature, paths] of Object.entries(held)) {
  test(`held ${feature} is blocked before config/auth/DB for every HTTP method`, async (t) => {
    if (feature !== 'tokenFunding') {
      const released = FEATURE_SWITCHES[feature];
      t.after(() => {
        FEATURE_SWITCHES[feature] = released;
      });
      FEATURE_SWITCHES[feature] = false;
    }
    // An invalid origin would fail before opening the DB if a gate regressed.
    configure({ CONCLAVE_APP_ORIGIN: 'not-an-origin' });
    for (const path of paths) {
      assert.equal(endpointFeature(path), feature, path);
      for (const method of [
        'GET',
        'HEAD',
        'POST',
        'PATCH',
        'DELETE',
        'OPTIONS',
      ]) {
        const response = await dispatch(
          new Request(`${origin}/api/${path}/?ignored=1`, { method }),
        );
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(
          (await response.json()).error.code,
          'FEATURE_UNAVAILABLE',
          `${method} ${path}`,
        );
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    }
  });
}

test('core chat and approved product routes retain service/auth enforcement', async () => {
  configure({ CONCLAVE_MODE: 'preview' });
  for (const [path, method] of [
    ['auth/challenge', 'POST'],
    ['auth/session', 'GET'],
    ['auth/logout', 'POST'],
    ['auth/passkeys/login/options', 'POST'],
    ['auth/security', 'GET'],
    ['routes', 'GET'],
    ['balance', 'GET'],
    ['projects', 'GET'],
    ['briefs', 'GET'],
    ['briefs/from-calls', 'POST'],
    [`briefs/${id}/document`, 'PATCH'],
    ['quotes', 'POST'],
    ['calls', 'POST'],
    [`calls/${id}/events`, 'GET'],
    ['comparison-quotes', 'POST'],
    ['comparisons', 'POST'],
    [`comparisons/${id}/vote`, 'POST'],
  ]) {
    assert.equal(endpointFeature(path), null, path);
    const response = await dispatch(
      new Request(`${origin}/api/${path}`, { method }),
    );
    assert.equal(response.status, 503, path);
    assert.equal(
      (await response.json()).error.code,
      'SERVICE_UNAVAILABLE',
      path,
    );
  }
});

test('configured service capabilities cannot activate held Studio or Purse', async (t) => {
  const purse = FEATURE_SWITCHES.purse;
  t.after(() => {
    FEATURE_SWITCHES.purse = purse;
  });
  FEATURE_SWITCHES.purse = false;
  configure();
  // Prove the synthetic underlying services would otherwise advertise ready.
  assert.equal(
    mediaCapability(fixtureEnv, mediaStorageConfigured(fixtureEnv)).configured,
    true,
  );
  assert.equal(depositCapability(fixtureEnv).configured, true);
  const response = await dispatch(new Request(`${origin}/api/capabilities`));
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.equal(capabilities.mode, 'service');
  assert.equal(capabilities.walletSignIn.configured, true);
  assert.equal(capabilities.passkeys.configured, true);
  assert.equal(capabilities.chat.configured, true);
  assert.equal(capabilities.projects.configured, true);
  for (const name of [
    'studio',
    'deposits',
    'receipts',
    'chapters',
    'sealedRoutes',
  ]) {
    assert.equal(capabilities[name].configured, false, name);
  }
  assert.equal(capabilities.studio.storageReady, false);
  assert.equal(capabilities.studio.deliveryReady, false);
  assert.equal(capabilities.deposits.recoveryConfigured, false);
  assert.equal(capabilities.deposits.walletSubmission, false);
  assert.equal(capabilities.deposits.recipientWallet, null);
  assert.equal(capabilities.deposits.recipientTokenAccount, null);
});

test('releasing one feature cannot release its neighbors', (t) => {
  const baseline = { ...FEATURE_SWITCHES };
  t.after(() => Object.assign(FEATURE_SWITCHES, baseline));
  for (const feature of Object.keys(held)) {
    if (feature !== 'tokenFunding') FEATURE_SWITCHES[feature] = false;
  }
  for (const feature of Object.keys(held)) {
    if (feature === 'tokenFunding') continue;
    try {
      FEATURE_SWITCHES[feature] = true;
      for (const path of held[feature])
        assert.doesNotThrow(() => assertEndpointReleased(path));
      for (const [other, paths] of Object.entries(held)) {
        if (other === feature) continue;
        for (const path of paths)
          assert.throws(() => assertEndpointReleased(path), {
            code: 'FEATURE_UNAVAILABLE',
          });
      }
    } finally {
      FEATURE_SWITCHES[feature] = false;
    }
  }
  assert.equal(endpointFeature('receipts-not-a-route'), null);
  assert.equal(endpointFeature('briefs/from-calls'), null);
});

test('Purse release permits USDC funding without releasing token payments or burns', async (t) => {
  const purse = FEATURE_SWITCHES.purse;
  t.after(() => {
    FEATURE_SWITCHES.purse = purse;
  });
  FEATURE_SWITCHES.purse = true;
  configure();
  for (const path of held.purse)
    assert.doesNotThrow(() => assertEndpointReleased(path));
  const capabilities = await (
    await dispatch(new Request(`${origin}/api/capabilities`))
  ).json();
  assert.equal(capabilities.deposits.configured, true);
  assert.equal(capabilities.deposits.walletSubmission, true);
  assert.equal(capabilities.studio.configured, false);
  for (const path of held.tokenFunding) {
    const response = await dispatch(
      new Request(`${origin}/api/${path}`, { method: 'POST' }),
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'FEATURE_UNAVAILABLE');
  }
});

const route = (family, modelId = modelForFamily(family)) => ({
  family,
  model_id: modelId,
  enabled: true,
  fresh: true,
  modality: 'chat',
  card: {
    reviewed: true,
    retentionDisclosure: 'Fixture reviewed terms.',
    evidenceUrl: 'https://example.com/terms',
    evidenceDate: '2026-10-14',
  },
});

test('all seven released model families are bound to their exact reviewed model IDs', () => {
  assert.equal(FEATURE_SWITCHES.moreModels, true);
  for (const family of [...BASE_CHAT_MODELS, ...MORE_CHAT_MODELS]) {
    assert.equal(releasedChatRoute(route(family)), true);
    assert.doesNotThrow(() => assertUsableRoute(route(family)));
    for (const other of [
      ...BASE_CHAT_MODELS,
      ...MORE_CHAT_MODELS,
      'image',
      'runway',
    ]) {
      if (other === family) continue;
      const mismatch = route(family, modelForFamily(other));
      assert.equal(releasedChatRoute(mismatch), false);
      assert.throws(() => assertUsableRoute(mismatch), {
        code: 'ROUTE_UNAVAILABLE',
      });
    }
    for (const change of [
      { enabled: false },
      { fresh: false },
      { modality: 'video' },
    ]) {
      assert.throws(() => assertUsableRoute({ ...route(family), ...change }), {
        code: 'ROUTE_UNAVAILABLE',
      });
    }
  }
  for (const family of ['unknown', 'image', 'runway']) {
    assert.equal(releasedChatRoute(route(family)), false);
    assert.throws(() => assertUsableRoute(route(family)), {
      code: 'ROUTE_UNAVAILABLE',
    });
  }
});

test('closing More models restores the four-family gate without widening model binding', () => {
  const released = FEATURE_SWITCHES.moreModels;
  try {
    FEATURE_SWITCHES.moreModels = false;
    for (const family of BASE_CHAT_MODELS) {
      assert.equal(releasedChatRoute(route(family)), true);
      assert.doesNotThrow(() => assertUsableRoute(route(family)));
    }
    for (const family of MORE_CHAT_MODELS) {
      assert.equal(releasedChatRoute(route(family)), false);
      assert.throws(() => assertUsableRoute(route(family)), {
        code: 'ROUTE_UNAVAILABLE',
      });
    }
    assert.throws(
      () => assertUsableRoute(route('claude', modelForFamily('qwen'))),
      { code: 'ROUTE_UNAVAILABLE' },
    );
    FEATURE_SWITCHES.moreModels = true;
    for (const family of MORE_CHAT_MODELS) {
      assert.equal(releasedChatRoute(route(family)), true);
      assert.doesNotThrow(() => assertUsableRoute(route(family)));
    }
  } finally {
    FEATURE_SWITCHES.moreModels = released;
  }
});

test('production origin remains exact and HTTPS-only', () => {
  assert.equal(serviceConfig(fixtureEnv).origin, origin);
  for (const invalid of [
    'http://conclave.example',
    `${origin}/dashboard`,
    `${origin}/?x=1`,
    `${origin}/#x`,
  ]) {
    assert.throws(
      () => serviceConfig({ ...fixtureEnv, CONCLAVE_APP_ORIGIN: invalid }),
      {
        code: 'CONFIGURATION_REQUIRED',
      },
    );
  }
  const request = (url, sentOrigin, site = 'same-origin') =>
    new Request(url, {
      method: 'POST',
      headers: { origin: sentOrigin, 'sec-fetch-site': site },
    });
  assert.doesNotThrow(() =>
    assertSameOrigin(request(`${origin}/api/quotes`, origin), origin),
  );
  for (const bad of [
    request(`${origin}/api/quotes`, 'https://other.example'),
    request('https://other.example/api/quotes', origin),
    request(`${origin}/api/quotes`, origin, 'cross-site'),
  ]) {
    assert.throws(() => assertSameOrigin(bad, origin), {
      code: 'ORIGIN_REJECTED',
    });
  }
});

test('secure sessions bind reads to the authenticated account', async () => {
  const token = generateSessionToken();
  const cookie = serializeSessionCookie(token);
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax'])
    assert.ok(cookie.includes(attribute));
  assert.ok(!cookie.includes('Domain='));
  const pool = {
    query: async (_sql, args) => {
      assert.deepEqual(args, [await hashToken(token)]);
      return { rows: [{ account_id: id }] };
    },
  };
  const headers = {
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    'x-conclave-account-id': id,
  };
  assert.equal(
    (await getSession(pool, new Request(`${origin}/api/balance`, { headers })))
      .accountId,
    id,
  );
  await assert.rejects(
    getSession(
      pool,
      new Request(`${origin}/api/balance`, {
        headers: { ...headers, 'x-conclave-account-id': crypto.randomUUID() },
      }),
    ),
    { code: 'ACCOUNT_CHANGED' },
  );
  await assert.rejects(getSession(pool, new Request(`${origin}/api/balance`)), {
    code: 'SIGN_IN_REQUIRED',
  });
  await assert.rejects(
    getSession(
      { query: async () => ({ rows: [] }) },
      new Request(`${origin}/api/balance`, { headers }),
    ),
    { code: 'SIGN_IN_REQUIRED' },
  );
});

test('production sign-in does not grant internal testing funds', () => {
  assert.equal(
    signInTestCreditUsd6(origin, {
      ...fixtureEnv,
      CONCLAVE_INTERNAL_TESTING: 'true',
      CONCLAVE_INTERNAL_TEST_CREDIT_USD: '5',
    }),
    null,
  );
});
