import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDirectory = fileURLToPath(new URL('../', import.meta.url));
const skipped = new Set(['test:database', 'test:runtime', 'test:coverage']);
const excluded = ['scripts/**', 'lib/**', 'app/**', 'components/**'];

/** Pure suites are the test:* scripts that are plain node runs the database harness does not already own. */
export function pureSuites(scripts, databaseSuites) {
  const suites = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith('test:') || skipped.has(name)) continue;
    const words = command.trim().split(/\s+/);
    if (words[0] !== 'node' || words.some((word) => /[;&|$`<>()]/.test(word)))
      throw new Error(`${name} is not a plain node invocation.`);
    const file = /^scripts\/check-(.+)\.mjs$/.exec(words.at(-1))?.[1];
    if (file && databaseSuites.has(file)) continue;
    suites.push({ name, args: words.slice(1) });
  }
  return suites;
}

/** The harness runs these against a fresh database each; they are not safe to run twice on a shared one. */
async function harnessSuites() {
  const source = await readFile(
    new URL('check-database.mjs', import.meta.url),
    'utf8',
  );
  const list = /const suites = Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
  if (!list) throw new Error('Could not read the database harness suite list.');
  return new Set([...list[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));
}

function run(args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, {
      cwd: webDirectory,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolveRun(-1));
    child.on('close', (code) => resolveRun(code ?? -1));
  });
}

async function main() {
  if (!process.env.CONCLAVE_TEST_DATABASE_URL)
    throw new Error(
      'Set CONCLAVE_TEST_DATABASE_URL to a loopback database ending in _test, as for test:database.',
    );
  const { scripts } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const suites = [
    { name: 'test:database', args: ['scripts/check-database.mjs'] },
    ...pureSuites(scripts, await harnessSuites()),
  ];
  const scratch = await mkdtemp(join(tmpdir(), 'conclave-coverage-'));
  const raw = join(scratch, 'raw');
  const env = { ...process.env, NODE_V8_COVERAGE: raw, TZ: 'UTC' };
  const failed = [];
  try {
    for (const suite of suites) {
      const code = await run(suite.args, env);
      console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${suite.name}`);
      if (code !== 0) failed.push(suite.name);
    }
    const c8 = join(webDirectory, 'node_modules/c8/bin/c8.js');
    const report = spawnSync(
      process.execPath,
      [
        c8,
        'report',
        '--temp-directory',
        raw,
        '--reports-dir',
        join(scratch, 'report'),
        '--all',
        '--include',
        'server/**',
        ...excluded.flatMap((pattern) => ['--exclude', pattern]),
        '--reporter',
        'text-summary',
        '--reporter',
        'json-summary',
      ],
      { cwd: webDirectory, stdio: 'inherit' },
    );
    if (report.status !== 0) throw new Error('c8 report failed.');
    const { total } = JSON.parse(
      await readFile(join(scratch, 'report', 'coverage-summary.json'), 'utf8'),
    );
    console.log(
      `server coverage: lines ${total.lines.pct}% (${total.lines.covered}/${total.lines.total}), branches ${total.branches.pct}% (${total.branches.covered}/${total.branches.total}), functions ${total.functions.pct}% (${total.functions.covered}/${total.functions.total})`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (failed.length) {
    console.error(`Failing suites: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
