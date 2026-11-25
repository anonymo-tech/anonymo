import { expect, test } from "bun:test";
import { encodeFunctionData, stringToHex } from "viem";
import { CheckoutAbi } from "../src/chain/abis.ts";
import { startRouter } from "./helpers.ts";

const path = "/v1/everyday/contracts";

test("Everyday contract metadata is absent by default and describes wallet checkout when enabled", async () => {
  const off = await startRouter({ providers: [] });
  try {
    expect(off.ctx.cfg.features.everydayContracts).toBe(false);
    expect((await off.request(path)).status).toBe(404);
  } finally {
    await off.close();
  }

  const on = await startRouter({ providers: [], env: { ANONYMO_FEATURE_EVERYDAY_CONTRACTS: "1" } });
  try {
    const response = await on.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      chainId: 4663,
      checkout: {
        usdgDecimals: 6,
        nymoDiscountBps: 2_000,
        passDurationSeconds: 2_592_000,
        prices: { PASS30: 12_000_000, PASS30_PLUS: 29_000_000 },
      },
    });
    expect(encodeFunctionData({
      abi: CheckoutAbi,
      functionName: "priceOf",
      args: [stringToHex("PASS30_PLUS", { size: 32 }), 1n],
    })).toHaveLength(138);
  } finally {
    await on.close();
  }
});
