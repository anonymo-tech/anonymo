// GET /deposits/contracts: the DepositRouter and tokens per EVM chain without a key, for the dashboard's /pay page in a
// phone wallet's own browser. It must match what a key's instructions say, and go quiet while deposits are paused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { moneyHarness, type MoneyHarness } from "./harness.ts";

const EVM = JSON.stringify([{ chain: "rhc", rpcUrl: "http://127.0.0.1:9", router: "0x00000000000000000000000000000000000000d1", tokens: [{ symbol: "USDG", address: "0x00000000000000000000000000000000000000c1", decimals: 6 }] }]);
let m: MoneyHarness;
beforeAll(async () => {
  m = await moneyHarness({ env: { ANONYMO_EVM_CHAINS: EVM } });
});
afterAll(async () => m?.close());

test("no key needed, and the same chains, routers and tokens as a key's deposit instructions", async () => {
  const r = await m.req("/deposits/contracts");
  expect(r.status).toBe(200);
  const body = (await r.json()) as { paused: boolean; chains: unknown[] };
  expect(body.paused).toBe(false);
  expect(body.chains.length).toBeGreaterThan(0);
  const k = await m.newKey();
  const mine = (await (await m.req("/deposits", { headers: k.auth })).json()) as { instructions: { evm: { chains: unknown[] } } };
  expect(body.chains).toEqual(mine.instructions.evm.chains);
  expect(JSON.stringify(body)).not.toContain("key_commit");
});

test("paused deposits list no contracts", async () => {
  const paused = await moneyHarness({ router: m.h, env: { ANONYMO_EVM_CHAINS: EVM }, config: { depositsPaused: true } });
  try {
    expect(await (await paused.req("/deposits/contracts")).json()).toEqual({ paused: true });
  } finally {
    await paused.close();
  }
});
