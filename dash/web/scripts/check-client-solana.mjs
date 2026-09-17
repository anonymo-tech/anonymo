import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  ExplainerError,
  parseExplanation,
  readTransactionExplanation,
  transactionSignature,
} from '../lib/client/solana.ts';
import { explainParsedTransaction } from '../server/solana/explain.ts';
import { SOLANA_NETWORKS, TOKEN_PROGRAM } from '../server/solana/validation.ts';

const signature = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
const otherSignature = bs58.encode(new Uint8Array(64).fill(12));
const address = (n) => bs58.encode(new Uint8Array(32).fill(n));
const accountId = '00000000-0000-4000-8000-000000000001';
const transaction = () => ({
  slot: 123456,
  transaction: {
    signatures: [signature],
    message: {
      instructions: [
        { programId: address(9), parsed: { type: 'unknown', info: {} } },
        {
          programId: TOKEN_PROGRAM,
          parsed: {
            type: 'approve',
            info: {
              source: address(1),
              delegate: address(2),
              owner: address(3),
              amount: '2500000',
            },
          },
        },
      ],
    },
  },
  meta: { err: null, innerInstructions: [] },
});
const fixture = (raw = transaction()) => {
  const explanation = explainParsedTransaction(raw);
  return {
    ...explanation,
    cluster: 'devnet',
    genesisHash: SOLANA_NETWORKS.devnet.genesisHash,
    finality: 'finalized',
    flags: explanation.flags.filter(
      (flag) => flag.code !== 'FINALITY_UNVERIFIED',
    ),
  };
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const clone = (value) => JSON.parse(JSON.stringify(value));

void test('accepts only a canonical 64-byte base58 transaction signature, never a wallet address or URL', () => {
  assert.equal(transactionSignature(` ${signature}\n`), signature);
  for (const value of [
    address(1),
    `https://example.invalid/tx/${signature}`,
    '',
    '0'.repeat(88),
    `${signature} extra`,
    '1'.repeat(89),
    null,
  ])
    assert.throws(() => transactionSignature(value), ExplainerError);
});

void test('current deterministic decoder output is accepted and critical warnings precede unknown-program warnings', () => {
  const parsed = parseExplanation(fixture(), signature);
  assert.equal(parsed.finality, 'finalized');
  assert.equal(parsed.execution, 'succeeded');
  assert.equal(parsed.flags[0].code, 'TOKEN_APPROVAL');
  assert.equal(parsed.flags[0].severity, 'critical');
  assert.equal(parsed.flags[1].code, 'UNKNOWN_PROGRAM');
  assert.equal(parsed.instructions[1].fields.amountRaw, '2500000');
  assert.equal(parsed.instructions[0].kind, 'unknown');
  const incompleteEnvelope = fixture();
  incompleteEnvelope.flags = [];
  assert.equal(
    parseExplanation(incompleteEnvelope, signature).flags[0].code,
    'TOKEN_APPROVAL',
    'per-instruction warnings remain prominent',
  );
});

void test('failed and unknown execution stay distinct from finalized inclusion', () => {
  const failed = transaction();
  failed.meta.err = { InstructionError: [0, 'Custom'] };
  const parsed = parseExplanation(fixture(failed), signature);
  assert.equal(parsed.execution, 'failed');
  assert.ok(parsed.flags.some((flag) => flag.code === 'TRANSACTION_FAILED'));
  const unknown = transaction();
  unknown.meta = null;
  const parsedUnknown = parseExplanation(fixture(unknown), signature);
  assert.equal(parsedUnknown.execution, 'unknown');
  assert.ok(
    parsedUnknown.flags.some((flag) => flag.code === 'INCOMPLETE_METADATA'),
  );
});

void test('rejects wrong signature, unverified finality, wrong genesis/cluster, unsafe slot and critical downgrade', () => {
  for (const change of [
    { signature: otherSignature },
    { finality: 'not-verified' },
    { cluster: 'testnet' },
    { genesisHash: SOLANA_NETWORKS['mainnet-beta'].genesisHash },
    { slot: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(
      () => parseExplanation({ ...fixture(), ...change }, signature),
      ExplainerError,
    );
  const downgraded = fixture();
  downgraded.instructions[1].flags[0].severity = 'info';
  assert.throws(() => parseExplanation(downgraded, signature), ExplainerError);
});

void test('enforces instruction, field, warning, location and text budgets before rendering', () => {
  const tooMany = fixture();
  tooMany.instructions = Array.from({ length: 257 }, () =>
    clone(tooMany.instructions[0]),
  );
  assert.throws(() => parseExplanation(tooMany, signature), ExplainerError);
  const fields = fixture();
  fields.instructions[0].fields = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`field${i}`, 'value']),
  );
  assert.throws(() => parseExplanation(fields, signature), ExplainerError);
  const flags = fixture();
  flags.flags = Array.from({ length: 2052 }, () => clone(flags.flags[0]));
  assert.throws(() => parseExplanation(flags, signature), ExplainerError);
  const duplicate = fixture();
  duplicate.instructions[1].location = duplicate.instructions[0].location;
  assert.throws(() => parseExplanation(duplicate, signature), ExplainerError);
  const missing = fixture();
  missing.flags[0].instruction = '63.127';
  assert.throws(() => parseExplanation(missing, signature), ExplainerError);
  const control = fixture();
  control.instructions[0].description = 'a\u0000b';
  assert.throws(() => parseExplanation(control, signature), ExplainerError);
  const giant = fixture();
  giant.instructions[0].description = 'x'.repeat(1025);
  assert.throws(() => parseExplanation(giant, signature), ExplainerError);
});

void test('read request uses one fixed same-origin account-bound endpoint and signature-only payload', async () => {
  const requests = [];
  const value = await readTransactionExplanation(signature, accountId, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return json({ explanation: fixture() });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/explanations');
  const options = requests[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.mode, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['X-Conclave-Account-Id'], accountId);
  assert.deepEqual(JSON.parse(options.body), { signature });
  assert.equal(value.signature, signature);
});

void test('RPC configuration and availability errors are static and never echo server bodies or remove input', async () => {
  const entered = signature;
  for (const [code, status] of [
    ['RPC_UNAVAILABLE', 503],
    ['SOLANA_NOT_FINALIZED', 422],
    ['SOLANA_WRONG_CLUSTER', 422],
    ['SOLANA_UNSUPPORTED_TRANSACTION', 422],
    ['SOLANA_RPC_TIMEOUT', 422],
  ]) {
    await assert.rejects(
      readTransactionExplanation(entered, accountId, {
        fetch: async () =>
          json(
            { error: { code, message: 'PRIVATE RPC ENDPOINT AND BODY' } },
            status,
          ),
      }),
      (error) =>
        error instanceof ExplainerError &&
        error.code === code &&
        !error.message.includes('PRIVATE'),
    );
  }
  assert.equal(entered, signature);
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      fetch: async () =>
        new Response('PRIVATE'.repeat(200000), { status: 401 }),
    }),
    (error) => error.status === 401 && !error.message.includes('PRIVATE'),
  );
});

void test('abort before request sends nothing; late and timed-out reads never publish a result', async () => {
  let requests = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      signal: controller.signal,
      fetch: async () => {
        requests++;
        return json({ explanation: fixture() });
      },
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(requests, 0);
  const late = new AbortController();
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      signal: late.signal,
      fetch: async () => {
        late.abort();
        return json({ explanation: fixture() });
      },
    }),
    (error) => error.name === 'AbortError',
  );
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      timeoutMs: 1,
      fetch: async (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          ),
        ),
    }),
    (error) => error.code === 'REQUEST_TIMEOUT',
  );
});

void test('oversized/invalid JSON and wrong requested signatures fail with no partial explanation', async () => {
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      fetch: async () =>
        new Response(' '.repeat(1048577), {
          headers: { 'content-type': 'application/json' },
        }),
    }),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      fetch: async () =>
        json({ explanation: { ...fixture(), signature: otherSignature } }),
    }),
    ExplainerError,
  );
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      fetch: async () =>
        new Response('{invalid', {
          headers: { 'content-type': 'application/json' },
        }),
    }),
    ExplainerError,
  );
});

void test('untrusted description strings remain literal text without being turned into links or markup', () => {
  const value = fixture();
  value.instructions[0].description =
    '<img src=x onerror=bad()> https://example.invalid';
  assert.equal(
    parseExplanation(value, signature).instructions[0].description,
    value.instructions[0].description,
  );
});

void test('rejects coerced execution/severity enums, unsupported decoder versions and omitted uncertainty flags', () => {
  for (const execution of [['failed'], ['succeeded'], {}, true, 0]) {
    assert.throws(
      () => parseExplanation({ ...fixture(), execution }, signature),
      ExplainerError,
    );
  }
  const malformedSeverity = fixture();
  malformedSeverity.instructions[0].flags[0].severity = ['warning'];
  assert.throws(
    () => parseExplanation(malformedSeverity, signature),
    ExplainerError,
  );
  assert.throws(
    () =>
      parseExplanation({ ...fixture(), decoderVersion: 'future' }, signature),
    ExplainerError,
  );
  const missingUnknown = fixture();
  missingUnknown.instructions[0].flags = [];
  assert.throws(
    () => parseExplanation(missingUnknown, signature),
    ExplainerError,
  );
  for (const execution of ['failed', 'unknown']) {
    assert.throws(
      () => parseExplanation({ ...fixture(), execution }, signature),
      ExplainerError,
    );
  }
  const downgrade = fixture();
  downgrade.instructions[0].flags[0].severity = 'info';
  assert.throws(() => parseExplanation(downgrade, signature), ExplainerError);
});

void test('duplicate global/local warnings retain the stronger severity', () => {
  const value = fixture();
  value.flags.find((flag) => flag.code === 'UNKNOWN_PROGRAM').severity =
    'critical';
  assert.equal(
    parseExplanation(value, signature).flags.find(
      (flag) => flag.code === 'UNKNOWN_PROGRAM',
    ).severity,
    'critical',
  );
});

void test('Token-2022 explanations always disclose uninspected extension state and reject suppressed flags', () => {
  const raw = transaction();
  raw.transaction.message.instructions[1].programId =
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const value = fixture(raw);
  assert.ok(
    parseExplanation(value, signature).flags.some(
      (flag) => flag.code === 'TOKEN_2022_STATE_UNINSPECTED',
    ),
  );
  value.instructions[1].flags = value.instructions[1].flags.filter(
    (flag) => flag.code !== 'TOKEN_2022_STATE_UNINSPECTED',
  );
  assert.throws(() => parseExplanation(value, signature), ExplainerError);
});

void test('timeout bounds an uncooperative fetch and stuck body, including cancellation cleanup', async () => {
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      timeoutMs: 5,
      fetch: () => new Promise(() => {}),
    }),
    (error) => error.code === 'REQUEST_TIMEOUT',
  );
  let cancelled = false;
  await assert.rejects(
    readTransactionExplanation(signature, accountId, {
      timeoutMs: 5,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    }),
    (error) => error.code === 'REQUEST_TIMEOUT',
  );
  assert.equal(cancelled, true);
});

void test('oversized declared bodies and expired sessions cancel their unread stream', async () => {
  for (const kind of ['oversized', 'expired']) {
    let cancelled = false;
    await assert.rejects(
      readTransactionExplanation(signature, accountId, {
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              status: kind === 'expired' ? 401 : 200,
              headers: {
                'content-type': 'application/json',
                'content-length': '9999999',
              },
            },
          ),
      }),
      ExplainerError,
    );
    assert.equal(cancelled, true);
  }
});
