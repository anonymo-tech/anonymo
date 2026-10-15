import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  secondLookRequest,
  secondLookError,
  SECOND_LOOK_REQUEST_TIMEOUT_MS,
} from '../lib/client/second-look.ts';
const accountId = randomUUID();
const session = () =>
  Response.json({
    accountId,
    identities: [
      { kind: 'solana', subject: '11111111111111111111111111111111' },
    ],
  });
const result = () => Response.json({ ok: true });
const valid = (value) => value?.ok === true;
const never = () => new Promise(() => {});
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const request = (fetch, extra = {}) =>
  secondLookRequest('second-look/signature/inspect', {
    accountId,
    body: { kind: 'domain', url: 'https://example.com' },
    validate: valid,
    fetch,
    timeoutMs: 100,
    ...extra,
  });
const timedOut = (error) =>
  error.code === 'REQUEST_TIMEOUT' &&
  /outcome may be unknown/.test(secondLookError(error));
function stalled(onCancel = () => {}) {
  return new Response(new ReadableStream({ cancel: onCancel }), {
    headers: { 'content-type': 'application/json' },
  });
}
test('normal request preserves both owner checks and performs one mutation only', async () => {
  const calls = [];
  const output = await request(async (url, init) => {
    calls.push([url, init.method]);
    assert.ok(init.signal instanceof AbortSignal);
    return url === '/api/auth/session' ? session() : result();
  });
  assert.deepEqual(output, { ok: true });
  assert.deepEqual(calls, [
    ['/api/auth/session', 'GET'],
    ['/api/second-look/signature/inspect', 'POST'],
    ['/api/auth/session', 'GET'],
  ]);
  assert.equal(SECOND_LOOK_REQUEST_TIMEOUT_MS, 60000);
});
test('stalled initial session fetch expires without dispatching mutation', async () => {
  let calls = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        return never();
      },
      { timeoutMs: 10 },
    ),
    timedOut,
  );
  assert.equal(calls, 1);
});
test('stalled initial session body expires and cancels the upstream reader', async () => {
  let calls = 0,
    cancelled = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        return stalled(() => {
          cancelled++;
        });
      },
      { timeoutMs: 10 },
    ),
    timedOut,
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});
test('stalled mutation fetch expires without a retry or trailing session request', async () => {
  const calls = [];
  let mutationSignal;
  await assert.rejects(
    request(
      async (url, init) => {
        calls.push(url);
        if (url === '/api/auth/session') return session();
        mutationSignal = init.signal;
        return never();
      },
      { timeoutMs: 10 },
    ),
    timedOut,
  );
  assert.equal(calls.length, 2);
  assert.equal(mutationSignal.aborted, true);
});
test('stalled mutation body expires even when stream cancellation never resolves', async () => {
  let calls = 0,
    cancelled = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        return calls === 1
          ? session()
          : stalled(() => {
              cancelled++;
              return never();
            });
      },
      { timeoutMs: 10 },
    ),
    timedOut,
  );
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
});
test('stalled final owner check never releases a possibly cross-account result', async () => {
  let calls = 0,
    validated = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        return calls === 1 ? session() : calls === 2 ? result() : never();
      },
      {
        timeoutMs: 10,
        validate: (value) => {
          validated++;
          return valid(value);
        },
      },
    ),
    timedOut,
  );
  assert.equal(calls, 3);
  assert.equal(validated, 0);
});
test('one deadline covers owner checks and mutation rather than resetting per request', async () => {
  let calls = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        await sleep(30);
        return calls === 1 ? session() : result();
      },
      { timeoutMs: 50 },
    ),
    timedOut,
  );
  assert.equal(calls, 2);
});
test('already aborted caller dispatches nothing and preserves cancellation semantics', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        return session();
      },
      { signal: controller.signal },
    ),
    (error) => error.name === 'AbortError',
  );
  assert.equal(calls, 0);
});
test('caller abort terminates a stalled body and is not mislabeled timeout', async () => {
  const controller = new AbortController();
  let calls = 0,
    cancelled = 0;
  const pending = request(
    async () => {
      calls++;
      if (calls === 1) return session();
      setTimeout(() => controller.abort(), 5);
      return stalled(() => {
        cancelled++;
      });
    },
    { signal: controller.signal },
  );
  await assert.rejects(
    pending,
    (error) => error.name === 'AbortError' && error.code !== 'REQUEST_TIMEOUT',
  );
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
});
test('response arriving after the deadline has its body cancelled and is not consumed', async () => {
  let resolveFetch,
    cancelled = 0;
  const pending = request(
    () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    { timeoutMs: 10 },
  );
  await assert.rejects(pending, timedOut);
  resolveFetch(
    stalled(() => {
      cancelled++;
    }),
  );
  await sleep(0);
  assert.equal(cancelled, 1);
});
test('invalid content-type cancels an unread body without a trailing owner check', async () => {
  let calls = 0,
    cancelled = 0;
  await assert.rejects(
    request(async () => {
      calls++;
      return calls === 1
        ? session()
        : new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { headers: { 'content-type': 'text/html' } },
          );
    }),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
});
test('oversized response cancels a hostile stream without waiting on cancel', async () => {
  let calls = 0,
    cancelled = 0;
  await assert.rejects(
    request(async () => {
      calls++;
      return calls === 1
        ? session()
        : new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(1048577));
              },
              cancel() {
                cancelled++;
                return never();
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
    }),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
});
test('invalid timeout overrides cannot disable or extend the production deadline', async () => {
  for (const timeoutMs of [0, -1, 60001, Infinity, NaN, '50', 1.5]) {
    let calls = 0;
    await assert.rejects(
      request(
        async () => {
          calls++;
          return result();
        },
        { timeoutMs },
      ),
      (error) => error.code === 'INVALID_TIMEOUT',
    );
    assert.equal(calls, 0);
  }
});
test('account change and service errors retain existing safe semantics', async () => {
  let calls = 0;
  await assert.rejects(
    request(async () => {
      calls++;
      return calls === 1
        ? session()
        : calls === 2
          ? result()
          : Response.json({
              accountId: randomUUID(),
              identities: [
                { kind: 'solana', subject: '11111111111111111111111111111111' },
              ],
            });
    }),
    (error) => error.code === 'SESSION_CHANGED',
  );
  calls = 0;
  await assert.rejects(
    request(async () =>
      ++calls === 1
        ? session()
        : Response.json(
            { error: { code: 'RATE_LIMITED', message: 'untrusted text' } },
            { status: 429 },
          ),
    ),
    (error) =>
      error.code === 'RATE_LIMITED' &&
      error.status === 429 &&
      !error.message.includes('untrusted'),
  );
  assert.equal(calls, 2);
});

test('stalled final session body is cancelled before any result validation', async () => {
  let calls = 0,
    cancelled = 0,
    validated = 0;
  await assert.rejects(
    request(
      async () => {
        calls++;
        return calls === 1
          ? session()
          : calls === 2
            ? result()
            : stalled(() => {
                cancelled++;
                return never();
              });
      },
      {
        timeoutMs: 10,
        validate: (value) => {
          validated++;
          return valid(value);
        },
      },
    ),
    timedOut,
  );
  assert.equal(calls, 3);
  assert.equal(cancelled, 1);
  assert.equal(validated, 0);
});
