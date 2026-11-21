// WS11 · Ventures sandbox policy (Ventures Backend spec, PART 0 Law 1 and PART 7).
//
// Law 1: "Builders never see the target." A builder sandbox has no network route to target domains, no Scout artifacts
// other than the filtered Spec, and no filesystem shared with Scout sandboxes, enforced by network policy and mounts,
// not prompts. PART 7: one microVM per candidate, egress allowlist = package registries + the Anonymo gateway only,
// 2 vCPU / 4 GB by default, a time cap per Step. The policy hash goes on the clean-room receipt.

import { createHash } from "node:crypto";
import type { ArtifactRef, Zone } from "../types.ts";

export type SandboxPolicy = {
  zone: Zone;
  /** Host patterns the sandbox may reach: "registry.npmjs.org" (exact) or "*.npmjs.org" (any subdomain). */
  egressAllow: string[];
  /** Target domains. A deny entry blocks the host and every subdomain of it, and always wins over the allowlist. */
  egressDeny: string[];
  vcpu: number;
  memMb: number;
  /** Wall-clock cap for the whole sandbox (one Step). */
  timeMs: number;
  mounts: ArtifactRef[];
};

/** Package registries a builder may install from. */
export const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "bun.sh",
  "pypi.org",
  "files.pythonhosted.org",
] as const;

export const DEFAULT_VCPU = 2;
export const DEFAULT_MEM_MB = 4096;
export const DEFAULT_TIME_MS = 30 * 60_000;

export class ZoneViolation extends Error {
  override readonly name = "ZoneViolation";
  constructor(
    message: string,
    readonly artifact?: ArtifactRef,
  ) {
    super(message);
  }
}

export function defaultBuilderPolicy(opts: { gatewayHost: string; targetHosts: string[]; mounts?: ArtifactRef[]; timeMs?: number }): SandboxPolicy {
  return {
    zone: "CLEAN",
    egressAllow: [...REGISTRY_HOSTS, normalizeHost(opts.gatewayHost)],
    egressDeny: opts.targetHosts.map(normalizeHost).filter(Boolean),
    vcpu: DEFAULT_VCPU,
    memMb: DEFAULT_MEM_MB,
    timeMs: opts.timeMs ?? DEFAULT_TIME_MS,
    mounts: opts.mounts ?? [],
  };
}

/** Lower-case, strip a trailing dot, IPv6 brackets and any port. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end > 0 ? h.slice(1, end) : h.slice(1);
  } else if (h.split(":").length === 2) {
    h = h.split(":")[0]!;
  }
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Throws ZoneViolation if a CLEAN policy mounts any SCOUT artifact (Law 1). */
export function checkMounts(policy: SandboxPolicy): void {
  if (policy.zone !== "CLEAN") return;
  for (const m of policy.mounts) {
    if (m.zone !== "CLEAN") throw new ZoneViolation(`CLEAN sandbox cannot mount ${m.zone} artifact ${m.sha256.slice(0, 12)}`, m);
  }
}

/** Basic shape checks run before any sandbox starts. */
export function validatePolicy(policy: SandboxPolicy): void {
  checkMounts(policy);
  if (!(policy.vcpu > 0) || !(policy.memMb > 0) || !(policy.timeMs > 0)) throw new Error("sandbox policy needs positive vcpu, memMb and timeMs");
  for (const p of policy.egressAllow) {
    const h = p.startsWith("*.") ? p.slice(2) : p;
    if (!h || h.includes("*")) throw new Error(`bad egress allow pattern: ${p}`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    return items.map((v) => [JSON.stringify(v), v] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: keys sorted, arrays sorted, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** sha256 hex of the canonical policy, for the clean-room receipt. */
export function policyHash(policy: SandboxPolicy): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}
