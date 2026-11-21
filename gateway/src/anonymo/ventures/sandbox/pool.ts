// WS11 · Ventures sandbox pool (Ventures Backend spec, PART 0 Law 1, PART 7, spend caps).
//
// PART 7: one sandbox per candidate, 2 vCPU / 4 GB default, a time cap per Step. Every start passes the caller's
// beforeStart() budget check first (throw = no sandbox). The pool bounds concurrency, enforces the time cap, always
// destroys the sandbox, reports vCPU-minutes and cost, and refuses CLEAN work on a driver that cannot keep the
// builder away from the target (at least proxy-only; production needs os or vm).

import { checkMounts, type SandboxPolicy } from "./policy.ts";
import { enforcementSufficient, SandboxRefused, SandboxTimeout, type Sandbox, type SandboxDriver } from "./driver.ts";
import type { EgressLogger } from "./egress.ts";

export type SandboxUsage = { sandboxId: string; policyHash: string; ms: number; vcpuMinutes: number; costUsd: number; timedOut: boolean };

export type RunOptions = {
  /** Budget check. Throwing refuses the sandbox before it starts. */
  beforeStart?: (est: { policy: SandboxPolicy; maxVcpuMinutes: number; maxCostUsd: number }) => void | Promise<void>;
  onMinutes?: (u: SandboxUsage) => void | Promise<void>;
  logger?: EgressLogger;
  allowUnenforced?: boolean;
};

export type SandboxPoolOptions = {
  driver: SandboxDriver;
  maxConcurrent?: number;
  pricePerVcpuMinuteUsd: number;
  production?: boolean;
};

export class SandboxPool {
  readonly maxConcurrent: number;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly opts: SandboxPoolOptions) {
    this.maxConcurrent = opts.maxConcurrent ?? 200;
    if (!(this.maxConcurrent >= 1)) throw new Error("maxConcurrent must be at least 1");
  }

  get running() {
    return this.active;
  }
  get queued() {
    return this.waiters.length;
  }

  private async acquire() {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((ok) => this.waiters.push(ok));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else this.active--;
  }

  async run<T>(policy: SandboxPolicy, fn: (sb: Sandbox) => Promise<T>, ro: RunOptions = {}): Promise<T> {
    checkMounts(policy);
    const production = this.opts.production ?? false;
    const declared = await this.opts.driver.enforcement?.();
    if (declared && !enforcementSufficient(policy, declared, production) && !(ro.allowUnenforced && !production)) {
      throw new SandboxRefused(`driver ${this.opts.driver.name} enforces network=${declared.network}; not enough for CLEAN${production ? " in production" : ""}`);
    }
    const maxVcpuMinutes = (policy.vcpu * policy.timeMs) / 60_000;
    await ro.beforeStart?.({ policy, maxVcpuMinutes, maxCostUsd: maxVcpuMinutes * this.opts.pricePerVcpuMinuteUsd });

    await this.acquire();
    let sb: Sandbox | undefined;
    const started = Date.now();
    let timedOut = false;
    try {
      sb = await this.opts.driver.create(policy, { production, logger: ro.logger, allowUnenforced: ro.allowUnenforced && !production });
      if (!enforcementSufficient(policy, sb.enforced, production) && !(ro.allowUnenforced && !production)) {
        throw new SandboxRefused(`sandbox enforces network=${sb.enforced.network}; not enough for CLEAN`);
      }
      const box = sb;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<never>((_, fail) => {
        timer = setTimeout(() => {
          timedOut = true;
          fail(new SandboxTimeout(`sandbox ${box.id} hit its ${policy.timeMs} ms time cap`));
        }, policy.timeMs);
      });
      try {
        return await Promise.race([fn(box), cap]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      try {
        if (sb) await sb.destroy();
      } finally {
        this.release();
        if (sb) {
          const ms = Date.now() - started;
          const vcpuMinutes = (policy.vcpu * ms) / 60_000;
          await ro.onMinutes?.({ sandboxId: sb.id, policyHash: sb.policyHash, ms, vcpuMinutes, costUsd: vcpuMinutes * this.opts.pricePerVcpuMinuteUsd, timedOut });
        }
      }
    }
  }
}
