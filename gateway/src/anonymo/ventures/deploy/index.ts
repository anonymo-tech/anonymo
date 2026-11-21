// WS11 · Ventures deploy (Ventures Backend spec, PART 7 "Deploy targets", static only): the Deployer Mo's static
// deploy.
//
// "No-ID hosting is fragile ... IPFS needs pinning. The crew deploys to two places by default." A static site goes to
// two pinning services on different hosts that must agree on the root CID, gets an Arweave copy, is health-checked
// through public gateways, and only then are name records produced. A failed health check with a previous deployment
// rolls back: the previous CID stays live and the name records point at it. Losing one pin is reported as degraded,
// never hidden. Dynamic targets (Akash, VPS) are not here.

import { sha256Hex, checkHealth, gatewayUrl, parseGateways, type GatewaySpec, type Health } from "./health.ts";
import { addDirectory, checkIndependent, checkSitePath, pinAndWait, toBytes, type PinnerEndpoint, type PinOutcome, type SiteFiles } from "./ipfs.ts";
import { HttpBundlerUploader, NullUploader, type ArweaveUploader } from "./arweave.ts";
import { arnsInstruction, dnslinkRecord, ensContenthashTx, validateArnsName, validateDomain, validateEnsName, type ArnsInstruction, type DnsProvider, type EnsRecord, type TxtRecord } from "./names.ts";
import { errorText, type Endpoint, type Fetch } from "./http.ts";

export type DeployStatus = "live" | "degraded" | "failed" | "rolled-back";

export type DnslinkResult = TxtRecord & { domain: string; set: boolean; provider?: string; error?: string };
export type ArnsResult = ArnsInstruction | { name: string; error: string };
export type EnsResult = EnsRecord | { name: string; error: string };

export type Deployment = {
  id: string;
  ventureId: string;
  target: "ipfs";
  /** The CID that is live: the new one, or the previous one after a rollback. */
  cid: string;
  /** The CID this deploy produced, when it was rolled back in favour of `cid`. */
  rejectedCid?: string;
  urls: string[];
  pins: PinOutcome[];
  arweave: { id?: string; skipped?: string; error?: string };
  dnslink?: DnslinkResult;
  ens?: EnsResult;
  arns?: ArnsResult;
  health: Health;
  status: DeployStatus;
  createdAt: string;
  /** Why the deploy is not plainly live, one line per problem. */
  problems: string[];
};

export type NameTargets = {
  dnslink?: { domain: string; provider?: DnsProvider };
  ens?: { name: string; resolver: string; chainId?: number };
  arns?: { name: string };
};

export type DeployStaticInput = {
  ventureId: string;
  files: SiteFiles;
  pinners: PinnerEndpoint[];
  arweave?: ArweaveUploader;
  names?: NameTargets;
  gateways: GatewaySpec[];
  previous?: Deployment;
  fetch?: Fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<unknown>;
  /** Health check tuning (defaults: 4 attempts, 500 ms base backoff, 10 s timeout). */
  health?: { attempts?: number; baseDelayMs?: number; timeoutMs?: number };
};

export class DeployConfigError extends Error {}

function urlsFor(gateways: GatewaySpec[], cid: string): string[] {
  return gateways.map((g) => gatewayUrl(g, cid));
}

async function nameRecords(input: DeployStaticInput, cid: string, arweaveId: string | undefined, problems: string[]) {
  const out: Pick<Deployment, "dnslink" | "ens" | "arns"> = {};
  const n = input.names;
  if (!n) return out;
  if (n.dnslink) {
    const rec = dnslinkRecord(n.dnslink.domain, cid);
    const r: DnslinkResult = { ...rec, domain: rec.name.slice("_dnslink.".length), set: false };
    if (n.dnslink.provider) {
      r.provider = n.dnslink.provider.name;
      try {
        await n.dnslink.provider.setTxt(rec.name, rec.value);
        r.set = true;
      } catch (err) {
        r.error = errorText(n.dnslink.provider.name, err);
        problems.push(`DNSLink not set: ${r.error}`);
      }
    }
    out.dnslink = r;
  }
  if (n.ens) {
    try {
      out.ens = ensContenthashTx({ name: n.ens.name, resolver: n.ens.resolver, cid, chainId: n.ens.chainId });
    } catch (err) {
      out.ens = { name: n.ens.name, error: errorText("ens", err) };
      problems.push(out.ens.error);
    }
  }
  if (n.arns) {
    if (!arweaveId) {
      out.arns = { name: n.arns.name, error: "arns: no Arweave manifest id to point at" };
      problems.push(out.arns.error);
    } else {
      try {
        out.arns = arnsInstruction(n.arns.name, arweaveId);
      } catch (err) {
        out.arns = { name: n.arns.name, error: errorText("arns", err) };
        problems.push(out.arns.error);
      }
    }
  }
  return out;
}

/** Deploy a static site to two pinning services and Arweave, health-check it, and roll back if it is not served. */
export async function deployStatic(input: DeployStaticInput): Promise<Deployment> {
  const now = input.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const opts = { fetch: input.fetch, sleep: input.sleep };

  // Configuration mistakes are thrown: they are ours to fix before anything is uploaded.
  for (const p of Object.keys(input.files)) checkSitePath(p);
  if (!("index.html" in input.files)) throw new DeployConfigError("a static site needs an index.html at its root");
  try {
    checkIndependent(input.pinners);
    if (input.names?.dnslink) validateDomain(input.names.dnslink.domain);
    if (input.names?.ens) {
      validateEnsName(input.names.ens.name);
      if (!/^0x[0-9a-fA-F]{40}$/.test(input.names.ens.resolver)) throw new Error("bad resolver address");
    }
    if (input.names?.arns) validateArnsName(input.names.arns.name);
  } catch (err) {
    throw new DeployConfigError(err instanceof Error ? err.message : String(err));
  }

  const problems: string[] = [];
  const base = { ventureId: input.ventureId, target: "ipfs" as const, createdAt };
  const idFor = (cid: string) => `dep_${sha256Hex(new TextEncoder().encode(`${input.ventureId}|${cid}|${createdAt}`)).slice(0, 20)}`;
  const failed = (cid: string, pins: PinOutcome[], arweave: Deployment["arweave"] = { skipped: "skipped: deploy failed" }): Deployment => ({
    ...base,
    id: idFor(cid),
    cid,
    urls: [],
    pins,
    arweave,
    health: { ok: false, checkedAt: now().toISOString(), details: [] },
    status: "failed",
    problems,
  });

  // 1. Files go to every Kubo pinner; they must all agree on the root CID.
  const kubo = input.pinners.filter((p) => p.kind === "kubo");
  const added = await Promise.all(
    kubo.map(async (p): Promise<PinOutcome> => {
      try {
        const { cid } = await addDirectory(p, input.files, { fetch: input.fetch });
        return { service: p.name, ok: true, cid };
      } catch (err) {
        return { service: p.name, ok: false, error: errorText(p.name, err, p.token) };
      }
    }),
  );
  const cids = [...new Set(added.filter((a) => a.ok).map((a) => a.cid!))];
  if (cids.length > 1) {
    problems.push(`pinning services disagree on the root CID (${cids.join(" vs ")})`);
    return failed("", added.map((a) => (a.ok ? { ...a, ok: false, error: `${a.service}: CID disagreement` } : a)));
  }
  if (!cids.length) {
    problems.push("no pinning service accepted the files");
    return failed("", [...added, ...input.pinners.filter((p) => p.kind === "psa").map((p) => ({ service: p.name, ok: false, error: `${p.name}: nothing to pin` }))]);
  }
  const cid = cids[0];

  // 2. Pinning Service API pinners pin that CID by reference.
  const byRef = await Promise.all(input.pinners.filter((p) => p.kind === "psa").map((p) => pinAndWait(p, cid, { ...opts, name: `venture-${input.ventureId}` })));
  const order = new Map(input.pinners.map((p, i) => [p.name, i]));
  const pins = [...added, ...byRef].sort((a, b) => (order.get(a.service) ?? 0) - (order.get(b.service) ?? 0));
  for (const p of pins) if (!p.ok) problems.push(`pin missing: ${p.error ?? p.service}`);

  // 3. The Arweave copy.
  let arweave: Deployment["arweave"];
  try {
    const up = await (input.arweave ?? new NullUploader()).upload({ files: input.files, index: "index.html" });
    arweave = "id" in up ? { id: up.id } : { skipped: up.skipped };
  } catch (err) {
    arweave = { error: errorText("arweave", err) };
    problems.push(`Arweave copy failed: ${arweave.error}`);
  }

  // 4. Is it served?
  const health = await checkHealth({
    cid,
    expectedSha256: sha256Hex(toBytes(input.files["index.html"])),
    gateways: input.gateways,
    fetch: input.fetch,
    sleep: input.sleep,
    now,
    ...input.health,
  });

  if (!health.ok) {
    problems.push(input.gateways.length ? "health check failed: no gateway served the deployed index.html" : "health check failed: no gateways configured");
    if (input.previous && input.previous.cid) {
      const prev = input.previous;
      problems.push(`rolled back to ${prev.cid}`);
      const names = await nameRecords(input, prev.cid, prev.arweave.id, problems);
      return { ...base, id: idFor(cid), cid: prev.cid, rejectedCid: cid, urls: urlsFor(input.gateways, prev.cid), pins, arweave, ...names, health, status: "rolled-back", problems };
    }
    return { ...failed(cid, pins, arweave), health, urls: urlsFor(input.gateways, cid) };
  }

  // 5. Names point at the new CID only once it is served.
  const names = await nameRecords(input, cid, arweave.id, problems);
  const status: DeployStatus = problems.length ? "degraded" : "live";
  return { ...base, id: idFor(cid), cid, urls: urlsFor(input.gateways, cid), pins, arweave, ...names, health, status, problems };
}

// ---- configuration from the environment ---------------------------------------------------------------------------

export type DeployConfig = {
  pinners: [PinnerEndpoint | null, PinnerEndpoint | null];
  arweave: Endpoint | null;
  gateways: GatewaySpec[] | null;
};

function pinnerFrom(env: Record<string, string | undefined>, slot: "A" | "B"): PinnerEndpoint | null {
  const url = env[`VENTURES_IPFS_${slot}_URL`]?.trim();
  if (!url) return null;
  const kind = (env[`VENTURES_IPFS_${slot}_KIND`]?.trim().toLowerCase() || "kubo") as PinnerEndpoint["kind"];
  if (kind !== "kubo" && kind !== "psa") throw new DeployConfigError(`VENTURES_IPFS_${slot}_KIND must be kubo or psa`);
  return { kind, name: `ipfs-${slot.toLowerCase()}`, url, token: env[`VENTURES_IPFS_${slot}_TOKEN`]?.trim() || null };
}

/**
 * Read the deploy targets from the environment. Unset pieces are null. Tokens are kept on the endpoint object and
 * only ever sent as an Authorization header.
 *
 *   VENTURES_IPFS_A_URL / _TOKEN / _KIND (kubo | psa, default kubo)
 *   VENTURES_IPFS_B_URL / _TOKEN / _KIND
 *   VENTURES_ARWEAVE_URL / VENTURES_ARWEAVE_TOKEN
 *   VENTURES_IPFS_GATEWAYS   comma list, e.g. "https://ipfs.example.com,https://{cid}.ipfs.example.net"
 */
export function deployConfigFromEnv(env: Record<string, string | undefined> = process.env): DeployConfig {
  const arweaveUrl = env.VENTURES_ARWEAVE_URL?.trim();
  const gw = env.VENTURES_IPFS_GATEWAYS?.trim();
  const gateways = gw ? parseGateways(gw) : null;
  return {
    pinners: [pinnerFrom(env, "A"), pinnerFrom(env, "B")],
    arweave: arweaveUrl ? { name: "arweave", url: arweaveUrl, token: env.VENTURES_ARWEAVE_TOKEN?.trim() || null } : null,
    gateways: gateways?.length ? gateways : null,
  };
}

/** The uploader a config implies: the HTTP bundler when configured, else a NullUploader that records the skip. */
export function arweaveUploaderFor(cfg: DeployConfig, opts: { fetch?: Fetch } = {}): ArweaveUploader {
  return cfg.arweave ? new HttpBundlerUploader(cfg.arweave, opts) : new NullUploader();
}

export { addDirectory, pinByCid, pinsForCid, pinAndWait, kuboMultipart, parseAddResponse } from "./ipfs.ts";
export type { PinnerEndpoint, KuboEndpoint, PinningServiceEndpoint, PinOutcome, SiteFiles } from "./ipfs.ts";
export { HttpBundlerUploader, NullUploader, buildPathManifest } from "./arweave.ts";
export type { ArweaveUploader, ArweavePathManifest } from "./arweave.ts";
export { dnslinkRecord, dnslinkValue, ipfsContenthash, ensContenthashTx, arnsInstruction, validateDomain, validateEnsName } from "./names.ts";
export type { DnsProvider } from "./names.ts";
export { checkHealth, gatewayUrl, parseGateway, parseGateways } from "./health.ts";
export type { GatewaySpec, Health } from "./health.ts";
