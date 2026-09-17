import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { readPreSignInspection as inspect } from '../server/solana/pre-sign.ts';
import {
  parsePreSignInspection,
  readPreSignInspection,
  serializedTransaction,
  serializedTransactionHash,
} from '../lib/client/pre-sign.ts';
const key = (n) => bs58.encode(new Uint8Array(32).fill(n));
const system = '11111111111111111111111111111111',
  token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const accountId = 'fd6cb92c-2694-45f3-af92-fbe9a2c120a6';
function wire({
  version = 'legacy',
  program = system,
  data = Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
  indexes = [0, 1],
} = {}) {
  return Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    ...(version === 'legacy' ? [] : [Buffer.from([128])]),
    Buffer.from([1, 0, 1, 3]),
    ...[key(1), key(2), program].map((a) => Buffer.from(bs58.decode(a))),
    Buffer.from(bs58.decode(key(9))),
    Buffer.from([1, 2, indexes.length, ...indexes, data.length]),
    data,
    ...(version === 'legacy' ? [] : [Buffer.from([0])]),
  ]).toString('base64');
}
const transaction = wire(),
  hash = createHash('sha256')
    .update(Buffer.from(transaction, 'base64'))
    .digest('hex');
async function result(encoded = transaction, simulation = {}) {
  return inspect(
    'devnet',
    async (method, params) => {
      if (method === 'getGenesisHash')
        return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      assert.equal(method, 'simulateTransaction');
      return {
        context: { slot: 120 },
        value: {
          err: null,
          unitsConsumed: 50,
          fee: 5000,
          loadedAddresses: { writable: [], readonly: [] },
          replacementBlockhash: {
            blockhash: key(8),
            lastValidBlockHeight: 150,
          },
          accounts: params[1].accounts.addresses.map(() => ({
            owner: system,
            executable: false,
            lamports: 10,
            data: ['', 'base64'],
            space: 0,
          })),
          innerInstructions: [],
          ...simulation,
        },
      };
    },
    encoded,
    undefined,
    { now: () => Date.parse('2026-01-01T00:00:00.000Z') },
  );
}
const valid = await result(),
  clone = () => structuredClone(valid);
const response = (value = valid, status = 200) =>
  new Response(JSON.stringify(status === 200 ? { inspection: value } : value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const rejected = (value) =>
  assert.throws(() => parsePreSignInspection(value, hash), {
    code: 'INVALID_RESPONSE',
  });
function mutations(cases) {
  for (const mutate of cases) {
    const v = clone();
    mutate(v);
    rejected(v);
  }
}
test('server legacy and v0 round trip with exact wire hash', async () => {
  assert.deepEqual(parsePreSignInspection(valid, hash), valid);
  const encoded = wire({ version: 0 }),
    value = await result(encoded);
  assert.deepEqual(
    parsePreSignInspection(value, await serializedTransactionHash(encoded)),
    value,
  );
  assert.equal(await serializedTransactionHash(transaction), hash);
});
test('canonical packet envelope rejects short, oversized, noncanonical and URL input', () => {
  for (const s of [
    'https://example.invalid/tx',
    'AA==',
    transaction.replace(/.$/, '!'),
    transaction + '=',
    'A'.repeat(1648),
    transaction.slice(0, 20) + '\n' + transaction.slice(20),
  ])
    assert.throws(() => serializedTransaction(s), {
      code: 'INVALID_TRANSACTION',
    });
  assert.equal(
    serializedTransaction(' ' + transaction + '\n').encoded,
    transaction,
  );
});
test('input, network, UTC, version and signatures bind evidence', () =>
  mutations([
    (v) => (v.transactionHash = 'f'.repeat(64)),
    (v) => (v.genesisHash = key(8)),
    (v) => (v.inspectedAt = '2026-01-01T01:00:00.000+01:00'),
    (v) => (v.inspectedAt = '2026-02-30T00:00:00.000Z'),
    (v) => (v.readerVersion = '2'),
    (v) => (v.input.signaturesVerified = true),
    (v) => (v.input.presentSignatures = 2),
  ]));
test('exact DTO rejects arbitrary logs, payload, extra keys and changed limits', () =>
  mutations([
    (v) => (v.logs = ['payload']),
    (v) => (v.simulation.logs = ['payload']),
    (v) => (v.input.wire = transaction),
    (v) => (v.limits.rpcCalls = 4),
    (v) => (v.instructions[0].fields = { constructor: 'bad' }),
  ]));
test('account roles, loaded groups and instruction locations are checked', () =>
  mutations([
    (v) => (v.accounts[0].writable = false),
    (v) => (v.accounts[1].signer = true),
    (v) => (v.accounts[1].address = v.accounts[0].address),
    (v) => (v.instructions[0].location = '1'),
    (v) => (v.instructions[0].programId = key(90)),
    (v) => (v.lookups.writable = [key(80)]),
  ]));
test('critical instruction flags cannot be removed or downgraded', async () => {
  const encoded = wire({
      program: token,
      data: Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]),
      indexes: [0, 1, 0],
    }),
    original = await result(encoded),
    binding = await serializedTransactionHash(encoded);
  assert.equal(original.instructions[0].kind, 'approve');
  parsePreSignInspection(original, binding);
  for (const mutate of [
    (v) => (v.instructions[0].flags = []),
    (v) => (v.instructions[0].flags[0].severity = 'info'),
  ]) {
    const v = structuredClone(original);
    mutate(v);
    assert.throws(() => parsePreSignInspection(v, binding), {
      code: 'INVALID_RESPONSE',
    });
  }
  const malformed = clone();
  malformed.instructions[0].kind = 'malformed';
  malformed.instructions[0].flags = [];
  rejected(malformed);
});
test('mandatory warnings, duplicates and severities are validated', () =>
  mutations([
    (v) =>
      (v.warnings = v.warnings.filter(
        (w) => w.code !== 'SIMULATION_NOT_SAFETY',
      )),
    (v) => v.warnings.push(v.warnings[0]),
    (v) => (v.warnings[0].severity = 'info'),
    (v) => (v.warnings[0].message = '\u202eunsafe'),
  ]));
test('success does not permit errors, verified signatures or complete effects', () =>
  mutations([
    (v) => (v.simulation.signatureVerification = true),
    (v) => (v.simulation.effectsComplete = true),
    (v) => (v.simulation.contextSlot = null),
    (v) =>
      (v.simulation.error = {
        category: 'transaction',
        instructionIndex: null,
        code: 'execution-failed',
        customCode: null,
      }),
  ]));
test('failed and unavailable evidence excludes provider prose and mixed post-state', async () => {
  const failed = await result(transaction, {
    err: { InstructionError: [0, { Custom: 91 }] },
  });
  assert.equal(
    parsePreSignInspection(failed, hash).simulation.error.customCode,
    '91',
  );
  const unavailable = await result(transaction, { accounts: 'malformed' });
  assert.equal(
    parsePreSignInspection(unavailable, hash).simulation.status,
    'unavailable',
  );
  const forged = structuredClone(unavailable);
  forged.simulation.accounts = valid.simulation.accounts;
  rejected(forged);
});
test('nonce and not-run require compatible blockhash and cause', () =>
  mutations([
    (v) => (v.input.nonce = 'durable'),
    (v) => (v.simulation.status = 'not-run'),
    (v) => (v.simulation.blockhashReplacementRequested = false),
  ]));
test('rounded amounts, mismatched accounts and malformed token state reject', () =>
  mutations([
    (v) => (v.simulation.feeLamports = 5000),
    (v) => (v.simulation.unitsConsumed = '01'),
    (v) => (v.simulation.accounts[0].lamports = '18446744073709551616'),
    (v) => (v.simulation.accounts[0].address = key(7)),
    (v) => (v.simulation.accounts[0].dataStatus = 'decoded'),
    (v) => (v.simulation.accounts[0].exists = false),
    (v) => (v.simulation.requestedAccounts = [system]),
  ]));
test('explicit request carries account, same-origin scope and exact body without retry', async () => {
  let calls = 0;
  const value = await readPreSignInspection(transaction, accountId, {
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, '/api/pre-sign-inspections');
      assert.equal(options.headers['X-Conclave-Account-Id'], accountId);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.mode, 'same-origin');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.deepEqual(JSON.parse(options.body), { transaction });
      return response();
    },
  });
  assert.equal(calls, 1);
  assert.equal(value.transactionHash, hash);
});
test('invalid input/account and aborted requests perform no fetch', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return response();
  };
  await assert.rejects(
    readPreSignInspection('not base64', accountId, { fetch }),
    { code: 'INVALID_TRANSACTION' },
  );
  await assert.rejects(
    readPreSignInspection(transaction, 'invalid', { fetch }),
    { code: 'ACCOUNT_REQUIRED' },
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    readPreSignInspection(transaction, accountId, { fetch, signal: c.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});
test('401 cancels unread body and reports session expiry', async () => {
  let cancelled = false;
  await assert.rejects(
    readPreSignInspection(transaction, accountId, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401 },
        ),
    }),
    { code: 'ACCOUNT_REQUIRED', status: 401 },
  );
  assert.equal(cancelled, true);
});
test('static errors never reflect server prose', async () => {
  await assert.rejects(
    readPreSignInspection(transaction, accountId, {
      fetch: async () =>
        response(
          {
            error: { code: 'REQUEST_FAILED', message: 'secret provider prose' },
          },
          500,
        ),
    }),
    (e) => !e.message.includes('secret provider prose'),
  );
  await assert.rejects(
    readPreSignInspection(transaction, accountId, {
      fetch: async () =>
        response(
          { error: { code: 'SOLANA_SENSITIVE_INPUT', message: 'secret' } },
          422,
        ),
    }),
    (e) =>
      e.code === 'SOLANA_SENSITIVE_INPUT' &&
      e.message.includes('not sent to the RPC'),
  );
});
test('content type, declared size, oversized stream and invalid UTF8 reject', async () => {
  for (const factory of [
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () =>
      new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'content-length': '524289',
        },
      }),
    () =>
      new Response(' '.repeat(524289), {
        headers: { 'content-type': 'application/json' },
      }),
    () =>
      new Response(new Uint8Array([255]), {
        headers: { 'content-type': 'application/json' },
      }),
  ])
    await assert.rejects(
      readPreSignInspection(transaction, accountId, {
        fetch: async () => factory(),
      }),
    );
});
test('deadline bounds abort-ignoring fetch', async () => {
  await assert.rejects(
    readPreSignInspection(transaction, accountId, {
      timeoutMs: 15,
      fetch: async () => new Promise(() => {}),
    }),
    { code: 'REQUEST_TIMEOUT' },
  );
});
test('deadline cancels stalled bodies', async () => {
  let cancelled = false;
  await assert.rejects(
    readPreSignInspection(transaction, accountId, {
      timeoutMs: 15,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    }),
    { code: 'REQUEST_TIMEOUT' },
  );
  assert.equal(cancelled, true);
});

test('stake merge retains its closure warning across the client boundary', async () => {
  const encoded = wire({
    program: 'Stake11111111111111111111111111111111111111',
    data: Buffer.from([7, 0, 0, 0]),
    indexes: [1, 0, 0],
  });
  const value = await result(encoded),
    binding = await serializedTransactionHash(encoded);
  assert.equal(value.instructions[0].kind, 'stakeMerge');
  parsePreSignInspection(value, binding);
  value.instructions[0].flags = value.instructions[0].flags.filter(
    (flag) => flag.code !== 'ACCOUNT_CLOSURE',
  );
  assert.throws(() => parsePreSignInspection(value, binding), {
    code: 'INVALID_RESPONSE',
  });
});
test('partial-effects warnings and requested account coverage cannot silently disappear', () => {
  for (const code of [
    'ACCOUNTS_INCOMPLETE',
    'INNER_INSTRUCTIONS_UNINSPECTED',
  ]) {
    const value = clone();
    value.warnings = value.warnings.filter((w) => w.code !== code);
    value.simulation.innerInstructions = 'not-returned';
    rejected(value);
  }
  const missing = clone();
  missing.simulation.requestedAccounts = [];
  missing.simulation.accounts = [];
  missing.simulation.omittedWritableAccounts = 0;
  rejected(missing);
  const replaced = clone();
  replaced.simulation.replacementBlockhash = null;
  replaced.warnings = replaced.warnings.filter(
    (w) => w.code !== 'BLOCKHASH_REPLACED',
  );
  rejected(replaced);
});
