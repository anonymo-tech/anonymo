import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {
  buildDepositTransaction,
  validateUnsignedDepositTransaction,
  validateSignedDepositTransaction,
  encodeTransactionBase64,
  decodeTransactionBase64,
  DepositTransactionError,
  DEPOSIT_TOKEN_PROGRAM,
} from '../lib/solana/deposit-transaction.ts';
import { createPaymentRpc } from '../server/solana/payment-rpc.ts';
import { SOLANA_NETWORKS } from '../server/solana/validation.ts';

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const key = (value) => bs58.encode(new Uint8Array(32).fill(value));
const terms = {
  sourceWallet: bs58.encode(ed25519.getPublicKey(seed)),
  sourceTokenAccount: key(33),
  recipientTokenAccount: key(34),
  mint: SOLANA_NETWORKS.devnet.usdcMint,
  reference: key(35),
  amountUsd6: '1000001',
  recentBlockhash: key(36),
};
const signed = (input = terms) => {
  const result = buildDepositTransaction(input);
  result.unsignedTransaction.set(ed25519.sign(result.message, seed), 1);
  return result.unsignedTransaction;
};
const code = (value) => (error) => error.code === value;

void test('canonical legacy transfer has one signer and one exact checked instruction', () => {
  const { message, unsignedTransaction } = buildDepositTransaction(terms);
  assert.equal(message.length, 247);
  assert.equal(unsignedTransaction.length, 312);
  assert.deepEqual([...message.subarray(0, 4)], [1, 0, 3, 6]);
  const keys = Array.from({ length: 6 }, (_, i) =>
    bs58.encode(message.subarray(4 + i * 32, 36 + i * 32)),
  );
  assert.deepEqual(keys, [
    terms.sourceWallet,
    terms.sourceTokenAccount,
    terms.recipientTokenAccount,
    terms.mint,
    terms.reference,
    DEPOSIT_TOKEN_PROGRAM,
  ]);
  assert.equal(bs58.encode(message.subarray(196, 228)), terms.recentBlockhash);
  assert.deepEqual(
    [...message.subarray(228, 238)],
    [1, 5, 5, 1, 3, 2, 0, 4, 10, 12],
  );
  assert.equal(new DataView(message.buffer).getBigUint64(238, true), 1000001n);
  assert.equal(message[246], 6);
  assert.equal(unsignedTransaction[0], 1);
  assert.ok(unsignedTransaction.subarray(1, 65).every((byte) => byte === 0));
  validateUnsignedDepositTransaction(unsignedTransaction, terms);
});
void test('amount encoding preserves full unsigned 64 bit precision', () => {
  for (const amountUsd6 of ['1', '9007199254740993', '18446744073709551615']) {
    const { message } = buildDepositTransaction({ ...terms, amountUsd6 });
    assert.equal(
      new DataView(message.buffer).getBigUint64(238, true).toString(),
      amountUsd6,
    );
  }
  for (const amountUsd6 of [
    '0',
    '01',
    '1.0',
    '-1',
    '18446744073709551616',
    '1e6',
  ])
    assert.throws(
      () => buildDepositTransaction({ ...terms, amountUsd6 }),
      DepositTransactionError,
    );
});
void test('all terms are canonical distinct public keys with no duplicate privileges', () => {
  for (const field of [
    'sourceWallet',
    'sourceTokenAccount',
    'recipientTokenAccount',
    'mint',
    'reference',
    'recentBlockhash',
  ])
    assert.throws(
      () => buildDepositTransaction({ ...terms, [field]: 'invalid' }),
      DepositTransactionError,
    );
  assert.throws(
    () =>
      buildDepositTransaction({
        ...terms,
        sourceTokenAccount: terms.sourceWallet,
      }),
    DepositTransactionError,
  );
  assert.throws(
    () =>
      buildDepositTransaction({ ...terms, reference: DEPOSIT_TOKEN_PROGRAM }),
    DepositTransactionError,
  );
});
void test('wallet signature verifies the exact prepared message and yields an independent snapshot', () => {
  const wire = signed(),
    result = validateSignedDepositTransaction(wire, terms);
  assert.equal(result.signature, bs58.encode(wire.subarray(1, 65)));
  wire.fill(0);
  assert.notEqual(result.signedTransaction[0], 0);
  assert.throws(
    () => validateUnsignedDepositTransaction(result.signedTransaction, terms),
    DepositTransactionError,
  );
});
void test('wallet rewrites missing signatures and noncanonical transaction formats are refused', () => {
  const valid = signed();
  for (const index of [0, 1, 65, 68, 70, 261, 293, 294, 295, 302, 311]) {
    const changed = valid.slice();
    changed[index] ^= 1;
    assert.throws(
      () => validateSignedDepositTransaction(changed, terms),
      DepositTransactionError,
    );
  }
  assert.throws(
    () =>
      validateSignedDepositTransaction(new Uint8Array([...valid, 0]), terms),
    DepositTransactionError,
  );
  assert.throws(
    () => validateSignedDepositTransaction(valid.subarray(0, 311), terms),
    DepositTransactionError,
  );
  assert.throws(
    () =>
      validateSignedDepositTransaction(
        buildDepositTransaction(terms).unsignedTransaction,
        terms,
      ),
    DepositTransactionError,
  );
  assert.throws(
    () =>
      validateSignedDepositTransaction(
        signed({ ...terms, amountUsd6: '2' }),
        terms,
      ),
    DepositTransactionError,
  );
});
void test('strict canonical bounded base64 roundtrips message and transaction', () => {
  for (const value of Object.values(buildDepositTransaction(terms)))
    assert.deepEqual(
      decodeTransactionBase64(encodeTransactionBase64(value)),
      value,
    );
  for (const value of ['', 'AA', 'AA==\n', 'AA_=', 'AB==', 'A'.repeat(1648)])
    assert.throws(
      () => decodeTransactionBase64(value),
      DepositTransactionError,
    );
  assert.throws(
    () => encodeTransactionBase64(new Uint8Array(1233)),
    DepositTransactionError,
  );
});
function options(fetcher, extra = {}) {
  return {
    rpcUrl: 'https://rpc.example.test/confidential-endpoint?key=synthetic',
    cluster: 'devnet',
    fetcher,
    ...extra,
  };
}
function json(body, value) {
  return Response.json({
    jsonrpc: '2.0',
    id: JSON.parse(body).id,
    result: value,
  });
}
void test('payment RPC uses explicit JSON methods without redirects cookies or automatic retries', async () => {
  const calls = [];
  const rpc = createPaymentRpc(
    options(async (url, init) => {
      calls.push({ url, init });
      return json(init.body, SOLANA_NETWORKS.devnet.genesisHash);
    }),
  );
  await rpc.verifyGenesis();
  assert.equal(calls.length, 1);
  const { init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(Object.keys(init.headers).sort(), [
    'Accept',
    'Content-Type',
  ]);
  assert.equal(JSON.parse(init.body).method, 'getGenesisHash');
  await assert.rejects(rpc.call('requestAirdrop', []), code('invalid_input'));
  await assert.rejects(
    rpc.call('getTransaction', ['x'.repeat(12001)]),
    code('invalid_input'),
  );
  assert.equal(calls.length, 1);
});
void test('wrong chain and malformed RPC envelopes fail closed', async () => {
  const wrong = createPaymentRpc(
    options(async (_u, init) =>
      json(init.body, SOLANA_NETWORKS['mainnet-beta'].genesisHash),
    ),
  );
  await assert.rejects(wrong.verifyGenesis(), code('wrong_cluster'));
  for (const payload of [
    { jsonrpc: '2.0', id: 'wrong', result: 1 },
    { jsonrpc: '2.0', id: 'wrong', error: { message: 'private' } },
  ]) {
    const rpc = createPaymentRpc(options(async () => Response.json(payload)));
    await assert.rejects(
      rpc.call('getBlockHeight', []),
      code('invalid_response'),
    );
  }
});
void test('RPC response bodies and declared sizes are bounded with static sanitized errors', async () => {
  for (const response of [
    () =>
      new Response('x'.repeat(129), {
        headers: { 'content-type': 'application/json' },
      }),
    () =>
      new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'content-length': '100000',
        },
      }),
  ]) {
    const rpc = createPaymentRpc(
      options(async () => response(), { maximumBytes: 128 }),
    );
    await assert.rejects(
      rpc.call('getBlockHeight', []),
      (error) =>
        error.code === 'response_too_large' &&
        !error.message.includes('synthetic'),
    );
  }
  const unavailable = createPaymentRpc(
    options(async () => {
      throw new Error('confidential-endpoint synthetic');
    }),
  );
  await assert.rejects(
    unavailable.call('getBlockHeight', []),
    (error) => error.message === 'rpc_unavailable',
  );
});
void test('RPC timeout covers a stalled stream and cancels its reader', async () => {
  let cancelled = false;
  const rpc = createPaymentRpc(
    options(
      async () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      { timeoutMs: 10 },
    ),
  );
  await assert.rejects(rpc.call('getBlockHeight', []), code('rpc_timeout'));
  assert.equal(cancelled, true);
});
void test('RPC external cancellation aborts a fetch without leaking request details', async () => {
  const controller = new AbortController();
  const rpc = createPaymentRpc(
    options(async () => new Promise(() => {}), { timeoutMs: 1000 }),
  );
  const pending = rpc.call('getBlockHeight', [], controller.signal);
  controller.abort();
  await assert.rejects(pending, code('cancelled'));
});
