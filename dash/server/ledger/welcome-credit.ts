import type { PoolClient } from "pg";
import { one, type Queryable } from "../db/database.ts";
import { ledgerAccount, post } from "./ledger.ts";
import { uuidField } from "../core/http.ts";
import { address } from "../solana/validation.ts";

export const WALLET_WELCOME_CAMPAIGN_ID = "wallet-welcome-2026-10-14";
export const WALLET_WELCOME_AMOUNT_USD6 = "5000000";
export const WALLET_WELCOME_LIMIT = 20;
export const WELCOME_CREDIT_LABEL = "Welcome usage credit (not USDC)";
type WelcomeCredit = { amountUsd6: string; transactionId: string; replayed: boolean };
type GrantRow = {
  account_id: string;
  identity_id: string;
  wallet_address: string;
  amount_usd6: string;
  ledger_transaction_id: string;
};

/** New-wallet sign-up transaction only. No environment switch, HTTP endpoint or
 * caller-selected amount can create or reset the persisted operator campaign. */
export async function grantWalletWelcomeCreditInTransaction(
  client: PoolClient,
  input: { accountId: string; identityId: string; walletAddress: string },
): Promise<WelcomeCredit | null> {
  const accountId = uuidField(input.accountId).toLowerCase();
  const identityId = uuidField(input.identityId).toLowerCase();
  const walletAddress = address(input.walletAddress);
  const campaign = await one<{ id: string; amount_usd6: string; max_grants: number }>(
    client,
    `SELECT id,amount_usd6::text,max_grants FROM wallet_welcome_campaigns
      WHERE id=$1 AND enabled AND starts_at<=clock_timestamp() FOR UPDATE`,
    [WALLET_WELCOME_CAMPAIGN_ID],
  );
  if (!campaign) return null;
  const previous = await one<GrantRow>(
    client,
    `SELECT account_id,identity_id,wallet_address,amount_usd6::text,ledger_transaction_id
       FROM wallet_welcome_grants WHERE account_id=$1 OR identity_id=$2 OR wallet_address=$3`,
    [accountId, identityId, walletAddress],
  );
  if (previous)
    return previous.account_id === accountId &&
      previous.identity_id === identityId &&
      previous.wallet_address === walletAddress
      ? {
          amountUsd6: previous.amount_usd6,
          transactionId: previous.ledger_transaction_id,
          replayed: true,
        }
      : null;
  const eligible = await one(
    client,
    `SELECT a.id FROM accounts a JOIN identities i ON i.account_id=a.id JOIN wallet_welcome_campaigns c ON c.id=$4
      WHERE a.id=$1 AND i.id=$2 AND i.subject=$3 AND i.kind='solana' AND i.revoked_at IS NULL AND a.disabled_at IS NULL
        AND a.created_at>=c.starts_at AND i.created_at>=c.starts_at
        AND a.created_at=transaction_timestamp() AND i.created_at=transaction_timestamp()
        AND a.xmin::text=pg_current_xact_id()::text AND i.xmin::text=pg_current_xact_id()::text
      FOR UPDATE OF a`,
    [accountId, identityId, walletAddress, campaign.id],
  );
  if (!eligible) return null;
  const total = await one<{ count: number }>(
    client,
    "SELECT count(*)::integer AS count FROM wallet_welcome_grants WHERE campaign_id=$1",
    [campaign.id],
  );
  if ((total?.count ?? 0) >= campaign.max_grants) return null;
  const available = await ledgerAccount(client, accountId, "available");
  const funding = await one<{ id: string }>(
    client,
    "SELECT id FROM ledger_accounts WHERE owner_id IS NULL AND kind='promotional_funding'",
  );
  if (!funding) throw new Error("Promotional funding account unavailable.");
  const amount = BigInt(campaign.amount_usd6);
  const transactionId = await post(
    client,
    `wallet-welcome:${campaign.id}:${accountId}`,
    "promotional_credit",
    [
      { id: funding.id, amount: -amount },
      { id: available.id, amount },
    ],
  );
  await client.query(
    "INSERT INTO wallet_welcome_grants(account_id,identity_id,wallet_address,campaign_id,amount_usd6,ledger_transaction_id) VALUES($1,$2,$3,$4,$5,$6)",
    [accountId, identityId, walletAddress, campaign.id, campaign.amount_usd6, transactionId],
  );
  return { amountUsd6: campaign.amount_usd6, transactionId, replayed: false };
}

/** Lifetime promotional grant metadata; never described as a deposit balance. */
export async function welcomeCreditGrantedUsd6(db: Queryable, accountId: string): Promise<string> {
  const row = await one<{ amount_usd6: string }>(
    db,
    "SELECT amount_usd6::text FROM wallet_welcome_grants WHERE account_id=$1",
    [uuidField(accountId).toLowerCase()],
  );
  return row?.amount_usd6 ?? "0";
}
