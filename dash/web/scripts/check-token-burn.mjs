import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {
  platformTokenConfig,
  requireWriteCapableToken,
} from '../server/token/config.ts';
import {
  assertUsableQuote,
  createSimulatedPriceSource,
  minimumAfterSlippage,
  tokensForUsd6,
  usd6ForTokens,
} from '../server/token/price.ts';
import {
  buildSignedTransaction,
  burnCheckedInstruction,
  compileLegacyMessage,
  keypairFromJsonArray,
  keypairFromSeed,
  loadLocalKeypair,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
  shortvecDecode,
  shortvecEncode,
  signCompiledMessage,
  transferCheckedInstruction,
  verifyMessageSignature,
} from '../server/token/transaction-builder.ts';
import { createTokenRpc } from '../server/token/localnet-rpc.ts';
import {
  BUYBACK_LIMITS,
  createJupiterExecutor,
  createSimulatedJupiter,
  simulatedImpactBps,
  simulatedSwapQuote,
} from '../server/token/buyback.ts';
import {
  canonicalTokenBurnRecord,
  requireClosedHour,
  tokenBurnRecordHash,
  verifyTokenBurnRecord,
} from '../server/token/burn-ledger.ts';
import { parseSerializedTransaction } from '../server/solana/serialized.ts';
import {
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from '../server/solana/validation.ts';

// Pure vectors: no database, no network, no validator. Keys are fixed seeds so
// every byte of the serialized transactions is reproducible.

const key = (n) => bs58.encode(Buffer.alloc(32, n));
const seed = (n) => Uint8Array.from(Buffer.alloc(32, n));
const blockhash = key(9);
const burnWallet = keypairFromSeed(seed(1));
const maker = keypairFromSeed(seed(2));
const mint = key(5);
const burnTokenAccount = key(6);
const makerTokenAccount = key(7);
const code = (value) => (error) => error.code === value;

const localnetEnv = {
  CONCLAVE_TOKEN_MINT: mint,
  CONCLAVE_TOKEN_CLUSTER: 'localnet',
  CONCLAVE_TOKEN_RPC_URL: 'http://127.0.0.1:8999',
  CONCLAVE_TOKEN_DECIMALS: '6',
  CONCLAVE_TOKEN_PROGRAM: 'token-2022',
  CONCLAVE_TOKEN_BURN_ENABLED: 'true',
};
const mainnetEnv = {
  CONCLAVE_TOKEN_MINT: mint,
  CONCLAVE_TOKEN_CLUSTER: 'mainnet-beta',
  CONCLAVE_TOKEN_RPC_URL: 'https://rpc.example.invalid',
  CONCLAVE_TOKEN_DECIMALS: '6',
};
const localnet = platformTokenConfig(localnetEnv);

const u64 = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return [...bytes];
};
function messageBytes(parsed) {
  return Uint8Array.from(Buffer.from(parsed.messageBase64, 'base64'));
}
function keyAt(parsed, index) {
  return parsed.staticAccounts[index].address;
}

void test('shortvec encoding round-trips and rejects non-minimal or oversized prefixes', () => {
  for (const [value, bytes] of [
    [0, [0]],
    [1, [1]],
    [127, [127]],
    [128, [128, 1]],
    [255, [255, 1]],
    [16383, [255, 127]],
    [16384, [128, 128, 1]],
    [65535, [255, 255, 3]],
  ]) {
    assert.deepEqual([...shortvecEncode(value)], bytes, `encode ${String(value)}`);
    assert.deepEqual(shortvecDecode(Uint8Array.from(bytes)), {
      value,
      length: bytes.length,
    });
  }
  assert.throws(() => shortvecEncode(65536), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => shortvecEncode(-1), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => shortvecEncode(1.5), code('TOKEN_TRANSACTION_INVALID'));
  // Non-minimal: 0x80 0x00 is "0" with a continuation byte.
  assert.throws(() => shortvecDecode(Uint8Array.from([128, 0])), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => shortvecDecode(Uint8Array.from([128])), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => shortvecDecode(Uint8Array.from([128, 128, 4])), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => shortvecDecode(Uint8Array.from([128, 128, 128, 1])), code('TOKEN_TRANSACTION_INVALID'));
});

void test('a BurnChecked transaction serializes to the legacy wire format and verifies', () => {
  const instruction = burnCheckedInstruction({
    programId: TOKEN_2022_PROGRAM,
    tokenAccount: burnTokenAccount,
    mint,
    owner: burnWallet.address,
    amountRaw: 1_234_567n,
    decimals: 6,
  });
  const signed = buildSignedTransaction({
    payer: burnWallet,
    recentBlockhash: blockhash,
    instructions: [instruction],
  });
  const parsed = parseSerializedTransaction(signed.base64);
  assert.equal(parsed.version, 'legacy');
  assert.equal(parsed.recentBlockhash, blockhash);
  assert.deepEqual(parsed.header, {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 1,
  });
  // Payer first (signer, writable), then writable non-signers, then the program.
  assert.deepEqual(
    parsed.staticAccounts.map((account) => [account.address, account.signer, account.writable]),
    [
      [burnWallet.address, true, true],
      [burnTokenAccount, false, true],
      [mint, false, true],
      [TOKEN_2022_PROGRAM, false, false],
    ],
  );
  assert.equal(parsed.instructions.length, 1);
  const [compiled] = parsed.instructions;
  assert.equal(keyAt(parsed, compiled.programIdIndex), TOKEN_2022_PROGRAM);
  assert.deepEqual(
    compiled.accountIndexes.map((index) => keyAt(parsed, index)),
    [burnTokenAccount, mint, burnWallet.address],
  );
  assert.deepEqual([...compiled.data], [15, ...u64(1_234_567n), 6]);
  assert.equal(parsed.signatures.length, 1);
  assert.ok(parsed.signatures[0].present);
  assert.equal(parsed.signatures[0].value, signed.signature);
  const signature = bs58.decode(parsed.signatures[0].value);
  assert.ok(ed25519.verify(signature, messageBytes(parsed), burnWallet.publicKey));
  assert.ok(verifyMessageSignature(messageBytes(parsed), signature, burnWallet.address));
  assert.ok(!verifyMessageSignature(messageBytes(parsed), signature, maker.address));
  assert.equal(parsed.byteLength, signed.byteLength);
  // Deterministic: the same inputs yield the same bytes (Ed25519 is deterministic).
  assert.equal(
    buildSignedTransaction({ payer: burnWallet, recentBlockhash: blockhash, instructions: [instruction] }).base64,
    signed.base64,
  );
});

void test('a TransferChecked transaction with compute budget instructions parses back exactly', () => {
  const signed = buildSignedTransaction({
    payer: maker,
    recentBlockhash: blockhash,
    instructions: [
      setComputeUnitLimitInstruction(50_000),
      setComputeUnitPriceInstruction(1_000n),
      transferCheckedInstruction({
        programId: TOKEN_PROGRAM,
        source: makerTokenAccount,
        mint,
        destination: burnTokenAccount,
        owner: maker.address,
        amountRaw: 42n,
        decimals: 6,
      }),
    ],
  });
  const parsed = parseSerializedTransaction(signed.base64);
  assert.deepEqual(parsed.header, {
    numRequiredSignatures: 1,
    numReadonlySignedAccounts: 0,
    numReadonlyUnsignedAccounts: 3,
  });
  assert.deepEqual(
    parsed.staticAccounts.map((account) => account.address),
    [maker.address, makerTokenAccount, burnTokenAccount, COMPUTE_BUDGET_PROGRAM, mint, TOKEN_PROGRAM],
  );
  const [limit, price, transfer] = parsed.instructions;
  assert.equal(keyAt(parsed, limit.programIdIndex), COMPUTE_BUDGET_PROGRAM);
  assert.deepEqual([...limit.data], [2, 0x50, 0xc3, 0, 0]);
  assert.deepEqual(limit.accountIndexes, []);
  assert.deepEqual([...price.data], [3, ...u64(1_000n)]);
  assert.equal(keyAt(parsed, transfer.programIdIndex), TOKEN_PROGRAM);
  assert.deepEqual(
    transfer.accountIndexes.map((index) => keyAt(parsed, index)),
    [makerTokenAccount, mint, burnTokenAccount, maker.address],
  );
  assert.deepEqual([...transfer.data], [12, ...u64(42n), 6]);
  assert.ok(ed25519.verify(bs58.decode(parsed.signatures[0].value), messageBytes(parsed), maker.publicKey));
});

void test('separate payer and owner produce two signatures and a readonly signed account', () => {
  const message = compileLegacyMessage({
    payer: maker.address,
    recentBlockhash: blockhash,
    instructions: [
      burnCheckedInstruction({
        programId: TOKEN_2022_PROGRAM,
        tokenAccount: burnTokenAccount,
        mint,
        owner: burnWallet.address,
        amountRaw: 1n,
        decimals: 0,
      }),
    ],
  });
  assert.deepEqual(message.header, {
    numRequiredSignatures: 2,
    numReadonlySignedAccounts: 1,
    numReadonlyUnsignedAccounts: 1,
  });
  assert.deepEqual(message.accountKeys, [
    maker.address,
    burnWallet.address,
    burnTokenAccount,
    mint,
    TOKEN_2022_PROGRAM,
  ]);
  const signed = signCompiledMessage(message, [maker, burnWallet]);
  const parsed = parseSerializedTransaction(signed.base64);
  assert.equal(parsed.signatures.length, 2);
  assert.ok(ed25519.verify(bs58.decode(parsed.signatures[0].value), message.bytes, maker.publicKey));
  assert.ok(ed25519.verify(bs58.decode(parsed.signatures[1].value), message.bytes, burnWallet.publicKey));
  // Missing, duplicate or surplus signers are refused.
  assert.throws(() => signCompiledMessage(message, [maker]), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => signCompiledMessage(message, [maker, maker]), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(
    () => signCompiledMessage(message, [maker, burnWallet, keypairFromSeed(seed(3))]),
    code('TOKEN_TRANSACTION_INVALID'),
  );
  assert.throws(
    () => signCompiledMessage(message, [maker, keypairFromSeed(seed(3))]),
    code('TOKEN_TRANSACTION_INVALID'),
  );
});

void test('instruction builders refuse invalid programs, amounts, decimals and addresses', () => {
  const valid = {
    programId: TOKEN_2022_PROGRAM,
    tokenAccount: burnTokenAccount,
    mint,
    owner: burnWallet.address,
    amountRaw: 1n,
    decimals: 6,
  };
  assert.throws(() => burnCheckedInstruction({ ...valid, programId: COMPUTE_BUDGET_PROGRAM }), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => burnCheckedInstruction({ ...valid, amountRaw: 0n }), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => burnCheckedInstruction({ ...valid, amountRaw: 1n << 64n }), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => burnCheckedInstruction({ ...valid, decimals: 10 }), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => burnCheckedInstruction({ ...valid, mint: 'not-an-address' }), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => setComputeUnitLimitInstruction(0), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(() => setComputeUnitLimitInstruction(1_400_001), code('TOKEN_TRANSACTION_INVALID'));
  assert.throws(
    () => compileLegacyMessage({ payer: maker.address, recentBlockhash: 'short', instructions: [burnCheckedInstruction(valid)] }),
    code('TOKEN_TRANSACTION_INVALID'),
  );
  assert.throws(
    () => compileLegacyMessage({ payer: maker.address, recentBlockhash: blockhash, instructions: [] }),
    code('TOKEN_TRANSACTION_INVALID'),
  );
  // A program may not also be a writable or signing account.
  assert.throws(
    () =>
      compileLegacyMessage({
        payer: maker.address,
        recentBlockhash: blockhash,
        instructions: [
          { programId: TOKEN_PROGRAM, accounts: [{ address: TOKEN_PROGRAM, signer: false, writable: true }], data: new Uint8Array() },
        ],
      }),
    code('TOKEN_TRANSACTION_INVALID'),
  );
  // Oversized transactions are refused before they can be sent.
  assert.throws(
    () =>
      buildSignedTransaction({
        payer: maker,
        recentBlockhash: blockhash,
        instructions: [{ programId: TOKEN_PROGRAM, accounts: [], data: new Uint8Array(1200) }],
      }),
    code('TOKEN_TRANSACTION_INVALID'),
  );
});

void test('local keypairs load from the 64-byte JSON array only on write-capable clusters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conclave-token-'));
  try {
    const file = join(directory, 'burn.json');
    await writeFile(file, JSON.stringify([...burnWallet.secretKey, ...burnWallet.publicKey]));
    const loaded = loadLocalKeypair(file, localnet);
    assert.equal(loaded.address, burnWallet.address);
    assert.deepEqual([...loaded.publicKey], [...burnWallet.publicKey]);
    // Mainnet refuses before touching the file; so does unconfigured.
    assert.throws(() => loadLocalKeypair(file, platformTokenConfig(mainnetEnv)), code('TOKEN_MAINNET_LOCKED'));
    assert.throws(() => loadLocalKeypair(file, platformTokenConfig({})), code('TOKEN_UNAVAILABLE'));
    assert.throws(() => loadLocalKeypair(join(directory, 'missing.json'), localnet), code('TOKEN_KEYPAIR_INVALID'));
    // Damaged files: wrong length, bytes out of range, public half mismatch.
    assert.throws(() => keypairFromJsonArray(JSON.stringify([...burnWallet.secretKey])), code('TOKEN_KEYPAIR_INVALID'));
    assert.throws(() => keypairFromJsonArray(JSON.stringify([...burnWallet.secretKey, ...burnWallet.publicKey.slice(0, 31), 256])), code('TOKEN_KEYPAIR_INVALID'));
    assert.throws(() => keypairFromJsonArray(JSON.stringify([...burnWallet.secretKey, ...maker.publicKey])), code('TOKEN_KEYPAIR_INVALID'));
    assert.throws(() => keypairFromJsonArray('{'), code('TOKEN_KEYPAIR_INVALID'));
    assert.throws(() => keypairFromSeed(new Uint8Array(31)), code('TOKEN_KEYPAIR_INVALID'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('token configuration fails closed on mainnet, bad decimals and plain http off localnet', () => {
  assert.equal(localnet.configured, true);
  assert.equal(localnet.writeCapable, true);
  assert.equal(localnet.programId, TOKEN_2022_PROGRAM);
  assert.equal(requireWriteCapableToken(localnet), localnet);
  const mainnet = platformTokenConfig(mainnetEnv);
  assert.equal(mainnet.configured, true);
  assert.equal(mainnet.writeCapable, false);
  assert.throws(() => requireWriteCapableToken(mainnet), code('TOKEN_MAINNET_LOCKED'));
  assert.deepEqual(
    platformTokenConfig({ ...mainnetEnv, CONCLAVE_TOKEN_BURN_ENABLED: 'true' }),
    { configured: false, label: 'platform token', reason: 'TOKEN_MAINNET_LOCKED' },
  );
  assert.throws(() => requireWriteCapableToken(platformTokenConfig({})), code('TOKEN_UNAVAILABLE'));
  for (const decimals of ['10', '-1', '6.0', 'six', ''])
    assert.throws(() => platformTokenConfig({ ...localnetEnv, CONCLAVE_TOKEN_DECIMALS: decimals }), code('CONFIGURATION_REQUIRED'));
  assert.throws(
    () => platformTokenConfig({ ...localnetEnv, CONCLAVE_TOKEN_CLUSTER: 'devnet', CONCLAVE_TOKEN_RPC_URL: 'http://rpc.example.invalid' }),
    code('CONFIGURATION_REQUIRED'),
  );
  assert.throws(
    () => platformTokenConfig({ ...localnetEnv, CONCLAVE_TOKEN_RPC_URL: 'http://rpc.example.invalid' }),
    code('CONFIGURATION_REQUIRED'),
  );
  assert.throws(
    () => platformTokenConfig({ ...localnetEnv, CONCLAVE_TOKEN_RPC_URL: 'http://user:secret@127.0.0.1:8999' }),
    code('CONFIGURATION_REQUIRED'),
  );
  assert.throws(() => platformTokenConfig({ ...localnetEnv, CONCLAVE_TOKEN_PROGRAM: 'token-3000' }), code('CONFIGURATION_REQUIRED'));
  assert.throws(() => platformTokenConfig({ CONCLAVE_TOKEN_MINT: mint }), code('CONFIGURATION_REQUIRED'));
  // The RPC client and simulated executor refuse the locked cluster at construction.
  assert.throws(() => createTokenRpc({ config: mainnet }), code('TOKEN_MAINNET_LOCKED'));
  assert.throws(() => createJupiterExecutor(mainnet), code('TOKEN_MAINNET_LOCKED'));
  assert.throws(() => createJupiterExecutor(platformTokenConfig({})), code('TOKEN_MAINNET_LOCKED'));
  assert.throws(() => createJupiterExecutor(localnet), code('NOT_IMPLEMENTED'));
});

void test('price helpers round in the protocol favour and refuse stale quotes', () => {
  // 1.5 USD at 0.25 USD/token with 6 decimals = 6.000000 tokens exactly.
  assert.equal(tokensForUsd6(1_500_000n, 250_000n, 6), 6_000_000n);
  // 1 USD6 at 3 USD/token rounds up to one raw unit, never zero.
  assert.equal(tokensForUsd6(1n, 3_000_000n, 6), 1n);
  assert.equal(usd6ForTokens(1n, 3_000_000n, 6), 3n);
  assert.equal(usd6ForTokens(1n, 1n, 6), 0n);
  assert.equal(minimumAfterSlippage(10_000n, 50), 9_950n);
  assert.equal(minimumAfterSlippage(1n, 1), 0n);
  assert.throws(() => minimumAfterSlippage(1n, 501), code('TOKEN_PRICE_UNAVAILABLE'));
  assert.throws(() => tokensForUsd6(1n, 0n, 6), code('TOKEN_PRICE_UNAVAILABLE'));
  const now = 1_700_000_000_000;
  const quote = {
    priceUsd6PerToken: 250_000n,
    source: 'simulated',
    observedAtMs: now,
    expiresAtMs: now + 60_000,
    confidenceBps: 0,
  };
  assert.equal(assertUsableQuote(quote, now), quote);
  assert.throws(() => assertUsableQuote(quote, now + 60_000), code('TOKEN_PRICE_STALE'));
  assert.throws(() => assertUsableQuote({ ...quote, observedAtMs: now + 1 }, now), code('TOKEN_PRICE_STALE'));
  assert.throws(
    () => assertUsableQuote({ ...quote, observedAtMs: now - 16 * 60_000, expiresAtMs: now + 1 }, now),
    code('TOKEN_PRICE_STALE'),
  );
  assert.throws(() => assertUsableQuote({ ...quote, confidenceBps: 1_001 }, now), code('TOKEN_PRICE_STALE'));
  assert.throws(() => assertUsableQuote({ ...quote, priceUsd6PerToken: 0n }, now), code('TOKEN_PRICE_UNAVAILABLE'));
});

void test('the simulated swap applies linear impact and refuses below the slippage floor or impact cap', async () => {
  const quote = (await createSimulatedPriceSource({ priceUsd6PerToken: 250_000n }).quote(1_700_000_000_000));
  assert.equal(simulatedImpactBps(0n, 1), 0);
  assert.equal(simulatedImpactBps(1n, 1), 1);
  assert.equal(simulatedImpactBps(1_000_000n, 1), 1);
  assert.equal(simulatedImpactBps(1_000_001n, 1), 2);
  assert.equal(simulatedImpactBps(250_000_000n, 1), 250);
  // 10 USD at 0.25 → 40 tokens expected; impact ceil(10 bps) → 0.04 tokens off.
  const plan = simulatedSwapQuote({
    usdcRaw: 10_000_000n,
    quote,
    slippageBps: 50,
    decimals: 6,
    impactBpsPerUsd: 1,
    maximumImpactBps: BUYBACK_LIMITS.maximumImpactBps,
  });
  assert.deepEqual(plan, {
    expectedRaw: 40_000_000n,
    minimumOutRaw: 39_800_000n,
    impactBps: 10,
    tokensOutRaw: 39_960_000n,
  });
  // 60 USD: impact 60 bps exceeds a 50 bps slippage tolerance.
  assert.throws(
    () =>
      simulatedSwapQuote({ usdcRaw: 60_000_000n, quote, slippageBps: 50, decimals: 6, impactBpsPerUsd: 1, maximumImpactBps: 300 }),
    code('TOKEN_SWAP_REJECTED'),
  );
  // Same amount clears with a wider tolerance, then hits the impact cap when the cap is lower.
  assert.equal(
    simulatedSwapQuote({ usdcRaw: 60_000_000n, quote, slippageBps: 100, decimals: 6, impactBpsPerUsd: 1, maximumImpactBps: 300 }).tokensOutRaw,
    240_000_000n - 1_440_000n,
  );
  assert.throws(
    () =>
      simulatedSwapQuote({ usdcRaw: 60_000_000n, quote, slippageBps: 100, decimals: 6, impactBpsPerUsd: 1, maximumImpactBps: 59 }),
    code('TOKEN_SWAP_REJECTED'),
  );
  assert.throws(
    () => simulatedSwapQuote({ usdcRaw: 0n, quote, slippageBps: 50, decimals: 6, impactBpsPerUsd: 1, maximumImpactBps: 300 }),
    code('INVALID_AMOUNT'),
  );
  assert.throws(
    () => simulatedSwapQuote({ usdcRaw: 1n, quote, slippageBps: 501, decimals: 6, impactBpsPerUsd: 1, maximumImpactBps: 300 }),
    code('TOKEN_SWAP_REJECTED'),
  );
});

function fakeRpc(overrides = {}) {
  const sent = [];
  const signatureFor = (base64) => parseSerializedTransaction(base64).signatures[0].value;
  return {
    sent,
    rpc: {
      cluster: 'localnet',
      async getGenesisHash() {
        return key(11);
      },
      async getLatestBlockhash() {
        return { blockhash, lastValidBlockHeight: 1_000 };
      },
      async sendTransaction(base64) {
        sent.push(base64);
        return signatureFor(base64);
      },
      async getSignatureStatuses(signatures) {
        return signatures.map(() => ({ state: 'finalized', slot: 77 }));
      },
      async getTokenAccountBalance() {
        return { amountRaw: 1_000_000_000_000n, decimals: 6 };
      },
      async getTokenSupply() {
        return { amountRaw: 1_000_000_000_000n, decimals: 6 };
      },
      async getAccountInfo() {
        return null;
      },
      async getBlockHeight() {
        return 1;
      },
      async waitForFinalized() {
        return { slot: 77 };
      },
      ...overrides,
    },
  };
}

void test('the simulated Jupiter executor delivers tokens with a real TransferChecked from the maker', async () => {
  const { rpc, sent } = fakeRpc();
  const executor = createSimulatedJupiter({
    rpc,
    config: localnet,
    makerKeypair: maker,
    makerTokenAccount,
    burnTokenAccount,
  });
  assert.equal(executor.kind, 'simulated-jupiter');
  const quote = await createSimulatedPriceSource({ priceUsd6PerToken: 250_000n }).quote();
  const result = await executor.swap({ usdcRaw: 10_000_000n, quote, slippageBps: 50 });
  assert.equal(result.tokensOutRaw, 39_960_000n);
  // 10 USD for 39.96 tokens → 250,250.25 USD6 per token, rounded up.
  assert.equal(result.effectivePriceUsd6PerToken, 250_251n);
  assert.equal(sent.length, 1);
  const parsed = parseSerializedTransaction(sent[0]);
  assert.equal(parsed.signatures[0].value, result.signature);
  const [transfer] = parsed.instructions;
  assert.equal(keyAt(parsed, transfer.programIdIndex), TOKEN_2022_PROGRAM);
  assert.deepEqual(
    transfer.accountIndexes.map((index) => keyAt(parsed, index)),
    [makerTokenAccount, mint, burnTokenAccount, maker.address],
  );
  assert.deepEqual([...transfer.data], [12, ...u64(39_960_000n), 6]);
  assert.ok(ed25519.verify(bs58.decode(parsed.signatures[0].value), messageBytes(parsed), maker.publicKey));
  // A short maker refuses rather than partially filling; a stale quote never swaps.
  const short = fakeRpc({ getTokenAccountBalance: async () => ({ amountRaw: 1n, decimals: 6 }) });
  await assert.rejects(
    createSimulatedJupiter({ rpc: short.rpc, config: localnet, makerKeypair: maker, makerTokenAccount, burnTokenAccount })
      .swap({ usdcRaw: 10_000_000n, quote, slippageBps: 50 }),
    code('TOKEN_SWAP_REJECTED'),
  );
  assert.equal(short.sent.length, 0);
  await assert.rejects(
    executor.swap({ usdcRaw: 10_000_000n, quote: { ...quote, expiresAtMs: 1 }, slippageBps: 50 }),
    code('TOKEN_PRICE_STALE'),
  );
  await assert.rejects(executor.swap({ usdcRaw: 60_000_000n, quote, slippageBps: 50 }), code('TOKEN_SWAP_REJECTED'));
  assert.equal(sent.length, 1);
  assert.throws(
    () => createSimulatedJupiter({ rpc, config: localnet, makerKeypair: maker, makerTokenAccount, burnTokenAccount: makerTokenAccount }),
    code('CONFIGURATION_REQUIRED'),
  );
  assert.throws(
    () => createSimulatedJupiter({ rpc: { ...rpc, cluster: 'devnet' }, config: localnet, makerKeypair: maker, makerTokenAccount, burnTokenAccount }),
    code('CONFIGURATION_REQUIRED'),
  );
  assert.throws(
    () => createSimulatedJupiter({ rpc, config: platformTokenConfig(mainnetEnv), makerKeypair: maker, makerTokenAccount, burnTokenAccount }),
    code('TOKEN_MAINNET_LOCKED'),
  );
});

function jsonFetcher(handler) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    const result = await handler(request.method, request.params);
    const body = JSON.stringify(
      result instanceof Error ? { jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'x' } }
        : { jsonrpc: '2.0', id: request.id, result },
    );
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

void test('the localnet RPC client bounds responses, rejects RPC errors and waits for finality', async () => {
  const statuses = [];
  let height = 10;
  const fetcher = jsonFetcher((method, params) => {
    switch (method) {
      case 'getGenesisHash':
        return key(12);
      case 'getLatestBlockhash':
        return { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 20 } };
      case 'sendTransaction':
        return params[1].skipPreflight === false ? bs58.encode(Buffer.alloc(64, 3)) : new Error('preflight');
      case 'getSignatureStatuses':
        return { context: { slot: 1 }, value: [statuses.shift() ?? null] };
      case 'getBlockHeight':
        return height;
      case 'getTokenSupply':
        return { context: { slot: 1 }, value: { amount: '123', decimals: 6, uiAmountString: '0.000123' } };
      case 'getTokenAccountBalance':
        return { context: { slot: 1 }, value: { amount: '5', decimals: 6 } };
      case 'getAccountInfo':
        return { context: { slot: 1 }, value: { owner: TOKEN_2022_PROGRAM, lamports: 5, executable: false, data: [Buffer.from([1, 2]).toString('base64'), 'base64'] } };
      default:
        return new Error('unknown');
    }
  });
  const rpc = createTokenRpc({ config: localnet, fetcher, pollIntervalMs: 10, finalizationTimeoutMs: 500 });
  assert.equal(await rpc.getGenesisHash(), key(12));
  assert.deepEqual(await rpc.getLatestBlockhash(), { blockhash, lastValidBlockHeight: 20 });
  assert.deepEqual(await rpc.getTokenSupply(mint), { amountRaw: 123n, decimals: 6 });
  assert.deepEqual(await rpc.getTokenAccountBalance(burnTokenAccount), { amountRaw: 5n, decimals: 6 });
  const info = await rpc.getAccountInfo(burnTokenAccount);
  assert.equal(info.owner, TOKEN_2022_PROGRAM);
  assert.deepEqual([...info.data], [1, 2]);
  const signature = await rpc.sendTransaction(Buffer.from('ab').toString('base64'));
  assert.equal(signature, bs58.encode(Buffer.alloc(64, 3)));
  // unknown → confirmed → finalized
  statuses.push(null, { slot: 5, confirmations: 3, err: null, confirmationStatus: 'confirmed' }, { slot: 6, confirmations: null, err: null, confirmationStatus: 'finalized' });
  assert.deepEqual(await rpc.waitForFinalized(signature, 20), { slot: 6 });
  // A failed transaction is definitive.
  statuses.push({ slot: 7, confirmations: null, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' });
  await assert.rejects(rpc.waitForFinalized(signature, 20), code('TOKEN_TRANSACTION_FAILED'));
  // Unknown past the blockhash validity means it expired.
  height = 21;
  await assert.rejects(rpc.waitForFinalized(signature, 20), code('TOKEN_TRANSACTION_EXPIRED'));
  height = 10;
  // Never finalizing within the bound fails closed, retryable.
  const stuck = createTokenRpc({
    config: localnet,
    fetcher: jsonFetcher((method) => (method === 'getSignatureStatuses' ? { context: {}, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] } : height)),
    pollIntervalMs: 10,
    finalizationTimeoutMs: 30,
  });
  await assert.rejects(stuck.waitForFinalized(signature, 20), (error) => error.code === 'TOKEN_NOT_FINALIZED' && error.retryable);
  // RPC errors (including preflight failures) are rejected without echoing the body.
  const failing = createTokenRpc({ config: localnet, fetcher: jsonFetcher(() => new Error('x')) });
  await assert.rejects(failing.getGenesisHash(), (error) => error.code === 'TOKEN_RPC_REJECTED' && !error.message.includes('x'));
  // Oversized or non-JSON responses are refused.
  const huge = createTokenRpc({
    config: localnet,
    maximumBytes: 128,
    fetcher: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'x', result: 'y'.repeat(200) }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(huge.getBlockHeight(), code('TOKEN_RPC_RESPONSE_TOO_LARGE'));
  const html = createTokenRpc({ config: localnet, fetcher: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html.getBlockHeight(), code('TOKEN_RPC_INVALID_RESPONSE'));
  const mismatched = createTokenRpc({ config: localnet, fetcher: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'other', result: 1 }), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(mismatched.getBlockHeight(), code('TOKEN_RPC_INVALID_RESPONSE'));
  const down = createTokenRpc({ config: localnet, fetcher: async () => new Response('', { status: 502 }) });
  await assert.rejects(down.getBlockHeight(), (error) => error.code === 'TOKEN_RPC_UNAVAILABLE' && error.retryable);
  const slow = createTokenRpc({ config: localnet, timeoutMs: 20, fetcher: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(slow.getBlockHeight(), code('TOKEN_RPC_TIMEOUT'));
  await assert.rejects(rpc.sendTransaction('not base64!'), code('TOKEN_TRANSACTION_INVALID'));
  await assert.rejects(rpc.getTokenSupply('nope'), (error) => error.code === 'invalid_input');
});

void test('burn record hashes are canonical and whole-hour periods are enforced', () => {
  const periodEnd = new Date('2026-10-10T12:00:00.000Z');
  assert.equal(requireClosedHour(periodEnd, periodEnd.getTime()), periodEnd);
  assert.throws(() => requireClosedHour(periodEnd, periodEnd.getTime() - 1), code('TOKEN_BURN_PERIOD_INVALID'));
  assert.throws(() => requireClosedHour(new Date('2026-10-10T12:30:00.000Z')), code('TOKEN_BURN_PERIOD_INVALID'));
  assert.throws(() => requireClosedHour(new Date(NaN)), code('TOKEN_BURN_PERIOD_INVALID'));
  const record = {
    id: '00000000-0000-4000-8000-000000000001',
    ledgerTransactionId: '00000000-0000-4000-8000-000000000002',
    periodStart: new Date('2026-10-10T11:00:00.000Z'),
    periodEnd,
    maturedUsd6: 31n,
    spentUsd6: 31n,
    funding: 'buyback-simulation',
    cluster: 'localnet',
    tokenMint: mint,
    tokenProgram: 'token-2022',
    tokenDecimals: 6,
    priceUsd6PerToken: 250_000n,
    priceSource: 'simulated',
    tokensBoughtRaw: 124n,
    tokensBurnedRaw: 124n,
    swapSignature: bs58.encode(Buffer.alloc(64, 1)),
    burnSignature: bs58.encode(Buffer.alloc(64, 2)),
    finalizedSlot: 77,
  };
  const canonical = canonicalTokenBurnRecord(record);
  assert.ok(canonical.startsWith('{"v":1,"id":"00000000-0000-4000-8000-000000000001","ledgerTransactionId":'));
  assert.ok(canonical.includes('"maturedUsd6":"31"'));
  const hash = tokenBurnRecordHash(record);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(tokenBurnRecordHash({ ...record }), hash);
  assert.notEqual(tokenBurnRecordHash({ ...record, spentUsd6: 30n }), hash);
  assert.notEqual(tokenBurnRecordHash({ ...record, ledgerTransactionId: record.id }), hash);
  const stored = {
    ...record,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    maturedUsd6: '31',
    spentUsd6: '31',
    fundingSource: record.funding,
    priceUsd6PerToken: '250000',
    tokensBoughtRaw: '124',
    tokensBurnedRaw: '124',
    recordHash: hash,
    createdAt: new Date().toISOString(),
  };
  assert.ok(verifyTokenBurnRecord(stored));
  assert.ok(!verifyTokenBurnRecord({ ...stored, tokensBurnedRaw: '125' }));
});
