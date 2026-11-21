// WS11 · Ventures sandbox egress proxy (Ventures Backend spec, PART 0 Law 1, PART 7, PART 13 test 2).
//
// PART 7: "egress allowlist = package registries + Anonymo gateway only (no target domains)". PART 13 test 2: "A builder
// sandbox's request to the target domain is dropped and logged." Every sandbox gets its own forward proxy on loopback.
// It speaks CONNECT (HTTPS) and absolute-URI HTTP, lets through only hosts that match the allowlist and no deny entry
// (deny always wins), refuses IP literals unless allowlisted exactly, and records every decision.

import net from "node:net";
import { normalizeHost, type SandboxPolicy } from "./policy.ts";

export type EgressReason = "allowlisted" | "denylisted" | "not-allowlisted" | "ip-literal" | "bad-host" | "bad-request" | "upstream-error";
export type EgressDecision = { at: string; host: string; port: number; allowed: boolean; reason: EgressReason };
export type EgressLogger = (d: EgressDecision) => void;
/** Maps a host the sandbox asked for to the address to dial. Injectable so tests can point names at local ports. */
export type EgressResolver = (host: string, port: number) => Promise<{ host: string; port: number }>;

const MAX_HEAD_BYTES = 64 * 1024;

/** True for anything getaddrinfo would treat as an address: dotted/decimal/hex IPv4 forms and IPv6. */
export function isIpLiteral(host: string): boolean {
  const h = normalizeHost(host);
  if (net.isIP(h)) return true;
  if (h.includes(":")) return true;
  if (/^[0-9.]+$/.test(h)) return true;
  if (/^(0x[0-9a-f]+)(\.(0x[0-9a-f]+|[0-9]+))*$/.test(h) || /^[0-9]+(\.(0x[0-9a-f]+|[0-9]+))*$/.test(h)) return true;
  return false;
}

function matchesAllow(host: string, pattern: string): boolean {
  const p = normalizeHost(pattern);
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return base.length > 0 && host.endsWith("." + base);
  }
  return host === p;
}

/** A deny entry covers the host itself and every subdomain ("*.x" is treated the same as "x"). */
function matchesDeny(host: string, pattern: string): boolean {
  let p = normalizeHost(pattern);
  if (p.startsWith("*.")) p = p.slice(2);
  if (!p) return false;
  return host === p || host.endsWith("." + p);
}

export function egressDecide(rawHost: string, policy: Pick<SandboxPolicy, "egressAllow" | "egressDeny">): { allowed: boolean; reason: EgressReason } {
  const host = normalizeHost(rawHost);
  if (!host || !/^[a-z0-9.:_-]+$/.test(host) || host.includes("..")) return { allowed: false, reason: "bad-host" };
  if (policy.egressDeny.some((d) => matchesDeny(host, d))) return { allowed: false, reason: "denylisted" };
  if (isIpLiteral(host)) {
    return policy.egressAllow.some((a) => normalizeHost(a) === host) ? { allowed: true, reason: "allowlisted" } : { allowed: false, reason: "ip-literal" };
  }
  if (policy.egressAllow.some((a) => matchesAllow(host, a))) return { allowed: true, reason: "allowlisted" };
  return { allowed: false, reason: "not-allowlisted" };
}

/** The policy decision alone: deny always wins; target hosts and their subdomains are never allowed. */
export function egressAllowed(host: string, policy: Pick<SandboxPolicy, "egressAllow" | "egressDeny">): boolean {
  return egressDecide(host, policy).allowed;
}

export type EgressProxyOptions = {
  policy: Pick<SandboxPolicy, "egressAllow" | "egressDeny">;
  logger?: EgressLogger;
  resolve?: EgressResolver;
  /** Also listen on this unix socket path (used to reach the proxy from a network-less Linux namespace). */
  unixPath?: string;
};

export type EgressProxy = {
  host: "127.0.0.1";
  port: number;
  url: string;
  unixPath?: string;
  decisions: EgressDecision[];
  close(): Promise<void>;
};

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const a = authority.trim();
  if (a.startsWith("[")) {
    const end = a.indexOf("]");
    if (end < 0) return null;
    const rest = a.slice(end + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : defaultPort;
    return Number.isInteger(port) && port > 0 && port < 65536 ? { host: a.slice(1, end), port } : null;
  }
  const i = a.lastIndexOf(":");
  if (i < 0) return { host: a, port: defaultPort };
  if (a.indexOf(":") !== i) return { host: a, port: defaultPort };
  const port = Number(a.slice(i + 1));
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: a.slice(0, i), port } : null;
}

const defaultResolve: EgressResolver = async (host, port) => ({ host, port });

/** Starts a forward proxy for one sandbox on 127.0.0.1:0. */
export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const decisions: EgressDecision[] = [];
  const resolve = opts.resolve ?? defaultResolve;
  const sockets = new Set<net.Socket>();

  const record = (host: string, port: number, allowed: boolean, reason: EgressReason) => {
    const d: EgressDecision = { at: new Date().toISOString(), host: normalizeHost(host), port, allowed, reason };
    decisions.push(d);
    if (!allowed) opts.logger?.(d);
    return d;
  };

  const refuse = (sock: net.Socket, status: string, reason: string) => {
    sock.end(`HTTP/1.1 ${status}\r\nX-Anonymo-Egress: ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  };

  const handle = (client: net.Socket) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_HEAD_BYTES) {
          client.off("data", onData);
          record("", 0, false, "bad-request");
          refuse(client, "431 Request Header Fields Too Large", "bad-request");
        }
        return;
      }
      client.off("data", onData);
      client.pause();
      void route(client, buf.subarray(0, end).toString("latin1"), buf.subarray(end + 4));
    };
    client.on("data", onData);
  };

  const route = async (client: net.Socket, head: string, rest: Buffer) => {
    const lines = head.split("\r\n");
    const [method, target, version] = (lines[0] ?? "").split(" ");
    if (!method || !target || !version?.startsWith("HTTP/")) {
      record("", 0, false, "bad-request");
      return refuse(client, "400 Bad Request", "bad-request");
    }
    let hp: { host: string; port: number } | null;
    let forwardHead: string | null = null;
    if (method.toUpperCase() === "CONNECT") {
      hp = splitHostPort(target, 443);
    } else {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        record("", 0, false, "bad-request");
        return refuse(client, "400 Bad Request", "bad-request");
      }
      if (u.protocol !== "http:") {
        record(u.hostname, 0, false, "bad-request");
        return refuse(client, "400 Bad Request", "bad-request");
      }
      hp = { host: u.hostname, port: u.port ? Number(u.port) : 80 };
      // Origin-form request line; one request per upstream connection so a kept-alive socket cannot switch hosts.
      const headers = lines
        .slice(1)
        .filter((l) => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(l));
      forwardHead = [`${method} ${u.pathname}${u.search} ${version}`, ...headers, "Connection: close"].join("\r\n") + "\r\n\r\n";
    }
    if (!hp || !hp.host) {
      record(target, 0, false, "bad-request");
      return refuse(client, "400 Bad Request", "bad-request");
    }
    const verdict = egressDecide(hp.host, opts.policy);
    if (!verdict.allowed) {
      record(hp.host, hp.port, false, verdict.reason);
      return refuse(client, "403 Forbidden", verdict.reason);
    }
    let dial: { host: string; port: number };
    try {
      dial = await resolve(normalizeHost(hp.host), hp.port);
    } catch {
      record(hp.host, hp.port, false, "upstream-error");
      return refuse(client, "502 Bad Gateway", "upstream-error");
    }
    record(hp.host, hp.port, true, "allowlisted");
    const upstream = net.connect(dial.port, dial.host);
    sockets.add(upstream);
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => {
      if (!client.destroyed && forwardHead === null && client.bytesWritten === 0) refuse(client, "502 Bad Gateway", "upstream-error");
      else client.destroy();
    });
    upstream.once("connect", () => {
      if (forwardHead === null) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      else upstream.write(forwardHead);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };

  const tcp = net.createServer(handle);
  await new Promise<void>((ok, fail) => {
    tcp.once("error", fail);
    tcp.listen(0, "127.0.0.1", () => ok());
  });
  let unix: net.Server | undefined;
  if (opts.unixPath) {
    unix = net.createServer(handle);
    const path = opts.unixPath;
    await new Promise<void>((ok, fail) => {
      unix!.once("error", fail);
      unix!.listen(path, () => ok());
    });
  }
  const port = (tcp.address() as net.AddressInfo).port;
  return {
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}`,
    unixPath: opts.unixPath,
    decisions,
    async close() {
      for (const s of sockets) s.destroy();
      await Promise.all([tcp, unix].filter((s): s is net.Server => !!s).map((s) => new Promise<void>((ok) => s.close(() => ok()))));
    },
  };
}
