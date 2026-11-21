// WS11 · Ventures sandbox driver contract (Ventures Backend spec, PART 0 Law 1 and PART 7).
//
// PART 7: "one Firecracker microVM per candidate; egress allowlist = package registries + Anonymo gateway only".
// A driver creates one isolated sandbox per candidate and says honestly how isolation is enforced: by the VM, by the OS
// sandbox, only by the proxy (the process could ignore HTTP_PROXY), or not at all.

import type { EgressDecision, EgressLogger } from "./egress.ts";
import type { SandboxPolicy } from "./policy.ts";

export type NetworkEnforcement = "vm" | "os" | "proxy-only" | "none";
export type FsEnforcement = "vm" | "private-dir";
export type Enforcement = { network: NetworkEnforcement; fs: FsEnforcement };

export type ExecOptions = { timeoutMs?: number; env?: Record<string, string>; cwd?: string };
export type ExecResult = { code: number; stdout: string; stderr: string; ms: number; timedOut: boolean };

export interface Sandbox {
  readonly id: string;
  readonly policy: SandboxPolicy;
  readonly policyHash: string;
  readonly enforced: Enforcement;
  writeFiles(files: Record<string, string | Uint8Array>): Promise<void>;
  readFiles(paths?: string[]): Promise<Record<string, string>>;
  exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
  egressLog(): EgressDecision[];
  destroy(): Promise<void>;
}

export type CreateOptions = {
  /** Production refuses anything weaker than OS- or VM-level network enforcement for CLEAN sandboxes. */
  production?: boolean;
  /** Let a CLEAN sandbox start even though the driver cannot enforce its egress policy (dev only). */
  allowUnenforced?: boolean;
  logger?: EgressLogger;
};

export interface SandboxDriver {
  readonly name: string;
  create(policy: SandboxPolicy, opts?: CreateOptions): Promise<Sandbox>;
  /** What a sandbox created now would get, if the driver can tell without creating one. */
  enforcement?(): Promise<Enforcement>;
}

const NETWORK_RANK: Record<NetworkEnforcement, number> = { none: 0, "proxy-only": 1, os: 2, vm: 3 };

/** CLEAN needs at least proxy-only; production needs os or vm. SCOUT sandboxes may browse, so anything goes. */
export function enforcementSufficient(policy: Pick<SandboxPolicy, "zone">, enforced: Enforcement, production = false): boolean {
  if (policy.zone !== "CLEAN") return true;
  return NETWORK_RANK[enforced.network] >= NETWORK_RANK[production ? "os" : "proxy-only"];
}

export class SandboxRefused extends Error {
  override readonly name = "SandboxRefused";
}

export class SandboxTimeout extends Error {
  override readonly name = "SandboxTimeout";
}

/** Rejects absolute paths, backslashes, NUL and any ".." segment. Returns the cleaned relative path. */
export function safeRelativePath(p: string): string {
  if (!p || p.includes("\0") || p.includes("\\") || p.startsWith("/")) throw new Error(`unsafe sandbox path: ${JSON.stringify(p)}`);
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0 || parts.some((s) => s === "..")) throw new Error(`unsafe sandbox path: ${JSON.stringify(p)}`);
  return parts.join("/");
}
