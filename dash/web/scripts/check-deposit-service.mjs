import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after, beforeEach } from 'node:test';
import bs58 from 'bs58';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import {
  creditDepositEvidence,
  createOwnedDeposit,
  getOwnedDeposit,
  listOwnedDeposits,
} from '../server/solana/deposit-store.ts';
import { depositCapability } from '../server/solana/deposit-config.ts';
import { solanaRoutes } from '../server/routes/solana.ts';
import { handleApi } from '../server/core/http.ts';
import { digestText } from '../server/core/digest.ts';
import { getBalance } from '../server/ledger/ledger.ts';
import { SOLANA_NETWORKS, TOKEN_PROGRAM } from '../server/solana/index.ts';

const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error('An isolated CONCLAVE_TEST_DATABASE_URL is required.');
const url = new URL(connection);
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('Only loopback test databases are supported.');
const pool = createDatabase(connection, 8);
before(() => migrate(pool));
after(() => pool.end());
const key = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)));

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
  return { accountId, intentId, evidence, policy, sourceWallet };
}

void test('concurrent notifications credit one finalized deposit exactly once with a balanced journal', async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      creditDepositEvidence(pool, f.accountId, f.intentId, f.evidence),
    ),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
  assert.deepEqual(await getBalance(pool, f.accountId), {
    availableUsd6: '1000000',
    reservedUsd6: '0',
    currency: 'USD6',
  });
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM deposit_events WHERE intent_id=$1',
        [f.intentId],
      )
    ).rows[0].count,
    '1',
  );
});
