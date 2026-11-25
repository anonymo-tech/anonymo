import type { Hono } from "hono";

export function everydayContractRoutes(app: Hono) {
  app.get("/v1/everyday/contracts", (c) => c.json({
    chainId: 4663,
    checkout: {
      usdgDecimals: 6,
      nymoDiscountBps: 2_000,
      passDurationSeconds: 30 * 86_400,
      prices: { PASS30: 12_000_000, PASS30_PLUS: 29_000_000 },
    },
  }));
}
