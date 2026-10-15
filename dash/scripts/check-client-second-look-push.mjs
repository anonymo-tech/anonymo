import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import {
  getBrowserPushStatus,
  enableBrowserPush,
  disableBrowserPush,
} from '../lib/client/push.ts';

const globals = ['window', 'navigator', 'Notification', 'localStorage'];
const original = new Map(
  globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
afterEach(() => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});
function fixture({
  blockedStorage = false,
  lostPost = false,
  failedDelete = false,
} = {}) {
  const accountId = randomUUID(),
    rows = new Map(),
    values = new Map();
  let current = null,
    registrations = 0,
    permissions = 0,
    postAttempts = 0,
    deletions = 0,
    unsubscribes = 0;
  const key = 'A'.repeat(87);
  const registration = {
    active: {},
    pushManager: {
      getSubscription: async () => current,
      subscribe: async () => {
        const endpoint = 'https://fcm.googleapis.com/fcm/send/' + randomUUID();
        const subscription = {
          endpoint,
          toJSON: () => ({
            endpoint,
            keys: { p256dh: key, auth: 'A'.repeat(22) },
          }),
          unsubscribe: async () => {
            unsubscribes++;
            if (current === subscription) current = null;
            return true;
          },
        };
        current = subscription;
        return subscription;
      },
    },
  };
  const notification = {
    permission: 'granted',
    requestPermission: async () => {
      permissions++;
      return notification.permission;
    },
  };
  const storage = {
    getItem: (key) => {
      if (blockedStorage) throw Error('Storage unavailable');
      return values.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (blockedStorage) throw Error('Storage unavailable');
      values.set(key, value);
    },
    removeItem: (key) => {
      if (blockedStorage) throw Error('Storage unavailable');
      values.delete(key);
    },
  };
  for (const [key, value] of Object.entries({
    window: {
      isSecureContext: true,
      PushManager: class {},
      Notification: notification,
    },
    navigator: {
      serviceWorker: {
        register: async () => {
          registrations++;
          return registration;
        },
        getRegistration: async () => registration,
      },
    },
    Notification: notification,
    localStorage: storage,
  }))
    Object.defineProperty(globalThis, key, { value, configurable: true });
  const fetch = async (url, init) => {
    if (url === '/api/auth/session')
      return Response.json({
        accountId,
        identities: [
          { kind: 'solana', subject: '11111111111111111111111111111111' },
        ],
      });
    if (url === '/api/second-look/push')
      return Response.json({
        configured: true,
        publicKey: key,
        reason: null,
        subscriptions: [...rows].map(([endpoint, saved]) => ({
          ...saved,
          endpointDigest: createHash('sha256').update(endpoint).digest('hex'),
        })),
      });
    if (
      url === '/api/second-look/push/subscriptions' &&
      init.method === 'POST'
    ) {
      postAttempts++;
      const body = JSON.parse(init.body);
      let saved = rows.get(body.endpoint);
      if (!saved) {
        saved = { id: randomUUID(), createdAt: new Date().toISOString() };
        rows.set(body.endpoint, saved);
      }
      if (lostPost && postAttempts === 1) throw TypeError('Lost response');
      return Response.json(saved);
    }
    if (
      url.startsWith('/api/second-look/push/subscriptions/') &&
      init.method === 'DELETE'
    ) {
      deletions++;
      if (failedDelete) throw TypeError('Offline');
      const id = url.split('/').at(-1);
      for (const [endpoint, saved] of rows)
        if (saved.id === id) rows.delete(endpoint);
      return Response.json({ removed: true });
    }
    throw Error('Unexpected request');
  };
  return {
    options: { accountId, fetch, publicKey: key },
    rows,
    values,
    notification,
    counts: () => ({
      registrations,
      permissions,
      postAttempts,
      deletions,
      unsubscribes,
    }),
    revoke: () => {
      current = null;
    },
    replace: async () => registration.pushManager.subscribe(),
  };
}

test('status reads never register a worker or request browser permission', async () => {
  const f = fixture();
  const status = await getBrowserPushStatus(f.options);
  assert.equal(status.subscriptionId, null);
  assert.equal(status.supported, true);
  assert.deepEqual(f.counts(), {
    registrations: 0,
    permissions: 0,
    postAttempts: 0,
    deletions: 0,
    unsubscribes: 0,
  });
});
test('blocked local storage preserves enrolled status and allows this browser to disable', async () => {
  const f = fixture({ blockedStorage: true });
  const saved = await enableBrowserPush(f.options);
  assert.equal(
    (await getBrowserPushStatus(f.options)).subscriptionId,
    saved.id,
  );
  await disableBrowserPush({ ...f.options, subscriptionId: saved.id });
  assert.equal((await getBrowserPushStatus(f.options)).subscriptionId, null);
  assert.equal(f.rows.size, 0);
  assert.equal(f.counts().unsubscribes, 1);
});
test('a full reload with blocked storage recovers the existing enrollment without taking another slot', async () => {
  const f = fixture({ blockedStorage: true });
  const saved = await enableBrowserPush(f.options);
  const fresh = await import('../lib/client/push.ts?fresh=' + randomUUID());
  assert.equal(
    (await fresh.getBrowserPushStatus(f.options)).subscriptionId,
    saved.id,
  );
  assert.equal(f.counts().postAttempts, 1);
  await fresh.disableBrowserPush({ ...f.options, subscriptionId: saved.id });
  assert.equal(f.counts().unsubscribes, 1);
  assert.equal(f.rows.size, 0);
});
test('stored enrollment contains only an identifier and one-way endpoint fingerprint', async () => {
  const f = fixture();
  const saved = await enableBrowserPush(f.options);
  const value = JSON.parse([...f.values.values()][0]);
  assert.deepEqual(Object.keys(value).sort(), ['fingerprint', 'id']);
  assert.equal(value.id, saved.id);
  assert.match(value.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(value).includes('fcm.googleapis.com'));
});
test('browser revocation clears a stale server identifier without requesting permission again', async () => {
  const f = fixture();
  await enableBrowserPush(f.options);
  f.revoke();
  assert.equal((await getBrowserPushStatus(f.options)).subscriptionId, null);
  assert.equal(f.counts().permissions, 1);
  assert.equal(f.counts().registrations, 1);
  assert.equal(f.rows.size, 1);
});
test('a different browser endpoint cannot inherit another account enrollment identifier', async () => {
  const f = fixture();
  await enableBrowserPush(f.options);
  await f.replace();
  assert.equal((await getBrowserPushStatus(f.options)).subscriptionId, null);
});
test('lost enrollment response retries the identical endpoint and consumes one device slot', async () => {
  const f = fixture({ lostPost: true });
  const saved = await enableBrowserPush(f.options);
  assert.equal(f.counts().postAttempts, 2);
  assert.equal(f.rows.size, 1);
  assert.equal(
    (await getBrowserPushStatus(f.options)).subscriptionId,
    saved.id,
  );
});
test('disabling this browser unsubscribes locally even if the server is unreachable', async () => {
  const f = fixture({ failedDelete: true });
  const saved = await enableBrowserPush(f.options);
  await assert.rejects(
    disableBrowserPush({ ...f.options, subscriptionId: saved.id }),
    (e) => e.code === 'NETWORK_ERROR',
  );
  assert.equal(f.counts().unsubscribes, 1);
  assert.equal((await getBrowserPushStatus(f.options)).subscriptionId, null);
});
test('removing another device does not unsubscribe this browser', async () => {
  const f = fixture();
  const saved = await enableBrowserPush(f.options);
  const other = { id: randomUUID(), createdAt: new Date().toISOString() };
  f.rows.set('another-device', other);
  await disableBrowserPush({ ...f.options, subscriptionId: other.id });
  assert.equal(f.counts().unsubscribes, 0);
  assert.equal(
    (await getBrowserPushStatus(f.options)).subscriptionId,
    saved.id,
  );
});
test('permission denied creates no subscription or server request', async () => {
  const f = fixture();
  f.notification.permission = 'denied';
  await assert.rejects(
    enableBrowserPush(f.options),
    /permission was not granted/,
  );
  assert.equal(f.rows.size, 0);
  assert.equal(f.counts().postAttempts, 0);
  assert.equal(f.counts().registrations, 0);
});
