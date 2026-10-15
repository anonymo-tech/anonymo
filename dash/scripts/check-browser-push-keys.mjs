import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBrowserPush } from './generate-browser-push.mjs';
import {
  pushConfig,
  pushCapability,
} from '../server/second-look/push-config.ts';

test('push key setup creates a private matching pair, keeps delivery off and refuses replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conclave-push-test-'));
  try {
    const path = join(dir, 'push.env');
    await generateBrowserPush(path, 'https://conclave.example');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const initial = await readFile(path, 'utf8');
    const env = Object.fromEntries(
      initial
        .trim()
        .split('\n')
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    assert.equal(pushCapability(pushConfig(env)).configured, false);
    assert.equal(
      pushCapability(
        pushConfig({ ...env, CONCLAVE_SECOND_LOOK_PUSH_ENABLED: 'true' }),
      ).configured,
      true,
    );
    await assert.rejects(
      generateBrowserPush(path, 'https://conclave.example'),
      { code: 'EEXIST' },
    );
    assert.equal(await readFile(path, 'utf8'), initial);
    await assert.rejects(
      generateBrowserPush(join(dir, 'bad.env'), 'http://localhost'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
