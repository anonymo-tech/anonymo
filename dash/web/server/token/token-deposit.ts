import { requireCondition } from '../core/errors.ts';
import {
  COMPUTE_BUDGET_PROGRAM,
  SOLANA_NETWORKS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  U64_MAX,
  address,
  amount,
  assertGenesis,
  finalizedStatus,
  list,
  record,
  requireSolana,
  signature,
  uint,
} from '../solana/validation.ts';
import { compiledTransaction } from '../solana/transaction.ts';
import { TOKEN_CLUSTERS, type TokenCluster } from './config.ts';
import { tokensForUsd6, usd6ForTokens, type TokenPriceQuote } from './price.ts';
import type { TokenDepositPolicy } from './token-deposit-config.ts';

// Pure verification of a pay-with-token deposit. It mirrors the USDC path:
// one top-level TransferChecked of the configured mint under the configured
// token program, the exact quoted raw amount, the intent's reference as a
// read-only account on the transfer, finalized and successful, inside the
// intent window. Evidence must come from the trusted reader, never a client.

const INT8_MAX = (1n << 63n) - 1n;

export type TokenDepositIntent = {
  id: string;
  sourceWallet: string;
  reference: string;
  amountRaw: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type TokenDepositEvidence = {
  cluster: TokenCluster;
  genesisHash: string;
  signature: string;
  status: unknown;
  transaction: unknown;
};

export type VerifiedTokenDeposit = {
  intentId: string;
  eventId: string;
  cluster: TokenCluster;
  signature: string;
  instructionIndex: number;
  innerInstructionIndex: null;
  reference: string;
  sourceWallet: string;
  sourceTokenAccount: string;
  recipientWallet: string;
  recipientTokenAccount: string;
  mint: string;
  programId: string;
  decimals: number;
  amountRaw: string;
  slot: number;
  blockTime: number;
};

/**
 * Fixes the token amount for a USD6 credit at a price quote. The raw amount
 * rounds up, so the payer covers the credit and overpays by at most one raw
 * unit; the credit is never above the quoted value of the tokens received.
 */
export function quoteTokenDeposit(input: {
  usd6: bigint;
  quote: TokenPriceQuote;
  decimals: number;
}) {
  requireCondition(
    typeof input.usd6 === 'bigint' && input.usd6 > 0n,
    400,
    'INVALID_AMOUNT',
    'The deposit amount is invalid.',
  );
  const price = input.quote.priceUsd6PerToken;
  const amountRaw = tokensForUsd6(input.usd6, price, input.decimals);
  requireCondition(
    amountRaw > 0n && amountRaw <= INT8_MAX && amountRaw <= U64_MAX,
    400,
    'TOKEN_AMOUNT_UNSUPPORTED',
    'This amount cannot be expressed in the platform token.',
  );
  const valueUsd6 = usd6ForTokens(amountRaw, price, input.decimals);
  requireCondition(
    valueUsd6 >= input.usd6,
    500,
    'TOKEN_QUOTE_INVARIANT',
    'The token quote arithmetic failed.',
  );
  return {
    amountRaw,
    usd6: input.usd6,
    valueUsd6,
    priceUsd6PerToken: price,
    priceSource: input.quote.source,
    priceObservedAtMs: input.quote.observedAtMs,
    priceExpiresAtMs: input.quote.expiresAtMs,
  };
}

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

function tokenCluster(value: unknown): TokenCluster {
  requireSolana(
    typeof value === 'string' &&
      (TOKEN_CLUSTERS as readonly string[]).includes(value),
    'invalid_configuration',
  );
  return value as TokenCluster;
}

/**
 * Supports one top-level TransferChecked (spl-token or token-2022, same
 * layout) with one reference and optional compute-budget prefixes. Accounts
 * must already exist; CPI, ATA creation, delegate/multisig authorities,
 * Token-2022 transfer hooks or fee extensions (extra accounts, other
 * instruction codes) and every other instruction fail closed.
 * DB must uniquely consume intent/reference and (cluster, signature, index).
 */
export function verifyTokenDeposit(options: {
  policy: TokenDepositPolicy;
  intent: TokenDepositIntent;
  evidence: TokenDepositEvidence;
}): VerifiedTokenDeposit {
  const { policy, intent, evidence } = options;
  const network = tokenCluster(policy.cluster);
  requireSolana(evidence.cluster === network, 'wrong_cluster');
  if (network === 'localnet') {
    // A local validator has no pinned genesis; a public network's hash must not pass as local.
    const genesis = address(evidence.genesisHash);
    requireSolana(
      !Object.values(SOLANA_NETWORKS).some(
        (known) => known.genesisHash === genesis,
      ),
      'wrong_cluster',
    );
  } else assertGenesis(network, evidence.genesisHash);
  const programId = address(policy.programId);
  requireSolana(
    (policy.program === 'spl-token' && programId === TOKEN_PROGRAM) ||
      (policy.program === 'token-2022' && programId === TOKEN_2022_PROGRAM),
    'invalid_configuration',
  );
  const decimals = uint(policy.decimals, 9);
  const mint = address(policy.mint);
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
    new Set([recipient, recipientOwner, sourceOwner, reference, mint]).size ===
      5,
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
    (instruction) => instruction.programId === programId,
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
      transfer.data[9] === decimals,
    'unsupported_instruction',
  );
  // Exactly source, mint, destination, owner and the reference: a transfer
  // hook, a multisig authority or a fee extension would add accounts.
  requireSolana(
    transfer.accounts.length === 5 && new Set(transfer.accounts).size === 5,
    'ambiguous_deposit',
  );
  const [sourceIndex, mintIndex, recipientIndex, ownerIndex, referenceIndex] =
    transfer.accounts;
  const [sourceKey, mintKey, recipientKey, ownerKey, referenceKey] =
    transfer.accounts.map((index) => tx.keys[index]);
  requireSolana(
    mintKey.address === mint &&
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
      pre.mint === mint &&
        post.mint === mint &&
        pre.programId === programId &&
        post.programId === programId &&
        pre.owner === owner &&
        post.owner === owner &&
        pre.decimals === decimals &&
        post.decimals === decimals,
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
    eventId: `token:${network}:${txid}:${transfer.index}`,
    cluster: network,
    signature: txid,
    instructionIndex: transfer.index,
    innerInstructionIndex: null,
    reference,
    sourceWallet: sourceOwner,
    sourceTokenAccount: sourceKey.address,
    recipientWallet: recipientOwner,
    recipientTokenAccount: recipient,
    mint,
    programId,
    decimals,
    amountRaw: expectedAmount.toString(),
    slot: tx.slot,
    blockTime,
  };
}
