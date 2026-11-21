// WS11 · sandbox pool (Ventures Backend spec, PART 7 and spend caps): concurrency bound and queueing, beforeStart
// refusal (throw = no sandbox), time cap, always-destroy, vCPU-minute reporting, and enforcement refusals for CLEAN.

import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import {
  defaultBuilderPolicy,
  LocalDriver,
  policyHash,
  SandboxPool,
  SandboxRefused,
  SandboxTimeout,
  ZoneViolation,
  type Enforcement,
  type Sandbox,
  type SandboxDriver,
  type SandboxPolicy,
  type SandboxUsage,
} from "../../src/anonymo/ventures/sandbox/index.ts";

class FakeDriver implements SandboxDriver {
  readonly name = "fake";
  created = 0;
  destroyed = 0;
  live = 0;
  peak = 0;
  constructor(private readonly network: Enforcement["network"] = "vm") {}
  async enforcement(): Promise<Enforcement> {
    return { network: this.network, fs: "vm" };
  }
  async create(policy: SandboxPolicy): Promise<Sandbox> {
    this.created++;
    this.live++;
    this.peak = Math.max(this.peak, this.live);
    const self = this;
    let gone = false;
    return {
      id: `fake_${this.created}`,
      policy,
      policyHash: policyHash(policy),
      enforced: { network: this.network, fs: "vm" },
      async writeFiles() {},
      async readFiles() {
        return {};
      },
      async exec() {
        return { code: 0, stdout: "", stderr: "", ms: 0, timedOut: false };
      },
      egressLog: () => [],
      async destroy() {
        if (gone) return;
        gone = true;
        self.live--;
        self.destroyed++;
      },
    };
  }
}

const policy = (timeMs = 10_000): SandboxPolicy => defaultBuilderPolicy({ gatewayHost: "gateway.test", targetHosts: ["target.test"], timeMs });

describe("SandboxPool", () => {
  test("defaults to 200 concurrent", () => {
    expect(new SandboxPool({ driver: new FakeDriver(), pricePerVcpuMinuteUsd: 0.001 }).maxConcurrent).toBe(200);
  });

  test("queues when full and never exceeds maxConcurrent; every sandbox is destroyed", async () => {
    const driver = new FakeDriver();
    const pool = new SandboxPool({ driver, maxConcurrent: 3, pricePerVcpuMinuteUsd: 0.001 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pool.run(policy(), async () => {
          await Bun.sleep(20 + (i % 3) * 10);
          return i;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(driver.peak).toBe(3);
    expect(driver.created).toBe(10);
    expect(driver.destroyed).toBe(10);
    expect(pool.running).toBe(0);
    expect(pool.queued).toBe(0);
  });

  test("beforeStart throwing means no sandbox starts", async () => {
    const driver = new FakeDriver();
    const pool = new SandboxPool({ driver, pricePerVcpuMinuteUsd: 0.01 });
    let est: { maxVcpuMinutes: number; maxCostUsd: number } | undefined;
    await expect(
      pool.run(policy(60_000), async () => "ran", {
        beforeStart: (e) => {
          est = e;
          throw new Error("key_cap_reached");
        },
      }),
    ).rejects.toThrow("key_cap_reached");
    expect(driver.created).toBe(0);
    expect(est!.maxVcpuMinutes).toBe(2);
    expect(est!.maxCostUsd).toBeCloseTo(0.02);
  });

  test("reports vCPU-minutes and cost, and destroys on failure", async () => {
    const driver = new FakeDriver();
    const pool = new SandboxPool({ driver, pricePerVcpuMinuteUsd: 0.5 });
    const usage: SandboxUsage[] = [];
    await expect(
      pool.run(policy(), async () => {
        await Bun.sleep(60);
        throw new Error("candidate failed");
      }, { onMinutes: (u) => void usage.push(u) }),
    ).rejects.toThrow("candidate failed");
    expect(driver.destroyed).toBe(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.ms).toBeGreaterThanOrEqual(55);
    expect(usage[0]!.vcpuMinutes).toBeCloseTo((2 * usage[0]!.ms) / 60_000, 6);
    expect(usage[0]!.costUsd).toBeCloseTo(usage[0]!.vcpuMinutes * 0.5, 9);
    expect(usage[0]!.policyHash).toBe(policyHash(policy()));
  });

  test("time cap: the run fails with SandboxTimeout and the sandbox is destroyed", async () => {
    const driver = new FakeDriver();
    const pool = new SandboxPool({ driver, pricePerVcpuMinuteUsd: 0 });
    const usage: SandboxUsage[] = [];
    await expect(pool.run(policy(100), () => new Promise(() => {}), { onMinutes: (u) => void usage.push(u) })).rejects.toThrow(SandboxTimeout);
    expect(driver.destroyed).toBe(1);
    expect(usage[0]!.timedOut).toBe(true);
  });

  test("CLEAN is refused on a driver that cannot enforce the network; production needs os or vm", async () => {
    const none = new SandboxPool({ driver: new FakeDriver("none"), pricePerVcpuMinuteUsd: 0 });
    await expect(none.run(policy(), async () => 1)).rejects.toThrow(SandboxRefused);
    expect(await none.run({ ...policy(), zone: "SCOUT" }, async () => 1)).toBe(1);

    const proxyOnly = new FakeDriver("proxy-only");
    expect(await new SandboxPool({ driver: proxyOnly, pricePerVcpuMinuteUsd: 0 }).run(policy(), async () => 2)).toBe(2);
    let budgetChecked = false;
    await expect(
      new SandboxPool({ driver: proxyOnly, pricePerVcpuMinuteUsd: 0, production: true }).run(policy(), async () => 3, { beforeStart: () => void (budgetChecked = true) }),
    ).rejects.toThrow(SandboxRefused);
    expect(budgetChecked).toBe(false);
    expect(await new SandboxPool({ driver: new FakeDriver("os"), pricePerVcpuMinuteUsd: 0, production: true }).run(policy(), async () => 4)).toBe(4);
    expect(await new SandboxPool({ driver: new FakeDriver("vm"), pricePerVcpuMinuteUsd: 0, production: true }).run(policy(), async () => 5)).toBe(5);
  });

  test("a CLEAN policy mounting a SCOUT artifact never starts", async () => {
    const driver = new FakeDriver();
    const pool = new SandboxPool({ driver, pricePerVcpuMinuteUsd: 0 });
    const p = { ...policy(), mounts: [{ sha256: "c".repeat(64), kind: "har" as const, zone: "SCOUT" as const }] };
    await expect(pool.run(p, async () => 1)).rejects.toThrow(ZoneViolation);
    expect(driver.created).toBe(0);
  });

  test("runs real work on the LocalDriver", async () => {
    const root = path.join(os.tmpdir(), `anonymo-sandbox-pool-${process.pid}`);
    try {
      const pool = new SandboxPool({ driver: new LocalDriver({ root }), maxConcurrent: 2, pricePerVcpuMinuteUsd: 0.001 });
      const outs = await Promise.all(
        [1, 2, 3].map((n) =>
          pool.run(policy(20_000), async (sb) => {
            await sb.writeFiles({ "n.txt": String(n) });
            return (await sb.exec(["bun", "-e", "console.log(Number(await Bun.file('n.txt').text()) * 10)"])).stdout.trim();
          }),
        ),
      );
      expect(outs).toEqual(["10", "20", "30"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
