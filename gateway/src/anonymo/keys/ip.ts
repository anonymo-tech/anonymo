// IPv4/IPv6 CIDR matching for a key's own IP allowlist. The caller's address is compared in memory and never stored.

function v4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function v6(s: string): bigint | null {
  let text = s.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: bigint | null = null;
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    tail = v4(text.slice(lastColon + 1));
    if (tail === null) return null;
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":") : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 2 && fill < 1) || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail !== null) n = (n >> 32n << 32n) | tail;
  return n;
}

export type ParsedIp = { family: 4 | 6; n: bigint };

export function parseIp(s: string): ParsedIp | null {
  const t = s.trim().replace(/^\[|\]$/g, "");
  const a = v4(t);
  if (a !== null) return { family: 4, n: a };
  const b = v6(t);
  if (b === null) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address.
  if (b >> 32n === 0xffffn) return { family: 4, n: b & 0xffffffffn };
  return { family: 6, n: b };
}

export function parseCidr(s: string): { family: 4 | 6; n: bigint; bits: number } | null {
  const [addr, len, extra] = s.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (bits < 0 || bits > max) return null;
  return { ...ip, bits };
}

export function ipAllowed(ip: string | null | undefined, allow: readonly string[]): boolean {
  const p = ip ? parseIp(ip) : null;
  if (!p) return false;
  for (const rule of allow) {
    const c = parseCidr(rule);
    if (!c || c.family !== p.family) continue;
    const width = BigInt(p.family === 4 ? 32 : 128);
    const shift = width - BigInt(c.bits);
    if (p.n >> shift === c.n >> shift) return true;
  }
  return false;
}
