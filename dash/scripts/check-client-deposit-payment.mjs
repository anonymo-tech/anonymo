import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {
  buildDepositTransaction,
  encodeTransactionBase64,
} from '../lib/solana/deposit-transaction.ts';
import {
  createDepositPaymentClient,
  parseDepositPayment,
  depositPaymentTerms,
  sameDepositPayment,
  connectDepositWallet,
  signDepositPayment,
  isDepositWallet,
  DepositPaymentError,
  formatLamports,
} from '../lib/client/deposit-payment.ts';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = new Uint8Array(32).fill(4),
  source = bs58.encode(ed25519.getPublicKey(seed));
const address = (n) =>
  bs58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(n)));
const now = Math.floor(Date.now() / 1000) * 1000,
  iso = (n) => new Date(n).toISOString();
const intent = () => ({
  id: uuid(1),
  state: 'awaiting_payment',
  status: 'awaiting_payment',
  paymentWindowOpen: true,
  canReconcile: true,
  amountUsd6: '5000000',
  reference: address(5),
  cluster: 'mainnet-beta',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  sourceWallet: source,
  recipientWallet: address(6),
  recipientTokenAccount: address(7),
  createdAt: iso(now - 10000),
  expiresAt: iso(now + 890000),
  settlement: null,
});
function prepared(original = intent()) {
  const payment = {
    id: uuid(2),
    intentId: original.id,
    state: 'prepared',
    sourceTokenAccount: address(8),
    recentBlockhash: address(9),
    lastValidBlockHeight: '100000',
    contextSlot: '99000',
    feeLamports: '5000',
    preparedAt: iso(now),
    expiresAt: iso(now + 90000),
    signature: null,
    submittedAt: null,
    acknowledgedAt: null,
    finalizedAt: null,
    failureCode: null,
    canSign: true,
    canSubmit: true,
  };
  const built = buildDepositTransaction(depositPaymentTerms(payment, original));
  return {
    ...payment,
    messageBase64: encodeTransactionBase64(built.message),
    unsignedTransaction: encodeTransactionBase64(built.unsignedTransaction),
  };
}
const signed = (payment = prepared(), original = intent()) => {
  const built = buildDepositTransaction(depositPaymentTerms(payment, original)),
    wire = new Uint8Array(built.unsignedTransaction);
  wire.set(ed25519.sign(built.message, seed), 1);
  return {
    paymentId: payment.id,
    signedTransaction: encodeTransactionBase64(wire),
    wire,
    signature: bs58.encode(wire.slice(1, 65)),
  };
};
const submitted = (payment = prepared()) => ({
  ...payment,
  state: 'submitted',
  signature: signed(payment).signature,
  submittedAt: iso(now + 1000),
  acknowledgedAt: iso(now + 1000),
  canSign: false,
});
const account = () => ({
  address: source,
  publicKey: ed25519.getPublicKey(seed),
  chains: ['solana:mainnet'],
  features: ['solana:signTransaction'],
});
function wallet(sign = async () => [{ signedTransaction: signed().wire }]) {
  const accounts = [account()];
  return {
    name: 'Synthetic wallet',
    chains: ['solana:mainnet'],
    accounts,
    features: {
      'standard:connect': { connect: async () => ({ accounts }) },
      'standard:events': { on: () => () => {} },
      'solana:signTransaction': {
        supportedTransactionVersions: ['legacy'],
        signTransaction: sign,
      },
      'solana:signAndSendTransaction': {
        signAndSendTransaction: () =>
          assert.fail('sign and send must never be called'),
      },
    },
  };
}
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const failure = (code, unknown) => (error) =>
  error instanceof DepositPaymentError &&
  (!code || error.code === code) &&
  (unknown === undefined || error.outcomeUnknown === unknown);

void test('prepared transfer binds exact intent, message, fee and review expiry', () => {
  const p = prepared();
  assert.deepEqual(parseDepositPayment(p, intent()), p);
  for (const change of [
    { intentId: uuid(8) },
    { messageBase64: 'AAAA' },
    { unsignedTransaction: 'AAAA' },
    { sourceTokenAccount: address(10) },
    { recentBlockhash: address(11) },
    { expiresAt: iso(now + 91000) },
    { feeLamports: 5000 },
    { feeLamports: '5.0' },
    { feeLamports: '9007199254740992' },
    { canSign: 'true' },
    { state: 'unknown' },
    { signature: signed().signature },
    { submittedAt: iso(now + 1) },
  ])
    assert.throws(
      () => parseDepositPayment({ ...p, ...change }, intent()),
      failure('INVALID_RESPONSE'),
    );
  assert.throws(
    () => parseDepositPayment(p, { ...intent(), amountUsd6: '6000000' }),
    failure('INVALID_RESPONSE'),
  );
  assert.equal(formatLamports('5000'), '0.000005000');
});
void test('immutable attempt and signature survive transitions; independent intent credit is distinct', () => {
  const p = prepared(),
    s = submitted();
  assert.ok(sameDepositPayment(p, s));
  for (const change of [
    { id: uuid(3) },
    { unsignedTransaction: 'AAAA' },
    { feeLamports: '6000' },
    { expiresAt: iso(now + 89000) },
  ])
    assert.equal(sameDepositPayment(p, { ...p, ...change }), false);
  assert.equal(
    sameDepositPayment(s, {
      ...s,
      signature: bs58.encode(new Uint8Array(64).fill(3)),
    }),
    false,
  );
  const paid = {
    ...intent(),
    state: 'credited',
    status: 'credited',
    paymentWindowOpen: false,
    canReconcile: false,
    settlement: {
      signature: s.signature,
      transactionId: uuid(5),
      slot: '100000',
      blockTime: Math.floor(now / 1000),
      verifiedAt: iso(now + 5000),
    },
  };
  assert.equal(
    parseDepositPayment(
      {
        ...s,
        state: 'finalized',
        finalizedAt: iso(now + 5000),
        canSubmit: false,
      },
      paid,
    ).state,
    'finalized',
  );
  assert.equal(
    parseDepositPayment({ ...p, canSign: false, canSubmit: false }, paid).state,
    'prepared',
  );
  assert.throws(() =>
    parseDepositPayment(
      {
        ...p,
        state: 'finalized',
        finalizedAt: iso(now + 5000),
        canSign: false,
        canSubmit: false,
      },
      paid,
    ),
  );
});
void test('mainnet legacy wallet must expose the exact source account', async () => {
  const w = wallet();
  assert.equal(isDepositWallet(w), true);
  assert.equal((await connectDepositWallet(w, source)).address, source);
  for (const bad of [
    {},
    { ...w, chains: ['solana:devnet'] },
    { ...w, features: {} },
    {
      ...w,
      features: {
        ...w.features,
        'solana:signTransaction': {
          supportedTransactionVersions: [0],
          signTransaction: () => {},
        },
      },
    },
  ])
    assert.equal(isDepositWallet(bad), false);
  await assert.rejects(
    connectDepositWallet(w, address(10)),
    failure('WALLET_CHANGED'),
  );
});
void test('wallet receives exact unsigned bytes once and returns only a verified signed payload', async () => {
  let calls = 0;
  const w = wallet(async (input) => {
    calls++;
    assert.equal(input.chain, 'solana:mainnet');
    assert.equal(input.account.address, source);
    assert.equal(
      encodeTransactionBase64(input.transaction),
      prepared().unsignedTransaction,
    );
    return [{ signedTransaction: signed().wire }];
  });
  const result = await signDepositPayment(
    w,
    w.accounts[0],
    prepared(),
    intent(),
    { now: () => now },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    paymentId: uuid(2),
    signedTransaction: signed().signedTransaction,
  });
  assert.ok(Object.isFrozen(result));
});
void test('modified amount, blockhash, appended bytes, forged signature and extra outputs fail closed', async () => {
  const altered = signed(),
    corrupt = new Uint8Array(altered.wire);
  corrupt[1] ^= 1;
  const changedIntent = { ...intent(), amountUsd6: '6000000' };
  const cases = [
    [{ signedTransaction: corrupt }],
    [{ signedTransaction: new Uint8Array([...altered.wire, 0]) }],
    [
      {
        signedTransaction: signed(prepared(changedIntent), changedIntent).wire,
      },
    ],
    [
      {
        signedTransaction: signed({
          ...prepared(),
          recentBlockhash: address(10),
        }).wire,
      },
    ],
    [{ signedTransaction: altered.wire }, { signedTransaction: altered.wire }],
  ];
  for (const outputs of cases) {
    const w = wallet(async () => outputs);
    await assert.rejects(
      signDepositPayment(w, w.accounts[0], prepared(), intent(), {
        now: () => now,
      }),
      failure('WALLET_TRANSACTION_MISMATCH'),
    );
  }
});
void test('account changes, aborted lifetime, stale scope and expiry cannot yield a submission payload', async () => {
  let calls = 0;
  const expired = wallet(async () => {
    calls++;
    return [{ signedTransaction: signed().wire }];
  });
  await assert.rejects(
    signDepositPayment(expired, expired.accounts[0], prepared(), intent(), {
      now: () => now + 90000,
    }),
    failure('PAYMENT_RECOVERY_ONLY'),
  );
  assert.equal(calls, 0);
  const abort = new AbortController(),
    w = wallet(async () => {
      abort.abort();
      return [{ signedTransaction: signed().wire }];
    });
  await assert.rejects(
    signDepositPayment(w, w.accounts[0], prepared(), intent(), {
      signal: abort.signal,
      now: () => now,
    }),
    { name: 'AbortError' },
  );
  let current = true;
  const stale = wallet(async () => {
    current = false;
    return [{ signedTransaction: signed().wire }];
  });
  await assert.rejects(
    signDepositPayment(stale, stale.accounts[0], prepared(), intent(), {
      current: () => current,
      now: () => now,
    }),
    failure('PAYMENT_INTERRUPTED'),
  );
  const changed = wallet(async () => {
    changed.accounts = [];
    return [{ signedTransaction: signed().wire }];
  });
  await assert.rejects(
    signDepositPayment(changed, changed.accounts[0], prepared(), intent(), {
      now: () => now,
    }),
    failure('WALLET_CHANGED'),
  );
});
void test('caller mutation during wallet interaction does not alter the reviewed snapshot', async () => {
  const original = intent(),
    w = wallet(async () => {
      original.amountUsd6 = '6000000';
      return [{ signedTransaction: signed().wire }];
    });
  const result = await signDepositPayment(
    w,
    w.accounts[0],
    prepared(),
    original,
    { now: () => now },
  );
  assert.equal(result.signedTransaction, signed().signedTransaction);
});
void test('owned same-origin reads and preparation never submit automatically', async () => {
  const calls = [],
    client = createDepositPaymentClient(uuid(10), {
      fetch: async (path, options) => {
        calls.push({ path, options });
        return json({ deposit: intent(), payment: prepared(), replayed: true });
      },
    });
  await client.read(intent());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  await client.prepare(intent());
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, `/api/deposits/${uuid(1)}/payment`);
  assert.equal(calls[1].options.body, '{}');
  for (const { options } of calls) {
    assert.equal(options.headers['X-Conclave-Account-Id'], uuid(10));
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
  }
  await assert.rejects(
    client.read({ ...intent(), id: 'https://example.test/other' }),
  );
  assert.equal(calls.length, 2);
});
void test('unknown submit retains identical bytes and never automatically retries', async () => {
  let calls = 0;
  const bodies = [],
    client = createDepositPaymentClient(uuid(10), {
      fetch: async (_path, options) => {
        bodies.push(options.body);
        calls++;
        if (calls === 1) throw new Error('synthetic transport failure');
        return json({
          deposit: intent(),
          payment: submitted(),
          submitted: true,
          replayed: true,
        });
      },
    });
  const approval = {
    paymentId: uuid(2),
    signedTransaction: signed().signedTransaction,
  };
  await assert.rejects(
    client.submit(intent(), prepared(), approval),
    failure(undefined, true),
  );
  assert.equal(calls, 1);
  assert.equal(
    (await client.submit(intent(), prepared(), approval)).replayed,
    true,
  );
  assert.equal(bodies[0], bodies[1]);
});
void test('malformed or oversized accepted submission is uncertain without leaking diagnostics', async () => {
  for (const response of [
    json({
      deposit: intent(),
      payment: submitted(),
      submitted: 'true',
      replayed: false,
    }),
    json({
      deposit: intent(),
      payment: {
        ...submitted(),
        signature: bs58.encode(new Uint8Array(64).fill(8)),
      },
      submitted: true,
      replayed: false,
    }),
    json(
      {
        error: {
          code: 'RPC_UNAVAILABLE',
          message: 'synthetic private diagnostic',
        },
      },
      503,
    ),
    new Response('x'.repeat(33000), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ]) {
    const client = createDepositPaymentClient(uuid(10), {
      fetch: async () => response,
    });
    await assert.rejects(
      client.submit(intent(), prepared(), signed()),
      (error) =>
        failure(undefined, true)(error) &&
        !error.message.includes('synthetic private diagnostic'),
    );
  }
});
void test('explicit retry contains retained payment ID and no replacement bytes', async () => {
  const requests = [],
    client = createDepositPaymentClient(uuid(10), {
      fetch: async (path, options) => {
        requests.push({ path, options });
        return json({
          deposit: intent(),
          payment: submitted(),
          submitted: true,
          replayed: true,
        });
      },
    });
  await client.retry(intent(), submitted());
  assert.equal(requests[0].path, `/api/deposits/${uuid(1)}/payment/retry`);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    paymentId: uuid(2),
  });
  await assert.rejects(client.retry(intent(), prepared()));
  assert.equal(requests.length, 1);
});
void test('bounded reference recovery preserves the difference between incomplete and no matching page', async () => {
  const response = {
    deposit: intent(),
    credited: false,
    replayed: false,
    transactionId: null,
    search: {
      checked: 8,
      nextCursor: 'cursor_123',
      status: 'incomplete',
      exhaustive: false,
    },
  };
  const calls = [],
    client = createDepositPaymentClient(uuid(10), {
      fetch: async (path, options) => {
        calls.push({ path, options });
        return json(response);
      },
    });
  assert.equal((await client.recover(intent())).search.status, 'incomplete');
  await client.recover(intent(), 'cursor_123');
  assert.deepEqual(JSON.parse(calls[1].options.body), { cursor: 'cursor_123' });
  await assert.rejects(client.recover(intent(), 'https://example.test'));
  assert.equal(calls.length, 2);
  for (const search of [
    { ...response.search, exhaustive: true },
    { ...response.search, checked: 9 },
    { ...response.search, status: 'credited' },
  ])
    await assert.rejects(
      createDepositPaymentClient(uuid(10), {
        fetch: async () => json({ ...response, search }),
      }).recover(intent()),
    );
});
void test('stalled response body releases on timeout and account failures are sanitized', async () => {
  let cancelled = false;
  const client = createDepositPaymentClient(uuid(10), {
    timeoutMs: 5,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  });
  await assert.rejects(client.read(intent()), failure('PAYMENT_INTERRUPTED'));
  assert.equal(cancelled, true);
  await assert.rejects(
    createDepositPaymentClient(uuid(10), {
      fetch: async () => json({}, 401),
    }).read(intent()),
    failure('ACCOUNT_CHANGED'),
  );
});
void test('client and UI never persist signatures or import server modules', async () => {
  for (const path of [
    '../lib/client/deposit-payment.ts',
    '../components/dashboard/live-deposit-payment.tsx',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|indexedDB|from ['"][^'"]*server\//,
    );
    assert.doesNotMatch(source, /signAndSendTransaction/);
  }
});
