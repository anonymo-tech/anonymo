// WS11 · Ventures tables (Ventures Backend PART 12). Migration: drizzle/0063_ventures.sql.
//
// Privacy, as for the rest of Anonymo: no email, name, IP address or user agent anywhere. A venture's target is kept only
// as target_commit = keccak256(salt ‖ url); the url itself lives in memory while the run lasts (Run Mode keeps it
// encrypted with the app secret until Run Mode is switched off). Artifact bodies are kept for 30 days, then only their
// hashes remain (store/artifacts.ts purge()). Bodies are never in Postgres: they live encrypted in the artifact store
// (store/bodies.ts), so the database keeps its promise of holding no prompt or answer text.

import { bigint, boolean, index, integer, jsonb, numeric, pgTable, primaryKey, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const ventures = pgTable(
  "ventures",
  {
    id: text("id").primaryKey(),
    /** The owner's key (sha256 of the bearer secret). */
    keyHash: text("key_hash").notNull(),
    accountId: text("account_id").notNull(),
    mode: text("mode").notNull(),
    targetCommit: text("target_commit"),
    tier: text("tier").notNull(),
    caps: jsonb("caps").notNull(), // { total, perStep } in USD
    priceUsd: money("price").notNull(), // pico-USD charged up front for the run
    paidBalance: money("paid_balance").notNull().default(0n), // the part of the price paid from the owner's balance (the most a failed run refunds)
    costUsd: money("cost").notNull().default(0n), // pico-USD the crew actually used (routes + sandboxes)
    status: text("status").notNull(),
    /** The crew key the run's model calls are billed to (funded from the owner's account, capped at the price). */
    crewKeyHash: text("crew_key_hash"),
    crewKeyEnc: text("crew_key_enc"),
    repoUrl: text("repo_url"),
    webhookUrl: text("webhook_url"),
    recipeId: text("recipe_id"),
    /** The artifact (zone CLEAN, name "input") holding the brief and options, never the target url. */
    inputSha256: text("input_sha256"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    purgedAt: ts("purged_at"),
  },
  (t) => [index("ventures_key_idx").on(t.keyHash, t.createdAt)],
);

export const ventureSteps = pgTable(
  "venture_steps",
  {
    id: text("id").primaryKey(),
    ventureId: text("venture_id").notNull(),
    key: text("key").notNull(),
    role: text("role").notNull(),
    kind: text("kind").notNull(),
    zone: text("zone").notNull(),
    fanout: integer("fanout").notNull(),
    selectMode: text("select_mode").notNull(),
    needs: text("needs").array().notNull(),
    state: text("state").notNull(),
    costUsd: money("cost").notNull().default(0n),
    capUsd: money("cap").notNull(),
    receiptIds: text("receipt_ids").array().notNull(),
    inputs: jsonb("inputs").notNull(),
    outputs: jsonb("outputs").notNull(),
    error: text("error"),
    position: integer("position").notNull(),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
  },
  (t) => [uniqueIndex("venture_steps_key_uq").on(t.ventureId, t.key)],
);

export const ventureArtifacts = pgTable(
  "venture_artifacts",
  {
    ventureId: text("venture_id").notNull(),
    sha256: text("sha256").notNull(),
    kind: text("kind").notNull(),
    zone: text("zone").notNull(),
    name: text("name"),
    mime: text("mime"),
    size: integer("size").notNull(),
    /** Where the encrypted body is in the artifact store (store/bodies.ts); the body never enters Postgres. */
    s3Key: text("s3_key"),
    purgedAt: ts("purged_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ventureId, t.sha256] }), index("venture_artifacts_created_idx").on(t.createdAt)],
);

export const ventureCandidates = pgTable("venture_candidates", {
  id: text("id").primaryKey(),
  ventureId: text("venture_id").notNull(),
  stepId: text("step_id").notNull(),
  family: text("family").notNull(),
  model: text("model").notNull(),
  passRate: real("pass_rate"),
  lintErrors: integer("lint_errors"),
  typeErrors: integer("type_errors"),
  bundleBytes: integer("bundle_bytes"),
  refused: boolean("refused").notNull().default(false),
  chosen: boolean("chosen").notNull().default(false),
  receiptId: text("receipt_id"),
  costUsd: money("cost").notNull().default(0n),
  error: text("error"),
});

export const ventureSpecs = pgTable("venture_specs", {
  sha256: text("sha256").primaryKey(),
  ventureId: text("venture_id").notNull(),
  leakageScan: jsonb("leakage_scan").notNull(),
});

export const ventureLicenceReports = pgTable("venture_licence_reports", {
  id: text("id").primaryKey(),
  ventureId: text("venture_id").notNull(),
  buildSha: text("build_sha").notNull(),
  spdx: jsonb("spdx").notNull(),
  decisions: jsonb("decisions").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const ventureDeployments = pgTable("venture_deployments", {
  id: text("id").primaryKey(),
  ventureId: text("venture_id").notNull(),
  target: text("target").notNull(),
  cid: text("cid"),
  url: text("url"),
  status: text("status").notNull(),
  details: jsonb("details").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Design systems already handed out, so every new venture's look is measurably different (Designer Mo). */
export const ventureDesigns = pgTable("venture_designs", {
  ventureId: text("venture_id").primaryKey(),
  system: jsonb("system").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const ventureRecipes = pgTable(
  "venture_recipes",
  {
    id: text("id").primaryKey(),
    creatorKeyHash: text("creator_key_hash").notNull(),
    creatorAccountId: text("creator_account_id").notNull(),
    creatorWallet: text("creator_wallet"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    mode: text("mode").notNull(),
    dag: jsonb("dag").notNull(),
    recipeHash: text("recipe_hash").notNull(),
    priceUsdg: money("price").notNull(),
    runs: integer("runs").notNull().default(0),
    earned: money("earned").notNull().default(0n),
    published: boolean("published").notNull().default(true),
    sourceVentureId: text("source_venture_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("venture_recipes_hash_uq").on(t.recipeHash)],
);

export const ventureRecipeRuns = pgTable("venture_recipe_runs", {
  orderRef: text("order_ref").primaryKey(),
  recipeId: text("recipe_id").notNull(),
  ventureId: text("venture_id").notNull(),
  creatorShare: money("creator_share").notNull(),
  onchainTx: text("onchain_tx"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const ventureRunMode = pgTable("venture_run_mode", {
  ventureId: text("venture_id").primaryKey(),
  enabled: boolean("enabled").notNull(),
  dailyCap: money("daily_cap").notNull(), // pico-USD per UTC day, the daily fee included
  hoursPerDay: integer("hours_per_day").notNull(),
  tasks: text("tasks").array().notNull(),
  day: text("day"), // the UTC day the counters below belong to
  spentToday: money("spent_today").notNull().default(0n),
  ticksToday: integer("ticks_today").notNull().default(0),
  nextTickAt: ts("next_tick_at"),
  /** The target url, encrypted with the app secret, kept only while Run Mode is on. */
  targetEnc: text("target_enc"),
  lastSpecHash: text("last_spec_hash"),
  lastBriefSha: text("last_brief_sha"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** People's Forks the gateway has seen on chain, and the venture that builds each one. */
export const ventureForks = pgTable("venture_forks", {
  forkId: text("fork_id").primaryKey(),
  chainId: integer("chain_id").notNull(),
  targetCommit: text("target_commit").notNull(),
  specHash: text("spec_hash"),
  status: text("status").notNull(), // open | triggered | building | fulfilled | refunded
  ventureId: text("venture_id"),
  repoHash: text("repo_hash"),
  receiptRoot: text("receipt_root"),
  /** USDG (base units) the fund routed through the fee router at trigger: the fork's cash. */
  usdgRouted: numeric("usdg_routed", { mode: "bigint" }),
  /** The fork's public target url, registered off chain against its on-chain commitment, encrypted until the build. */
  targetEnc: text("target_enc"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Build Fuel credits spent per wallet per UTC day (credits never enter the ledger and expire with their day). */
export const ventureFuel = pgTable(
  "venture_fuel",
  {
    wallet: text("wallet").notNull(),
    day: text("day").notNull(),
    used: money("used").notNull().default(0n),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.day] })],
);

/** Runs paid on chain through Checkout (Paid events), each spendable once by the key whose wallet paid it. */
export const ventureOrders = pgTable("venture_orders", {
  orderId: text("order_id").primaryKey(),
  chainId: integer("chain_id").notNull(),
  sku: text("sku").notNull(),
  payer: text("payer").notNull(),
  qty: integer("qty").notNull(),
  amount: numeric("amount", { mode: "bigint" }).notNull(),
  currency: text("currency").notNull(),
  usedBy: text("used_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
