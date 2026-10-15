import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createDatabase,
  supportsPostgresChannelBinding,
} from '../server/db/database.ts';
import { serviceConfig, requireService } from '../server/core/config.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import { configuredReceiptSigner } from '../server/receipts/service.ts';
import { createPpqClient } from '../server/ppq/index.ts';
import { crossCheckExecutionConfigured } from '../server/crosscheck/execution.ts';
import { callRoutes } from '../server/routes/calls.ts';
import { comparisonRoutes } from '../server/routes/comparisons.ts';
import { solanaRoutes } from '../server/routes/solana.ts';
import { dispatch } from '../server/routes/dispatch.ts';

const directory = fileURLToPath(new URL('../', import.meta.url));
const uuid = '00000000-0000-4000-8000-000000000001';
async function environment(values, run) {
  const names = new Set([
    ...Object.keys(process.env).filter(
      (name) => name.startsWith('CONCLAVE_') || name === 'PPQ_API_KEY',
    ),
    ...Object.keys(values),
  ]);
  const original = new Map([...names].map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    return await run();
  } finally {
    for (const name of names) {
      if (original.get(name) === undefined) delete process.env[name];
      else process.env[name] = original.get(name);
    }
  }
}

void test('Node retains supported SCRAM channel binding and certificate-verified remote TLS', async () => {
  assert.equal(supportsPostgresChannelBinding(), true);
  const pool = createDatabase(
    'postgresql://runtime_test@database.example.invalid/runtime_test?sslmode=verify-full',
  );
  try {
    assert.equal(pool.options.enableChannelBinding, true);
    assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true });
    assert.equal(pool.options.options, '-c timezone=UTC');
    assert.throws(() =>
      createDatabase(
        'postgresql://runtime_test@database.example.invalid/runtime_test?sslmode=disable',
      ),
    );
  } finally {
    await pool.end();
  }
});

void test('installed Workers pg transport uses verified TLS without unsupported SCRAM-PLUS', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--conditions=workerd',
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
    const { createDatabase, supportsPostgresChannelBinding } = await import('./server/db/database.ts');
    const require = createRequire(import.meta.url), pgRequire = createRequire(require.resolve('pg'));
    const { CloudflareSocket } = pgRequire('pg-cloudflare'), sasl = pgRequire('./crypto/sasl.js');
    const pool = createDatabase('postgresql://runtime_test@database.example.invalid/runtime_test?sslmode=verify-full');
    try {
      assert.equal(supportsPostgresChannelBinding(), false);
      assert.equal(pool.options.enableChannelBinding, false);
      assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true });
      const socket = new CloudflareSocket(pool.options.ssl);
      assert.equal(typeof socket.getPeerCertificate, 'undefined');
      assert.throws(() => sasl.startSession(['SCRAM-SHA-256-PLUS', 'SCRAM-SHA-256'], socket), /requires a certificate/);
      assert.equal(sasl.startSession(['SCRAM-SHA-256-PLUS', 'SCRAM-SHA-256'], pool.options.enableChannelBinding && socket).mechanism, 'SCRAM-SHA-256');
      assert.throws(() => sasl.startSession(['SCRAM-SHA-256-PLUS'], false));
    } finally { await pool.end(); }
  `,
    ],
    { cwd: directory, timeout: 15000, stdio: 'ignore' },
  );
  assert.equal(
    child.status,
    0,
    'Offline Workers transport negotiation regression failed.',
  );
});

void test('default preview cannot open protected or chargeable API paths', async () => {
  await environment({}, async () => {
    assert.equal(serviceConfig().mode, 'preview');
    assert.throws(() => requireService(serviceConfig()), {
      code: 'SERVICE_UNAVAILABLE',
    });
    const capabilities = await dispatch(
      new Request('https://conclave.test/api/capabilities'),
    );
    const body = await capabilities.json();
    assert.equal(body.mode, 'preview');
    for (const capability of [
      'walletSignIn',
      'chat',
      'projects',
      'studio',
      'deposits',
      'receipts',
      'sealedRoutes',
      'chapters',
    ])
      assert.equal(body[capability].configured, false);
    for (const path of [
      'calls',
      'comparisons',
      'deposits',
      'crosscheck',
      'media/quotes',
      'media/jobs',
    ]) {
      const response = await dispatch(
        new Request('https://conclave.test/api/' + path, { method: 'POST' }),
      );
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'SERVICE_UNAVAILABLE');
    }
  });
});

void test('integrated media capability requires service storage and explicit generation configuration', async () => {
  await environment(
    {
      CONCLAVE_MODE: 'service',
      CONCLAVE_APP_ORIGIN: 'https://conclave.test',
      CONCLAVE_DATABASE_URL: 'postgresql://runtime_test@127.0.0.1/runtime_test',
      PPQ_API_KEY: 'synthetic-provider-key',
      CONCLAVE_INFERENCE_ENABLED: 'true',
      CONCLAVE_MEDIA_ENABLED: 'true',
      CONCLAVE_DATA_KEYS: JSON.stringify({
        test: randomBytes(32).toString('base64'),
      }),
      CONCLAVE_ACTIVE_DATA_KEY: 'test',
    },
    async () => {
      const response = await dispatch(
        new Request('https://conclave.test/api/capabilities'),
      );
      const { studio } = await response.json();
      assert.equal(studio.configured, true);
      assert.equal(studio.storageReady, true);
      assert.equal(studio.deliveryReady, true);
      assert.equal(studio.reason, 'MEDIA_CONFIGURED');
    },
  );
});

void test('capabilities return flags without serializing synthetic server credentials', async () => {
  const secret = 'synthetic-server-marker-' + randomBytes(8).toString('hex');
  await environment(
    {
      CONCLAVE_MODE: 'service',
      CONCLAVE_APP_ORIGIN: 'https://conclave.test',
      CONCLAVE_DATABASE_URL: secret,
      PPQ_API_KEY: secret,
      CONCLAVE_DATA_KEYS: secret,
      CONCLAVE_RECEIPT_SIGNER_SEED_HEX: secret,
    },
    async () => {
      const response = await dispatch(
        new Request('https://conclave.test/api/capabilities'),
      );
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.ok(!text.includes(secret));
      assert.equal(JSON.parse(text).chat.configured, false);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    },
  );
});

void test('missing provider, encryption and signer configuration fail before network or database activity', async () => {
  let touched = false;
  const database = {
    query() {
      touched = true;
      throw new Error('Unexpected database access');
    },
  };
  const input = {
    projectId: uuid,
    routeVersionId: uuid,
    messages: [{ role: 'user', content: 'Synthetic runtime check.' }],
    maxOutputTokens: 128,
    privacy: 'standard',
  };
  const request = (body) =>
    new Request('https://conclave.test/api/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  await environment({}, async () => {
    assert.throws(() => configuredKeyring(), { code: 'STORAGE_KEY_REQUIRED' });
    assert.throws(() => configuredReceiptSigner(), {
      code: 'RECEIPT_SIGNER_UNAVAILABLE',
    });
    await assert.rejects(
      callRoutes(database, request(input), 'quotes', uuid, false),
      { code: 'PROVIDER_UNAVAILABLE' },
    );
    await assert.rejects(
      callRoutes(database, request(input), 'quotes', uuid, true),
      { code: 'STORAGE_KEY_REQUIRED' },
    );
    await assert.rejects(
      comparisonRoutes(
        database,
        request({ projectId: uuid, items: [input] }),
        'comparison-quotes',
        uuid,
        false,
      ),
      { code: 'PROVIDER_UNAVAILABLE' },
    );
    // Saved intent replay may read its owned database record even when new payments
    // are disabled. Configuration discovery itself must stay network/database free.
    const deposits = await solanaRoutes(
      database,
      new Request('https://conclave.test/api/deposits/capabilities'),
      'deposits/capabilities',
      uuid,
    );
    const depositFlags = await deposits.json();
    assert.equal(depositFlags.configured, false);
    assert.equal(depositFlags.recoveryConfigured, false);
    assert.equal(depositFlags.networkVerified, false);
    const client = createPpqClient({
      fetch: async () => {
        touched = true;
        throw new Error('Unexpected network access');
      },
    });
    await assert.rejects(
      async () => {
        for await (const _event of client.chat({
          modelId: 'claude-opus-5.5',
          messages: input.messages,
        })) {
          /* No event may arrive. */
        }
      },
      { code: 'unavailable' },
    );
  });
  assert.equal(touched, false);
});

void test('Cross-Check paid execution requires every explicit gate and a valid encryption key', () => {
  const configured = {
    CONCLAVE_MODE: 'service',
    CONCLAVE_CROSSCHECK_ENABLED: 'true',
    CONCLAVE_INFERENCE_ENABLED: 'true',
    PPQ_API_KEY: 'synthetic-test-only',
    CONCLAVE_APP_ORIGIN: 'https://conclave.test',
    CONCLAVE_DATABASE_URL: 'synthetic-test-only',
    CONCLAVE_ACTIVE_DATA_KEY: 'test',
    CONCLAVE_DATA_KEYS: JSON.stringify({
      test: randomBytes(32).toString('base64'),
    }),
  };
  assert.equal(crossCheckExecutionConfigured(configured), true);
  for (const name of Object.keys(configured)) {
    const missing = { ...configured };
    delete missing[name];
    assert.equal(crossCheckExecutionConfigured(missing), false, name);
  }
});

void test(
  'built browser files exclude server configuration and database code',
  { skip: !process.argv.includes('--bundle') },
  async () => {
    const directory = new URL('../dist/client/', import.meta.url);
    let checked = 0;
    async function inspect(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = new URL(
          entry.name + (entry.isDirectory() ? '/' : ''),
          dir,
        );
        if (entry.isDirectory()) await inspect(file);
        else if (/\.(?:js|json|html|map)$/.test(entry.name)) {
          const body = await readFile(file, 'utf8');
          for (const marker of [
            'CONCLAVE_DATABASE_URL',
            'PPQ_API_KEY',
            'CONCLAVE_DATA_KEYS',
            'CONCLAVE_RECEIPT_SIGNER_SEED_HEX',
            'CONCLAVE_PLATFORM_FEE_BPS',
            'CONCLAVE_BURN_SHARE_BPS',
            'CONCLAVE_INTERNAL_TESTING',
            'CONCLAVE_INTERNAL_TEST_CREDIT_USD',
            'enableChannelBinding',
            'postgresql://',
          ])
            assert.ok(
              !body.includes(marker),
              `Unexpected server marker in browser artifact: ${entry.name}`,
            );
          checked++;
        }
      }
    }
    await inspect(directory);
    assert.ok(
      checked > 0,
      'Build browser artifacts before checking the boundary.',
    );
  },
);

void test(
  'built content guard has a same-origin worker asset and stays out of UI chunks',
  { skip: !process.argv.includes('--bundle') },
  async () => {
    const directory = new URL('../dist/client/', import.meta.url);
    const references = new Set();
    let workers = 0;
    async function inspect(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = new URL(
          entry.name + (entry.isDirectory() ? '/' : ''),
          dir,
        );
        if (entry.isDirectory()) await inspect(file);
        else if (entry.name.endsWith('.js')) {
          const body = await readFile(file, 'utf8');
          assert.ok(
            !/file:\/\/[^"'`]*use-content-guard/.test(body),
            'The content guard worker must not resolve from a server file URL.',
          );
          if (/^content-guard\.worker-[\w-]+\.js$/.test(entry.name)) {
            workers++;
            assert.ok(
              body.includes('input.scan-budget'),
              'The emitted worker must contain the checksum guard.',
            );
          } else {
            assert.ok(
              !body.includes('input.scan-budget'),
              `Checksum guard code leaked into UI chunk: ${entry.name}`,
            );
            for (const match of body.matchAll(
              /["'`](\/[^"'`]*content-guard\.worker-[\w-]+\.js)["'`]/g,
            ))
              references.add(match[1]);
          }
        }
      }
    }
    await inspect(directory);
    assert.ok(
      workers > 0 && references.size > 0,
      'A browser-addressable content guard worker is required.',
    );
    for (const reference of references) {
      assert.ok(!reference.startsWith('//') && !reference.includes('..'));
      await readFile(new URL(reference.slice(1), directory));
    }
  },
);
