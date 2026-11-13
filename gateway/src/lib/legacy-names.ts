import type { MiddlewareHandler } from "hono";
import { log } from "./util.ts";

// WS01 rebrand. The router used to be called Anonymo: its request headers were `x-anonymo-*` and its settings
// `ANONYMO_*`. For one release both old forms are still read, as aliases of the `x-anonymo-*` / `ANONYMO_*` names.
// The new name wins when a request or an environment sets both. Both aliases are removed in the next release;
// docs/rebrand.md has the table.

export const LEGACY_HEADER_PREFIX = "x-anonymo-";
export const HEADER_PREFIX = "x-anonymo-";
export const LEGACY_ENV_PREFIX = "ANONYMO_";
export const ENV_PREFIX = "ANONYMO_";

/** The deprecation notice sent (as a `Warning` header) on a response to a request that used an old header name. */
export const LEGACY_HEADER_WARNING = '299 - "x-anonymo-* request headers are deprecated and will be removed in the next release; send x-anonymo-* instead"';

/**
 * Copies every `x-anonymo-<name>` request header to `x-anonymo-<name>` unless the request already sends that, so the
 * rest of the router reads only the new names. Mounted first, before any route reads a header.
 */
export function legacyHeaderAliases(): MiddlewareHandler {
  return async (c, next) => {
    let headers: Headers | null = null;
    for (const [name, value] of c.req.raw.headers) {
      if (!name.startsWith(LEGACY_HEADER_PREFIX)) continue;
      const renamed = HEADER_PREFIX + name.slice(LEGACY_HEADER_PREFIX.length);
      headers ??= new Headers(c.req.raw.headers);
      if (!c.req.raw.headers.has(renamed)) headers.set(renamed, value);
      headers.delete(name);
    }
    if (headers) c.req.raw = new Request(c.req.raw, { headers });
    await next();
    if (headers) c.res.headers.append("warning", LEGACY_HEADER_WARNING);
  };
}

const warned = new Set<string>();

/**
 * The environment with every `ANONYMO_<name>` setting also available as `ANONYMO_<name>` (unless that is set). Logs
 * one deprecation warning per old name per process. Values that are not strings are copied as they are.
 */
export function withLegacyEnv<T extends Record<string, unknown>>(env: T): T {
  let out: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const renamed = ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length);
    if (env[renamed] !== undefined) continue;
    out ??= { ...env };
    out[renamed] = value;
    if (!warned.has(name)) {
      warned.add(name);
      log.warn("deprecated setting name", { name, use: renamed, removal: "next release" });
    }
  }
  return (out ?? env) as T;
}
