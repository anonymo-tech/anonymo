import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID, randomBytes, createECDH, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import webpush from 'web-push';
import { migrate } from './migrate.mjs';
import { createDatabase, transaction } from '../server/db/database.ts';
import {
  pushConfig,
  pushCapability,
  validatePushSubscription,
} from '../server/second-look/push-config.ts';
import {
  subscribePush,
  getPushStatus,
  unsubscribePush,
} from '../server/second-look/push-store.ts';
import {
  runSecondLookPushOnce,
  sendSecondLookPush,
  PUSH_INBOX_URL,
} from '../server/second-look/push-worker.ts';
import { insertSecondLookAlert } from '../server/second-look/alerts-store.ts';
import {
  pushStatusResponse,
  subscribePushResponse,
} from '../lib/client/push-contracts.ts';
import { pushRoutes } from '../server/second-look/push-routes.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection) throw Error('Isolated test database required.');
const endpoint = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
  !endpoint.pathname.endsWith('_test')
)
  throw Error('Only loopback test databases are permitted.');
for (const key of Object.keys(process.env))
  if (key.startsWith('CONCLAVE_')) delete process.env[key];
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  CONCLAVE_ACTIVE_DATA_KEY: 'push-test',
  CONCLAVE_DATA_KEYS: JSON.stringify({
    'push-test': randomBytes(32).toString('base64'),
  }),
  CONCLAVE_SECOND_LOOK_PUSH_ENABLED: 'true',
  CONCLAVE_PUSH_VAPID_SUBJECT: 'https://example.org/',
  CONCLAVE_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
  CONCLAVE_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
});
const pool = createDatabase(connection, 8),
  config = pushConfig(),
  owners = [];
before(async () => {
  await migrate(pool);
});
after(async () => {
  await pool.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [owners]);
  await pool.end();
});
async function owner() {
  const id = randomUUID();
  owners.push(id);
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  return id;
}
function sub(token = randomUUID()) {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/' + token,
    expirationTime: null,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
async function alert(accountId) {
  return transaction(pool, (c) =>
    insertSecondLookAlert(c, accountId, {
      kind: 'cool_head',
      dedupeKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      title: 'Private reminder',
      message: 'A private observation',
      evidence: { private: true },
    }),
  );
}
async function isolate() {
  await pool.query(
    "UPDATE second_look_push_outbox SET state='expired' WHERE state IN('queued','sending')",
  );
}

test('configuration exposes only public VAPID material and requires matching keys', () => {
  assert.equal(pushCapability(config).configured, true);
  assert.ok(!JSON.stringify(pushCapability(config)).includes(vapid.privateKey));
  assert.equal(pushCapability(pushConfig({})).reason, 'PUSH_DISABLED');
  assert.equal(
    pushCapability(pushConfig({ CONCLAVE_SECOND_LOOK_PUSH_ENABLED: 'true' }))
      .reason,
    'PUSH_KEYS_REQUIRED',
  );
  assert.equal(
    pushCapability(
      pushConfig({
        ...process.env,
        CONCLAVE_PUSH_VAPID_PUBLIC_KEY: webpush.generateVAPIDKeys().publicKey,
      }),
    ).configured,
    false,
  );
});
test('subscriptions reject private endpoints, redirects, malformed keys and expired data', () => {
  const valid = sub();
  assert.deepEqual(validatePushSubscription(valid), valid);
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://127.0.0.1/x',
    'https://fcm.googleapis.com.evil.test/fcm/send/x',
    'https://fcm.googleapis.com/fcm/send/x?target=1',
    'https://user@fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/not-push/x',
  ])
    assert.throws(() => validatePushSubscription({ ...valid, endpoint }));
  assert.throws(() =>
    validatePushSubscription({
      ...valid,
      keys: { ...valid.keys, p256dh: 'x' },
    }),
  );
  assert.throws(() =>
    validatePushSubscription({ ...valid, expirationTime: 1 }),
  );
});
test('subscription storage is encrypted, scoped, idempotent and limited under concurrency', async () => {
  const a = await owner(),
    b = await owner(),
    input = sub();
  const saved = await subscribePush(pool, a, input, config);
  assert.ok(subscribePushResponse(saved));
  assert.deepEqual(await subscribePush(pool, a, input, config), saved);
  await assert.rejects(
    subscribePush(pool, b, input, config),
    (e) => e.code === 'PUSH_SUBSCRIPTION_EXISTS',
  );
  const raw = await pool.query(
    'SELECT payload_ciphertext FROM second_look_push_subscriptions WHERE id=$1',
    [saved.id],
  );
  assert.ok(!raw.rows[0].payload_ciphertext.includes(input.endpoint));
  assert.ok(!raw.rows[0].payload_ciphertext.includes(input.keys.auth));
  const replies = await Promise.allSettled(
    Array.from({ length: 8 }, () => subscribePush(pool, a, sub(), config)),
  );
  assert.equal(replies.filter((x) => x.status === 'fulfilled').length, 4);
  const status = await getPushStatus(pool, a, config);
  assert.ok(pushStatusResponse(status));
  assert.equal(status.subscriptions.length, 5);
  assert.equal(
    status.subscriptions.find((s) => s.id === saved.id).endpointDigest,
    createHash('sha256').update(input.endpoint).digest('hex'),
  );
  assert.ok(!JSON.stringify(status).includes(input.endpoint));
  assert.equal(
    pushStatusResponse({
      ...status,
      subscriptions: [{ ...status.subscriptions[0], endpoint: input.endpoint }],
    }),
    false,
  );
  assert.equal((await getPushStatus(pool, b, config)).subscriptions.length, 0);
  await assert.rejects(
    unsubscribePush(pool, b, saved.id),
    (e) => e.code === 'PUSH_SUBSCRIPTION_NOT_FOUND',
  );
});
test('outbox creation shares the alert transaction and has account-matching foreign keys', async () => {
  const a = await owner(),
    b = await owner(),
    s = await subscribePush(pool, a, sub(), config),
    other = await subscribePush(pool, b, sub(), config);
  const note = await alert(a);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM second_look_push_outbox WHERE alert_id=$1 AND subscription_id=$2',
        [note.id, s.id],
      )
    ).rowCount,
    1,
  );
  await assert.rejects(
    pool.query(
      'INSERT INTO second_look_push_outbox(alert_id,subscription_id,account_id) VALUES($1,$2,$3)',
      [note.id, other.id, a],
    ),
    (e) => e.code === '23503',
  );
  await assert.rejects(
    transaction(pool, async (c) => {
      await insertSecondLookAlert(c, a, {
        kind: 'cool_head',
        dedupeKey: 'rollback',
        occurredAt: new Date().toISOString(),
        title: 'Rollback',
        message: 'Rollback',
        evidence: {},
      });
      throw Error('rollback');
    }),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer n FROM second_look_push_outbox WHERE account_id=$1',
        [a],
      )
    ).rows[0].n,
    1,
  );
});
test('concurrent workers send once and ambiguous outcomes are never replayed', async () => {
  await isolate();
  const a = await owner();
  await subscribePush(pool, a, sub(), config);
  await alert(a);
  let calls = 0;
  const send = async (_s, payload) => {
    calls++;
    const body = JSON.parse(payload);
    assert.equal(body.url, PUSH_INBOX_URL);
    assert.equal(JSON.stringify(body).includes('private'), false);
    return { kind: 'ambiguous' };
  };
  await Promise.all([
    runSecondLookPushOnce(pool, { config, send }),
    runSecondLookPushOnce(pool, { config, send }),
  ]);
  await runSecondLookPushOnce(pool, { config, send });
  assert.equal(calls, 1);
  assert.equal(
    (
      await pool.query(
        'SELECT state FROM second_look_push_outbox WHERE account_id=$1',
        [a],
      )
    ).rows[0].state,
    'ambiguous',
  );
});
test('definite rate-limit rejection retries, gone endpoints disable, and expired reminders do not send', async () => {
  await isolate();
  const a = await owner(),
    s = await subscribePush(pool, a, sub(), config);
  await alert(a);
  assert.equal(
    (
      await runSecondLookPushOnce(pool, {
        config,
        send: async () => ({ kind: 'retry', retryMs: 30000 }),
      })
    ).state,
    'queued',
  );
  await pool.query(
    'UPDATE second_look_push_outbox SET next_run_at=now() WHERE account_id=$1',
    [a],
  );
  assert.equal(
    (
      await runSecondLookPushOnce(pool, {
        config,
        send: async () => ({ kind: 'gone' }),
      })
    ).state,
    'rejected',
  );
  assert.equal((await getPushStatus(pool, a, config)).subscriptions.length, 0);
  await unsubscribePush(pool, a, s.id);
  await subscribePush(pool, a, sub(), config);
  await alert(a);
  await pool.query(
    "UPDATE second_look_push_outbox SET expires_at=now()-interval '1 second' WHERE account_id=$1 AND state='queued'",
    [a],
  );
  assert.equal(
    (
      await runSecondLookPushOnce(pool, {
        config,
        send: async () => {
          throw Error('must not send');
        },
      })
    ).state,
    'idle',
  );
});
test('unsubscribe deletes pending deliveries and abandoned sends become ambiguous', async () => {
  await isolate();
  const a = await owner(),
    s = await subscribePush(pool, a, sub(), config);
  const note = await alert(a);
  await pool.query(
    "UPDATE second_look_push_outbox SET state='sending',started_at=now()-interval '2 minutes',attempts=1 WHERE alert_id=$1",
    [note.id],
  );
  await runSecondLookPushOnce(pool, {
    config,
    send: async () => {
      throw Error('no replay');
    },
  });
  assert.equal(
    (
      await pool.query(
        'SELECT state FROM second_look_push_outbox WHERE alert_id=$1',
        [note.id],
      )
    ).rows[0].state,
    'ambiguous',
  );
  await unsubscribePush(pool, a, s.id);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM second_look_push_outbox WHERE alert_id=$1',
        [note.id],
      )
    ).rowCount,
    0,
  );
});
test('transport sends encrypted standard payloads and classifies uncertainty without leaking provider text', async () => {
  for (const [status, kind] of [
    [201, 'accepted'],
    [410, 'gone'],
    [429, 'retry'],
    [503, 'ambiguous'],
    [403, 'rejected'],
  ]) {
    const result = await sendSecondLookPush(
      sub(),
      JSON.stringify({ private: 'sample' }),
      config,
      async (url, init) => {
        assert.equal(init.redirect, 'error');
        assert.equal(init.method, 'POST');
        assert.ok(!Buffer.from(init.body).includes(Buffer.from('sample')));
        assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
        return new Response('untrusted provider body', { status });
      },
    );
    assert.equal(result.kind, kind);
  }
  assert.equal(
    (
      await sendSecondLookPush(sub(), '{}', config, async () => {
        throw Error('request outcome unknown');
      })
    ).kind,
    'ambiguous',
  );
});
test('push routes expose no endpoint or auth material and reject foreign deletion', async () => {
  const a = await owner(),
    b = await owner(),
    input = sub(),
    s = await subscribePush(pool, a, input, config);
  const res = await pushRoutes(
    pool,
    new Request('https://example.org/api/service/second-look/push'),
    'second-look/push',
    a,
  );
  const status = await res.json();
  assert.ok(pushStatusResponse(status));
  for (const secret of [input.endpoint, input.keys.auth, input.keys.p256dh])
    assert.ok(!JSON.stringify(status).includes(secret));
  await assert.rejects(
    pushRoutes(
      pool,
      new Request(
        'https://example.org/api/service/second-look/push/subscriptions/' +
          s.id,
        { method: 'DELETE' },
      ),
      'second-look/push/subscriptions/' + s.id,
      b,
    ),
    (e) => e.code === 'PUSH_SUBSCRIPTION_NOT_FOUND',
  );
});
test('service worker validates payload and persists dedupe before showing a generic fixed-link notification', async () => {
  const handlers = {},
    shown = [],
    seen = new Map();
  let wait;
  const indexedDB = {
    open: () => {
      const r = {};
      queueMicrotask(() => {
        r.result = {
          createObjectStore() {},
          close() {},
          transaction() {
            const tx = {};
            const store = {
              get(id) {
                const request = {};
                queueMicrotask(() => {
                  request.result = seen.get(id);
                  request.onsuccess();
                  queueMicrotask(() => tx.oncomplete());
                });
                return request;
              },
              put(value, id) {
                seen.set(id, value);
              },
              openCursor() {
                const request = {};
                queueMicrotask(() => {
                  request.result = null;
                  request.onsuccess();
                });
                return request;
              },
            };
            tx.objectStore = () => store;
            return tx;
          },
        };
        r.onsuccess();
      });
      return r;
    },
  };
  const self = {
    addEventListener: (name, fn) => (handlers[name] = fn),
    registration: {
      showNotification: async (title, options) =>
        shown.push({ title, ...options }),
    },
    location: { origin: 'https://example.org' },
    clients: {
      matchAll: async () => [],
      openWindow: async (url) => assert.equal(url, PUSH_INBOX_URL),
    },
  };
  runInNewContext(
    await readFile(
      new URL('../public/second-look-push-sw.js', import.meta.url),
      'utf8',
    ),
    { self, indexedDB, Date, URL, Error, Promise, queueMicrotask },
  );
  const value = {
    version: 1,
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    url: PUSH_INBOX_URL,
  };
  for (const body of [
    value,
    value,
    { ...value, id: randomUUID(), url: 'https://evil.test' },
  ]) {
    handlers.push({ data: { json: () => body }, waitUntil: (p) => (wait = p) });
    await wait;
  }
  assert.equal(shown.length, 1);
  assert.equal(shown[0].body, 'You have a new Second Look reminder.');
  assert.equal(shown[0].data.url, PUSH_INBOX_URL);
});
