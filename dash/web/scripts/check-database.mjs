import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';

const suites = Object.freeze([
  'account-security',
  'passkeys',
  'ledger',
  'test-credits',
  'platform-fee',
  'token-ledger',
  'reconciliation',
  'ledger-invariants',
  'service',
  'deposit-service',
  'deposit-payment',
  'deposit-submit',
  'deposit-search',
  'token-deposit-service',
  'receipt-service',
  'comparisons',
  'route-registry',
  'auto-routing-service',
  'crosscheck-service',
  'crosscheck-execution',
  'crosscheck-registry',
  'briefs',
  'brief-synthesis-service',
  'media-service',
  'media-registry',
  'media-assets',
  'media-ingest',
  'media-reader',
  'media-content-service',
  'media-receipt-service',
]);
const generatedName = /^conclave_[0-9a-f]{32}_test$/;
const webDirectory = fileURLToPath(new URL('../', import.meta.url));
const safeTitle = /^[A-Za-z0-9][A-Za-z0-9 ,;()'/_-]{0,179}$/;
const failedTitleLimit = 8;

/** Only static suite titles can leave the child; interpolated values never qualify. */
export function declaredTestTitles(source) {
  const titles = new Set();
  for (const match of source.matchAll(
    /(?:^|\n)[ \t]*(?:void )?test\(\s*(['"])([A-Za-z0-9][A-Za-z0-9 ,;()'/_-]{0,179})\1\s*,/g,
  ))
    if (safeTitle.test(match[2])) titles.add(match[2]);
  return titles;
}

export function tapSummary(allowedTitles) {
  const counts = {},
    failedTestTitles = [];
  let tail = '',
    oversizedLine = false;
  function line(value) {
    const total = /^# (tests|pass|fail|cancelled|skipped) (\d{1,9})\r?$/.exec(
      value,
    );
    if (total) counts[total[1]] = Number(total[2]);
    const failed = /^not ok \d{1,9} - (.+?)\r?$/.exec(value);
    if (
      failed &&
      safeTitle.test(failed[1]) &&
      allowedTitles.has(failed[1]) &&
      failedTestTitles.length < failedTitleLimit &&
      !failedTestTitles.includes(failed[1])
    )
      failedTestTitles.push(failed[1]);
  }
  function write(chunk) {
    for (const part of chunk.matchAll(/[^\n]*\n|[^\n]+$/g)) {
      const ended = part[0].endsWith('\n');
      const content = ended ? part[0].slice(0, -1) : part[0];
      if (!oversizedLine) {
        if (tail.length + content.length > 256) {
          tail = '';
          oversizedLine = true;
        } else tail += content;
      }
      if (ended) {
        if (!oversizedLine) line(tail);
        tail = '';
        oversizedLine = false;
      }
    }
  }
  return {
    write,
    end() {
      if (tail && !oversizedLine) line(tail);
      tail = '';
      oversizedLine = false;
      return { counts: { ...counts }, failedTestTitles: [...failedTestTitles] };
    },
  };
}

/** Deliberately reject options that could redirect a nominally local URL. */
export function testEndpoint(value) {
  try {
    if (typeof value !== 'string' || !value) throw new Error();
    const endpoint = new URL(value);
    const database = decodeURIComponent(endpoint.pathname.slice(1));
    if (
      !['postgres:', 'postgresql:'].includes(endpoint.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
      !/^\/[A-Za-z_][A-Za-z0-9_]*_test$/.test(endpoint.pathname) ||
      database.length > 63 ||
      !endpoint.username ||
      endpoint.hash ||
      [...endpoint.searchParams].some(
        ([key, setting]) => key !== 'sslmode' || setting !== 'verify-full',
      ) ||
      (endpoint.port &&
        (!/^\d+$/.test(endpoint.port) ||
          Number(endpoint.port) < 1 ||
          Number(endpoint.port) > 65535))
    )
      throw new Error();
    decodeURIComponent(endpoint.username);
    decodeURIComponent(endpoint.password);
    return endpoint;
  } catch {
    throw new Error(
      'CONCLAVE_TEST_DATABASE_URL must name a loopback PostgreSQL database ending in _test, with an explicit user and no routing options.',
    );
  }
}

export function databaseIdentifier(name) {
  if (typeof name !== 'string' || !generatedName.test(name))
    throw new Error('Only a generated test database identifier is allowed.');
  return `"${name}"`;
}

function adminClient(endpoint) {
  return new pg.Client({
    host: endpoint.hostname.replace(/^\[|\]$/g, ''),
    port: endpoint.port ? Number(endpoint.port) : 5432,
    database: decodeURIComponent(endpoint.pathname.slice(1)),
    user: decodeURIComponent(endpoint.username),
    password: decodeURIComponent(endpoint.password),
    ssl: endpoint.searchParams.has('sslmode')
      ? { rejectUnauthorized: true }
      : false,
    enableChannelBinding: true,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    application_name: 'conclave_test_harness',
    options: '-c timezone=UTC',
  });
}

async function runSuite(suite, connection, signal) {
  assert.ok(suites.includes(suite));
  const parser = tapSummary(
    declaredTestTitles(
      await readFile(new URL(`check-${suite}.mjs`, import.meta.url), 'utf8'),
    ),
  );
  return new Promise((resolveResult) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--test-reporter=tap',
        `scripts/check-${suite}.mjs`,
      ],
      {
        cwd: webDirectory,
        env: {
          ...process.env,
          // Exact-charge suites assume fee-free, credit-free defaults even when a local launcher env is loaded.
          CONCLAVE_PLATFORM_FEE_BPS: undefined,
          CONCLAVE_BURN_SHARE_BPS: undefined,
          CONCLAVE_INTERNAL_TESTING: undefined,
          CONCLAVE_INTERNAL_TEST_CREDIT_USD: undefined,
          GATEWAY_API_KEY: undefined,
          GATEWAY_API_ORIGIN: 'https://api.inference.invalid',
          GATEWAY_EVIDENCE_ORIGINS: '["https://inference.invalid","https://www.inference.invalid"]',
          CONCLAVE_TEST_DATABASE_URL: connection,
          CONCLAVE_DATABASE_URL: connection,
          TZ: 'UTC',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let killTimer,
      timedOut = false;
    // Only numeric totals and allowlisted failure titles reach the parent log.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', parser.write);
    child.stderr.resume();
    const stop = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    const suiteTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, 300000);
    suiteTimer.unref();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    let failedToStart = false;
    child.on('error', () => {
      failedToStart = true;
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      clearTimeout(suiteTimer);
      signal.removeEventListener('abort', stop);
      const { counts, failedTestTitles } = parser.end();
      resolveResult({
        passed:
          !failedToStart &&
          !timedOut &&
          code === 0 &&
          !signal.aborted &&
          counts.tests > 0 &&
          counts.pass > 0 &&
          counts.fail === 0 &&
          counts.cancelled === 0,
        counts,
        failedTestTitles,
      });
    });
  });
}

async function checkDatabases() {
  const endpoint = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL);
  const client = adminClient(endpoint);
  const created = new Set(),
    retained = new Set();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let failures = 0;
  try {
    await client.connect();
    for (const suite of suites) {
      if (controller.signal.aborted) break;
      const name = `conclave_${randomUUID().replaceAll('-', '')}_test`;
      const identifier = databaseIdentifier(name);
      const connection = new URL(endpoint);
      connection.pathname = `/${name}`;
      console.log(`Running ${suite}: ${name}`);
      try {
        // A failed/colliding CREATE never grants this invocation permission to DROP.
        await client.query(`CREATE DATABASE ${identifier} TEMPLATE template0`);
        created.add(name);
      } catch {
        console.error(
          `Database creation failed for ${name}; no deletion attempted.`,
        );
        failures++;
        break;
      }
      const result = await runSuite(suite, connection.href, controller.signal);
      if (!result.passed) {
        retained.add(name);
        failures++;
        console.error(
          `FAIL ${suite}: ${result.counts.pass ?? 0} passed, ${result.counts.fail ?? 0} failed; retained ${name}; raw child output suppressed.`,
        );
        for (const title of result.failedTestTitles)
          console.error(`Failed test: ${title}`);
        if (!result.failedTestTitles.length)
          console.error('No safe static failing test title was available.');
      } else {
        try {
          // Child exit closes its sockets. No FORCE/termination touches other sessions.
          assert.ok(created.has(name));
          await client.query(`DROP DATABASE ${databaseIdentifier(name)}`);
          created.delete(name);
          console.log(
            `PASS ${suite}: ${result.counts.pass ?? '?'} passed; removed ${name}`,
          );
        } catch {
          retained.add(name);
          failures++;
          console.error(`Cleanup failed for ${name}; database retained.`);
        }
      }
    }
  } catch {
    console.error(
      'The local database test harness could not complete. No connection details are logged.',
    );
    failures++;
  } finally {
    await client.end().catch(() => {});
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    for (const name of created) {
      if (!retained.has(name))
        console.error(`Retained interrupted database: ${name}`);
    }
  }
  if (controller.signal.aborted || failures) process.exitCode = 1;
  else console.log(`All ${suites.length} isolated database suites passed.`);
}

function selfTest() {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(
      testEndpoint(`postgresql://test_user@${host}/fixture_test`).hostname,
      host,
    );
  }
  for (const value of [
    undefined,
    '',
    'https://test_user@localhost/fixture_test',
    'postgresql://test_user@database.example/fixture_test',
    'postgresql://test_user@localhost/production',
    'postgresql://localhost/fixture_test',
    'postgresql://test_user@localhost/fixture_test?host=database.example',
    'postgresql://test_user@localhost/fixture_test?options=unsafe',
    'postgresql://test_user@localhost/fixture%2F_test',
    'postgresql://test_user@localhost/fixture_test#other',
    `postgresql://test_user@localhost/${'a'.repeat(64)}_test`,
  ])
    assert.throws(() => testEndpoint(value));
  const name = `conclave_${randomUUID().replaceAll('-', '')}_test`;
  assert.equal(databaseIdentifier(name), `"${name}"`);
  for (const value of [
    'fixture_test',
    name + ';DROP DATABASE fixture_test',
    name.toUpperCase(),
    undefined,
  ])
    assert.throws(() => databaseIdentifier(value));
  const title = 'concurrent requests reserve exactly once';
  const declared = declaredTestTitles(
    `test('${title}', () => {});\nvoid test(\n  "readonly results remain visible", () => {});\n` +
      'test(`dynamic ${value}`, () => {});\n' +
      "test('prefix' + value, () => {});\n" +
      "test('https://private.invalid', () => {});",
  );
  assert.deepEqual([...declared], [title, 'readonly results remain visible']);
  const parser = tapSummary(declared);
  parser.write('TAP version 13\nnot o');
  parser.write(`k 1 - ${title}\r\n  ---\n  error: 'secret diagnostic'\n`);
  parser.write(`  not ok 2 - ${title}\nnot ok 3 - https://private.invalid\n`);
  parser.write('not ok 4 - undeclared secretlikevalue\n');
  parser.write(`not ok 5 - ${title}\n`);
  // Never parse a truncated oversized line's suffix as a new TAP line.
  parser.write('x'.repeat(300));
  parser.write('not ok 6 - readonly results remain visible\n');
  parser.write('# tests 5\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 0');
  assert.deepEqual(parser.end(), {
    counts: { tests: 5, pass: 4, fail: 1, cancelled: 0, skipped: 0 },
    failedTestTitles: [title],
  });
  const boundedTitles = Array.from({ length: 10 }, (_, i) => `safe case ${i}`);
  const bounded = tapSummary(new Set([...boundedTitles, 'x'.repeat(181)]));
  bounded.write(
    boundedTitles.map((name, i) => `not ok ${i + 1} - ${name}\n`).join('') +
      `not ok 11 - ${'x'.repeat(181)}\n`,
  );
  assert.deepEqual(bounded.end().failedTestTitles, boundedTitles.slice(0, 8));
  const unsafe = [
    'https://private.invalid/path',
    'person@example.invalid',
    '/tmp/fixture',
    'driver: authentication failed',
    'unsafe\u001b[31m title',
    'x'.repeat(181),
  ];
  const rejected = tapSummary(new Set(unsafe));
  rejected.write(
    unsafe.map((name, i) => `not ok ${i + 1} - ${name}\n`).join(''),
  );
  assert.deepEqual(rejected.end().failedTestTitles, []);
  console.log(
    'Database harness URL, identifier and TAP summary safety checks passed; no database connection made.',
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test')
    selfTest();
  else if (process.argv.length !== 2) {
    console.error('Usage: node scripts/check-database.mjs [--self-test]');
    process.exitCode = 1;
  } else {
    await checkDatabases().catch(() => {
      console.error(
        'The local database harness configuration is invalid. No databases were changed.',
      );
      process.exitCode = 1;
    });
  }
}
