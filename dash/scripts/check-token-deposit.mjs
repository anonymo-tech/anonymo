import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  COMPUTE_BUDGET_PROGRAM,
  SOLANA_NETWORKS,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  SolanaError,
} from '../server/solana/index.ts';
import {
  quoteTokenDeposit,
  verifyTokenDeposit,
} from '../server/token/token-deposit.ts';
import {
  sameTokenDepositPolicy,
  tokenDepositCapability,
  tokenDepositConfiguration,
} from '../server/token/token-deposit-config.ts';
import { createSimulatedPriceSource } from '../server/token/price.ts';

const key = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
const txid = () => bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
const clone = (value) => structuredClone(value);
const error = (code) => (failure) =>
  failure instanceof SolanaError && (!code || failure.code === code);
const blockTime = 1_760_000_000;
const DECIMALS = 9;
const RAW = 2_500_000_000n;

function checkedTransfer(raw = RAW, decimals = DECIMALS) {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, raw, true);
  data[9] = decimals;
  return bs58.encode(data);
}

function fixture({
  program = 'spl-token',
  cluster = 'devnet',
  genesisHash = cluster === 'localnet'
    ? key()
    : SOLANA_NETWORKS[cluster].genesisHash,
} = {}) {
  const programId =
    program === 'spl-token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
  const mint = key();
  const sourceWallet = key();
  const source = key();
  const recipient = key();
  const recipientWallet = key();
  const reference = key();
  const signature = txid();
  const balance = (index, owner, raw) => ({
    accountIndex: index,
    mint,
    owner,
    programId,
    uiTokenAmount: {
      amount: raw,
      decimals: DECIMALS,
      uiAmount: null,
      uiAmountString: 'ignored',
    },
  });
  return {
    policy: {
      cluster,
      mint,
      decimals: DECIMALS,
      program,
      programId,
      recipientWallet,
      recipientTokenAccount: recipient,
    },
    intent: {
      id: crypto.randomUUID(),
      sourceWallet,
      reference,
      amountRaw: RAW.toString(),
      createdAtMs: blockTime * 1000 - 5000,
      expiresAtMs: blockTime * 1000 + 60_000,
    },
    evidence: {
      cluster,
      genesisHash,
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
            balance(1, sourceWallet, '10000000000'),
            balance(2, recipientWallet, '0'),
          ],
          postTokenBalances: [
            balance(1, sourceWallet, '7500000000'),
            balance(2, recipientWallet, '2500000000'),
          ],
        },
        transaction: {
          signatures: [signature],
          message: {
            header: {
              numRequiredSignatures: 1,
              numReadonlySignedAccounts: 0,
              numReadonlyUnsignedAccounts: 5,
            },
            accountKeys: [
              sourceWallet,
              source,
              recipient,
              mint,
              reference,
              programId,
              COMPUTE_BUDGET_PROGRAM,
              SYSTEM_PROGRAM,
            ],
            instructions: [
              {
                programIdIndex: 5,
                accounts: [1, 3, 2, 0, 4],
                data: checkedTransfer(),
              },
            ],
          },
        },
      },
    },
  };
}
const message = (value) => value.evidence.transaction.transaction.message;
const meta = (value) => value.evidence.transaction.meta;
const transfer = (value) => message(value).instructions.at(-1);
const rejected = (change, code, options) => {
  const value = fixture(options);
  change(value);
  assert.throws(() => verifyTokenDeposit(value), error(code));
};

void test('one finalized TransferChecked of the configured mint credits the exact quoted raw amount', () => {
  const value = fixture();
  const verified = verifyTokenDeposit(value);
  assert.equal(verified.eventId, `token:devnet:${value.evidence.signature}:0`);
  assert.equal(verified.amountRaw, RAW.toString());
  assert.equal(verified.decimals, DECIMALS);
  assert.equal(verified.programId, TOKEN_PROGRAM);
  assert.equal(verified.mint, value.policy.mint);
  assert.equal(verified.reference, value.intent.reference);
  assert.equal(verified.sourceWallet, value.intent.sourceWallet);
  assert.equal(
    verified.recipientTokenAccount,
    value.policy.recipientTokenAccount,
  );
  assert.equal(verified.blockTime, blockTime);
  assert.equal(verified.innerInstructionIndex, null);
});

void test('a plain Token-2022 TransferChecked with the same layout is accepted under a token-2022 policy', () => {
  const value = fixture({ program: 'token-2022' });
  const verified = verifyTokenDeposit(value);
  assert.equal(verified.programId, TOKEN_2022_PROGRAM);
  assert.equal(verified.amountRaw, RAW.toString());
});

void test('wrong mint, wrong program, wrong amount and wrong decimals never credit', () => {
  rejected((v) => {
    message(v).accountKeys[3] = key();
  }, 'deposit_mismatch');
  rejected((v) => {
    const other = key();
    message(v).accountKeys[3] = other;
    for (const list of [meta(v).preTokenBalances, meta(v).postTokenBalances])
      for (const balance of list) balance.mint = other;
  }, 'deposit_mismatch');
  // The transfer ran under the other token program than the policy names.
  rejected((v) => {
    message(v).accountKeys[5] = TOKEN_2022_PROGRAM;
  }, 'unsupported_instruction');
  rejected(
    (v) => {
      message(v).accountKeys[5] = TOKEN_PROGRAM;
    },
    'unsupported_instruction',
    { program: 'token-2022' },
  );
  rejected((v) => {
    message(v).accountKeys[5] = key();
  }, 'unsupported_instruction');
  rejected((v) => {
    transfer(v).data = checkedTransfer(RAW - 1n);
  }, 'deposit_mismatch');
  rejected((v) => {
    transfer(v).data = checkedTransfer(RAW + 1n);
  }, 'deposit_mismatch');
  rejected((v) => {
    transfer(v).data = checkedTransfer(RAW, 6);
  }, 'unsupported_instruction');
  rejected((v) => {
    const bytes = bs58.decode(transfer(v).data);
    bytes[0] = 3;
    transfer(v).data = bs58.encode(bytes);
  }, 'unsupported_instruction');
  // Balance metadata that disagrees with the instruction is rejected.
  rejected((v) => {
    meta(v).postTokenBalances[1].uiTokenAmount.amount = '2500000001';
  }, 'deposit_mismatch');
  rejected((v) => {
    for (const list of [meta(v).preTokenBalances, meta(v).postTokenBalances])
      for (const balance of list) balance.uiTokenAmount.decimals = 6;
  }, 'deposit_mismatch');
});

void test('the intent reference must be a read-only non-signer account on the transfer itself', () => {
  rejected((v) => {
    message(v).accountKeys[4] = key();
  }, 'deposit_mismatch');
  rejected((v) => {
    transfer(v).accounts = [1, 3, 2, 0];
  }, 'ambiguous_deposit');
  rejected((v) => {
    // Reference present in the transaction but not on the transfer.
    transfer(v).accounts = [1, 3, 2, 0, 7];
  }, 'deposit_mismatch');
  rejected((v) => {
    // Reference as a writable account.
    message(v).header.numReadonlyUnsignedAccounts = 3;
  }, 'deposit_mismatch');
  rejected((v) => {
    const keys = message(v).accountKeys;
    [keys[0], keys[4]] = [keys[4], keys[0]];
    transfer(v).accounts = [1, 3, 2, 4, 0];
    v.intent.reference = keys[0];
    v.intent.sourceWallet = keys[4];
    for (const list of [meta(v).preTokenBalances, meta(v).postTokenBalances])
      list[0].owner = keys[4];
  }, 'deposit_mismatch');
});

void test('a delegate or other authority, a different destination and a self transfer are rejected', () => {
  rejected((v) => {
    message(v).accountKeys[0] = key();
  }, 'deposit_mismatch');
  rejected((v) => {
    for (const list of [meta(v).preTokenBalances, meta(v).postTokenBalances])
      list[0].owner = key();
  }, 'deposit_mismatch');
  rejected((v) => {
    message(v).accountKeys[2] = key();
  }, 'deposit_mismatch');
  rejected((v) => {
    for (const list of [meta(v).preTokenBalances, meta(v).postTokenBalances])
      list[1].owner = key();
  }, 'deposit_mismatch');
  rejected((v) => {
    transfer(v).accounts = [2, 3, 2, 0, 4];
  }, 'ambiguous_deposit');
});

void test('extra instructions, inner instructions and a second transfer fail closed', () => {
  rejected((v) => {
    message(v).instructions.push({
      programIdIndex: 7,
      accounts: [0, 2],
      data: bs58.encode(new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])),
    });
  }, 'unsupported_instruction');
  rejected((v) => {
    message(v).instructions.unshift({
      programIdIndex: 7,
      accounts: [0, 2],
      data: bs58.encode(new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])),
    });
  }, 'unsupported_instruction');
  rejected((v) => {
    message(v).instructions.push(clone(transfer(v)));
  }, 'ambiguous_deposit');
  rejected((v) => {
    meta(v).innerInstructions = [
      { index: 0, instructions: [clone(transfer(v))] },
    ];
  }, 'unsupported_instruction');
  rejected((v) => {
    meta(v).innerInstructions = null;
  }, 'incomplete_metadata');
});

void test('supported compute-budget prefixes keep the transfer index; the transfer must be last', () => {
  const value = fixture();
  const compute = {
    programIdIndex: 6,
    accounts: [],
    data: bs58.encode(new Uint8Array([2, 1, 0, 0, 0])),
  };
  message(value).instructions.unshift(compute);
  const verified = verifyTokenDeposit(value);
  assert.equal(verified.instructionIndex, 1);
  assert.ok(verified.eventId.endsWith(':1'));
  message(value).instructions.push(compute);
  assert.throws(
    () => verifyTokenDeposit(value),
    error('unsupported_instruction'),
  );
});

void test('confirmed, failed and inconsistent transactions are never credited', () => {
  rejected((v) => {
    v.evidence.status.confirmationStatus = 'confirmed';
  }, 'not_finalized');
  rejected((v) => {
    v.evidence.status.confirmations = 31;
  }, 'not_finalized');
  rejected((v) => {
    v.evidence.status = null;
  }, 'not_finalized');
  rejected((v) => {
    v.evidence.status.err = { InstructionError: [0, 'InvalidArgument'] };
    meta(v).err = v.evidence.status.err;
  }, 'transaction_failed');
  rejected((v) => {
    meta(v).err = { InstructionError: [0, 'InvalidArgument'] };
  }, 'transaction_failed');
  rejected((v) => {
    v.evidence.signature = txid();
  }, 'deposit_mismatch');
  rejected((v) => {
    v.evidence.transaction.slot = 999;
  }, 'deposit_mismatch');
});

void test('the payment block time must lie inside the intent window', () => {
  rejected((v) => {
    v.evidence.transaction.blockTime = Math.floor(v.intent.expiresAtMs / 1000);
  }, 'deposit_mismatch');
  rejected((v) => {
    v.evidence.transaction.blockTime =
      Math.floor(v.intent.createdAtMs / 1000) - 1;
  }, 'deposit_mismatch');
  rejected((v) => {
    v.evidence.transaction.blockTime = null;
  }, 'invalid_response');
  const value = fixture();
  value.evidence.transaction.blockTime = Math.floor(
    value.intent.createdAtMs / 1000,
  );
  assert.equal(
    verifyTokenDeposit(value).blockTime,
    value.evidence.transaction.blockTime,
  );
  rejected((v) => {
    v.intent.expiresAtMs = v.intent.createdAtMs;
  }, 'invalid_input');
});

void test('Token-2022 transfer hooks, fee extensions and multisig authorities add accounts and fail closed', () => {
  rejected(
    (v) => {
      // A transfer hook appends the hook program and its extra accounts.
      transfer(v).accounts.push(7);
    },
    'ambiguous_deposit',
    { program: 'token-2022' },
  );
  rejected(
    (v) => {
      transfer(v).accounts.push(6, 7);
    },
    'ambiguous_deposit',
    { program: 'token-2022' },
  );
  rejected(
    (v) => {
      // TransferCheckedWithFee uses a different instruction prefix and length.
      const bytes = new Uint8Array(19);
      bytes[0] = 26;
      bytes[1] = 1;
      new DataView(bytes.buffer).setBigUint64(2, RAW, true);
      bytes[10] = DECIMALS;
      transfer(v).data = bs58.encode(bytes);
    },
    'unsupported_instruction',
    { program: 'token-2022' },
  );
  rejected(
    (v) => {
      // Multisig authority: the owner slot is the multisig and signers follow.
      transfer(v).accounts = [1, 3, 2, 7, 4, 0];
    },
    'ambiguous_deposit',
    { program: 'token-2022' },
  );
});

void test('cluster and genesis must agree; a public network hash can never pass as localnet', () => {
  rejected((v) => {
    v.evidence.cluster = 'localnet';
  }, 'wrong_cluster');
  rejected((v) => {
    v.evidence.genesisHash = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
  }, 'wrong_cluster');
  rejected((v) => {
    v.evidence.cluster = 'mainnet-beta';
    v.evidence.genesisHash = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
  }, 'wrong_cluster');
  rejected(
    (v) => {
      v.evidence.genesisHash = SOLANA_NETWORKS.devnet.genesisHash;
    },
    'wrong_cluster',
    { cluster: 'localnet' },
  );
  rejected(
    (v) => {
      v.evidence.genesisHash = 'not-a-hash';
    },
    'invalid_input',
    { cluster: 'localnet' },
  );
  const local = fixture({ cluster: 'localnet' });
  const verified = verifyTokenDeposit(local);
  assert.equal(verified.cluster, 'localnet');
  assert.ok(verified.eventId.startsWith('token:localnet:'));
  rejected((v) => {
    v.policy.cluster = 'testnet';
    v.evidence.cluster = 'testnet';
  }, 'invalid_configuration');
});

void test('the policy must name a real token program and distinct addresses', () => {
  rejected((v) => {
    v.policy.programId = key();
  }, 'invalid_configuration');
  rejected((v) => {
    v.policy.program = 'token-2022';
  }, 'invalid_configuration');
  rejected((v) => {
    v.policy.decimals = 10;
  }, 'invalid_response');
  rejected((v) => {
    v.policy.recipientTokenAccount = v.policy.recipientWallet;
  }, 'deposit_mismatch');
  rejected((v) => {
    v.intent.sourceWallet = v.policy.recipientWallet;
  }, 'deposit_mismatch');
  rejected((v) => {
    v.intent.amountRaw = '0';
  }, 'invalid_amount');
  rejected((v) => {
    v.intent.amountRaw = '2.5';
  }, 'invalid_amount');
});

void test('quotes round the token amount up so the credit never exceeds the value received', async () => {
  const source = createSimulatedPriceSource({ priceUsd6PerToken: 400_000n });
  const quote = await source.quote(1_700_000_000_000);
  const exact = quoteTokenDeposit({ usd6: 1_000_000n, quote, decimals: 9 });
  assert.equal(exact.amountRaw, 2_500_000_000n);
  assert.equal(exact.valueUsd6, 1_000_000n);
  assert.equal(exact.priceUsd6PerToken, 400_000n);
  assert.equal(exact.priceSource, 'simulated');
  assert.equal(exact.priceObservedAtMs, 1_700_000_000_000);
  assert.equal(exact.priceExpiresAtMs, 1_700_000_120_000);
  const odd = await createSimulatedPriceSource({ priceUsd6PerToken: 7n }).quote(
    1,
  );
  const rounded = quoteTokenDeposit({
    usd6: 1_000_000n,
    quote: odd,
    decimals: 9,
  });
  assert.equal(rounded.amountRaw, 142_857_142_857_143n);
  assert.ok(rounded.valueUsd6 >= 1_000_000n);
  // One raw unit less would not cover the credit.
  assert.ok(((rounded.amountRaw - 1n) * 7n) / 1_000_000_000n < 1_000_000n);
  const coarse = quoteTokenDeposit({
    usd6: 1n,
    quote: { ...odd, priceUsd6PerToken: 3n },
    decimals: 0,
  });
  assert.equal(coarse.amountRaw, 1n);
  assert.equal(coarse.valueUsd6, 3n);
  for (const usd6 of [0n, -1n, 1, '1'])
    assert.throws(() => quoteTokenDeposit({ usd6, quote, decimals: 9 }), {
      code: 'INVALID_AMOUNT',
    });
  assert.throws(
    () =>
      quoteTokenDeposit({
        usd6: 9_000_000_000_000_000n,
        quote: { ...quote, priceUsd6PerToken: 1n },
        decimals: 9,
      }),
    { code: 'TOKEN_AMOUNT_UNSUPPORTED' },
  );
  assert.throws(
    () =>
      quoteTokenDeposit({
        usd6: 1n,
        quote: { ...quote, priceUsd6PerToken: 0n },
        decimals: 9,
      }),
    { code: 'TOKEN_PRICE_UNAVAILABLE' },
  );
});

void test('capability is off by default and every missing piece names its reason without secrets', () => {
  const treasury = key(),
    treasuryAccount = key(),
    mint = key();
  const env = {
    CONCLAVE_TOKEN_MINT: mint,
    CONCLAVE_TOKEN_CLUSTER: 'devnet',
    CONCLAVE_TOKEN_RPC_URL: 'https://rpc.example/token?key=fixture-marker',
    CONCLAVE_TOKEN_DECIMALS: '9',
    CONCLAVE_TOKEN_PROGRAM: 'spl-token',
    CONCLAVE_TOKEN_PAYMENTS_ENABLED: 'true',
    CONCLAVE_TOKEN_TREASURY_WALLET: treasury,
    CONCLAVE_TOKEN_TREASURY_TOKEN_ACCOUNT: treasuryAccount,
    CONCLAVE_TOKEN_MAX_DEPOSIT_USD6: '100000000',
    CONCLAVE_TOKEN_PRICE_SOURCE: 'simulated',
    CONCLAVE_TOKEN_SIMULATED_PRICE_USD6: '400000',
  };
  const enabled = tokenDepositConfiguration(env);
  assert.equal(enabled.capability.configured, true);
  assert.equal(enabled.capability.reason, 'TOKEN_DEPOSITS_CONFIGURED');
  assert.equal(enabled.capability.label, 'platform token');
  assert.equal(enabled.capability.quoteTtlMs, 120_000);
  assert.equal(enabled.capability.priceSource, 'simulated');
  assert.equal(enabled.capability.transactionFormat, 'spl-transfer-checked-v1');
  assert.equal(enabled.policy.programId, TOKEN_PROGRAM);
  assert.equal(enabled.priceSource.kind, 'simulated');
  const serialized = JSON.stringify(enabled.capability);
  assert.ok(!serialized.includes('rpc.example'));
  assert.ok(!serialized.includes('fixture-marker'));
  assert.ok(
    sameTokenDepositPolicy(
      enabled.policy,
      tokenDepositConfiguration(env).policy,
    ),
  );
  assert.equal(
    tokenDepositConfiguration({ ...env, CONCLAVE_TOKEN_QUOTE_TTL_MS: '30000' })
      .capability.quoteTtlMs,
    30_000,
  );
  assert.equal(
    tokenDepositConfiguration({ ...env, CONCLAVE_TOKEN_PROGRAM: 'token-2022' })
      .policy.programId,
    TOKEN_2022_PROGRAM,
  );
  const off = tokenDepositCapability({});
  assert.equal(off.configured, false);
  assert.equal(off.reason, 'TOKEN_NOT_CONFIGURED');
  assert.equal(off.recipientWallet, null);
  for (const [name, value, reason] of [
    ['CONCLAVE_TOKEN_PAYMENTS_ENABLED', 'false', 'TOKEN_PAYMENTS_DISABLED'],
    ['CONCLAVE_TOKEN_PAYMENTS_ENABLED', undefined, 'TOKEN_PAYMENTS_DISABLED'],
    ['CONCLAVE_TOKEN_CLUSTER', 'mainnet-beta', 'TOKEN_MAINNET_LOCKED'],
    ['CONCLAVE_TOKEN_CLUSTER', 'testnet', 'TOKEN_CONFIGURATION_INVALID'],
    ['CONCLAVE_TOKEN_MINT', 'not-a-mint', 'TOKEN_CONFIGURATION_INVALID'],
    ['CONCLAVE_TOKEN_DECIMALS', undefined, 'TOKEN_CONFIGURATION_INVALID'],
    [
      'CONCLAVE_TOKEN_TREASURY_WALLET',
      undefined,
      'TOKEN_DEPOSIT_CONFIGURATION_REQUIRED',
    ],
    [
      'CONCLAVE_TOKEN_TREASURY_WALLET',
      treasuryAccount,
      'TOKEN_DEPOSIT_CONFIGURATION_REQUIRED',
    ],
    [
      'CONCLAVE_TOKEN_TREASURY_TOKEN_ACCOUNT',
      mint,
      'TOKEN_DEPOSIT_CONFIGURATION_REQUIRED',
    ],
    [
      'CONCLAVE_TOKEN_MAX_DEPOSIT_USD6',
      '0',
      'TOKEN_DEPOSIT_CONFIGURATION_REQUIRED',
    ],
    [
      'CONCLAVE_TOKEN_MAX_DEPOSIT_USD6',
      '1.25',
      'TOKEN_DEPOSIT_CONFIGURATION_REQUIRED',
    ],
    [
      'CONCLAVE_TOKEN_QUOTE_TTL_MS',
      '0',
      'TOKEN_DEPOSIT_CONFIGURATION_REQUIRED',
    ],
    [
      'CONCLAVE_TOKEN_QUOTE_TTL_MS',
      '900001',
      'TOKEN_DEPOSIT_CONFIGURATION_REQUIRED',
    ],
    ['CONCLAVE_TOKEN_PRICE_SOURCE', undefined, 'TOKEN_PRICE_UNAVAILABLE'],
    ['CONCLAVE_TOKEN_PRICE_SOURCE', 'oracle', 'TOKEN_PRICE_UNAVAILABLE'],
    ['CONCLAVE_TOKEN_SIMULATED_PRICE_USD6', '0', 'TOKEN_PRICE_UNAVAILABLE'],
    ['CONCLAVE_TOKEN_SIMULATED_PRICE_USD6', 'free', 'TOKEN_PRICE_UNAVAILABLE'],
  ]) {
    const changed = { ...env };
    if (value === undefined) delete changed[name];
    else changed[name] = value;
    const result = tokenDepositConfiguration(changed);
    assert.equal(result.capability.configured, false, `${name}=${value}`);
    assert.equal(result.capability.reason, reason, `${name}=${value}`);
    assert.equal(result.priceSource, null);
  }
  // Payments disabled still exposes the terms the user would see, but nothing is enabled.
  const disabled = tokenDepositConfiguration({
    ...env,
    CONCLAVE_TOKEN_PAYMENTS_ENABLED: 'false',
  });
  assert.equal(disabled.capability.recipientWallet, treasury);
  assert.equal(disabled.policy, null);
  // Localnet is write-capable and can be configured against a loopback validator.
  const local = tokenDepositConfiguration({
    ...env,
    CONCLAVE_TOKEN_CLUSTER: 'localnet',
    CONCLAVE_TOKEN_RPC_URL: 'http://127.0.0.1:8899',
  });
  assert.equal(local.capability.configured, true);
  assert.equal(local.policy.cluster, 'localnet');
});
