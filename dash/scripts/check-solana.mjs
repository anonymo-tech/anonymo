import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { solanaPayUrl } from '../lib/anonymo/solana-pay.ts';
import { attemptSlot, matchAttempt, newAttempt, parseAttempt, topupView } from '../lib/anonymo/topup-attempt.ts';
import { parseUpdates, RELEASED } from '../lib/anonymo/updates.ts';
import {
  COMPUTE_BUDGET_PROGRAM,
  SOLANA_NETWORKS,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  SolanaError,
  createSolanaReader,
  explainParsedTransaction,
  verifyUsdcDeposit,
} from '../server/solana/index.ts';

const key = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
const txid = () => bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
const clone = (value) => structuredClone(value);
const error = (code) => (failure) =>
  failure instanceof SolanaError && (!code || failure.code === code);
const network = 'devnet';
const mint = SOLANA_NETWORKS[network].usdcMint;
const blockTime = 1_760_000_000;
const rpcUrl = 'https://rpc.example/solana';

function checkedTransfer(raw = 1_000_000n, decimals = 6) {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, raw, true);
  data[9] = decimals;
  return bs58.encode(data);
}

function fixture() {
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
    programId: TOKEN_PROGRAM,
    uiTokenAmount: {
      amount: raw,
      decimals: 6,
      uiAmount: null,
      uiAmountString: 'ignored',
    },
  });
  return {
    policy: {
      cluster: network,
      recipientWallet,
      recipientTokenAccount: recipient,
      usdcMint: mint,
    },
    intent: {
      id: crypto.randomUUID(),
      sourceWallet,
      reference,
      amountRaw: '1000000',
      createdAtMs: blockTime * 1000 - 5000,
      expiresAtMs: blockTime * 1000 + 60_000,
    },
    evidence: {
      cluster: network,
      genesisHash: SOLANA_NETWORKS[network].genesisHash,
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
            balance(1, sourceWallet, '10000000'),
            balance(2, recipientWallet, '0'),
          ],
          postTokenBalances: [
            balance(1, sourceWallet, '9000000'),
            balance(2, recipientWallet, '1000000'),
          ],
        },
        transaction: {
          signatures: [signature],
          message: {
            header: {
              numRequiredSignatures: 1,
              numReadonlySignedAccounts: 0,
              numReadonlyUnsignedAccounts: 4,
            },
            accountKeys: [
              sourceWallet,
              source,
              recipient,
              mint,
              reference,
              TOKEN_PROGRAM,
              COMPUTE_BUDGET_PROGRAM,
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
const rejectedMutation = (change, code) => {
  const value = fixture();
  change(value);
  assert.throws(() => verifyUsdcDeposit(value), error(code));
};

void test('one finalized successful TransferChecked returns an exact DB settlement identity', () => {
  const value = fixture();
  const result = verifyUsdcDeposit(value);
  assert.deepEqual(result, {
    intentId: value.intent.id,
    eventId: `solana:devnet:${value.evidence.signature}:0`,
    cluster: 'devnet',
    signature: value.evidence.signature,
    instructionIndex: 0,
    innerInstructionIndex: null,
    reference: value.intent.reference,
    sourceWallet: value.intent.sourceWallet,
    sourceTokenAccount: message(value).accountKeys[1],
    recipientWallet: value.policy.recipientWallet,
    recipientTokenAccount: value.policy.recipientTokenAccount,
    mint,
    decimals: 6,
    amountRaw: '1000000',
    slot: 1000,
    blockTime,
  });
});

void test('mainnet and devnet explicitly pin different genesis hashes and issuer mints', () => {
  const value = fixture();
  const mainnet = SOLANA_NETWORKS['mainnet-beta'];
  value.policy.cluster = 'mainnet-beta';
  value.evidence.cluster = 'mainnet-beta';
  value.evidence.genesisHash = mainnet.genesisHash;
  value.policy.usdcMint = mainnet.usdcMint;
  message(value).accountKeys[3] = mainnet.usdcMint;
  for (const entry of [
    ...meta(value).preTokenBalances,
    ...meta(value).postTokenBalances,
  ])
    entry.mint = mainnet.usdcMint;
  assert.equal(verifyUsdcDeposit(value).cluster, 'mainnet-beta');
  rejectedMutation((v) => {
    v.evidence.genesisHash = mainnet.genesisHash;
  }, 'wrong_cluster');
  rejectedMutation((v) => {
    v.evidence.cluster = 'mainnet-beta';
  }, 'wrong_cluster');
  rejectedMutation((v) => {
    v.policy.usdcMint = key();
  }, 'invalid_configuration');
});

void test('confirmed, processed, missing and inconsistent finality are never credited', () => {
  for (const confirmationStatus of ['processed', 'confirmed', undefined])
    rejectedMutation((v) => {
      v.evidence.status.confirmationStatus = confirmationStatus;
    }, 'not_finalized');
  rejectedMutation((v) => {
    v.evidence.status = null;
  }, 'not_finalized');
  rejectedMutation((v) => {
    v.evidence.status.confirmations = 32;
  }, 'not_finalized');
  rejectedMutation((v) => {
    v.evidence.status.slot += 1;
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    v.evidence.transaction.transaction.signatures[0] = txid();
  }, 'deposit_mismatch');
});

void test('failed status or transaction metadata cannot produce a deposit', () => {
  rejectedMutation((v) => {
    v.evidence.status.err = { InstructionError: [0, 'Custom'] };
  }, 'transaction_failed');
  rejectedMutation((v) => {
    meta(v).err = { InstructionError: [0, 'Custom'] };
  }, 'transaction_failed');
  rejectedMutation((v) => {
    delete meta(v).err;
  }, 'transaction_failed');
});

void test('mint, token recipient, source authority and actual instruction reference must match', () => {
  for (const index of [0, 2, 3, 4])
    rejectedMutation((v) => {
      message(v).accountKeys[index] = key();
    }, 'deposit_mismatch');
  rejectedMutation((v) => {
    v.intent.reference = key();
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    v.intent.sourceWallet = key();
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    v.policy.recipientTokenAccount = key();
  }, 'deposit_mismatch');
});

void test('a reference elsewhere in the transaction is insufficient', () => {
  rejectedMutation((v) => {
    transfer(v).accounts.pop();
  }, 'ambiguous_deposit');
  rejectedMutation((v) => {
    transfer(v).accounts[4] = 6;
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    message(v).instructions.unshift({
      programIdIndex: 6,
      accounts: [4],
      data: bs58.encode(new Uint8Array([2, 1, 0, 0, 0])),
    });
  }, 'unsupported_instruction');
});

void test('reference must be read-only, not a signer, and distinct from transfer accounts', () => {
  rejectedMutation((v) => {
    message(v).header.numReadonlyUnsignedAccounts = 2;
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    transfer(v).accounts[4] = transfer(v).accounts[0];
  }, 'ambiguous_deposit');
  const value = fixture();
  const keys = message(value).accountKeys;
  const moved = [keys[0], keys[4], keys[1], keys[2], keys[3], keys[5], keys[6]];
  message(value).accountKeys = moved;
  message(value).header = {
    numRequiredSignatures: 2,
    numReadonlySignedAccounts: 1,
    numReadonlyUnsignedAccounts: 3,
  };
  value.evidence.transaction.transaction.signatures.push(txid());
  transfer(value).accounts = [2, 4, 3, 0, 1];
  assert.throws(() => verifyUsdcDeposit(value), error('deposit_mismatch'));
});

void test('historical token owner, program, mint and decimal metadata must agree on both sides', () => {
  for (const side of ['preTokenBalances', 'postTokenBalances'])
    for (const index of [0, 1]) {
      for (const field of ['owner', 'mint', 'programId'])
        rejectedMutation((v) => {
          meta(v)[side][index][field] = key();
        }, 'deposit_mismatch');
      rejectedMutation((v) => {
        meta(v)[side][index].uiTokenAmount.decimals = 9;
      }, 'deposit_mismatch');
      rejectedMutation((v) => {
        delete meta(v)[side][index].owner;
      });
    }
  rejectedMutation((v) => {
    v.policy.recipientWallet = key();
  }, 'deposit_mismatch');
});

void test('exact source debit and recipient credit are required; UI floating values are ignored', () => {
  rejectedMutation((v) => {
    meta(v).postTokenBalances[0].uiTokenAmount.amount = '8999999';
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    meta(v).postTokenBalances[1].uiTokenAmount.amount = '999999';
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    transfer(v).data = checkedTransfer(999_999n);
  }, 'deposit_mismatch');
  const value = fixture();
  for (const row of [
    ...meta(value).preTokenBalances,
    ...meta(value).postTokenBalances,
  ]) {
    row.uiTokenAmount.uiAmount = 99e99;
    row.uiTokenAmount.uiAmountString = 'not trusted';
  }
  assert.equal(verifyUsdcDeposit(value).amountRaw, '1000000');
});

void test('u64 amounts above Number precision remain exact and unsafe numeric values fail', () => {
  const value = fixture();
  const raw = 9_007_199_254_740_993n;
  value.intent.amountRaw = raw.toString();
  transfer(value).data = checkedTransfer(raw);
  meta(value).preTokenBalances[0].uiTokenAmount.amount = (raw + 1n).toString();
  meta(value).postTokenBalances[0].uiTokenAmount.amount = '1';
  meta(value).postTokenBalances[1].uiTokenAmount.amount = raw.toString();
  assert.equal(verifyUsdcDeposit(value).amountRaw, raw.toString());
  for (const invalid of [
    0,
    1_000_000,
    Number.MAX_SAFE_INTEGER + 1,
    '0',
    '-1',
    '01',
    '1e6',
    '1.0',
    '18446744073709551616',
  ])
    rejectedMutation((v) => {
      v.intent.amountRaw = invalid;
    }, 'invalid_amount');
  rejectedMutation((v) => {
    meta(v).postTokenBalances[1].uiTokenAmount.amount =
      Number.MAX_SAFE_INTEGER + 1;
  }, 'invalid_amount');
  rejectedMutation((v) => {
    v.evidence.status.slot = Number.MAX_SAFE_INTEGER + 1;
  }, 'invalid_response');
});

void test('multiple transfers, duplicated metadata and extra token balances are ambiguous', () => {
  rejectedMutation((v) => {
    message(v).instructions.push(clone(transfer(v)));
  }, 'ambiguous_deposit');
  rejectedMutation((v) => {
    meta(v).preTokenBalances.push(clone(meta(v).preTokenBalances[0]));
  }, 'ambiguous_deposit');
  rejectedMutation((v) => {
    const row = clone(meta(v).preTokenBalances[0]);
    row.accountIndex = 0;
    meta(v).preTokenBalances.push(row);
  }, 'ambiguous_deposit');
  rejectedMutation((v) => {
    meta(v).postTokenBalances = [];
  }, 'ambiguous_deposit');
});

void test('repeat proof has the same event identity so DB can reject cross-intent double credit', () => {
  const value = fixture();
  const first = verifyUsdcDeposit(value);
  value.intent.id = crypto.randomUUID();
  const second = verifyUsdcDeposit(value);
  assert.notEqual(first.intentId, second.intentId);
  assert.equal(first.eventId, second.eventId);
  assert.deepEqual(
    [first.cluster, first.signature, first.instructionIndex],
    [second.cluster, second.signature, second.instructionIndex],
  );
});

void test('unsupported SPL transfer, Token-2022, CPI, unknown programs and extra references fail closed', () => {
  rejectedMutation((v) => {
    const bytes = bs58.decode(transfer(v).data);
    bytes[0] = 3;
    transfer(v).data = bs58.encode(bytes);
  }, 'unsupported_instruction');
  rejectedMutation((v) => {
    transfer(v).data = checkedTransfer(1_000_000n, 9);
  }, 'unsupported_instruction');
  rejectedMutation((v) => {
    message(v).accountKeys[5] = TOKEN_2022_PROGRAM;
  }, 'unsupported_instruction');
  rejectedMutation((v) => {
    message(v).accountKeys[5] = key();
  }, 'unsupported_instruction');
  rejectedMutation((v) => {
    meta(v).innerInstructions = [
      { index: 0, instructions: [clone(transfer(v))] },
    ];
  }, 'unsupported_instruction');
  rejectedMutation((v) => {
    meta(v).innerInstructions = null;
  }, 'incomplete_metadata');
  rejectedMutation((v) => {
    transfer(v).accounts.push(6);
  }, 'ambiguous_deposit');
});

void test('supported compute prefixes retain the transfer instruction index; transfer must be last', () => {
  const value = fixture();
  const compute = {
    programIdIndex: 6,
    accounts: [],
    data: bs58.encode(new Uint8Array([2, 1, 0, 0, 0])),
  };
  message(value).instructions.unshift(compute);
  assert.equal(verifyUsdcDeposit(value).instructionIndex, 1);
  assert.equal(verifyUsdcDeposit(value).eventId.endsWith(':1'), true);
  message(value).instructions.push(compute);
  assert.throws(
    () => verifyUsdcDeposit(value),
    error('unsupported_instruction'),
  );
});

void test('deposits resolve complete v0 loaded addresses and ownership indexes', () => {
  const value = fixture();
  const old = message(value).accountKeys;
  value.evidence.transaction.version = 0;
  message(value).accountKeys = [old[0], TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM];
  message(value).header.numReadonlyUnsignedAccounts = 2;
  message(value).addressTableLookups = [
    { accountKey: key(), writableIndexes: [1, 3], readonlyIndexes: [2, 4] },
  ];
  meta(value).loadedAddresses = {
    writable: [old[1], old[2]],
    readonly: [old[3], old[4]],
  };
  transfer(value).programIdIndex = 1;
  transfer(value).accounts = [3, 5, 4, 0, 6];
  for (const side of ['preTokenBalances', 'postTokenBalances']) {
    meta(value)[side][0].accountIndex = 3;
    meta(value)[side][1].accountIndex = 4;
  }
  assert.equal(verifyUsdcDeposit(value).sourceTokenAccount, old[1]);
  delete meta(value).loadedAddresses;
  assert.throws(() => verifyUsdcDeposit(value), error('incomplete_metadata'));
});

void test('unknown versions, malformed account indexes and duplicate loaded keys cannot resolve silently', () => {
  rejectedMutation((v) => {
    v.evidence.transaction.version = 1;
  }, 'unsupported_transaction');
  rejectedMutation((v) => {
    transfer(v).accounts[0] = 99;
  }, 'invalid_response');
  rejectedMutation((v) => {
    transfer(v).programIdIndex = 99;
  }, 'invalid_response');
  rejectedMutation((v) => {
    message(v).accountKeys[6] = message(v).accountKeys[4];
  }, 'invalid_response');
  rejectedMutation((v) => {
    transfer(v).data = '!';
  }, 'invalid_response');
  rejectedMutation((v) => {
    transfer(v).data = '1'.repeat(2000);
  }, 'invalid_response');
});

void test('payment block time must lie inside the intent window, even if settlement is later', () => {
  rejectedMutation((v) => {
    v.evidence.transaction.blockTime = null;
  }, 'invalid_response');
  rejectedMutation((v) => {
    v.evidence.transaction.blockTime =
      Math.floor(v.intent.createdAtMs / 1000) - 1;
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    v.evidence.transaction.blockTime = Math.floor(v.intent.expiresAtMs / 1000);
  }, 'deposit_mismatch');
  rejectedMutation((v) => {
    v.intent.expiresAtMs = v.intent.createdAtMs;
  }, 'invalid_input');
});

function parsedFixture(instructions) {
  return {
    version: 'legacy',
    slot: 1000,
    meta: { err: null, innerInstructions: [] },
    transaction: { signatures: [txid()], message: { instructions } },
  };
}
const instruction = (programId, type, info) => ({
  programId,
  program: 'untrusted label',
  parsed: { type, info },
});

void test('deterministic explainer identifies SOL and SPL transfers without asserting finality or safety', () => {
  const source = key();
  const destination = key();
  const authority = key();
  const result = explainParsedTransaction(
    parsedFixture([
      instruction(SYSTEM_PROGRAM, 'transfer', {
        source,
        destination,
        lamports: 1234,
      }),
      instruction(TOKEN_PROGRAM, 'transfer', {
        source,
        destination,
        authority,
        amount: '9007199254740993',
      }),
      instruction(TOKEN_PROGRAM, 'transferChecked', {
        source,
        destination,
        authority,
        mint,
        tokenAmount: { amount: '1000000', decimals: 6 },
      }),
    ]),
  );
  assert.deepEqual(
    result.instructions.map((entry) => entry.kind),
    ['systemTransfer', 'transfer', 'transferChecked'],
  );
  assert.equal(result.instructions[1].fields.amountRaw, '9007199254740993');
  assert.equal(result.finality, 'not-verified');
  assert.equal(result.safe, undefined);
  assert.equal(
    result.flags.some((flag) => flag.code === 'FINALITY_UNVERIFIED'),
    true,
  );
});

void test('approvals, authority changes and account closures always receive deterministic critical flags', () => {
  const a = key();
  const b = key();
  const c = key();
  const result = explainParsedTransaction(
    parsedFixture([
      instruction(TOKEN_PROGRAM, 'approve', {
        source: a,
        delegate: b,
        owner: c,
        amount: '50',
      }),
      instruction(TOKEN_PROGRAM, 'approveChecked', {
        source: a,
        delegate: b,
        owner: c,
        mint,
        tokenAmount: { amount: '50', decimals: 6 },
      }),
      instruction(TOKEN_PROGRAM, 'setAuthority', {
        account: a,
        authority: b,
        authorityType: 'accountOwner',
        newAuthority: c,
      }),
      instruction(TOKEN_PROGRAM, 'setAuthority', {
        mint,
        authority: b,
        authorityType: 'mintTokens',
        newAuthority: null,
      }),
      instruction(TOKEN_PROGRAM, 'closeAccount', {
        account: a,
        destination: b,
        owner: c,
      }),
    ]),
  );
  assert.deepEqual(
    result.instructions.map((entry) => entry.flags[0].code),
    [
      'TOKEN_APPROVAL',
      'TOKEN_APPROVAL',
      'AUTHORITY_CHANGE',
      'AUTHORITY_CHANGE',
      'ACCOUNT_CLOSURE',
    ],
  );
  assert.equal(
    result.instructions.every(
      (entry) => entry.flags[0].severity === 'critical',
    ),
    true,
  );
  assert.equal(result.instructions[3].fields.newAuthority, 'none');
});

void test('unknown program IDs cannot impersonate System or Token using parsed labels', () => {
  const result = explainParsedTransaction(
    parsedFixture([
      {
        ...instruction(key(), 'transfer', {
          source: key(),
          destination: key(),
          lamports: 1,
        }),
        program: 'system',
      },
      instruction(TOKEN_2022_PROGRAM, 'transferChecked', {}),
      instruction(TOKEN_PROGRAM, 'futureInstruction', {}),
    ]),
  );
  assert.deepEqual(
    result.instructions.map((entry) => entry.flags[0].code),
    [
      'UNKNOWN_PROGRAM',
      'TOKEN_2022_STATE_UNINSPECTED',
      'UNSUPPORTED_INSTRUCTION',
    ],
  );
});

void test('explainer never rounds unsafe amounts or infers absent authority fields', () => {
  const result = explainParsedTransaction(
    parsedFixture([
      instruction(SYSTEM_PROGRAM, 'transfer', {
        source: key(),
        destination: key(),
        lamports: Number.MAX_SAFE_INTEGER + 1,
      }),
      instruction(TOKEN_PROGRAM, 'approve', {
        source: key(),
        delegate: key(),
        owner: key(),
        amount: 100,
      }),
      instruction(TOKEN_PROGRAM, 'closeAccount', {
        account: key(),
        destination: key(),
      }),
    ]),
  );
  assert.equal(
    result.instructions.every((entry) =>
      entry.flags.some((flag) => flag.code === 'MALFORMED_INSTRUCTION'),
    ),
    true,
  );
  assert.equal(
    result.instructions.every(
      (entry) => Object.keys(entry.fields).length === 0,
    ),
    true,
  );
  assert.equal(
    result.instructions[1].flags.some(
      (flag) => flag.code === 'TOKEN_APPROVAL' && flag.severity === 'critical',
    ),
    true,
  );
  assert.equal(
    result.instructions[2].flags.some(
      (flag) => flag.code === 'ACCOUNT_CLOSURE' && flag.severity === 'critical',
    ),
    true,
  );
});

void test('explainer includes inner operations and explicitly marks failed/incomplete execution', () => {
  const value = parsedFixture([{ programId: key(), accounts: [], data: '1' }]);
  value.meta.innerInstructions = [
    {
      index: 0,
      instructions: [
        instruction(TOKEN_PROGRAM, 'approve', {
          source: key(),
          owner: key(),
          delegate: key(),
          amount: '1',
        }),
      ],
    },
  ];
  value.meta.err = { InstructionError: [0, 'Custom'] };
  const result = explainParsedTransaction(value);
  assert.equal(result.instructions[1].location, '0.0');
  assert.equal(
    result.flags.some((flag) => flag.code === 'TOKEN_APPROVAL'),
    true,
  );
  assert.equal(result.execution, 'failed');
  assert.equal(
    result.flags.some((flag) => flag.code === 'TRANSACTION_FAILED'),
    true,
  );
  value.meta = null;
  assert.equal(
    explainParsedTransaction(value).flags.some(
      (flag) => flag.code === 'INCOMPLETE_METADATA',
    ),
    true,
  );
});

function rpcMock(value = fixture(), customize) {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const result =
      body.method === 'getGenesisHash'
        ? value.evidence.genesisHash
        : body.method === 'getSignatureStatuses'
          ? { context: { slot: 1001 }, value: [value.evidence.status] }
          : value.evidence.transaction;
    const response = customize?.({ body, result, url, init });
    if (response !== undefined) return response;
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  return { calls, fetcher };
}

void test('configured reader checks genesis and finalized historical status before retrieving compiled JSON', async () => {
  const value = fixture();
  const mock = rpcMock(value);
  const reader = createSolanaReader({
    rpcUrl,
    cluster: network,
    fetcher: mock.fetcher,
  });
  const evidence = await reader.readDepositEvidence(value.evidence.signature);
  assert.equal(verifyUsdcDeposit({ ...value, evidence }).amountRaw, '1000000');
  assert.deepEqual(
    mock.calls.map((call) => call.body.method),
    ['getGenesisHash', 'getSignatureStatuses', 'getTransaction'],
  );
  assert.deepEqual(mock.calls[1].body.params[1], {
    searchTransactionHistory: true,
  });
  assert.deepEqual(mock.calls[2].body.params[1], {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
    encoding: 'json',
  });
  assert.equal(
    mock.calls.every(
      (call) =>
        call.url === rpcUrl &&
        call.init.redirect === 'error' &&
        call.init.credentials === 'omit' &&
        call.init.cache === 'no-store',
    ),
    true,
  );
  assert.equal(Object.hasOwn(reader, 'sendTransaction'), false);
  assert.equal(Object.hasOwn(reader, 'rpc'), false);
});

void test('wrong genesis and nonfinalized status stop the reader before transaction retrieval', async () => {
  const value = fixture();
  value.evidence.genesisHash = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
  const wrong = rpcMock(value);
  await assert.rejects(
    createSolanaReader({
      rpcUrl,
      cluster: network,
      fetcher: wrong.fetcher,
    }).readDepositEvidence(value.evidence.signature),
    error('wrong_cluster'),
  );
  assert.equal(wrong.calls.length, 1);
  value.evidence.genesisHash = SOLANA_NETWORKS.devnet.genesisHash;
  value.evidence.status.confirmationStatus = 'confirmed';
  const pending = rpcMock(value);
  await assert.rejects(
    createSolanaReader({
      rpcUrl,
      cluster: network,
      fetcher: pending.fetcher,
    }).readDepositEvidence(value.evidence.signature),
    error('not_finalized'),
  );
  assert.equal(pending.calls.length, 2);
});

void test('RPC configuration cannot be changed by a signature and rejects unsafe endpoint syntax', async () => {
  for (const endpoint of [
    'http://rpc.example',
    'file:///tmp/rpc',
    'https://user:password@rpc.example',
    'https://rpc.example/#fragment',
    'not-a-url',
  ])
    assert.throws(
      () => createSolanaReader({ rpcUrl: endpoint, cluster: network }),
      error('invalid_configuration'),
    );
  assert.throws(
    () => createSolanaReader({ rpcUrl, cluster: 'testnet' }),
    error('invalid_configuration'),
  );
  const mock = rpcMock();
  await assert.rejects(
    createSolanaReader({
      rpcUrl,
      cluster: network,
      fetcher: mock.fetcher,
    }).readDepositEvidence('https://client.example'),
    error('invalid_input'),
  );
  assert.equal(mock.calls.length, 0);
});

void test('RPC validates response identity, body shape and media type without leaking provider text', async () => {
  const value = fixture();
  const cases = [
    ({ body, result }) =>
      Response.json({ jsonrpc: '2.0', id: `${body.id}-wrong`, result }),
    ({ body, result }) =>
      Response.json({ jsonrpc: '1.0', id: body.id, result }),
    ({ body }) =>
      Response.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { message: 'private endpoint detail' },
      }),
    () =>
      new Response('private endpoint detail', {
        headers: { 'Content-Type': 'text/html' },
      }),
    () =>
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const customize of cases) {
    const mock = rpcMock(value, customize);
    await assert.rejects(
      createSolanaReader({
        rpcUrl,
        cluster: network,
        fetcher: mock.fetcher,
      }).readDepositEvidence(value.evidence.signature),
      (failure) =>
        error('invalid_response')(failure) &&
        !failure.message.includes('private'),
    );
  }
});

void test('HTTP failures, redirects, oversized declared/streamed bodies and null transactions fail closed', async () => {
  const value = fixture();
  for (const status of [302, 401, 429, 500]) {
    const mock = rpcMock(
      value,
      () => new Response('provider detail', { status }),
    );
    await assert.rejects(
      createSolanaReader({
        rpcUrl,
        cluster: network,
        fetcher: mock.fetcher,
      }).readDepositEvidence(value.evidence.signature),
      error('rpc_unavailable'),
    );
  }
  for (const headers of [
    { 'Content-Type': 'application/json', 'Content-Length': '999999' },
    { 'Content-Type': 'application/json' },
  ]) {
    const mock = rpcMock(
      value,
      () => new Response('x'.repeat(2048), { headers }),
    );
    await assert.rejects(
      createSolanaReader({
        rpcUrl,
        cluster: network,
        maximumBytes: 1024,
        fetcher: mock.fetcher,
      }).readDepositEvidence(value.evidence.signature),
      error('response_too_large'),
    );
  }
  const mock = rpcMock(value, ({ body }) =>
    body.method === 'getTransaction'
      ? Response.json({ jsonrpc: '2.0', id: body.id, result: null })
      : undefined,
  );
  await assert.rejects(
    createSolanaReader({
      rpcUrl,
      cluster: network,
      fetcher: mock.fetcher,
    }).readDepositEvidence(value.evidence.signature),
    error('not_finalized'),
  );
});

void test('transport timeout includes body streaming and cancels a stuck reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = async () =>
    new Response(body, { headers: { 'Content-Type': 'application/json' } });
  const reader = createSolanaReader({
    rpcUrl,
    cluster: network,
    fetcher,
    timeoutMs: 15,
  });
  await assert.rejects(
    reader.readDepositEvidence(txid()),
    error('rpc_timeout'),
  );
  assert.equal(cancelled, true);
});

void test('timeout also bounds a fetch implementation that never resolves', async () => {
  const fetcher = () => new Promise(() => {});
  await assert.rejects(
    createSolanaReader({
      rpcUrl,
      cluster: network,
      fetcher,
      timeoutMs: 15,
    }).readDepositEvidence(txid()),
    error('rpc_timeout'),
  );
});

void test('explicit cancellation works before a request and while waiting for response data', async () => {
  const controller = new AbortController();
  controller.abort();
  const mock = rpcMock();
  await assert.rejects(
    createSolanaReader({
      rpcUrl,
      cluster: network,
      fetcher: mock.fetcher,
    }).readDepositEvidence(txid(), controller.signal),
    error('cancelled'),
  );
  assert.equal(mock.calls.length, 0);
  const active = new AbortController();
  const fetcher = () => {
    active.abort();
    return new Promise(() => {});
  };
  await assert.rejects(
    createSolanaReader({
      rpcUrl,
      cluster: network,
      fetcher,
    }).readDepositEvidence(txid(), active.signal),
    error('cancelled'),
  );
});

void test('only the configured finalized RPC path can label a parsed explanation finalized', async () => {
  const value = fixture();
  value.evidence.transaction = parsedFixture([
    instruction(SYSTEM_PROGRAM, 'transfer', {
      source: key(),
      destination: key(),
      lamports: 1,
    }),
  ]);
  value.evidence.transaction.transaction.signatures = [
    value.evidence.signature,
  ];
  const mock = rpcMock(value);
  const result = await createSolanaReader({
    rpcUrl,
    cluster: network,
    fetcher: mock.fetcher,
  }).readExplanation(value.evidence.signature);
  assert.equal(result.finality, 'finalized');
  assert.equal(
    result.flags.some((flag) => flag.code === 'FINALITY_UNVERIFIED'),
    false,
  );
  assert.equal(mock.calls[2].body.params[1].encoding, 'jsonParsed');
});

void test('finalized failed transactions can be explained without accepting them as deposits', async () => {
  const value = fixture();
  value.evidence.status.err = { InstructionError: [0, 'Custom'] };
  value.evidence.transaction = parsedFixture([
    instruction(TOKEN_PROGRAM, 'approve', {
      source: key(),
      delegate: key(),
      owner: key(),
      amount: '10',
    }),
  ]);
  value.evidence.transaction.transaction.signatures = [
    value.evidence.signature,
  ];
  value.evidence.transaction.meta.err = clone(value.evidence.status.err);
  const mock = rpcMock(value);
  const reader = createSolanaReader({
    rpcUrl,
    cluster: network,
    fetcher: mock.fetcher,
  });
  const result = await reader.readExplanation(value.evidence.signature);
  assert.equal(result.finality, 'finalized');
  assert.equal(result.execution, 'failed');
  assert.equal(
    result.flags.some((flag) => flag.code === 'TRANSACTION_FAILED'),
    true,
  );
  await assert.rejects(
    reader.readDepositEvidence(value.evidence.signature),
    error('transaction_failed'),
  );
});

void test('status and parsed metadata must agree on success or failure', async () => {
  const value = fixture();
  value.evidence.transaction.meta.err = 'InvalidInstructionData';
  const mock = rpcMock(value);
  await assert.rejects(
    createSolanaReader({
      rpcUrl,
      cluster: network,
      fetcher: mock.fetcher,
    }).readExplanation(value.evidence.signature),
    error('invalid_response'),
  );
});

void test('malformed execution metadata cannot produce a successful or apparently complete explanation', () => {
  for (const err of [true, false, 0, 12, [], ['failed']]) {
    const value = parsedFixture([]);
    value.meta.err = err;
    assert.throws(
      () => explainParsedTransaction(value),
      error('invalid_response'),
    );
  }
  for (const innerInstructions of [false, 1, {}, 'unavailable']) {
    const value = parsedFixture([]);
    value.meta.innerInstructions = innerInstructions;
    assert.throws(
      () => explainParsedTransaction(value),
      error('invalid_response'),
    );
  }
});

const payInstructions = {
  cluster: 'mainnet-beta',
  recipient_wallet: 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx',
  reference: 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN',
  tokens: [
    { symbol: 'USDC', mint: SOLANA_NETWORKS['mainnet-beta'].usdcMint, token_account: '7EJSueeCjseYzghxU2XhcGEUn7RJDh43Z2dL6dvGy9mw' }, // gitleaks:allow (public Solana fixture addresses)
    { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', token_account: 'MnVorf8KKPzHgQpa6exLfKpam8YkTn8WpeUuuFwgsob' }, // gitleaks:allow (public Solana fixture addresses)
  ],
};

void test('Solana Pay uses the wallet owner and the selected mint, with an exact decimal amount and escaped message', () => {
  const message = 'Top-up & café + tea #1?';
  const amounts = [['05.000000', '5'], [' $ 10.2500 ', '10.25'], ['0.000001', '0.000001'], ['999999999.999999', '999999999.999999']];
  for (const token of payInstructions.tokens) {
    for (const [input, expected] of amounts) {
      const url = solanaPayUrl(payInstructions, token.mint, input, message);
      const parsed = new URL(url);
      assert.equal(parsed.protocol, 'solana:');
      assert.equal(parsed.pathname, payInstructions.recipient_wallet);
      assert.deepEqual(Object.fromEntries(parsed.searchParams), {
        amount: expected, 'spl-token': token.mint, reference: payInstructions.reference, label: 'Anonymo', message,
      });
      assert.match(url, /&message=Top-up%20%26%20caf%C3%A9%20%2B%20tea%20%231%3F$/);
    }
  }
});

void test('Solana Pay rejects malformed values, unknown or duplicate mints and a nonmatching treasury token account', () => {
  const usdc = payInstructions.tokens[0];
  const build = (patch, selected = usdc.mint, amount = '5', message) =>
    solanaPayUrl({ ...payInstructions, ...patch }, selected, amount, message);
  for (const invalid of ['', '0', '-1', '+2', '1e3', '1,000', 'NaN', '1&amount=25', '0.0000001', '1000000000', 5]) {
    assert.equal(build({}, usdc.mint, invalid), null);
  }
  for (const bad of ['0'.repeat(32), '1'.repeat(31), '1'.repeat(33), `${payInstructions.reference}?amount=1`]) {
    assert.equal(build({ reference: bad }), null);
    assert.equal(build({ recipient_wallet: bad }), null);
    assert.equal(build({ tokens: [{ ...usdc, mint: bad }] }, bad), null);
  }
  assert.equal(build({}, key()), null);
  assert.equal(build({ tokens: [usdc, usdc] }), null);
  assert.equal(build({ tokens: [usdc, { ...payInstructions.tokens[1], symbol: 'USDC' }] }), null);
  assert.equal(build({ tokens: [{ ...usdc, symbol: 'ABC' }] }), null);
  assert.equal(build({ tokens: [{ ...usdc, token_account: payInstructions.tokens[1].token_account }] }), null);
  assert.equal(build({ recipient_wallet: usdc.token_account }), null);
  assert.equal(build({ reference: usdc.mint }), null);
  assert.equal(build({ cluster: 'other' }), null);
  assert.equal(build({}, usdc.mint, '5', '\uD800'), null);
});

void test('Solana wallet checkout is opt-in', () => {
  assert.equal(RELEASED.has('solpay'), false);
  assert.equal(parseUpdates(undefined).has('solpay'), false);
  assert.equal(parseUpdates('photos, solpay').has('solpay'), true);
  assert.equal(parseUpdates('all').has('solpay'), true);
});

void test('Solana arrival tracking survives reload and waits for a fresh matching ledger row', () => {
  const { reference } = payInstructions;
  const now = Date.now();
  const deposit = { chain: 'solana', token: 'USDC', amount_usd: '5', created_at: new Date(now).toISOString(), status: 'credited' };
  const old = { ...deposit, ref: 'solana:old:0' };
  const next = { ...deposit, ref: 'solana:new:2' };
  const attempt = newAttempt({ keyCommit: reference, rail: 'solana', chain: 'solana', token: 'USDC', amount: '5', musd: 5_000_000, rows: [old], now });
  const raw = JSON.stringify(attempt);
  assert.deepEqual(parseAttempt(raw, reference, 'solana'), attempt);
  assert.equal(parseAttempt(raw, reference.toLowerCase(), 'solana'), null);
  assert.notEqual(attemptSlot(reference, 'solana'), attemptSlot(reference.toLowerCase(), 'solana'));
  assert.equal(matchAttempt(attempt, [old, { ...next, chain: 'base' }, { ...next, token: 'USDT' }]).kind, 'none');
  assert.equal(topupView(attempt, [{ ...next, amount_usd: '10' }], now).stage, 'wallet');
  assert.equal(matchAttempt(attempt, [next, { ...next, ref: 'solana:another:0' }]).kind, 'candidates');
  assert.equal(topupView(attempt, [old, { ...next, status: 'held' }], now).stage, 'held');
  assert.equal(topupView(attempt, [old, next], now).stage, 'credited');
});
