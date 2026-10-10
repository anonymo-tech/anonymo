/** Server-only operator configuration. No endpoint is inferred from a credential.
 * The selected service must implement this adapter's wire and billing contract;
 * origin configuration does not make arbitrary inference APIs compatible. */
export type GatewayEnvironment = Record<string, string | undefined>;

/** Accept an exact HTTPS DNS origin, never a URL, IP literal, or local host. */
export function parseGatewayOrigin(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    typeof window !== 'undefined'
  )
    return null;
  try {
    const url = new URL(value);
    const labels = url.hostname.split('.');
    if (
      url.protocol !== 'https:' ||
      url.origin !== value ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      labels.length < 2 ||
      labels.some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
      ) ||
      !/^[a-z]{2,63}$/.test(labels.at(-1)!) ||
      ['localhost', 'local', 'internal', 'home', 'lan'].includes(labels.at(-1)!)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function gatewayApiOrigin(
  env: GatewayEnvironment = process.env,
): string | null {
  return parseGatewayOrigin(env.GATEWAY_API_ORIGIN);
}

/** Policy origins are an explicit complete set; malformed entries invalidate it. */
export function gatewayEvidenceOrigins(
  env: GatewayEnvironment = process.env,
): readonly string[] {
  if (
    typeof window !== 'undefined' ||
    !env.GATEWAY_EVIDENCE_ORIGINS ||
    env.GATEWAY_EVIDENCE_ORIGINS.length > 4096
  )
    return [];
  try {
    const values: unknown = JSON.parse(env.GATEWAY_EVIDENCE_ORIGINS);
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.length > 8 ||
      values.some((value) => !parseGatewayOrigin(value)) ||
      new Set(values).size !== values.length
    )
      return [];
    return Object.freeze(values as string[]);
  } catch {
    return [];
  }
}

export function gatewayCatalogUrl(
  env: GatewayEnvironment = process.env,
): string | null {
  const origin = gatewayApiOrigin(env);
  return origin ? `${origin}/v1/models?type=all` : null;
}

export function gatewayEvidenceUrl(
  value: unknown,
  env: GatewayEnvironment = process.env,
): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.href === value &&
      gatewayEvidenceOrigins(env).includes(url.origin) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function gatewayConfigured(
  env: GatewayEnvironment = process.env,
): boolean {
  return (
    typeof window === 'undefined' &&
    typeof env.GATEWAY_API_KEY === 'string' &&
    /^[\x21-\x7e]{1,512}$/.test(env.GATEWAY_API_KEY) &&
    gatewayApiOrigin(env) !== null &&
    gatewayEvidenceOrigins(env).length > 0
  );
}
