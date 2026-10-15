import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { FEATURE_SWITCHES } from '../components/dashboard/feature-switches.ts';
import {
  BASE_CHAT_MODELS,
  MORE_CHAT_MODELS,
  releasedChatFamilies,
} from '../lib/model-release.ts';
import { PPQ_MODEL_ALLOWLIST } from '../server/ppq/catalog.ts';
import { claimJob, recoverExpiredJobs } from '../server/db/jobs.ts';
import { runNextCall } from '../server/routes/call-worker.ts';

test('PostgreSQL worker leasing follows the seven-family release without opening held jobs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'conclave-released-worker-'));
  const database = join(directory, 'pg'),
    socket = join(directory, 'socket');
  const original = FEATURE_SWITCHES.moreModels;
  let pool,
    started = false;
  try {
    await mkdir(socket);
    execFileSync(
      'initdb',
      [
        '-D',
        database,
        '-U',
        'fixture',
        '-A',
        'trust',
        '--no-locale',
        '--encoding=UTF8',
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'pg_ctl',
      [
        '-D',
        database,
        '-l',
        join(directory, 'postgres.log'),
        '-o',
        `-h '' -k ${socket} -p 55439`,
        '-w',
        'start',
      ],
      { stdio: 'ignore' },
    );
    started = true;
    pool = new pg.Pool({
      host: socket,
      port: 55439,
      user: 'fixture',
      database: 'postgres',
      max: 4,
    });
    assert.equal(typeof runNextCall, 'function');
    await pool.query(
      `
      CREATE TABLE route_versions(id uuid PRIMARY KEY,family text,model_id text,modality text);
      CREATE TABLE calls(id uuid PRIMARY KEY,route_version_id uuid,account_id uuid,hold_id uuid,state text);
      CREATE TABLE holds(id uuid PRIMARY KEY,state text,cancel_requested_at timestamptz);
      CREATE TABLE crosscheck_review_calls(call_id uuid);
      CREATE TABLE brief_synthesis_executions(call_id uuid);
      CREATE TABLE jobs(id uuid PRIMARY KEY,kind text,reference text,payload jsonb,state text,
        run_after timestamptz DEFAULT now(),attempts integer DEFAULT0,max_attempts integer DEFAULT1,
        lease_token uuid,lease_expires_at timestamptz,updated_at timestamptz,last_error_code text);
    `
        .replaceAll('DEFAULT0', 'DEFAULT 0')
        .replaceAll('DEFAULT1', 'DEFAULT 1'),
    );
    let index = 0;
    async function seed(
      name,
      family,
      {
        model = PPQ_MODEL_ALLOWLIST[family]?.id,
        kind = 'inference',
        state = 'queued',
        modality = 'chat',
        group,
      } = {},
    ) {
      const route = crypto.randomUUID(),
        call = crypto.randomUUID(),
        hold = crypto.randomUUID();
      await pool.query('INSERT INTO route_versions VALUES($1,$2,$3,$4)', [
        route,
        family,
        model,
        modality,
      ]);
      await pool.query('INSERT INTO calls VALUES($1,$2,$3,$4,$5)', [
        call,
        route,
        crypto.randomUUID(),
        hold,
        'succeeded',
      ]);
      await pool.query("INSERT INTO holds VALUES($1,'settled',NULL)", [hold]);
      await pool.query(
        "INSERT INTO jobs(id,kind,reference,payload,state,run_after,lease_expires_at) VALUES($1,$2,$3,$4,$5,now()-make_interval(secs=>$6),now()-interval '1minute')",
        [
          crypto.randomUUID(),
          kind,
          name,
          { callId: call },
          state,
          1000 - index++,
        ],
      );
      if (group) await pool.query(`INSERT INTO ${group} VALUES($1)`, [call]);
    }
    for (const family of releasedChatFamilies())
      await seed(`chat-${family}`, family);
    await seed('held-crosscheck', 'deepseek', {
      group: 'crosscheck_review_calls',
    });
    await seed('held-synthesis', 'qwen', {
      group: 'brief_synthesis_executions',
    });
    await seed('held-receipt', 'llama', { kind: 'receipt' });
    await seed('held-media', 'runway', { modality: 'video' });
    await seed('wrong-family', 'llama', { model: PPQ_MODEL_ALLOWLIST.gpt.id });
    await seed('unknown-model', 'claude', { model: 'unreviewed-latest' });
    for (const family of MORE_CHAT_MODELS)
      await seed(`expired-${family}`, family, { state: 'running' });
    await seed('expired-crosscheck', 'deepseek', {
      state: 'running',
      group: 'crosscheck_review_calls',
    });
    await seed('expired-synthesis', 'qwen', {
      state: 'running',
      group: 'brief_synthesis_executions',
    });
    await t.test(
      'closed switch leases only original four and leaves added recovery untouched',
      async () => {
        FEATURE_SWITCHES.moreModels = false;
        const claimed = [];
        for (let i = 0; i < 5; i++) {
          const job = await claimJob(
            pool,
            ['inference'],
            120,
            'baseline-inference',
          );
          if (job) claimed.push(job.reference);
        }
        assert.deepEqual(
          claimed,
          BASE_CHAT_MODELS.map((f) => `chat-${f}`),
        );
        assert.equal(await recoverExpiredJobs(pool, 'baseline-inference'), 0);
      },
    );
    await t.test(
      'released switch leases each added exact model once and recovers only released inference',
      async () => {
        FEATURE_SWITCHES.moreModels = true;
        const claimed = [];
        for (let i = 0; i < 4; i++) {
          const job = await claimJob(
            pool,
            ['inference'],
            120,
            'baseline-inference',
          );
          if (job) claimed.push(job.reference);
        }
        assert.deepEqual(
          claimed,
          MORE_CHAT_MODELS.map((f) => `chat-${f}`),
        );
        assert.equal(await recoverExpiredJobs(pool, 'baseline-inference'), 3);
        assert.equal(
          await claimJob(pool, ['inference'], 120, 'baseline-inference'),
          null,
        );
      },
    );
    await t.test(
      'held tools, unknown models and mislabeled families retain their original state and zero attempts',
      async () => {
        const rows = (
          await pool.query(
            "SELECT reference,state,attempts FROM jobs WHERE reference LIKE 'held-%' OR reference IN ('wrong-family','unknown-model','expired-crosscheck','expired-synthesis')",
          )
        ).rows;
        assert.equal(rows.length, 8);
        for (const row of rows) {
          assert.equal(
            row.state,
            row.reference.startsWith('expired-') ? 'running' : 'queued',
          );
          assert.equal(row.attempts, 0);
        }
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM jobs WHERE reference LIKE 'chat-%' AND state='running' AND attempts=1",
            )
          ).rows[0].n,
          7,
        );
      },
    );
  } finally {
    FEATURE_SWITCHES.moreModels = original;
    await pool?.end();
    if (started)
      execFileSync('pg_ctl', ['-D', database, '-m', 'fast', '-w', 'stop'], {
        stdio: 'ignore',
      });
    await rm(directory, { recursive: true, force: true });
  }
});
