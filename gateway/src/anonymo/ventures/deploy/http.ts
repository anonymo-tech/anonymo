// WS11 · Ventures deploy (Ventures Backend spec, PART 7): the small HTTP rules every deploy client shares.
//
// Tokens only ever travel in the Authorization header: an endpoint URL that carries credentials is refused, and any
// error text that comes back from a remote is cut short and scrubbed of the token before it is recorded.

export type Fetch = typeof fetch;

/** An endpoint a deploy client talks to. `token` is sent as a bearer token unless it already names its scheme. */
export type Endpoint = { name: string; url: string; token?: string | null };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Parse and check an endpoint base URL: https only (plain http for loopback), no credentials, no query string. */
export function endpointBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("endpoint is not a URL");
  }
  if (url.username || url.password) throw new Error("endpoint URL carries credentials; put the token in its own setting");
  if (url.search || url.hash) throw new Error("endpoint URL must not carry a query string or fragment");
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("endpoint must use https");
  return url;
}

/** The endpoint's origin plus its path prefix, without a trailing slash ("https://h.example.com/rpc"). */
export function baseString(raw: string): string {
  const u = endpointBase(raw);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** `${base}${path}` with the base's own path prefix kept. */
export function joinUrl(base: string, path: string): string {
  return `${baseString(base)}${path}`;
}

export function authHeader(token: string | null | undefined): Record<string, string> {
  if (!token) return {};
  return { authorization: /^(Bearer|Basic) /.test(token) ? token : `Bearer ${token}` };
}

/** A short, token-free description of a failed response. */
export async function httpError(service: string, res: Response, token?: string | null): Promise<string> {
  let body = "";
  try {
    body = (await res.text()).slice(0, 200);
  } catch {
    /* body unreadable */
  }
  return redact(`${service}: HTTP ${res.status}${body ? ` ${body.replace(/\s+/g, " ").trim()}` : ""}`, token);
}

export function redact(text: string, token?: string | null): string {
  if (!token) return text;
  const bare = token.replace(/^(Bearer|Basic) /, "");
  return bare ? text.split(bare).join("[redacted]") : text;
}

export function errorText(service: string, err: unknown, token?: string | null): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redact(`${service}: ${msg}`, token);
}
