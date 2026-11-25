import type { TableDoc } from "../types.ts";
import { KEPT_APPEND } from "./common.ts";

const keyHash = "SHA-256 of the Anonymo key associated with an entitlement.";
const orderId = "Contract order digest derived from the chain, Checkout, the payer and a random reference.";

export const passTables: Record<string, TableDoc> = {
  pass_orders: {
    category: "billing",
    purpose: "Associate a Checkout order with an Anonymo key before payment.",
    request: "no",
    retention: KEPT_APPEND,
    columns: { order_id: orderId, key_hash: keyHash, sku: "One of the two accepted pass product codes." },
  },
  passes: {
    category: "billing",
    purpose: "Entitlements confirmed by Checkout events. Each order activates one pass.",
    request: "no",
    retention: KEPT_APPEND,
    columns: {
      order_id: orderId, key_hash: keyHash, sku: "One of the two accepted pass product codes.",
      starts: "When the entitlement starts.", ends: "When the entitlement expires.",
    },
  },
};

export const stakeTables: Record<string, TableDoc> = {
  stake_links: {
    category: "keys",
    purpose: "Identify the Anonymo key a wallet has authorized for staking benefits.",
    request: "no",
    retention: KEPT_APPEND,
    columns: { wallet: "Public EVM wallet address proven by a signature.", key_hash: keyHash },
  },
  stake_checkpoints: {
    category: "chain",
    purpose: "Public StakeCredits balance checkpoints used to compute seven-day averages.",
    request: "no",
    retention: "No automatic deletion. Later events at the same timestamp replace the balance.",
    columns: {
      contract: "Public StakeCredits contract address.", wallet: "Public staking wallet from the chain event.",
      at: "Confirmed block time in Unix seconds.", balance: "The staked balance at that time in raw token units.",
    },
  },
  daily_mo_credits: {
    category: "billing",
    purpose: "Non-transferable usage allocations. These never enter an account's cash balance.",
    request: "no",
    retention: "Records close to spending at midnight UTC and are kept to prevent repeat grants.",
    columns: { key_hash: keyHash, day: "UTC date of the grant.", amount: "Usage-only amount in pico-USD." },
  },
};
