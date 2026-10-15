import bs58 from "bs58";
import { requireCondition } from "../core/errors.ts";
import { parseSerializedTransaction } from "../solana/serialized.ts";
import { associatedTokenAddress } from "../solana/associated-token.ts";
import { burnCheckedInstruction, compileLegacyMessage } from "../token/transaction-builder.ts";

export const OWNER = "49exMtr1QiaN6mcHszMe2nAMwbEVCngZmV134Ua5c5Q1";
export const MINT = "8pe4i3qKgta9pFgDrnQJtakv6ArqUUGswtax12aEpump";
export const TOKEN_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const ATA = associatedTokenAddress({
  owner: OWNER,
  mint: MINT,
  tokenProgram: TOKEN_PROGRAM,
});
const METHODS = new Set([
  "getGenesisHash",
  "getTransaction",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSignaturesForAddress",
  "getTokenAccountBalance",
  "getBalance",
]);
export function checkedSignature(value: unknown): string {
  requireCondition(
    typeof value === "string" && value.length <= 88,
    400,
    "INVALID_SIGNATURE",
    "Enter a Solana transaction signature.",
  );
  let valid = false;
  try {
    valid = bs58.decode(value).length === 64;
  } catch {
    /* invalid address */
  }
  requireCondition(valid, 400, "INVALID_SIGNATURE", "Enter a Solana transaction signature.");
  return value;
}
/** Deliberately read-only: signing and submission exist only in the owner's wallet. */
export async function rpc(method: string, params: unknown[] = []): Promise<any> {
  requireCondition(
    METHODS.has(method),
    500,
    "RPC_METHOD_REJECTED",
    "This chain operation is unavailable.",
  );
  const endpoint = process.env.CONCLAVE_SOLANA_RPC_URL;
  requireCondition(endpoint, 503, "CHAIN_UNAVAILABLE", "The chain reader is not configured.");
  const url = new URL(endpoint);
  requireCondition(
    url.protocol === "https:" && !url.username && !url.password,
    503,
    "CHAIN_UNAVAILABLE",
    "The chain reader is not configured.",
  );
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  requireCondition(
    response.ok,
    503,
    "CHAIN_UNAVAILABLE",
    "The chain reader is temporarily unavailable.",
  );
  const body = await response.text();
  requireCondition(
    body.length <= 2_000_000,
    503,
    "CHAIN_UNAVAILABLE",
    "The chain response was too large.",
  );
  const result = JSON.parse(body);
  requireCondition(
    !result.error,
    503,
    "CHAIN_UNAVAILABLE",
    "The chain reader could not complete this check.",
  );
  return result.result;
}
export async function mainnet() {
  requireCondition(
    (await rpc("getGenesisHash")) === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    503,
    "WRONG_CHAIN",
    "Mainnet verification failed.",
  );
}
export async function finalized(signature: string, encoding: "json" | "base64" = "json") {
  checkedSignature(signature);
  const tx = await rpc("getTransaction", [
    signature,
    { encoding, commitment: "finalized", maxSupportedTransactionVersion: 0 },
  ]);
  requireCondition(
    tx && tx.meta && tx.meta.err === null,
    409,
    "AWAITING_FINALITY",
    "No successful finalized transaction was found. Wait, then check the same signature again.",
  );
  requireCondition(
    Number.isSafeInteger(tx.slot) && tx.slot > 0,
    503,
    "CHAIN_UNAVAILABLE",
    "The transaction slot is unavailable.",
  );
  return tx;
}
export function verifySwap(tx: any, input: { signature: string; amount: string; createdAt: Date }) {
  const keys = [
    ...(tx.transaction?.message?.accountKeys ?? []),
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  requireCondition(
    tx.meta?.err === null &&
      tx.transaction?.signatures?.[0] === input.signature &&
      keys[0] === OWNER &&
      tx.transaction.message.header.numRequiredSignatures === 1,
    400,
    "SWAP_PROOF_REJECTED",
    "The swap must be signed only by the flywheel wallet.",
  );
  requireCondition(
    Number.isSafeInteger(tx.blockTime) && tx.blockTime * 1000 >= input.createdAt.getTime() - 1000,
    400,
    "SWAP_PROOF_REJECTED",
    "The swap must occur after this batch was reserved.",
  );
  requireCondition(
    tx.transaction.message.instructions.some((i: any) => keys[i.programIdIndex] === JUPITER),
    400,
    "SWAP_PROOF_REJECTED",
    "A finalized Jupiter swap is required.",
  );
  const safePrograms = new Set([
    JUPITER,
    "ComputeBudget111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "11111111111111111111111111111111",
  ]);
  for (const instruction of tx.transaction.message.instructions) {
    const program = keys[instruction.programIdIndex];
    // Separate token transfers/approvals could inflate the apparent swap spend.
    // Jupiter token movements must occur within its checked program invocation.
    let closeOnly = false;
    if (program === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || program === TOKEN_PROGRAM) {
      try {
        const data = bs58.decode(instruction.data);
        closeOnly = data.length === 1 && data[0] === 9;
      } catch {
        /* reject */
      }
    }
    requireCondition(
      safePrograms.has(program) || closeOnly,
      400,
      "SWAP_PROOF_REJECTED",
      "This transaction contains instructions outside the supported Jupiter swap route.",
    );
  }
  function balances(rows: any[], mint: string) {
    const map = new Map<number, bigint>();
    for (const row of rows ?? []) {
      if (row.owner !== OWNER || row.mint !== mint) continue;
      requireCondition(
        !map.has(row.accountIndex) &&
          row.uiTokenAmount?.decimals === 6 &&
          /^(0|[1-9][0-9]{0,18})$/.test(row.uiTokenAmount.amount),
        400,
        "SWAP_PROOF_REJECTED",
        "Token balance evidence is invalid.",
      );
      if (mint === MINT)
        requireCondition(
          keys[row.accountIndex] === ATA && row.programId === TOKEN_PROGRAM,
          400,
          "SWAP_PROOF_REJECTED",
          "CLVE must arrive in the flywheel token account.",
        );
      map.set(row.accountIndex, BigInt(row.uiTokenAmount.amount));
    }
    return [...map.values()].reduce((a, b) => a + b, 0n);
  }
  const spent =
    balances(tx.meta.preTokenBalances, USDC) - balances(tx.meta.postTokenBalances, USDC);
  const received =
    balances(tx.meta.postTokenBalances, MINT) - balances(tx.meta.preTokenBalances, MINT);
  requireCondition(
    spent === BigInt(input.amount) && received > 0n && received < 2n ** 63n,
    400,
    "SWAP_PROOF_REJECTED",
    "The USDC spent must exactly match this batch, with a positive CLVE receipt.",
  );
  return received;
}
export function unsignedBurn(amount: bigint, blockhash: string) {
  const message = compileLegacyMessage({
    payer: OWNER,
    recentBlockhash: blockhash,
    instructions: [
      burnCheckedInstruction({
        programId: TOKEN_PROGRAM,
        tokenAccount: ATA,
        mint: MINT,
        owner: OWNER,
        amountRaw: amount,
        decimals: 6,
      }),
    ],
  }).bytes;
  return {
    message: Buffer.from(message).toString("base64"),
    wire: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString("base64"),
  };
}
export function verifyBurn(tx: any, signature: string, message: string) {
  requireCondition(
    tx.meta?.err === null && Array.isArray(tx.transaction) && tx.transaction[1] === "base64",
    400,
    "BURN_PROOF_REJECTED",
    "Successful finalized burn evidence is required.",
  );
  const parsed = parseSerializedTransaction(tx.transaction[0]);
  requireCondition(
    parsed.messageBase64 === message &&
      parsed.signatures[0]?.value === signature &&
      parsed.signatures[0]?.present,
    400,
    "BURN_PROOF_REJECTED",
    "The burn does not match the exact prepared transaction.",
  );
  return tx.slot as number;
}
