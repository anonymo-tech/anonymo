// WS11 · Build Fuel credits and on-chain Checkout orders, gateway side (Ventures Overview §5, Backend PART 10).
//
// Build Fuel: a wallet that locks $NYMO in BuildFuel gets dailyFuelOf(wallet) build credits every UTC day for as long
// as it stays locked. Credits are not money: they never enter the ledger balance, can't be withdrawn or moved, and
// expire at the end of their day. They pay (part of) a run's price; the house account sponsors that part of the crew
// budget. 1 credit = 1 USDG base unit (6 decimals), i.e. dailyFuelOf / 1e6 USD.
//
// Checkout: a run can be paid on chain instead (payUSDG, or payNYMO at 25% less with the $NYMO burned). Each Paid
// event is an order; the key whose SIWE wallet paid it can spend it once on a run of the matching mode
// (sku = keccak256("anonymo-ventures:<MODE>")). The order's money went to the FeeRouter on chain; the house funds the
// crew key for it.

import { and, eq, isNull, sql } from "drizzle-orm";
import { keccak256, toBytes, type Address, type Hex, type PublicClient } from "viem";
import type { Ctx } from "../../context.ts";
import { accounts } from "../../db/schema.ts";
import { usdToPico, type Pico } from "../../lib/money.ts";
import { FUEL_POOL_ACCOUNT } from "./money.ts";
import { fuelWalletDailyCapUsd } from "./pricing.ts";
import { checkoutAbi } from "./chain/abis.ts";
import { ventureFuel, ventureOrders } from "./store/schema.ts";
import type { VentureMode } from "./types.ts";

export const skuOf = (mode: VentureMode): Hex => keccak256(toBytes(`anonymo-ventures:${mode}`));
const PICO_PER_CREDIT = 1_000_000n; // a credit is 1e-6 USD = 1e6 pico-USD
const DAILY_FUEL_ABI = [{ type: "function", name: "dailyFuelOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }] as const;

export type FuelReader = (wallet: Address) => Promise<bigint>;
let fuelOverride: FuelReader | null = null;
export const setFuelReader = (r: FuelReader | null) => void (fuelOverride = r);

export function chainFuelReader(client: PublicClient, address: Address): FuelReader {
  return async (wallet) => (await client.readContract({ address, abi: DAILY_FUEL_ABI, functionName: "dailyFuelOf", args: [wallet] })) as bigint;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** What the Build Fuel pool holds (filled by 5% of every finished run's price). */
export async function fuelPoolAvailable(ctx: Ctx): Promise<Pico> {
  const [row] = await ctx.db.select({ balance: accounts.balance, held: accounts.held }).from(accounts).where(eq(accounts.id, FUEL_POOL_ACCOUNT));
  return row ? row.balance - row.held : 0n;
}

/**
 * Today's unused credits for a wallet, in pico-USD: dailyFuelOf on chain, capped per wallet per day
 * (VENTURES_FUEL_WALLET_DAILY_USD) and by what the pool holds (`poolLeft`). 0 without a wallet or a BuildFuel contract.
 */
export async function fuelAvailable(ctx: Ctx, wallet: string | null, now = new Date(), poolLeft?: Pico): Promise<Pico> {
  if (!wallet) return 0n;
  const address = process.env.VENTURES_BUILD_FUEL_ADDRESS as Address | undefined;
  const reader = fuelOverride ?? (address ? chainFuelReader(ctx.chain.client, address) : null);
  if (!reader) return 0n;
  let daily: bigint;
  try {
    daily = (await reader(wallet as Address)) * PICO_PER_CREDIT;
  } catch {
    return 0n;
  }
  const walletCap = usdToPico(fuelWalletDailyCapUsd().toFixed(6), "floor");
  if (daily > walletCap) daily = walletCap;
  const [row] = await ctx.db.select().from(ventureFuel).where(and(eq(ventureFuel.wallet, wallet), eq(ventureFuel.day, day(now))));
  const used = row?.used ?? 0n;
  const left = daily > used ? daily - used : 0n;
  return poolLeft !== undefined && poolLeft < left ? (poolLeft > 0n ? poolLeft : 0n) : left;
}

/** Spends up to `amount` of today's credits; returns what was spent. Credits that aren't spent today expire. */
export async function spendFuel(ctx: Ctx, wallet: string, amount: Pico, now = new Date()): Promise<Pico> {
  const have = await fuelAvailable(ctx, wallet, now);
  const spend = have < amount ? have : amount;
  if (spend <= 0n) return 0n;
  await ctx.db
    .insert(ventureFuel)
    .values({ wallet, day: day(now), used: spend })
    .onConflictDoUpdate({ target: [ventureFuel.wallet, ventureFuel.day], set: { used: sql`${ventureFuel.used} + ${spend}` } });
  return spend;
}

// ---- Checkout orders -------------------------------------------------------------------------------------------------

export type PaidOrder = { orderId: Hex; sku: Hex; payer: Address; qty: bigint; amount: bigint; currency: number; ventureId: Hex; chainId: number };
export type OrderReader = () => Promise<PaidOrder[]>;

export function chainOrderReader(client: PublicClient, address: Address, chainId: number, fromBlock = 0n): OrderReader {
  return async () => {
    const logs = (await client.getContractEvents({ address, abi: checkoutAbi, eventName: "Paid", fromBlock })) as unknown as { args: Record<string, unknown> }[];
    return logs.map((l) => ({ orderId: l.args.orderId as Hex, sku: l.args.sku as Hex, payer: l.args.payer as Address, qty: BigInt(l.args.qty as bigint), amount: BigInt(l.args.amount as bigint), currency: Number(l.args.currency), ventureId: l.args.ventureId as Hex, chainId }));
  };
}

/** Records Paid events as orders (idempotent on the order id). */
export async function syncOrders(ctx: Ctx, read: OrderReader): Promise<number> {
  let n = 0;
  for (const o of await read()) {
    const r = await ctx.db
      .insert(ventureOrders)
      .values({ orderId: o.orderId.toLowerCase(), chainId: o.chainId, sku: o.sku.toLowerCase(), payer: o.payer.toLowerCase(), qty: Number(o.qty), amount: o.amount, currency: o.currency === 1 ? "NYMO" : "USDG" })
      .onConflictDoNothing()
      .returning({ id: ventureOrders.orderId });
    n += r.length;
  }
  return n;
}

/** Claims an unused order for a run: it must be paid by the key's wallet, for this mode. Returns false otherwise. */
export async function claimOrder(ctx: Ctx, o: { orderId: string; wallet: string | null; mode: VentureMode; ventureId: string; price?: Pico }): Promise<boolean> {
  if (!o.wallet) return false;
  // A USDG order must have paid at least the run's price (a SKU priced low on chain by mistake can't buy a run at a
  // loss). A NYMO order is accepted as paid: its NYMO is burned, which the business absorbs by design.
  if (o.price !== undefined) {
    const [ord] = await ctx.db.select().from(ventureOrders).where(eq(ventureOrders.orderId, o.orderId.toLowerCase()));
    if (ord && ord.currency === "USDG" && ord.amount * PICO_PER_CREDIT < o.price) return false;
  }
  const r = await ctx.db
    .update(ventureOrders)
    .set({ usedBy: o.ventureId })
    .where(and(eq(ventureOrders.orderId, o.orderId.toLowerCase()), eq(ventureOrders.payer, o.wallet.toLowerCase()), eq(ventureOrders.sku, skuOf(o.mode).toLowerCase()), isNull(ventureOrders.usedBy)))
    .returning({ id: ventureOrders.orderId });
  return r.length === 1;
}

/** Gives an order back when the run it was claimed for could not start. */
export async function releaseOrder(ctx: Ctx, orderId: string) {
  await ctx.db.update(ventureOrders).set({ usedBy: null }).where(eq(ventureOrders.orderId, orderId.toLowerCase()));
}
