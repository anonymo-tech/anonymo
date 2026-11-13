import type { TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, KEPT, UPDATED, rv } from "./common.ts";

// Chain: what the router has read from, and written to, the blockchain. Blockchain data is public; these tables are a working copy
// of it plus the router's own bookkeeping for deposits and slashing.

export const chainTables: Record<string, TableDoc> = {
  chain_events: {
    category: "chain",
    purpose: "Contract events the router has read from the chain, each processed once.",
    request: "no",
    retention: KEPT,
    columns: {
      tx_hash: "The transaction.",
      log_index: "The log's position in the transaction.",
      contract: "The contract that emitted it.",
      event: "The event name.",
      block_number: "The block.",
      args: { purpose: "The event's decoded arguments: addresses, amounts and hashes.", review: JSON_FIELDS("Decoded on-chain event arguments; public blockchain data.") },
      processed: "Whether the router has acted on it.",
      processed_at: "When it did.",
      error: {
        purpose: "Why processing the event failed, when it did.",
        review: rv(["name:content"], "no-request-content", "An error string from the chain indexer while handling a public on-chain event; the indexer never sees a request."),
      },
      created_at: CREATED,
    },
  },

  chain_cursor: {
    category: "chain",
    purpose: "How far the router has read each chain.",
    request: "no",
    retention: "One row per cursor, overwritten as the chain advances.",
    columns: { id: "The cursor's name.", block: "The last block read.", updated_at: UPDATED },
  },





  slashes: {
    category: "chain",
    purpose: "Penalties proposed against a provider for empty answers, precision fraud, poor uptime or dropped parameters, with the evidence and where it stands.",
    request: "aggregate",
    retention: KEPT,
    columns: {
      id: "Slash id.",
      provider_id: "The provider.",
      model_id: "The model, when the penalty is per model.",
      kind: "empty200, quant_fraud, uptime or param_drop.",
      amount_usdg: "The amount in USDG base units.",
      delist: "Whether the provider is delisted with it.",
      evidence_root: "A Merkle root over the evidence.",
      evidence: {
        purpose: "The evidence: counts of requests and empty answers, canary results or uptime figures, and the window they cover.",
        review: JSON_FIELDS("Assembled by gatherEvidence in slasher.ts from counts, canary results and time windows; no request or answer text is read."),
      },
      status: "proposed, disputed, cancelled, executed or auto_refunded.",
      proposed_at: "When it was proposed.",
      executable_at: "When it may be executed.",
      executed_at: "When it was.",
      dispute_hash: "The hash of the provider's dispute.",
      disputed_at: "When it disputed.",
      onchain_id: "The id on chain.",
      tx_hash: "The transaction.",
      refunded: "Pico-USD refunded to callers affected.",
    },
  },

  spent_roots: {
    category: "chain",
    purpose: "A Merkle root over every key's cumulative spend, posted on chain so balances can be settled.",
    request: "aggregate",
    retention: KEPT,
    columns: {
      epoch: "The epoch.",
      root: "The Merkle root.",
      as_of: "The time the spend is counted to.",
      total_spent_usdg: "Total spend in USDG base units.",
      leaves: { purpose: "Pairs of a key's chain hash and its cumulative spend in USDG base units, in tree order.", review: JSON_FIELDS("[chainKeyHash, cumulativeSpentUsdg] pairs built from ledger totals.") },
      tx_hash: "The transaction that posted the root.",
      status: "pending, submitted or confirmed.",
      created_at: CREATED,
    },
  },
};
