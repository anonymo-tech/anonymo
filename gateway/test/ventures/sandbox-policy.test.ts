// WS11 · sandbox policy and egress decision (Ventures Backend spec, PART 0 Law 1, PART 7): hash stability for the
// clean-room receipt, ZoneViolation on a SCOUT mount, and property tests that deny always wins.

import { describe, expect, test } from "bun:test";
import { checkMounts, defaultBuilderPolicy, egressAllowed, egressDecide, isIpLiteral, policyHash, REGISTRY_HOSTS, ZoneViolation, type SandboxPolicy } from "../../src/anonymo/ventures/sandbox/index.ts";

const sha = (c: string) => c.repeat(64);

describe("sandbox policy", () => {
  test("defaultBuilderPolicy: CLEAN, registries + gateway, 2 vCPU / 4096 MB, targets denied", () => {
    const p = defaultBuilderPolicy({ gatewayHost: "Gateway.Test", targetHosts: ["target.test"] });
    expect(p.zone).toBe("CLEAN");
    expect(p.vcpu).toBe(2);
    expect(p.memMb).toBe(4096);
    for (const h of REGISTRY_HOSTS) expect(p.egressAllow).toContain(h);
    expect(p.egressAllow).toContain("gateway.test");
    expect(p.egressDeny).toEqual(["target.test"]);
  });

  test("policyHash is stable across key order and array order, and changes with content", () => {
    const a = defaultBuilderPolicy({ gatewayHost: "gateway.test", targetHosts: ["target.test", "other.test"] });
    const b: SandboxPolicy = {
      mounts: [],
      timeMs: a.timeMs,
      memMb: 4096,
      vcpu: 2,
      egressDeny: ["other.test", "target.test"],
      egressAllow: [...a.egressAllow].reverse(),
      zone: "CLEAN",
    };
    expect(policyHash(a)).toBe(policyHash(b));
    expect(policyHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(policyHash({ ...a, vcpu: 4 })).not.toBe(policyHash(a));
    expect(policyHash({ ...a, egressDeny: ["target.test"] })).not.toBe(policyHash(a));
    // A known value pins the canonical form so receipts stay verifiable across releases.
    const fixed: SandboxPolicy = { zone: "CLEAN", egressAllow: ["b.test", "a.test"], egressDeny: ["t.test"], vcpu: 2, memMb: 4096, timeMs: 1000, mounts: [] };
    expect(policyHash(fixed)).toBe(new Bun.CryptoHasher("sha256").update('{"egressAllow":["a.test","b.test"],"egressDeny":["t.test"],"memMb":4096,"mounts":[],"timeMs":1000,"vcpu":2,"zone":"CLEAN"}').digest("hex"));
  });

  test("checkMounts throws ZoneViolation when a CLEAN policy mounts a SCOUT artifact", () => {
    const clean = defaultBuilderPolicy({ gatewayHost: "gateway.test", targetHosts: [], mounts: [{ sha256: sha("a"), kind: "spec", zone: "CLEAN" }] });
    expect(() => checkMounts(clean)).not.toThrow();
    const leaked = { ...clean, mounts: [...clean.mounts, { sha256: sha("b"), kind: "har" as const, zone: "SCOUT" as const }] };
    expect(() => checkMounts(leaked)).toThrow(ZoneViolation);
    // A SCOUT sandbox may hold SCOUT artifacts.
    expect(() => checkMounts({ ...leaked, zone: "SCOUT" })).not.toThrow();
  });
});

// Deterministic pseudo-random numbers for the property tests.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("egressAllowed", () => {
  const p = defaultBuilderPolicy({ gatewayHost: "gateway.test", targetHosts: ["target.test"] });

  test("examples", () => {
    expect(egressAllowed("registry.npmjs.org", p)).toBe(true);
    expect(egressAllowed("REGISTRY.NPMJS.ORG.", p)).toBe(true);
    expect(egressAllowed("gateway.test", p)).toBe(true);
    expect(egressAllowed("evil.npmjs.org", p)).toBe(false);
    expect(egressAllowed("target.test", p)).toBe(false);
    expect(egressAllowed("api.target.test", p)).toBe(false);
    expect(egressAllowed("127.0.0.1", p)).toBe(false);
    expect(egressDecide("2130706433", p).reason).toBe("ip-literal");
    expect(egressDecide("0x7f.1", p).reason).toBe("ip-literal");
    expect(egressDecide("[::1]", p).reason).toBe("ip-literal");
    expect(egressAllowed("10.0.0.5", { egressAllow: ["10.0.0.5"], egressDeny: [] })).toBe(true);
    expect(egressAllowed("a.npmjs.org", { egressAllow: ["*.npmjs.org"], egressDeny: [] })).toBe(true);
    expect(egressAllowed("npmjs.org", { egressAllow: ["*.npmjs.org"], egressDeny: [] })).toBe(false);
    expect(egressAllowed("bad host", p)).toBe(false);
    expect(isIpLiteral("example.test")).toBe(false);
  });

  test("property: deny always wins; target hosts and their subdomains are never allowed", () => {
    const r = rng(11);
    const labels = ["a", "api", "cdn", "registry", "npmjs", "org", "test", "x1", "target", "gateway", "pypi"];
    const pick = () => labels[Math.floor(r() * labels.length)]!;
    const name = (n: number) => Array.from({ length: n }, pick).join(".");
    for (let i = 0; i < 3000; i++) {
      const targets = Array.from({ length: 1 + Math.floor(r() * 3) }, () => name(1 + Math.floor(r() * 3)));
      const allow = Array.from({ length: Math.floor(r() * 6) }, () => (r() < 0.4 ? "*." : "") + name(1 + Math.floor(r() * 3)));
      // Adversarial allowlists: include the target itself and wildcards over it.
      if (r() < 0.5) allow.push(targets[0]!, "*." + targets[0]!);
      const policy = { egressAllow: allow, egressDeny: targets };
      for (const t of targets) {
        const sub = r() < 0.5 ? t : `${name(1 + Math.floor(r() * 2))}.${t}`;
        const cased = r() < 0.3 ? sub.toUpperCase() + (r() < 0.5 ? "." : "") : sub;
        expect(egressAllowed(cased, policy)).toBe(false);
      }
      // Anything allowed matches an allow pattern and no deny entry.
      const h = name(1 + Math.floor(r() * 4));
      if (egressAllowed(h, policy)) {
        expect(targets.some((t) => h === t || h.endsWith("." + t))).toBe(false);
        expect(allow.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) : h === a))).toBe(true);
      }
    }
  });

  test("property: IP literals are refused unless allowlisted exactly", () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const ip = Array.from({ length: 4 }, () => Math.floor(r() * 256)).join(".");
      expect(egressAllowed(ip, { egressAllow: ["*.test", "registry.npmjs.org"], egressDeny: [] })).toBe(false);
      expect(egressAllowed(ip, { egressAllow: [ip], egressDeny: [] })).toBe(true);
      expect(egressAllowed(ip, { egressAllow: [ip], egressDeny: [ip] })).toBe(false);
    }
  });
});
