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
