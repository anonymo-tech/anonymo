import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  createDepositsClient,
  DepositClientError,
  depositErrorMessage,
  depositSignature,
  formatDepositAmount,
  makeDepositCreation,
  parseDeposit,
  parseDepositAmount,
  parseDepositCapability,
  sameDepositTerms,
} from '../lib/client/deposits.ts';
import { depositCapability } from '../server/solana/deposit-config.ts';

const uuid = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const address = (number) => bs58.encode(new Uint8Array(32).fill(number));
const signature = (number) => bs58.encode(new Uint8Array(64).fill(number));
const owner = uuid(1),
  intentId = uuid(2),
  ledgerId = uuid(3),
  sourceWallet = address(3);
const env = {
  CONCLAVE_MODE: 'service',
  CONCLAVE_APP_ORIGIN: 'https://app.example.invalid',
  CONCLAVE_DATABASE_URL: 'postgresql://fixture.example.invalid/db',
  CONCLAVE_SOLANA_CLUSTER: 'devnet',
  CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example.invalid',
  CONCLAVE_DEPOSITS_ENABLED: 'true',
  CONCLAVE_TREASURY_WALLET: address(4),
  CONCLAVE_TREASURY_TOKEN_ACCOUNT: address(5),
  CONCLAVE_MAX_DEPOSIT_USD6: '100000000',
};
const capability = () => depositCapability(env);
const fixture = () => ({
  id: intentId,
  state: 'awaiting_payment',
  status: 'awaiting_payment',
  paymentWindowOpen: true,
  canReconcile: true,
  amountUsd6: '1250001',
  reference: address(6),
  cluster: 'devnet',
  mint: capability().mint,
  recipientWallet: address(4),
  recipientTokenAccount: address(5),
  sourceWallet,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:15:00.000Z',
  settlement: null,
});
const credited = () => ({
  ...fixture(),
  state: 'credited',
  status: 'credited',
  paymentWindowOpen: false,
  canReconcile: false,
  settlement: {
    signature: signature(8),
    transactionId: ledgerId,
    slot: '123456',
    blockTime: Date.parse('2026-01-01T00:01:00Z') / 1000,
    verifiedAt: '2026-01-01T00:30:00.000Z',
  },
});
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

void test('USDC parsing uses exact integer units and never rounds a seventh decimal place', () => {
  for (const [input, expected] of [
    ['0.000001', '1'],
    ['1.250001', '1250001'],
    [' 5.00 ', '5000000'],
    ['9000000000', '9000000000000000'],
  ])
    assert.equal(parseDepositAmount(input), expected);
  for (const value of [
    '0',
    '-1',
    '.1',
    '01',
    '1.0000001',
    '1e6',
    '1,000',
    'NaN',
    'Infinity',
    '9000000000.000001',
    '',
    '1.',
  ])
    assert.throws(() => parseDepositAmount(value), DepositClientError);
  assert.equal(formatDepositAmount('1250001'), '1.250001');
  assert.equal(formatDepositAmount('1'), '0.000001');
  assert.equal(formatDepositAmount('9000000000000000'), '9000000000.000000');
});

void test('current backend configuration contracts distinguish disabled, recovery-only and new-intent availability', () => {
  const disabled = parseDepositCapability(depositCapability({}));
  assert.equal(disabled.configured, false);
  assert.equal(disabled.recoveryConfigured, false);
  assert.equal(disabled.cluster, null);
  const available = parseDepositCapability(capability());
  assert.equal(available.configured, true);
  assert.equal(available.networkVerified, false);
  assert.equal(available.walletSubmission, false);
  assert.equal(
    parseDepositCapability(
      depositCapability({
        ...env,
        CONCLAVE_DEPOSIT_PAYMENTS_ENABLED: 'true',
      }),
    ).walletSubmission,
    true,
  );
  const recovery = parseDepositCapability(
    depositCapability({
      ...env,
      CONCLAVE_DEPOSITS_ENABLED: 'false',
      CONCLAVE_DEPOSIT_RECOVERY_ENABLED: 'true',
    }),
  );
  assert.equal(recovery.configured, false);
  assert.equal(recovery.recoveryConfigured, true);
  for (const update of [
    { networkVerified: true },
    { walletSubmission: 'true' },
    { mint: address(9) },
    { cluster: 'testnet' },
    { intentSeconds: 0 },
    { recipientTokenAccount: address(4) },
    { maximumUsd6: null },
  ])
    assert.throws(
      () => parseDepositCapability({ ...capability(), ...update }),
      DepositClientError,
    );
  assert.throws(
    () =>
      parseDepositCapability({
        ...recovery,
        walletSubmission: true,
      }),
    DepositClientError,
  );
});

void test('owned intent states preserve expiry recovery and current payment gates separately', () => {
  assert.equal(parseDeposit(fixture(), intentId).amountUsd6, '1250001');
  const gated = parseDeposit({ ...fixture(), paymentWindowOpen: false });
  assert.equal(gated.status, 'awaiting_payment');
  assert.equal(gated.paymentWindowOpen, false);
  const expired = parseDeposit({
    ...fixture(),
    status: 'expired',
    paymentWindowOpen: false,
  });
  assert.equal(expired.canReconcile, true);
  const settled = parseDeposit(credited());
  assert.equal(settled.status, 'credited');
  assert.equal(settled.settlement.signature, signature(8));
  for (const update of [
    { state: 'credited' },
    { status: 'credited' },
    { status: 'expired', paymentWindowOpen: true },
    { state: 'rejected' },
    { mint: address(9) },
    { recipientWallet: sourceWallet },
    { reference: address(4) },
    { amountUsd6: '01' },
    { expiresAt: fixture().createdAt },
  ])
    assert.throws(
      () => parseDeposit({ ...fixture(), ...update }),
      DepositClientError,
    );
  assert.throws(() => parseDeposit(fixture(), uuid(90)), DepositClientError);
});

void test('settlement must be credited, in the original payment window, and backed by consistent identifiers', () => {
  assert.equal(sameDepositTerms(fixture(), credited()), true);
  assert.equal(
    sameDepositTerms(fixture(), { ...credited(), amountUsd6: '2000000' }),
    false,
  );
  for (const mutate of [
    (value) => {
      value.canReconcile = true;
    },
    (value) => {
      value.settlement = null;
    },
    (value) => {
      value.settlement.blockTime = Date.parse(value.expiresAt) / 1000;
    },
    (value) => {
      value.settlement.blockTime = Date.parse(value.createdAt) / 1000 - 1;
    },
    (value) => {
      value.settlement.slot = '9007199254740992';
    },
    (value) => {
      value.settlement.slot = '-1';
    },
    (value) => {
      value.settlement.signature = sourceWallet;
    },
    (value) => {
      value.settlement.transactionId = 'not-a-ledger-id';
    },
  ]) {
    const value = credited();
    mutate(value);
    assert.throws(() => parseDeposit(value), DepositClientError);
  }
  assert.throws(
    () => parseDeposit({ ...fixture(), settlement: credited().settlement }),
    DepositClientError,
  );
});

void test('canonical transaction signatures are distinct from wallet addresses, URLs and malformed base58', () => {
  assert.equal(depositSignature(` ${signature(8)}\n`), signature(8));
  for (const value of [
    sourceWallet,
    `https://example.invalid/tx/${signature(8)}`,
    '0'.repeat(88),
    `${signature(8)} extra`,
    '',
    null,
  ])
    assert.throws(() => depositSignature(value), DepositClientError);
});

void test('a frozen creation request retains exact terms and one key after response loss; retries are explicit', async () => {
  const creation = makeDepositCreation(
    '1250001',
    sourceWallet,
    'deposit-request-key-0001',
  );
  assert.throws(() => {
    creation.amountUsd6 = '1000000';
  }, TypeError);
  const requests = [];
  const client = createDepositsClient(owner, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) throw new TypeError('PRIVATE NETWORK BODY');
      return json({ deposit: fixture(), replayed: true });
    },
  });
  await assert.rejects(
    client.create(creation, capability()),
    (failure) =>
      failure.code === 'NETWORK_ERROR' && !failure.message.includes('PRIVATE'),
  );
  assert.equal(requests.length, 1);
  const recovered = await client.create(creation, capability());
  assert.equal(recovered.replayed, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.body, requests[1].options.body);
  assert.deepEqual(JSON.parse(requests[0].options.body), creation);
  assert.equal(requests[0].url, '/api/deposits');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['X-Conclave-Account-Id'], owner);
  for (const field of ['credentials', 'mode'])
    assert.equal(requests[0].options[field], 'same-origin');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.cache, 'no-store');
});

void test('new-intent responses cannot silently change the reviewed amount, wallet, network or treasury', async () => {
  const creation = makeDepositCreation(
    '1250001',
    sourceWallet,
    'deposit-request-key-0001',
  );
  for (const update of [
    { amountUsd6: '1250002' },
    { sourceWallet: address(9) },
    { recipientTokenAccount: address(9) },
    { recipientWallet: address(9) },
    {
      cluster: 'mainnet-beta',
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    },
  ]) {
    const client = createDepositsClient(owner, {
      fetch: async () =>
        json({ deposit: { ...fixture(), ...update }, replayed: false }),
    });
    await assert.rejects(
      client.create(creation, capability()),
      (failure) => failure.code === 'INVALID_RESPONSE' && failure.status === 0,
    );
  }
});

void test('account-bound identity reads accept only server verified source wallets', async () => {
  const requests = [];
  const client = createDepositsClient(owner, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return json({
        accountId: owner,
        identities: [
          { kind: 'solana', subject: sourceWallet },
          { kind: 'passkey', subject: 'credential-id' },
        ],
      });
    },
  });
  assert.deepEqual(await client.wallets(), [sourceWallet]);
  assert.equal(requests[0].url, '/api/auth/session');
  assert.equal(requests[0].options.headers['X-Conclave-Account-Id'], owner);
  await assert.rejects(
    createDepositsClient(owner, {
      fetch: async () =>
        json({
          accountId: uuid(90),
          identities: [{ kind: 'solana', subject: sourceWallet }],
        }),
    }).wallets(),
    DepositClientError,
  );
  await assert.rejects(
    createDepositsClient(owner, {
      fetch: async () =>
        json({
          accountId: owner,
          identities: [{ kind: 'solana', subject: 'unverified' }],
        }),
    }).wallets(),
    DepositClientError,
  );
});

void test('list, capability and saved-status reads never construct or submit a wallet transaction', async () => {
  const requests = [];
  const client = createDepositsClient(owner, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return url.includes('capabilities')
        ? json(capability())
        : url.includes('cursor=')
          ? json({ deposits: [fixture()], nextCursor: null })
          : json({ deposit: credited() });
    },
  });
  await client.capability();
  await client.list('opaque+/=cursor');
  await client.read(intentId);
  assert.ok(
    requests.every(
      (item) =>
        item.options.method === 'GET' && item.options.body === undefined,
    ),
  );
  assert.equal(requests[1].url, '/api/deposits?cursor=opaque%2B%2F%3Dcursor');
  assert.equal(requests[2].url, `/api/deposits/${intentId}`);
});

void test('explicit signature reconciliation verifies the same intent and credits only the returned signature/ledger match', async () => {
  const requests = [];
  const result = await createDepositsClient(owner, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      return json({
        deposit: credited(),
        credited: true,
        replayed: false,
        transactionId: ledgerId,
      });
    },
  }).reconcile(fixture(), signature(8));
  assert.equal(result.credited, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/deposits/${intentId}/reconcile`);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    signature: signature(8),
  });
  for (const mutate of [
    (value) => {
      value.transactionId = uuid(90);
    },
    (value) => {
      value.credited = false;
    },
    (value) => {
      value.deposit.settlement.signature = signature(9);
    },
    (value) => {
      value.deposit.reference = address(9);
    },
    (value) => {
      value.deposit.amountUsd6 = '1250002';
    },
    (value) => {
      value.deposit.id = uuid(90);
    },
  ]) {
    const value = {
      deposit: credited(),
      credited: true,
      replayed: false,
      transactionId: ledgerId,
    };
    mutate(value);
    await assert.rejects(
      createDepositsClient(owner, { fetch: async () => json(value) }).reconcile(
        fixture(),
        signature(8),
      ),
      DepositClientError,
    );
  }
});

void test('pending, failed and unavailable recovery responses stay distinct and do not claim credit', async () => {
  for (const [code, status] of [
    ['SOLANA_NOT_FINALIZED', 422],
    ['SOLANA_TRANSACTION_FAILED', 422],
    ['SOLANA_DEPOSIT_MISMATCH', 422],
    ['DEPOSIT_RECOVERY_UNAVAILABLE', 503],
    ['DEPOSIT_POLICY_UNAVAILABLE', 503],
  ]) {
    let requests = 0;
    const client = createDepositsClient(owner, {
      fetch: async () => {
        requests++;
        return json(
          { error: { code, message: 'PRIVATE ENDPOINT AND SIGNATURE' } },
          status,
        );
      },
    });
    await assert.rejects(
      client.reconcile(fixture(), signature(8)),
      (failure) =>
        failure.code === code &&
        failure.status === status &&
        !depositErrorMessage(failure).includes('PRIVATE'),
    );
    assert.equal(requests, 1);
  }
});

void test('aborted requests and account changes never publish late private state', async () => {
  const before = new AbortController();
  before.abort();
  let requests = 0;
  await assert.rejects(
    createDepositsClient(owner, {
      signal: before.signal,
      fetch: async () => {
        requests++;
        return json({ deposit: fixture() });
      },
    }).read(intentId),
    (failure) => failure.name === 'AbortError',
  );
  assert.equal(requests, 0);
  const late = new AbortController();
  await assert.rejects(
    createDepositsClient(owner, {
      signal: late.signal,
      fetch: async () => {
        late.abort();
        return json({ deposit: fixture() });
      },
    }).read(intentId),
    (failure) => failure.name === 'AbortError',
  );
  await assert.rejects(
    createDepositsClient(owner, {
      fetch: async () =>
        new Response('PRIVATE'.repeat(100_000), { status: 401 }),
    }).read(intentId),
    (failure) =>
      failure.status === 401 &&
      failure.code === 'ACCOUNT_CHANGED' &&
      !failure.message.includes('PRIVATE'),
  );
});

void test('stalled or oversized mutation responses remain uncertain and do not retry automatically', async () => {
  let requests = 0;
  await assert.rejects(
    createDepositsClient(owner, {
      timeoutMs: 1,
      fetch: async (_url, { signal }) => {
        requests++;
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          ),
        );
      },
    }).reconcile(fixture(), signature(8)),
    (failure) => failure.code === 'REQUEST_TIMEOUT',
  );
  assert.equal(requests, 1);
  await assert.rejects(
    createDepositsClient(owner, {
      fetch: async () =>
        new Response(' '.repeat(131073), {
          headers: { 'content-type': 'application/json' },
        }),
    }).reconcile(fixture(), signature(8)),
    (failure) =>
      failure.code === 'RESPONSE_TOO_LARGE' &&
      failure.status === 0 &&
      failure.message.includes('may still have completed'),
  );
});

void test('list bounds, duplicate intents, broken JSON and wrong requested IDs are rejected', async () => {
  for (const page of [
    {
      deposits: Array.from({ length: 21 }, (_, index) => ({
        ...fixture(),
        id: uuid(30 + index),
      })),
      nextCursor: null,
    },
    { deposits: [fixture(), fixture()], nextCursor: null },
    { deposits: [], nextCursor: { invalid: true } },
  ])
    await assert.rejects(
      createDepositsClient(owner, { fetch: async () => json(page) }).list(),
      DepositClientError,
    );
  await assert.rejects(
    createDepositsClient(owner, {
      fetch: async () =>
        new Response('{broken', {
          headers: { 'content-type': 'application/json' },
        }),
    }).list(),
    DepositClientError,
  );
  await assert.rejects(
    createDepositsClient(owner, {
      fetch: async () => json({ deposit: { ...fixture(), id: uuid(90) } }),
    }).read(intentId),
    DepositClientError,
  );
});
