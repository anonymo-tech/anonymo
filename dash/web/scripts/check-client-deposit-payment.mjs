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
