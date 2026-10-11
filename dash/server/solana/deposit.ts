import {
  COMPUTE_BUDGET_PROGRAM,
  SOLANA_NETWORKS,
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

/**
 * Supports one top-level legacy SPL TransferChecked with one reference and optional
 * compute-budget prefixes. Accounts must already exist; CPI, ATA creation,
 * delegate/multisig, Token-2022 and every other instruction fail closed.
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
  for (const raw of list(tx.meta.innerInstructions, 64)) {
    const inner = record(raw);
    uint(inner.index, tx.instructions.length - 1);
    requireSolana(
      list(inner.instructions).length === 0,
      'unsupported_instruction',
    );
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
  for (const instruction of tx.instructions.slice(0, -1)) {
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
  requireSolana(before.size === 2 && after.size === 2, 'ambiguous_deposit');
  for (const [index, owner] of [
    [sourceIndex, sourceOwner],
    [recipientIndex, recipientOwner],
  ] as const) {
    const pre = before.get(index);
    const post = after.get(index);
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
