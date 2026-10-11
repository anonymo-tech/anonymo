import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import bs58 from 'bs58';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { testEndpoint } from './check-database.mjs';
import {
  searchOwnedDeposit,
  DEPOSIT_SEARCH_PAGE_SIZE,
} from '../server/solana/deposit-search.ts';
import { getBalance } from '../server/ledger/ledger.ts';
import {
  SOLANA_NETWORKS,
  TOKEN_PROGRAM,
  SolanaError,
} from '../server/solana/index.ts';

const connection = testEndpoint(process.env.CONCLAVE_TEST_DATABASE_URL).href;
const pool = createDatabase(connection, 8);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('External requests are disabled in this test.');
};
before(() => migrate(pool));
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
});
const key = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
const txid = () => bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
async function fixture({ blockTime = Math.floor(Date.now() / 1000) } = {}) {
  const accountId = randomUUID(),
    intentId = randomUUID();
  const sourceWallet = key(),
    sourceAccount = key(),
    recipientWallet = key(),
    recipientAccount = key(),
    reference = key();
  const mint = SOLANA_NETWORKS.devnet.usdcMint;
  const signature = bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
  const policy = {
    cluster: 'devnet',
    recipientWallet,
    recipientTokenAccount: recipientAccount,
    usdcMint: mint,
  };
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
  await pool.query(
    `INSERT INTO deposit_intents(id,account_id,source_wallet,reference,amount_usd6,policy,created_at,expires_at)
    VALUES($1,$2,$3,$4,1000000,$5,$6,$7)`,
    [
      intentId,
      accountId,
      sourceWallet,
      reference,
      policy,
      new Date((blockTime - 10) * 1000),
      new Date((blockTime + 300) * 1000),
    ],
  );
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, 1000000n, true);
  data[9] = 6;
  const balance = (accountIndex, owner, amount) => ({
    accountIndex,
    mint,
    owner,
    programId: TOKEN_PROGRAM,
    uiTokenAmount: {
      amount,
      decimals: 6,
      uiAmount: null,
      uiAmountString: 'ignored',
    },
  });
  const evidence = {
    cluster: 'devnet',
    genesisHash: SOLANA_NETWORKS.devnet.genesisHash,
    signature,
    status: {
      slot: 1000,
      confirmations: null,
      err: null,
      confirmationStatus: 'finalized',
    },
    transaction: {
      version: 'legacy',
      slot: 1000,
      blockTime,
      meta: {
        err: null,
        innerInstructions: [],
        loadedAddresses: { writable: [], readonly: [] },
        preTokenBalances: [
          balance(1, sourceWallet, '9000000'),
          balance(2, recipientWallet, '0'),
        ],
        postTokenBalances: [
          balance(1, sourceWallet, '8000000'),
          balance(2, recipientWallet, '1000000'),
        ],
      },
      transaction: {
        signatures: [signature],
        message: {
          header: {
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 3,
          },
          accountKeys: [
            sourceWallet,
            sourceAccount,
            recipientAccount,
            mint,
            reference,
            TOKEN_PROGRAM,
          ],
          instructions: [
            {
              programIdIndex: 5,
              accounts: [1, 3, 2, 0, 4],
              data: bs58.encode(data),
            },
          ],
        },
      },
    },
  };
  return {
    accountId,
    intentId,
    evidence,
    policy,
    sourceWallet,
    reference,
    env: {
      CONCLAVE_MODE: 'service',
      CONCLAVE_APP_ORIGIN: 'https://example.test',
      CONCLAVE_DATABASE_URL: connection,
      CONCLAVE_SOLANA_CLUSTER: 'devnet',
      CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example.invalid/solana',
      CONCLAVE_TREASURY_WALLET: recipientWallet,
      CONCLAVE_TREASURY_TOKEN_ACCOUNT: recipientAccount,
      CONCLAVE_MAX_DEPOSIT_USD6: '10000000',
      CONCLAVE_DEPOSITS_ENABLED: 'false',
      CONCLAVE_DEPOSIT_RECOVERY_ENABLED: 'true',
    },
  };
}

function candidate(signature, slot = 1000) {
  return {
    signature,
    slot,
    err: null,
    memo: null,
    blockTime: null,
    confirmationStatus: null,
  };
}
function evidenceFor(f, id = f.evidence.signature, change) {
  const evidence = structuredClone(f.evidence);
  evidence.signature = id;
  evidence.transaction.transaction.signatures[0] = id;
  change?.(evidence);
  return evidence;
}
function readerFor(f, candidates, values = new Map()) {
  const reads = [],
    pages = [];
  return {
    reads,
    pages,
    async readSignaturesForReference(reference, before, limit, signal) {
      assert.equal(reference, f.reference);
      assert.equal(limit, DEPOSIT_SEARCH_PAGE_SIZE);
      assert.equal(signal.aborted, false);
      pages.push(before);
      return typeof candidates === 'function' ? candidates(before) : candidates;
    },
    async readDepositEvidence(id, signal) {
      reads.push(id);
      assert.equal(signal.aborted, false);
      const value = values.has(id) ? values.get(id) : evidenceFor(f, id);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}
const search = (f, reader, cursor = null, extra = {}) =>
  searchOwnedDeposit(
    pool,
    { accountId: f.accountId, intentId: f.intentId, cursor },
    { env: f.env, reader, ...extra },
  );
async function noCredit(f) {
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '0');
}

void test('reference discovery credits only full finalized evidence despite nullable index metadata', async () => {
  const f = await fixture(),
    reader = readerFor(f, [candidate(f.evidence.signature)]);
  const result = await search(f, reader);
  assert.equal(result.credited, true);
  assert.equal(result.replayed, false);
  assert.equal(result.deposit.settlement.signature, f.evidence.signature);
  assert.equal(result.transactionId, result.deposit.settlement.transactionId);
  assert.deepEqual(result.search, {
    checked: 1,
    nextCursor: null,
    status: 'credited',
    exhaustive: false,
  });
  assert.deepEqual(reader.pages, [null]);
  assert.deepEqual(reader.reads, [f.evidence.signature]);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
});

void test('mere reference presence, wrong amounts and unrelated instructions never credit', async () => {
  for (const alter of [
    (e) => {
      e.transaction.transaction.message.accountKeys[4] = key();
    },
    (e) => {
      e.transaction.transaction.message.accountKeys[3] = key();
    },
    (e) => {
      e.transaction.transaction.message.accountKeys[2] = key();
    },
    (e) => {
      e.transaction.transaction.message.instructions = [];
    },
    (e) => {
      const data = bs58.decode(
        e.transaction.transaction.message.instructions[0].data,
      );
      new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(
        1,
        2000000n,
        true,
      );
      e.transaction.transaction.message.instructions[0].data =
        bs58.encode(data);
    },
  ]) {
    const f = await fixture(),
      evidence = evidenceFor(f, undefined, alter);
    const result = await search(
      f,
      readerFor(
        f,
        [candidate(evidence.signature)],
        new Map([[evidence.signature, evidence]]),
      ),
    );
    assert.equal(result.credited, false);
    assert.equal(result.search.status, 'no_match_on_page');
    assert.equal(result.search.checked, 1);
    assert.equal(result.search.exhaustive, false);
    await noCredit(f);
  }
});

void test('late discovery accepts finalized payment inside the original expired intent window only', async () => {
  const old = Math.floor(Date.now() / 1000) - 3600,
    f = await fixture({ blockTime: old });
  const result = await search(
    f,
    readerFor(f, [candidate(f.evidence.signature)]),
  );
  assert.equal(result.credited, true);
  const outside = await fixture({ blockTime: old }),
    evidence = evidenceFor(outside);
  evidence.transaction.blockTime = old + 300;
  const rejected = await search(
    outside,
    readerFor(
      outside,
      [candidate(evidence.signature)],
      new Map([[evidence.signature, evidence]]),
    ),
  );
  assert.equal(rejected.credited, false);
  await noCredit(outside);
});

void test('concurrent discovery and credited replay produce one journal and need no subsequent RPC or gate', async () => {
  const f = await fixture(),
    reader = readerFor(f, [candidate(f.evidence.signature)]);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => search(f, reader)),
  );
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(new Set(results.map((r) => r.transactionId)).size, 1);
  assert.equal((await getBalance(pool, f.accountId)).availableUsd6, '1000000');
  const replay = await searchOwnedDeposit(
    pool,
    { accountId: f.accountId, intentId: f.intentId },
    {
      env: {},
      reader: {
        readSignaturesForReference() {
          assert.fail('Replay must not use RPC');
        },
        readDepositEvidence() {
          assert.fail('Replay must not use RPC');
        },
      },
    },
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.search.checked, 0);
});

void test('foreign owners, disabled accounts, disabled recovery and changed policy fail before discovery', async () => {
  const f = await fixture(),
    other = await fixture(),
    reader = readerFor(f, []);
  await assert.rejects(
    searchOwnedDeposit(
      pool,
      { accountId: other.accountId, intentId: f.intentId },
      { env: f.env, reader },
    ),
    { code: 'DEPOSIT_NOT_FOUND' },
  );
  await assert.rejects(
    search(f, reader, null, {
      env: { ...f.env, CONCLAVE_DEPOSIT_RECOVERY_ENABLED: 'false' },
    }),
    { code: 'DEPOSIT_RECOVERY_UNAVAILABLE' },
  );
  await assert.rejects(
    search(f, reader, null, {
      env: { ...f.env, CONCLAVE_TREASURY_WALLET: key() },
    }),
    { code: 'DEPOSIT_POLICY_UNAVAILABLE' },
  );
  await pool.query('UPDATE accounts SET disabled_at=now() WHERE id=$1', [
    f.accountId,
  ]);
  await assert.rejects(search(f, reader), { code: 'ACCOUNT_UNAVAILABLE' });
  assert.deepEqual(reader.pages, []);
  await noCredit(f);
});

void test('one bounded page advances with an owned cursor and the following page can find the payment', async () => {
  const f = await fixture(),
    ids = Array.from({ length: 8 }, txid),
    values = new Map(
      ids.map((id) => [
        id,
        evidenceFor(f, id, (e) => {
          e.transaction.transaction.message.accountKeys[4] = key();
        }),
      ]),
    );
  const reader = readerFor(
    f,
    (before) =>
      before === null
        ? ids.map((id) => candidate(id))
        : [candidate(f.evidence.signature)],
    values,
  );
  const first = await search(f, reader);
  assert.equal(first.search.checked, 8);
  assert.equal(first.credited, false);
  assert.ok(first.search.nextCursor);
  assert.equal(first.search.status, 'no_match_on_page');
  assert.equal(first.search.exhaustive, false);
  assert.equal(reader.reads.length, 8);
  const second = await search(f, reader, first.search.nextCursor);
  assert.equal(second.credited, true);
  assert.deepEqual(reader.pages, [null, ids[7]]);
  const foreign = await fixture();
  await assert.rejects(search(foreign, reader, first.search.nextCursor), {
    code: 'INVALID_CURSOR',
  });
  for (const invalid of [
    '',
    '!',
    'a'.repeat(513),
    Buffer.from(
      JSON.stringify([1, f.accountId, f.intentId, f.reference, 'invalid']),
    ).toString('base64url'),
  ])
    await assert.rejects(search(f, reader, invalid), {
      code: 'INVALID_CURSOR',
    });
});

void test('temporary evidence failure retains cursor before the affected candidate and recovery rechecks it', async () => {
  const f = await fixture(),
    wrong = txid(),
    target = f.evidence.signature;
  const values = new Map([
    [
      wrong,
      evidenceFor(f, wrong, (e) => {
        e.transaction.transaction.message.accountKeys[4] = key();
      }),
    ],
    [target, new SolanaError('not_finalized')],
  ]);
  const reader = readerFor(
    f,
    (before) =>
      before === null
        ? [candidate(wrong), candidate(target)]
        : [candidate(target)],
    values,
  );
  const first = await search(f, reader);
  assert.equal(first.search.status, 'incomplete');
  assert.equal(first.search.checked, 1);
  assert.ok(first.search.nextCursor);
  await noCredit(f);
  values.set(target, f.evidence);
  const second = await search(f, reader, first.search.nextCursor);
  assert.equal(second.credited, true);
  assert.deepEqual(reader.pages, [null, wrong]);
});

void test('unknown errors, malformed pages and missing transaction metadata stay incomplete without exposing details', async () => {
  const f = await fixture();
  for (const entries of [
    null,
    {},
    Array.from({ length: 9 }, () => candidate(txid())),
    [candidate(f.evidence.signature), candidate(f.evidence.signature)],
    [{ ...candidate(f.evidence.signature), slot: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...candidate(f.evidence.signature), err: undefined }],
    [{ ...candidate(f.evidence.signature), blockTime: '1000' }],
  ]) {
    const reader = readerFor(f, entries),
      result = await search(f, reader);
    assert.equal(result.search.status, 'incomplete');
    assert.equal(result.search.nextCursor, null);
    assert.equal(reader.reads.length, 0);
  }
  const marker = 'rpc-diagnostic-fixture';
  const leaked = await search(f, {
    readSignaturesForReference: async () => {
      throw new Error(marker);
    },
    readDepositEvidence: async () => {
      assert.fail();
    },
  });
  assert.equal(leaked.search.status, 'incomplete');
  assert.equal(JSON.stringify(leaked).includes(marker), false);
  const missing = evidenceFor(f);
  delete missing.transaction.meta.preTokenBalances;
  const result = await search(
    f,
    readerFor(
      f,
      [candidate(missing.signature)],
      new Map([[missing.signature, missing]]),
    ),
  );
  assert.equal(result.search.status, 'incomplete');
  assert.equal(result.search.nextCursor, null);
  await noCredit(f);
});

void test('finality, signature and slot disagreements cannot be credited from index metadata', async () => {
  for (const alter of [
    (e) => {
      e.status.confirmationStatus = 'confirmed';
    },
    (e) => {
      e.status.confirmations = 1;
    },
    (e) => {
      e.signature = txid();
    },
    (e) => {
      e.transaction.slot = 1001;
    },
  ]) {
    const f = await fixture(),
      evidence = evidenceFor(f, undefined, alter);
    const result = await search(
      f,
      readerFor(
        f,
        [candidate(f.evidence.signature)],
        new Map([[f.evidence.signature, evidence]]),
      ),
    );
    assert.equal(result.search.status, 'incomplete');
    await noCredit(f);
  }
  const f = await fixture(),
    evidence = evidenceFor(f);
  evidence.cluster = 'mainnet-beta';
  await assert.rejects(
    search(
      f,
      readerFor(
        f,
        [candidate(f.evidence.signature)],
        new Map([[f.evidence.signature, evidence]]),
      ),
    ),
    { code: 'wrong_cluster' },
  );
  await noCredit(f);
});

void test('finalized failed transaction may be skipped but an empty page never proves nonpayment', async () => {
  const f = await fixture(),
    failed = txid();
  const reader = readerFor(
    f,
    [candidate(failed), candidate(f.evidence.signature)],
    new Map([[failed, new SolanaError('transaction_failed')]]),
  );
  const result = await search(f, reader);
  assert.equal(result.credited, true);
  assert.equal(result.search.checked, 2);
  const missing = await fixture(),
    empty = await search(missing, readerFor(missing, []));
  assert.equal(empty.credited, false);
  assert.equal(empty.search.status, 'no_match_on_page');
  assert.equal(empty.search.nextCursor, null);
  assert.equal(empty.search.exhaustive, false);
});

void test('outer deadline bounds an uncooperative reader and request cancellation starts no further work', async () => {
  const f = await fixture(),
    reader = readerFor(f, []);
  reader.readSignaturesForReference = () => new Promise(() => {});
  const result = await search(f, reader, null, { timeoutMs: 5 });
  assert.equal(result.search.status, 'incomplete');
  assert.equal(result.search.nextCursor, null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(search(f, reader, null, { signal: controller.signal }), {
    code: 'cancelled',
  });
  const second = new AbortController();
  const running = search(
    f,
    {
      readSignaturesForReference: async () => {
        second.abort();
        throw new Error('fixture');
      },
      readDepositEvidence: async () => {
        assert.fail();
      },
    },
    null,
    { signal: second.signal },
  );
  await assert.rejects(running, { code: 'cancelled' });
  await noCredit(f);
});

void test('default transport uses only owned finalized read methods and the configured cluster', async () => {
  const f = await fixture(),
    methods = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, f.env.CONCLAVE_SOLANA_RPC_URL);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    methods.push(body.method);
    let result;
    if (body.method === 'getGenesisHash')
      result = SOLANA_NETWORKS.devnet.genesisHash;
    else if (body.method === 'getSignaturesForAddress') {
      assert.deepEqual(body.params, [
        f.reference,
        { commitment: 'finalized', limit: 8 },
      ]);
      result = [candidate(f.evidence.signature)];
    } else if (body.method === 'getSignatureStatuses')
      result = { value: [f.evidence.status] };
    else if (body.method === 'getTransaction') {
      assert.deepEqual(body.params, [
        f.evidence.signature,
        {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
        },
      ]);
      result = f.evidence.transaction;
    } else assert.fail('Discovery must never write to the chain');
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  try {
    const result = await searchOwnedDeposit(
      pool,
      { accountId: f.accountId, intentId: f.intentId },
      { env: f.env },
    );
    assert.equal(result.credited, true);
    assert.deepEqual(methods, [
      'getGenesisHash',
      'getSignaturesForAddress',
      'getGenesisHash',
      'getSignatureStatuses',
      'getTransaction',
    ]);
    const other = await fixture();
    methods.length = 0;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      methods.push(body.method);
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
      });
    };
    await assert.rejects(
      searchOwnedDeposit(
        pool,
        { accountId: other.accountId, intentId: other.intentId },
        { env: other.env },
      ),
      { code: 'wrong_cluster' },
    );
    assert.deepEqual(methods, ['getGenesisHash']);
    await noCredit(other);
  } finally {
    globalThis.fetch = previous;
  }
});

void test('default reader advances only past proven finalized failure and retains uncertain or contradictory evidence', async () => {
  const cases = [
    {
      change: (e) => {
        e.status.err = 'InvalidInstructionData';
      },
      skips: true,
    },
    {
      change: (e) => {
        e.status.err = 'InvalidInstructionData';
        e.status.confirmationStatus = 'confirmed';
        e.status.confirmations = 1;
      },
    },
    {
      change: (e) => {
        e.status.err = 'InvalidInstructionData';
        e.status.slot = Number.MAX_SAFE_INTEGER + 1;
      },
    },
    {
      change: (e) => {
        delete e.status.err;
      },
    },
    {
      change: (e) => {
        e.status.err = [];
      },
    },
    {
      change: (e) => {
        e.transaction.meta.err = 'InvalidInstructionData';
      },
    },
  ];
  for (const entry of cases) {
    const f = await fixture(),
      first = txid(),
      firstEvidence = evidenceFor(f, first, entry.change),
      read = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      let result;
      if (body.method === 'getGenesisHash')
        result = SOLANA_NETWORKS.devnet.genesisHash;
      else if (body.method === 'getSignaturesForAddress')
        result = [candidate(first), candidate(f.evidence.signature)];
      else if (body.method === 'getSignatureStatuses') {
        const signature = body.params[0][0];
        read.push(signature);
        result = {
          value: [
            signature === first ? firstEvidence.status : f.evidence.status,
          ],
        };
      } else if (body.method === 'getTransaction')
        result =
          body.params[0] === first
            ? firstEvidence.transaction
            : f.evidence.transaction;
      else assert.fail('Discovery must never write to the chain');
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    };
    try {
      const result = await searchOwnedDeposit(
        pool,
        { accountId: f.accountId, intentId: f.intentId },
        { env: f.env },
      );
      assert.equal(result.credited, Boolean(entry.skips));
      assert.equal(
        result.search.status,
        entry.skips ? 'credited' : 'incomplete',
      );
      assert.equal(result.search.checked, entry.skips ? 2 : 0);
      assert.equal(result.search.nextCursor, null);
      assert.deepEqual(
        read,
        entry.skips ? [first, f.evidence.signature] : [first],
      );
      if (!entry.skips) await noCredit(f);
    } finally {
      globalThis.fetch = previous;
    }
  }
});
