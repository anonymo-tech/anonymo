import { randomBytes, randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {
  SOLANA_NETWORKS,
  TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  assertGenesis,
} from '../../server/solana/validation.ts';
import {
  encodeTransactionBase64,
  depositRecipientTokenAddress,
  decodeTransactionBase64,
} from '../../lib/solana/deposit-transaction.ts';

const key = () => bs58.encode(randomBytes(32));
export function tokenAccountFixture(
  mint,
  owner,
  amount = 5_000_000n,
  changes = {},
) {
  const bytes = new Uint8Array(165),
    view = new DataView(bytes.buffer);
  bytes.set(bs58.decode(mint), 0);
  bytes.set(bs58.decode(owner), 32);
  view.setBigUint64(64, amount, true);
  bytes[108] = 1;
  if (changes.state !== undefined) bytes[108] = changes.state;
  if (changes.delegate) {
    view.setUint32(72, 1, true);
    bytes.set(bs58.decode(changes.delegate), 76);
    view.setBigUint64(121, 1n, true);
  }
  return {
    data: [Buffer.from(bytes).toString('base64'), 'base64'],
    owner: TOKEN_PROGRAM,
    executable: false,
    lamports: 2039280,
    space: 165,
  };
}
export function mintAccountFixture() {
  const bytes = new Uint8Array(82);
  bytes[44] = 6;
  bytes[45] = 1;
  return {
    data: [Buffer.from(bytes).toString('base64'), 'base64'],
    owner: TOKEN_PROGRAM,
    executable: false,
    lamports: 1461600,
    space: 82,
  };
}

/** Synthetic, process-local fixtures only. No transport or chain writes. */
export async function depositPaymentFixture(pool, options = {}) {
  const seed = randomBytes(32),
    sourceWallet = bs58.encode(ed25519.getPublicKey(seed));
  const f = {
    accountId: randomUUID(),
    intentId: randomUUID(),
    seed,
    sourceWallet,
    sourceAccounts: [key(), key()].sort(),
    recipientWallet: key(),
    recipientTokenAccount: key(),
    reference: key(),
    mint: SOLANA_NETWORKS.devnet.usdcMint,
    blockhash: key(),
    lastValidBlockHeight: 1200,
    height: 1100,
    slot: 2000,
    genesisHash: SOLANA_NETWORKS.devnet.genesisHash,
    fee: 5000,
    balanceLamports: 10_000_000,
    blockhashValid: true,
    amountUsd6: options.amountUsd6 ?? '1000000',
    handlers: {},
    calls: [],
  };
  if (options.createRecipientAccount)
    f.recipientTokenAccount = depositRecipientTokenAddress(
      f.recipientWallet,
      f.mint,
    );
  f.policy = {
    cluster: 'devnet',
    recipientWallet: f.recipientWallet,
    recipientTokenAccount: f.recipientTokenAccount,
    usdcMint: f.mint,
  };
  f.installConfig = () =>
    Object.assign(process.env, {
      CONCLAVE_MODE: 'service',
      CONCLAVE_APP_ORIGIN: 'https://workspace.example.test',
      CONCLAVE_DATABASE_URL: process.env.CONCLAVE_TEST_DATABASE_URL,
      CONCLAVE_SOLANA_CLUSTER: 'devnet',
      CONCLAVE_SOLANA_RPC_URL: 'https://rpc.example.test/private-test',
      CONCLAVE_TREASURY_WALLET: f.recipientWallet,
      CONCLAVE_TREASURY_TOKEN_ACCOUNT: f.recipientTokenAccount,
      CONCLAVE_MAX_DEPOSIT_USD6: '100000000',
      CONCLAVE_DEPOSITS_ENABLED: 'true',
      CONCLAVE_DEPOSIT_PAYMENTS_ENABLED: 'true',
    });
  f.installConfig();
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [f.accountId]);
  await pool.query(
    "INSERT INTO identities(id,account_id,kind,subject) VALUES($1,$2,'solana',$3)",
    [randomUUID(), f.accountId, sourceWallet],
  );
  await pool.query(
    `INSERT INTO deposit_intents(id,account_id,source_wallet,reference,amount_usd6,policy,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,date_trunc('second',clock_timestamp()),date_trunc('second',clock_timestamp())+($7 * interval '1 second'))`,
    [
      f.intentId,
      f.accountId,
      sourceWallet,
      f.reference,
      f.amountUsd6,
      f.policy,
      options.expiresInSeconds ?? 900,
    ],
  );
  f.intent = (
    await pool.query('SELECT * FROM deposit_intents WHERE id=$1', [f.intentId])
  ).rows[0];
  const context = (value) => ({ context: { slot: f.slot }, value });
  f.reply = (method, params) => {
    switch (method) {
      case 'getGenesisHash':
        return f.genesisHash;
      case 'getLatestBlockhash':
        return context({
          blockhash: f.blockhash,
          lastValidBlockHeight: f.lastValidBlockHeight,
        });
      case 'getTokenAccountsByOwner':
        return context(
          [...f.sourceAccounts].reverse().map((pubkey) => ({
            pubkey,
            account: tokenAccountFixture(f.mint, sourceWallet),
          })),
        );
      case 'getMultipleAccounts':
        return context([
          mintAccountFixture(),
          tokenAccountFixture(f.mint, sourceWallet),
          options.createRecipientAccount
            ? null
            : tokenAccountFixture(f.mint, f.recipientWallet, 0n),
          {
            data: ['', 'base64'],
            owner: SYSTEM_PROGRAM,
            executable: false,
            lamports: f.balanceLamports,
            space: 0,
          },
        ]);
      case 'getMinimumBalanceForRentExemption':
        return 2039280;
      case 'getFeeForMessage':
        return context(f.fee);
      case 'simulateTransaction':
        return context({
          err: null,
          logs: [],
          innerInstructions: [],
          replacementBlockhash: null,
          fee: f.fee,
          unitsConsumed: 6100,
        });
      case 'isBlockhashValid':
        return context(f.blockhashValid);
      case 'getBlockHeight':
        return f.height;
      case 'sendTransaction':
        return bs58.encode(decodeTransactionBase64(params[0]).subarray(1, 65));
      default:
        throw new Error('Unconfigured synthetic RPC method');
    }
  };
  f.rpc = {
    cluster: 'devnet',
    async verifyGenesis(signal) {
      signal?.throwIfAborted();
      assertGenesis('devnet', await this.call('getGenesisHash', [], signal));
    },
    async call(method, params, signal) {
      signal?.throwIfAborted();
      f.calls.push({ method, params: structuredClone(params) });
      return f.handlers[method]
        ? f.handlers[method](params, signal)
        : f.reply(method, params);
    },
  };
  f.signPayment = (payment) => {
    const wire = decodeTransactionBase64(payment.unsignedTransaction);
    wire.set(ed25519.sign(wire.subarray(65), seed), 1);
    return encodeTransactionBase64(wire);
  };
  return f;
}
