import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeypair } from '../server/token/transaction-builder.ts';
import {
  guardChainConfig,
  createGuardChainReader,
  encodeGuardLimits,
} from '../server/second-look/guard-chain.ts';
import {
  compileGuardMessage,
  ed25519Attestation,
} from '../server/second-look/guard-transaction.ts';
const limits = {
  dailyBuy: '100000000',
  perToken: '50000000',
  dailyLoss: '25000000',
  slippageBps: 100,
  cooldownLosses: 3,
  cooldownSeconds: 600,
};
test('local adapter refuses public networks, credentials, paths and malformed inputs before I/O', async () => {
  for (const url of [
    'https://api.mainnet-beta.solana.com',
    'http://example.test',
    'https://localhost',
    'http://127.0.0.1/path',
    'http://user@127.0.0.1',
    'http://127.0.0.1/?key=x',
  ])
    assert.equal(
      guardChainConfig({
        CONCLAVE_GUARD_LOCAL_ENABLED: 'true',
        CONCLAVE_GUARD_LOCAL_RPC_URL: url,
      }).configured,
      false,
    );
  assert.equal(
    guardChainConfig({
      CONCLAVE_GUARD_LOCAL_ENABLED: 'true',
      CONCLAVE_GUARD_LOCAL_RPC_URL: 'http://127.0.0.1:8899',
    }).configured,
    true,
  );
  assert.equal(encodeGuardLimits(limits).length, 31);
  for (const bad of [
    null,
    {},
    { ...limits, dailyBuy: 500 },
    { ...limits, dailyBuy: '500000001' },
    { ...limits, extra: true },
  ])
    assert.throws(
      () => encodeGuardLimits(bad),
      (e) => e.status === 400,
    );
  let io = 0;
  const reader = createGuardChainReader({}, async () => {
    io++;
    throw Error('I/O forbidden');
  });
  for (const action of [
    { kind: 'tighten', limits: null },
    { kind: 'withdraw_gas', lamports: '-1' },
    { kind: 'propose_timezone', timezoneMinutes: 900 },
  ])
    await assert.rejects(
      reader.prepare(generateKeypair().address, action),
      (e) => e.status === 400,
    );
  assert.equal(io, 0);
});
test('versioned message keeps signers and programs static and deduplicates lookup accounts', () => {
  const [payer, program, writable, readonly, table] = Array.from(
    { length: 5 },
    () => generateKeypair().address,
  );
  const base = {
    payer,
    recentBlockhash: generateKeypair().address,
    instructions: [
      {
        programId: program,
        data: Buffer.from([1]),
        accounts: [
          { address: payer, signer: true, writable: true },
          { address: writable, signer: false, writable: true },
          { address: readonly, signer: false, writable: false },
        ],
      },
    ],
  };
  const msg = compileGuardMessage({
    ...base,
    tables: [
      { address: table, addresses: [payer, program, readonly, writable] },
    ],
  });
  assert.equal(msg.bytes[0], 128);
  assert.equal(msg.header.numRequiredSignatures, 1);
  assert.deepEqual(msg.accountKeys, [payer, program, writable, readonly]);
  assert.throws(() =>
    compileGuardMessage({
      ...base,
      tables: [{ address: table, addresses: [writable, writable] }],
    }),
  );
  assert.throws(() =>
    ed25519Attestation(Buffer.alloc(32), Buffer.alloc(64), Buffer.alloc(31)),
  );
});
