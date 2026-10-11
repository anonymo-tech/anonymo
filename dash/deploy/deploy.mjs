#!/usr/bin/env node
// Reproducible deploy sequence. 
//
//   node deploy/deploy.mjs --env=staging --plan        print the steps, run nothing
//   node deploy/deploy.mjs --env=staging --dry-run     everything except migrations and the deploy
//   node deploy/deploy.mjs --env=staging --confirm     the full sequence, ending in `wrangler deploy`
//
// Every step runs against a private mirror of the source tree (a temporary
// directory outside the repository), so the code that is tested is the code
// that is built and deployed. Children get only the environment variables
// their step needs. Progress goes to stderr; stdout carries one JSON document.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const node = ['node', '--experimental-strip-types'];
const modes = ['plan', 'dry-run', 'confirm'];
const baseVariables = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'PNPM_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'CI',
];

const usage =
  'Usage: deploy.mjs --env=NAME (--plan | --dry-run | --confirm) [--manifest-out=FILE] [--keep-mirror] [--allow-dirty]';

/** Exactly one mode and one environment; --confirm never combines with --allow-dirty. */
export function parseArguments(argv) {
  const options = {
    environment: null,
    mode: null,
    manifestOut: null,
    keepMirror: false,
    allowDirty: false,
  };
  const fail = () => {
    throw new Error(usage);
  };
  for (const arg of argv) {
    if (arg.startsWith('--env=') && options.environment === null)
      options.environment = arg.slice(6);
    else if (
      arg.startsWith('--manifest-out=') &&
      options.manifestOut === null &&
      arg.length > 15
    )
      options.manifestOut = resolve(arg.slice(15));
    else if (arg === '--keep-mirror' && !options.keepMirror)
      options.keepMirror = true;
    else if (arg === '--allow-dirty' && !options.allowDirty)
      options.allowDirty = true;
    else if (arg.startsWith('--') && modes.includes(arg.slice(2))) {
      if (options.mode !== null) fail();
      options.mode = arg.slice(2);
    } else fail();
  }
  if (
    !options.environment ||
    !/^[a-z][a-z-]{0,31}$/.test(options.environment) ||
    options.mode === null ||
    (options.mode === 'confirm' && options.allowDirty)
  )
    fail();
  return options;
}

/** Names of the database suites that check-database.mjs runs, as check-*.mjs file names. */
export function databaseSuiteFiles(source) {
  const list = /const suites = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source);
  if (!list) throw new Error('The database suite list could not be read.');
  return new Set(
    [...list[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => `check-${m[1]}.mjs`),
  );
}

/**
 * The pure suites: every `test:*` script except `test:database` (which runs
 * the database suites against a loopback database), the database suites it
 * owns, and `test:runtime` (run once more after the build with --bundle).
 */
export function pureSuites(scripts, databaseFiles) {
  return Object.entries(scripts)
    .filter(([name, command]) => {
      if (!name.startsWith('test:') || ['test:database', 'test:runtime'].includes(name))
        return false;
      const file = /scripts\/(check-[a-z0-9-]+\.mjs)/.exec(command)?.[1];
      return !(file && databaseFiles.has(file));
    })
    .map(([name]) => name);
}

/**
 * The ordered steps. `mutates` steps change a shared system and are skipped
 * by --dry-run; `confirmOnly` steps run only with --confirm.
 */
export function buildPlan(options, context) {
  const environment = context.environments[options.environment];
  if (!environment) throw new Error('Choose an environment from environments.json.');
  const pnpm = (...args) => ['pnpm', ...args];
  return [
    { id: 'environment', title: 'Check required environment variable names and the expected cluster' },
    { id: 'source', title: 'Record the git commit and require a clean tree for --confirm' },
    { id: 'mirror', title: 'Copy the source tree into a private mirror outside the repository' },
    { id: 'install', title: 'Install dependencies from the lockfile', commands: [pnpm('install', '--frozen-lockfile')], env: 'build' },
    { id: 'typecheck', title: 'Typecheck', commands: [pnpm('typecheck')], env: 'build' },
    { id: 'lint', title: 'Lint (portable rules)', commands: [pnpm('lint:portable')], env: 'build' },
    {
      id: 'tests-pure',
      title: 'Run the pure test suites',
      commands: context.pureSuites.map((name) => pnpm(name)),
      env: 'test',
    },
    { id: 'tests-database', title: 'Run the database suites against the loopback test database', commands: [pnpm('test:database')], env: 'test' },
    { id: 'build', title: 'Production build in the mirror', commands: [pnpm('build')], env: 'build' },
    { id: 'tests-bundle', title: 'Runtime checks against the built bundle', commands: [pnpm('test:runtime', '--bundle')], env: 'test' },
    { id: 'digest', title: 'Hash dist/server/wrangler.json and the build output' },
    {
      id: 'migrate',
      title: 'Apply migrations with CONCLAVE_MIGRATION_DATABASE_URL',
      commands: [[...node, 'scripts/migrate.mjs']],
      env: 'migrate',
      mutates: true,
    },
    {
      id: 'live-check',
      title: 'Read-only live verification: genesis hash, treasury token account, migrations, role, grants, TLS',
      commands: [
        [
          ...node,
          'scripts/check-readiness.mjs',
          '--target=live',
          ...(environment.production ? ['--production'] : []),
          `--schema=${environment.databaseSchema}`,
        ],
      ],
      env: 'live',
    },
    {
      id: 'deploy',
      title: 'Deploy the built Worker',
      commands: [
        pnpm('exec', 'wrangler', 'deploy', '--config', 'dist/server/wrangler.json', '--name', environment.workerName),
      ],
      env: 'deploy',
      mutates: true,
      confirmOnly: true,
    },
    { id: 'manifest', title: 'Print the deploy manifest' },
  ].map((step) => ({
    commands: [],
    env: null,
    mutates: false,
    confirmOnly: false,
    ...step,
  }));
}

export const runsIn = (step, mode) =>
  mode === 'plan'
    ? false
    : step.confirmOnly
      ? mode === 'confirm'
      : !(step.mutates && mode === 'dry-run');

/** Only the variables a step needs; test and build steps never see service credentials. */
export function stepEnvironment(kind, env) {
  const pick = (names) =>
    Object.fromEntries(
      names.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
    );
  const base = { ...pick(baseVariables), TZ: 'UTC' };
  switch (kind) {
    case 'build':
      return base;
    case 'test':
      return { ...base, ...pick(['CONCLAVE_TEST_DATABASE_URL']) };
    case 'migrate':
      return {
        ...base,
        ...pick(['CONCLAVE_DATABASE_CA_FILE']),
        CONCLAVE_DATABASE_URL: env.CONCLAVE_MIGRATION_DATABASE_URL ?? '',
      };
    case 'live':
      return {
        ...base,
        ...pick(
          Object.keys(env).filter(
            (name) => name.startsWith('CONCLAVE_') || name.startsWith('GATEWAY_'),
          ),
        ),
      };
    case 'deploy':
      return { ...base, ...pick(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) };
    default:
      throw new Error('Unknown step environment.');
  }
}

/** Presence and consistency of the operator's environment; reports names only. */
export function checkEnvironment(environment, env, mode) {
  const problems = [];
  const required = [
    ...environment.requiredEnvironment.worker,
    ...environment.requiredEnvironment.operator,
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length)
    problems.push(`Missing required environment variables: ${missing.join(', ')}.`);
  if (env.CONCLAVE_SOLANA_CLUSTER !== environment.expectedCluster)
    problems.push('CONCLAVE_SOLANA_CLUSTER does not match the cluster expected for this environment.');
  if (environment.workerName.startsWith('REPLACE_') && mode === 'confirm')
    problems.push('Set workerName for this environment in deploy/environments.json before deploying.');
  return problems;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Order-independent digest of a directory: sha256 over sorted `path\0filehash` lines. */
export function treeDigest(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(directory);
  const lines = files
    .map((path) => `${relative(directory, path).split('\\').join('/')}\0${sha256(readFileSync(path))}\n`)
    .sort();
  return { sha256: sha256(lines.join('')), files: lines.length };
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('A git command failed.');
  return result.stdout;
}

function copySource(root, mirror) {
  const files = git(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    root,
  )
    .split('\0')
    .filter(Boolean);
  let copied = 0;
  for (const file of files) {
    const from = join(root, file);
    if (!existsSync(from)) continue;
    const to = join(mirror, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
  return copied;
}

function execute(command, cwd, env) {
  const [program, ...args] = command;
  const result = spawnSync(program, args, {
    cwd,
    env,
    // Child output goes to stderr so stdout stays a single JSON document.
    stdio: ['ignore', 2, 2],
  });
  return result.status === 0;
}

async function run(options) {
  const environments = JSON.parse(
    readFileSync(join(projectDirectory, 'deploy/environments.json'), 'utf8'),
  ).environments;
  const scripts = JSON.parse(readFileSync(join(projectDirectory, 'package.json'), 'utf8')).scripts;
  const databaseFiles = databaseSuiteFiles(
    readFileSync(join(projectDirectory, 'scripts/check-database.mjs'), 'utf8'),
  );
  const environment = environments[options.environment];
  const plan = buildPlan(options, {
    environments,
    pureSuites: pureSuites(scripts, databaseFiles),
  });
  if (options.mode === 'plan') {
    process.stdout.write(
      JSON.stringify(
        {
          schema: 'conclave-deploy-plan-v1',
          environment: options.environment,
          steps: plan.map((step) => ({
            id: step.id,
            title: step.title,
            commands: step.commands.map((command) => command.join(' ')),
            mutates: step.mutates,
            runsInDryRun: runsIn(step, 'dry-run'),
            runsOnConfirm: runsIn(step, 'confirm'),
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  const manifest = {
    schema: 'conclave-deploy-manifest-v1',
    environment: options.environment,
    mode: options.mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    gitCommit: null,
    dirty: null,
    node: process.version,
    pnpm: null,
    wranglerConfigSha256: null,
    buildOutputSha256: null,
    buildOutputFiles: null,
    deployed: false,
    steps: [],
  };
  let root, mirror;
  let ok = true;
  try {
    for (const step of plan) {
      const entry = { id: step.id, status: 'skipped', startedAt: null, finishedAt: null };
      manifest.steps.push(entry);
      if (!ok || (!runsIn(step, options.mode) && step.id !== 'manifest')) continue;
      if (step.id === 'manifest') {
        entry.status = 'passed';
        continue;
      }
      entry.startedAt = new Date().toISOString();
      process.stderr.write(`==> ${step.id}: ${step.title}\n`);
      let passed = true;
      if (step.id === 'environment') {
        const problems = checkEnvironment(environment, process.env, options.mode);
        for (const problem of problems) process.stderr.write(`${problem}\n`);
        passed = problems.length === 0;
      } else if (step.id === 'source') {
        root = git(['rev-parse', '--show-toplevel'], projectDirectory).trim();
        manifest.gitCommit = git(['rev-parse', 'HEAD'], root).trim();
        manifest.dirty = git(['status', '--porcelain'], root).trim() !== '';
        if (manifest.dirty && !options.allowDirty) {
          process.stderr.write(
            options.mode === 'confirm'
              ? 'The source tree has uncommitted changes; commit them before deploying.\n'
              : 'The source tree has uncommitted changes; pass --allow-dirty to rehearse with them.\n',
          );
          passed = false;
        }
      } else if (step.id === 'mirror') {
        mirror = mkdtempSync(join(tmpdir(), 'conclave-deploy-'));
        copySource(root, mirror);
        manifest.pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout.trim();
      } else if (step.id === 'digest') {
        const config = join(mirror, 'dist/server/wrangler.json');
        manifest.wranglerConfigSha256 = sha256(readFileSync(config));
        const digest = treeDigest(join(mirror, 'dist'));
        manifest.buildOutputSha256 = digest.sha256;
        manifest.buildOutputFiles = digest.files;
      } else {
        const env = stepEnvironment(step.env, process.env);
        for (const command of step.commands) {
          if (!execute(command, mirror, env)) {
            process.stderr.write(`Step ${step.id} failed: ${command.join(' ')}\n`);
            passed = false;
            break;
          }
        }
        if (passed && step.id === 'deploy') manifest.deployed = true;
      }
      entry.status = passed ? 'passed' : 'failed';
      entry.finishedAt = new Date().toISOString();
      ok = passed;
    }
  } finally {
    manifest.finishedAt = new Date().toISOString();
    if (mirror && !options.keepMirror) rmSync(mirror, { recursive: true, force: true });
  }
  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (options.manifestOut) writeFileSync(options.manifestOut, text, { mode: 0o600 });
  process.stdout.write(text);
  return ok ? 0 : 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (failure) {
    process.stderr.write(`${failure.message}\n`);
    process.exit(1);
  }
  try {
    process.exitCode = await run(options);
  } catch {
    process.stderr.write(
      'The deploy sequence could not run. No configuration values are logged.\n',
    );
    process.exitCode = 1;
  }
}
