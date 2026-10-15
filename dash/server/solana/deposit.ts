import bs58 from 'bs58';
import {
  COMPUTE_BUDGET_PROGRAM,
  SOLANA_NETWORKS,
  SYSTEM_PROGRAM,
  SolanaError,
  TOKEN_PROGRAM,
  address,
  amount,
  assertGenesis,
  cluster,
  finalizedStatus,
  list,
  record,
  requireSolana,
  signature,
  uint,
  type SolanaCluster,
} from './validation.ts';
import { compiledTransaction } from './transaction.ts';
import { ASSOCIATED_TOKEN_PROGRAM, associatedTokenAddress } from './associated-token.ts';

export type DepositPolicy = {
  cluster: SolanaCluster;
  recipientWallet: string;
  recipientTokenAccount: string;
  usdcMint: string;
};
export type DepositIntent = {
  id: string;
  sourceWallet: string;
  reference: string;
  amountRaw: string;
  createdAtMs: number;
  expiresAtMs: number;
};
export type DepositEvidence = {
  cluster: SolanaCluster;
  genesisHash: string;
  signature: string;
  status: unknown;
  transaction: unknown;
};
export type VerifiedDeposit = {
  intentId: string;
  eventId: string;
  cluster: SolanaCluster;
  signature: string;
  instructionIndex: number;
  innerInstructionIndex: null;
  reference: string;
  sourceWallet: string;
  sourceTokenAccount: string;
  recipientWallet: string;
  recipientTokenAccount: string;
  mint: string;
  decimals: 6;
  amountRaw: string;
  slot: number;
  blockTime: number;
};

function tokenBalances(value: unknown, keyCount: number) {
  const balances = new Map<
    number,
    {
      mint: string;
      owner: string;
      programId: string;
      decimals: number;
      amount: bigint;
    }
  >();
  for (const raw of list(value)) {
    const balance = record(raw);
    const index = uint(balance.accountIndex, keyCount - 1);
    requireSolana(!balances.has(index), 'ambiguous_deposit');
    const token = record(balance.uiTokenAmount);
    balances.set(index, {
      mint: address(balance.mint),
      owner: address(balance.owner),
      programId: address(balance.programId),
      decimals: uint(token.decimals, 255),
      amount: amount(token.amount),
    });
  }
  return balances;
}

type CompiledDeposit = ReturnType<typeof compiledTransaction>;

/** Only the reviewed wallet-paid idempotent recipient-ATA prefix is supported. */
function verifyRecipientAtaCreation(
  tx: CompiledDeposit,
  create: CompiledDeposit['instructions'][number],
  terms: {
    sourceOwner: string; source: string; recipient: string; recipientOwner: string;
    mint: string; reference: string; createdRecipient: boolean; inner: unknown[];
  },
) {
  const expectedKeys = [
    terms.sourceOwner, terms.source, terms.recipient, terms.mint, terms.reference,
    TOKEN_PROGRAM, terms.recipientOwner, SYSTEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM,
  ];
  requireSolana(
    tx.root.version === 'legacy' && tx.signatures.length === 1 &&
      tx.instructions.length === 2 && create.index === 0 &&
      create.data.length === 1 && create.data[0] === 1 &&
      create.accounts.join(',') === '0,2,6,3,7,5' &&
      tx.instructions[1].accounts.join(',') === '1,3,2,0,4' &&
      tx.keys.length === expectedKeys.length &&
      tx.keys.every((key, index) => key.address === expectedKeys[index] &&
        key.signer === (index === 0) && key.writable === (index < 3)) &&
      associatedTokenAddress({ owner: terms.recipientOwner, mint: terms.mint, tokenProgram: TOKEN_PROGRAM }) === terms.recipient,
    'deposit_mismatch',
  );
  if (!terms.createdRecipient) {
    // An already-existing ATA makes CreateIdempotent a no-op. It must not run
    // initialization again or mutate another account through an inner call.
    requireSolana(terms.inner.length === 0, 'unsupported_instruction');
    return;
  }
  requireSolana(terms.inner.length >= 4 && terms.inner.length <= 6, 'incomplete_metadata');
  const inner = terms.inner.map((raw) => {
    const entry = record(raw);
    const programIndex = uint(entry.programIdIndex, tx.keys.length - 1);
    const program = tx.keys[programIndex];
    requireSolana(!program.writable && !program.signer, 'unsupported_instruction');
    requireSolana(entry.stackHeight === undefined || entry.stackHeight === null || entry.stackHeight === 2, 'unsupported_instruction');
    const accounts = list(entry.accounts, 6).map((index) => uint(index, tx.keys.length - 1));
    requireSolana(typeof entry.data === 'string' && entry.data.length <= 100, 'invalid_response');
    let data: Uint8Array;
    try { data = bs58.decode(entry.data); }
    catch { throw new SolanaError('invalid_response'); }
    requireSolana(bs58.encode(data) === entry.data, 'invalid_response');
    return { program: program.address, accounts, data };
  });
  const matches = (at: number, program: string, accounts: number[], bytes: number[]) => {
    const instruction = inner[at];
    requireSolana(instruction && instruction.program === program &&
      instruction.accounts.join(',') === accounts.join(',') &&
      instruction.data.length === bytes.length &&
      instruction.data.every((byte, index) => byte === bytes[index]), 'unsupported_instruction');
  };
  // ATA asks the legacy Token program for the native token-account size with
  // its ImmutableOwner extension hint. Tokenkeg still creates a 165-byte account.
  matches(0, TOKEN_PROGRAM, [3], [21, 7, 0]);
  const system = inner[1];
  const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let next = 2;
  if (system.program === SYSTEM_PROGRAM && system.data.length === 52 && view(system.data).getUint32(0, true) === 0) {
    requireSolana(system.accounts.join(',') === '0,2' &&
      view(system.data).getBigUint64(4, true) > 0n &&
      view(system.data).getBigUint64(12, true) === 165n &&
      bs58.encode(system.data.subarray(20)) === TOKEN_PROGRAM, 'unsupported_instruction');
  } else {
    // A system-owned ATA address may have been dusted between preparation and
    // execution. The ATA program then funds if needed, allocates, and assigns it.
    if (system.program === SYSTEM_PROGRAM && system.data.length === 12 && view(system.data).getUint32(0, true) === 2) {
      requireSolana(system.accounts.join(',') === '0,2' && view(system.data).getBigUint64(4, true) > 0n, 'unsupported_instruction');
      next++;
    }
    const allocate = inner[next - 1];
    requireSolana(allocate && allocate.program === SYSTEM_PROGRAM && allocate.accounts.join(',') === '2' &&
      allocate.data.length === 12 && view(allocate.data).getUint32(0, true) === 8 &&
      view(allocate.data).getBigUint64(4, true) === 165n, 'unsupported_instruction');
    const assign = inner[next++];
    requireSolana(assign && assign.program === SYSTEM_PROGRAM && assign.accounts.join(',') === '2' &&
      assign.data.length === 36 && view(assign.data).getUint32(0, true) === 1 &&
      bs58.encode(assign.data.subarray(4)) === TOKEN_PROGRAM, 'unsupported_instruction');
  }
  matches(next++, TOKEN_PROGRAM, [2], [22]);
  matches(next++, TOKEN_PROGRAM, [2, 3], [18, ...bs58.decode(terms.recipientOwner)]);
  requireSolana(next === inner.length, 'unsupported_instruction');
}

/**
 * Supports one top-level legacy SPL TransferChecked with one reference and optional
 * compute-budget prefixes, or the exact two-instruction recipient ATA creation
 * transaction. Only canonical ATA initialization CPI is allowed; delegates,
 * multisig, Token-2022 and unrelated instructions fail closed.
 * Evidence must come from the configured trusted reader, never a client body.
 * DB must uniquely consume intent/reference and (cluster, signature, instructionIndex).
 */
export function verifyUsdcDeposit(options: {
  policy: DepositPolicy;
  intent: DepositIntent;
  evidence: DepositEvidence;
}): VerifiedDeposit {
  const { policy, intent, evidence } = options;
  const network = cluster(policy.cluster);
  requireSolana(evidence.cluster === network, 'wrong_cluster');
  assertGenesis(network, evidence.genesisHash);
  requireSolana(
    policy.usdcMint === SOLANA_NETWORKS[network].usdcMint,
    'invalid_configuration',
  );
  const recipient = address(policy.recipientTokenAccount);
  const recipientOwner = address(policy.recipientWallet);
  const sourceOwner = address(intent.sourceWallet);
  const reference = address(intent.reference);
  const expectedAmount = amount(intent.amountRaw, true);
  requireSolana(
    typeof intent.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(intent.id),
    'invalid_input',
  );
  const created = uint(intent.createdAtMs, 8_640_000_000_000_000);
  const expires = uint(intent.expiresAtMs, 8_640_000_000_000_000);
  requireSolana(expires > created, 'invalid_input');
  requireSolana(
    new Set([
      recipient,
      recipientOwner,
      sourceOwner,
      reference,
      policy.usdcMint,
    ]).size === 5,
    'deposit_mismatch',
  );
  const txid = signature(evidence.signature);
  const finalized = finalizedStatus(evidence.status);
  const tx = compiledTransaction(evidence.transaction);
  requireSolana(
    tx.signatures[0] === txid && tx.slot === finalized.slot,
    'deposit_mismatch',
  );
  requireSolana(tx.meta.err === null, 'transaction_failed');
  const blockTime = uint(tx.root.blockTime, 8_640_000_000_000);
  // RPC block times have one-second resolution; intent windows use whole UTC seconds.
  requireSolana(
    blockTime >= Math.floor(created / 1000) &&
      blockTime < Math.floor(expires / 1000),
    'deposit_mismatch',
  );
  requireSolana(
    Array.isArray(tx.meta.innerInstructions),
    'incomplete_metadata',
  );
  const innerByIndex = new Map<number, unknown[]>();
  for (const raw of list(tx.meta.innerInstructions, 64)) {
    const inner = record(raw);
    const index = uint(inner.index, tx.instructions.length - 1);
    requireSolana(!innerByIndex.has(index), 'ambiguous_deposit');
    innerByIndex.set(index, list(inner.instructions, 16));
  }
  const transfers = tx.instructions.filter(
    (instruction) => instruction.programId === TOKEN_PROGRAM,
  );
  requireSolana(
    transfers.length === 1,
    transfers.length > 1 ? 'ambiguous_deposit' : 'unsupported_instruction',
  );
  const transfer = transfers[0];
  requireSolana(
    transfer.index === tx.instructions.length - 1,
    'unsupported_instruction',
  );
  const creates = tx.instructions.filter((instruction) => instruction.programId === ASSOCIATED_TOKEN_PROGRAM);
  requireSolana(creates.length <= 1, 'unsupported_instruction');
  const create = creates[0];
  for (const instruction of tx.instructions.slice(0, -1)) {
    if (instruction === create) continue;
    requireSolana(
      instruction.programId === COMPUTE_BUDGET_PROGRAM &&
        instruction.accounts.length === 0,
      'unsupported_instruction',
    );
    const lengths: Record<number, number> = { 1: 5, 2: 5, 3: 9, 4: 5 };
    requireSolana(
      lengths[instruction.data[0]] === instruction.data.length,
      'unsupported_instruction',
    );
  }
  requireSolana(
    transfer.data.length === 10 &&
      transfer.data[0] === 12 &&
      transfer.data[9] === 6,
    'unsupported_instruction',
  );
  requireSolana(
    transfer.accounts.length === 5 && new Set(transfer.accounts).size === 5,
    'ambiguous_deposit',
  );
  const [sourceIndex, mintIndex, recipientIndex, ownerIndex, referenceIndex] =
    transfer.accounts;
  const [sourceKey, mintKey, recipientKey, ownerKey, referenceKey] =
    transfer.accounts.map((index) => tx.keys[index]);
  requireSolana(
    mintKey.address === policy.usdcMint &&
      recipientKey.address === recipient &&
      ownerKey.address === sourceOwner &&
      referenceKey.address === reference,
    'deposit_mismatch',
  );
  requireSolana(
    sourceKey.writable &&
      recipientKey.writable &&
      ownerKey.signer &&
      !mintKey.writable &&
      !mintKey.signer &&
      !referenceKey.writable &&
      !referenceKey.signer,
    'deposit_mismatch',
  );
  requireSolana(
    sourceKey.address !== recipient &&
      sourceIndex !== ownerIndex &&
      referenceIndex !== mintIndex,
    'deposit_mismatch',
  );
  const rawAmount = new DataView(
    transfer.data.buffer,
    transfer.data.byteOffset,
    transfer.data.byteLength,
  ).getBigUint64(1, true);
  requireSolana(rawAmount === expectedAmount, 'deposit_mismatch');
  const before = tokenBalances(tx.meta.preTokenBalances, tx.keys.length);
  const after = tokenBalances(tx.meta.postTokenBalances, tx.keys.length);
  const createdRecipient = Boolean(create) && !before.has(recipientIndex);
  if (create) {
    verifyRecipientAtaCreation(tx, create, {
      sourceOwner, source: sourceKey.address, recipient, recipientOwner,
      mint: policy.usdcMint, reference, createdRecipient,
      inner: innerByIndex.get(create.index) ?? [],
    });
  }
  for (const [index, inner] of innerByIndex)
    requireSolana(index === create?.index || inner.length === 0, 'unsupported_instruction');
  requireSolana(before.size === (createdRecipient ? 1 : 2) && after.size === 2, 'ambiguous_deposit');
  for (const [index, owner] of [
    [sourceIndex, sourceOwner],
    [recipientIndex, recipientOwner],
  ] as const) {
    const post = after.get(index);
    // An absent recipient is zero only after exact ATA creation has been proved.
    const pre = before.get(index) ?? (createdRecipient && index === recipientIndex && post
      ? { ...post, amount: 0n }
      : undefined);
    requireSolana(pre && post, 'incomplete_metadata');
    requireSolana(
      pre.mint === policy.usdcMint &&
        post.mint === policy.usdcMint &&
        pre.programId === TOKEN_PROGRAM &&
        post.programId === TOKEN_PROGRAM &&
        pre.owner === owner &&
        post.owner === owner &&
        pre.decimals === 6 &&
        post.decimals === 6,
      'deposit_mismatch',
    );
    const delta =
      index === sourceIndex
        ? pre.amount - post.amount
        : post.amount - pre.amount;
    requireSolana(delta === expectedAmount, 'deposit_mismatch');
  }
  return {
    intentId: intent.id,
    eventId: `solana:${network}:${txid}:${transfer.index}`,
    cluster: network,
    signature: txid,
    instructionIndex: transfer.index,
    innerInstructionIndex: null,
    reference,
    sourceWallet: sourceOwner,
    sourceTokenAccount: sourceKey.address,
    recipientWallet: recipientOwner,
    recipientTokenAccount: recipient,
    mint: policy.usdcMint,
    decimals: 6,
    amountRaw: expectedAmount.toString(),
    slot: tx.slot,
    blockTime,
  };
}
