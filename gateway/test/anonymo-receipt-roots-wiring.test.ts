// Rollout A3: with ReceiptRoots and the anchoring key configured, the receipts-anchor job posts each hour's Anonymo
// root through ChainService.postReceiptRoot. Without them, roots stay "local".
import { afterEach, expect, test } from "bun:test";
import type { Hex } from "viem";
import { receiptRootsPoster } from "../src/receipts/roots.ts";
import { startRouter, type Harness } from "./helpers.ts";

const ROOTS = "0x" + "5".repeat(40);
const KEY = "0x" + "2".repeat(64);
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

test("the poster is plugged in when ReceiptRoots and the anchoring key are both set, and posts through the chain service", async () => {
  h = await startRouter({ env: { ANONYMO_RECEIPT_ROOTS_ADDRESS: ROOTS, ANCHORER_PRIVATE_KEY: KEY } });
  expect(h.ctx.cfg.chain.anonymoReceiptRoots).toBe(ROOTS);
  const poster = receiptRootsPoster(h.ctx);
  expect(poster).not.toBeNull();
  const calls: [bigint, Hex][] = [];
  h.ctx.chain.postReceiptRoot = async (hour, root) => {
    calls.push([hour, root]);
    return { txHash: "0xabc" };
  };
  const root = ("0x" + "a".repeat(64)) as Hex;
  expect(await poster!.post(7n, root)).toEqual({ txHash: "0xabc" });
  expect(calls).toEqual([[7n, root]]);
});

test("no poster without the ReceiptRoots address", async () => {
  h = await startRouter({ env: { ANCHORER_PRIVATE_KEY: KEY } });
  expect(receiptRootsPoster(h.ctx)).toBeNull();
});
