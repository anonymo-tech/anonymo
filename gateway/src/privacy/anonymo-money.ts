// WS05 entries in the data inventory: the Anonymo key, deposit, withdrawal, BTCPay and sanctions tables, and the routes that
// read a request body or the caller's address. Nothing here is personal: no email, name, IP address or user agent is stored.

import type { ExternalDoc, TableDoc, Touchpoint } from "./types.ts";
import { CREATED, KEPT, rv } from "./tables/common.ts";

const WALLET = (what: string) => rv(["name:network"], "wallet-address", `${what}: a public blockchain wallet or payment address (or a Lightning address the key owner chose for refunds), never a caller's IP or connection address.`);

export function describeAnonymoMoney(docs: Record<string, TableDoc>) {
  docs.anonymo_keys = {
    category: "keys", request: "no",
    purpose: "Anonymo controls on top of an API key (same key_hash as keys): spend caps per day, month and lifetime, the owner's IP allowlist, sealed-only, and the wallet a SIWE-minted key is bound to. The model allowlist and expiry live on keys.",
    retention: KEPT,
    columns: {
      key_hash: "sha256 of the API key; the key itself is shown once and never stored.",
      wallet: "Lowercase 0x wallet address proven by a Sign-In with Ethereum signature; withdrawals may go there. Null for anonymous keys.",
      daily_cap: "Spend cap since UTC midnight, pico-USD; null for none.",
      monthly_cap: "Spend cap since the 1st of the UTC month, pico-USD; null for none.",
      lifetime_cap: "Spend cap over the key's life, pico-USD; null for none.",
      ip_allow: { purpose: "Addresses or CIDR ranges the key owner allows calls from, written by the owner. The caller's own address is compared in memory and never stored.", review: rv(["name:network"], "config", "Owner-written allowlist validated as IP/CIDR syntax; it is configuration, not a record of any caller's address.") },
      sealed_only: "Whether the key may call only anonymo-sealed.",
      created_at: CREATED,
    },
  };
  docs.anonymo_deposit_addresses = {
    category: "chain", request: "no",
    purpose: "The deposit identifier each key has per chain family: an EVM key commitment (keccak of the key hash), a Solana Pay reference (sha256 of the key hash) or a Tron address derived from the operator's xpub.",
    retention: KEPT,
    columns: {
      key_hash: "sha256 of the API key.",
      chain: "evm, solana or tron.",
      address: { purpose: "The commitment, reference or Tron address.", review: WALLET("A deposit commitment or address we issue") },
      derivation_index: "Tron: the child index under the xpub; null otherwise.",
      created_at: CREATED,
    },
  };
  docs.anonymo_deposits = {
    category: "chain", request: "no",
    purpose: "Every confirmed deposit a watcher or the BTCPay webhook reported: credited ones (with a matching dep:<ref> ledger row) and held ones (sanctioned sender, or screening unavailable), which were never credited.",
    retention: KEPT,
    columns: {
      ref: "Chain, transaction and log or instruction index (or btcpay:<invoice id>); unique.",
      key_hash: "sha256 of the API key credited.",
      chain: "base, arbitrum, rhc, solana, tron, btc or ln.",
      token: "USDC, USDT, USDG or BTC.",
      amount_raw: "Token base units as sent.",
      amount_pico: "USD value credited (stablecoins 1:1, BTC at the BTCPay quote), pico-USD.",
      source_addr: { purpose: "Where the deposit came from (the transaction sender, Solana token owner, Tron sender, or the refund address named on a BTCPay invoice). Withdrawals may go only there.", review: WALLET("The depositing wallet") },
      status: "credited or held.",
      reason: "For a held deposit: sanctioned or screening_unavailable.",
      created_at: CREATED,
      credited_at: "When it was credited; null while held.",
    },
  };
  docs.anonymo_withdrawals = {
    category: "chain", request: "no",
    purpose: "Withdrawals of unused credit back to a source address. The ledger debit wd:<id> is written with the row; a revert by an operator writes wd-revert:<id>.",
    retention: KEPT,
    columns: {
      id: "Random withdrawal id; also the payout idempotency key.",
      key_hash: "sha256 of the API key debited.",
      account_id: "Billing account debited.",
      idempotency_key: "The client's Idempotency-Key, unique per key, so a retry never withdraws twice.",
      chain: "Payout chain.",
      token: "Payout token.",
      to_addr: { purpose: "Destination: one of this key's deposit sources, or its SIWE wallet.", review: WALLET("The payout wallet") },
      amount_pico: "Amount debited, pico-USD.",
      status: "pending, sent or reverted.",
      tx_ref: "Payout transaction reference once sent.",
      attempts: "Payout attempts so far.",
      last_error: { purpose: "First line of the last payout error from our own payout rail, at most 200 characters.", review: rv(["name:content"], "no-request-content", "An error message from the payout rail about a transfer we initiated; withdrawals carry no prompt or answer text.") },
      created_at: CREATED,
      sent_at: "When the payout was sent.",
    },
  };
  docs.anonymo_btcpay_invoices = {
    category: "chain", request: "no",
    purpose: "BTCPay invoices this router created for a key. BTCPay sees only a random order id, not the key.",
    retention: KEPT,
    columns: {
      invoice_id: "BTCPay invoice id.",
      key_hash: "sha256 of the API key to credit.",
      refund_chain: "btc or ln.",
      refund_addr: { purpose: "The Bitcoin or Lightning address the key owner named for refunds of this deposit.", review: WALLET("The refund address") },
      status: "new, credited, held or expired.",
      created_at: CREATED,
    },
  };
  docs.anonymo_sanctions = {
    category: "operations", request: "no",
    purpose: "Digital-currency addresses of every family (EVM, Tron, Solana, Bitcoin) from the public OFAC SDN XML, for screening deposit senders. No names or identity records.",
    retention: "Replaced atomically on a successful refresh; a failed refresh keeps the last good list.",
    columns: {
      address: { purpose: "A listed address, in one canonical spelling.", review: WALLET("A sanctioned wallet from the SDN list") },
      family: "evm, tron, solana, btc or other.",
      list_date: "Publication date of the list it came from.",
      created_at: CREATED,
    },
  };
}

const ev = (file: string, contains: string) => ({ file, contains });

export const anonymoMoneyBodyReaders: ExternalDoc["bodyReaders"] = [
  {
    file: "src/anonymo/keys/routes.ts", carries: "payment-or-signature",
    reads: "POST /keys: optional caps. POST /keys/siwe: a SIWE message and its signature, plus optional caps. PATCH /keys/caps: caps.",
    then: "Validates the caps and the SIWE message (domain, single-use nonce, time, signature), then creates a key and returns it once.",
    kept: "sha256 of the new key in keys, caps and the proven wallet in anonymo_keys. The SIWE message and signature are not stored; the nonce row is deleted when used.",
    evidence: [ev("src/anonymo/keys/routes.ts", "createBody.parse(await readJson(c))"), ev("src/anonymo/keys/routes.ts", "siweBody.parse(await readJson(c))")],
  },
  {
    file: "src/anonymo/deposits/routes.ts", carries: "payment-or-signature",
    reads: "POST /withdraw: chain, destination, token, amount and idempotency key. POST /deposits/btcpay: an amount and a refund address. POST /webhooks/btcpay: BTCPay's signed event (invoice id and type).",
    then: "Withdrawals are checked against the key's deposit sources and balance; the BTCPay event's HMAC is verified and the invoice is read back from BTCPay before any credit.",
    kept: "anonymo_withdrawals, anonymo_btcpay_invoices and anonymo_deposits rows as documented. The webhook body itself is not stored.",
    evidence: [ev("src/anonymo/deposits/routes.ts", "withdrawBody.parse(await readJson(c))"), ev("src/anonymo/deposits/routes.ts", "const raw = await c.req.text();")],
  },
  {
    file: "src/anonymo/keys/caps.ts", carries: "prompt-or-answer",
    reads: "Only the `model` field of an inference request, and only for a key marked sealed_only.",
    then: "Compared with anonymo-sealed in memory to allow or refuse the call.",
    kept: "Nothing.",
    evidence: [ev("src/anonymo/keys/caps.ts", "const body = (await c.req.json().catch(() => ({}))) as { model?: unknown };")],
  },
];

export const anonymoMoneyAddressReader: Touchpoint = {
  file: "src/anonymo/keys/caps.ts",
  reads: "The caller's address from the shared ingress helper, only for an Anonymo key that has an IP allowlist.",
  then: "Compared in memory with the owner's CIDR list to allow or refuse the call.",
  kept: "Nothing: not written to Postgres, Redis or a log.",
  evidence: [ev("src/anonymo/keys/caps.ts", "clientIp(c, ctx.cfg.trustProxy)")],
};
