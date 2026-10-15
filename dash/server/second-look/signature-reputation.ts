/** Trusted operator-reviewed reference data. Request bodies cannot supply evidence. */
export type SignatureReferences = {
  blocklist: null | {
    domains: string[];
    wallets: string[];
    source: string;
    license: string;
    reviewedAt: string;
    expiresAt: string;
  };
  apps: {
    packageName: string;
    certificateSha256: string[];
    listing: string;
    reviewedAt: string;
    expiresAt: string;
  }[];
};
const https = (value: unknown) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      value.length <= 2048
    );
  } catch {
    return false;
  }
};
const fresh = (row: Record<string, unknown>, now: number) =>
  typeof row.reviewedAt === 'string' &&
  typeof row.expiresAt === 'string' &&
  row.reviewedAt.endsWith('Z') &&
  row.expiresAt.endsWith('Z') &&
  Date.parse(row.reviewedAt) <= now &&
  Date.parse(row.reviewedAt) >= now - 86400000 &&
  Date.parse(row.expiresAt) > now &&
  Date.parse(row.expiresAt) <= Date.parse(row.reviewedAt) + 86400000;
export function signatureReferences(
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): SignatureReferences {
  const empty: SignatureReferences = { blocklist: null, apps: [] };
  try {
    const raw = env.CONCLAVE_SIGNATURE_REFERENCES;
    if (!raw || raw.length > 1_000_000) return empty;
    const value = JSON.parse(raw);
    if (
      value?.version !== 1 ||
      !Array.isArray(value.apps) ||
      value.apps.length > 1000
    )
      return empty;
    if (value.blocklist) {
      const row = value.blocklist;
      if (
        !fresh(row, now) ||
        row.commercialUse !== 'allowed' ||
        !https(row.source) ||
        typeof row.license !== 'string' ||
        !row.license.trim() ||
        row.license.length > 100 ||
        !Array.isArray(row.domains) ||
        row.domains.length > 10000 ||
        row.domains.some(
          (d: unknown) =>
            typeof d !== 'string' ||
            !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d),
        ) ||
        !Array.isArray(row.wallets) ||
        row.wallets.length > 10000 ||
        row.wallets.some(
          (w: unknown) =>
            typeof w !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w),
        )
      )
        return empty;
      empty.blocklist = {
        domains: [...row.domains],
        wallets: [...row.wallets],
        source: row.source,
        license: row.license,
        reviewedAt: row.reviewedAt,
        expiresAt: row.expiresAt,
      };
    }
    for (const row of value.apps) {
      if (
        !fresh(row, now) ||
        !https(row.listing) ||
        typeof row.packageName !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){1,15}$/.test(
          row.packageName,
        ) ||
        !Array.isArray(row.certificateSha256) ||
        !row.certificateSha256.length ||
        row.certificateSha256.length > 8 ||
        row.certificateSha256.some(
          (v: unknown) => typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v),
        )
      )
        return { blocklist: null, apps: [] };
      empty.apps.push({
        packageName: row.packageName,
        certificateSha256: [...row.certificateSha256],
        listing: row.listing,
        reviewedAt: row.reviewedAt,
        expiresAt: row.expiresAt,
      });
    }
    if (
      new Set(empty.apps.map((row) => row.packageName)).size !==
      empty.apps.length
    )
      return { blocklist: null, apps: [] };
    return empty;
  } catch {
    return { blocklist: null, apps: [] };
  }
}
// Registry endpoints reviewed against the IANA DNS RDAP bootstrap. Unsupported
// suffixes remain unknown; URLs in an inspected page or RDAP body are never followed.
const rdapBases: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1/domain/',
  net: 'https://rdap.verisign.com/net/v1/domain/',
  family: 'https://rdap.identitydigital.services/rdap/domain/',
  app: 'https://pubapi.registry.google/rdap/domain/',
  fun: 'https://rdap.radix.host/rdap/domain/',
};
export async function readDomainAge(
  host: string,
  options: {
    now?: number;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  const suffix = host.split('.').at(-1) ?? '',
    base = rdapBases[suffix];
  if (
    !base ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    host.length > 253
  )
    return null;
  // These reviewed registry suffixes each register one label below the TLD.
  // Registration belongs to that domain, not to a user-supplied subdomain.
  const registeredDomain = host.split('.').slice(-2).join('.');
  const controller = new AbortController(),
    duration = options.timeoutMs ?? 5000;
  if (
    !Number.isSafeInteger(duration) ||
    duration < 1 ||
    duration > 5000 ||
    options.signal?.aborted
  )
    return null;
  const timer = setTimeout(() => controller.abort(), duration),
    abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const wait = <T>(promise: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const cancel = () => reject(new Error('unavailable'));
      if (controller.signal.aborted) {
        void promise.catch(() => {});
        cancel();
        return;
      }
      controller.signal.addEventListener('abort', cancel, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', cancel));
    });
  try {
    const response = await wait(
      (options.fetcher ?? fetch)(base + encodeURIComponent(registeredDomain), {
        headers: { Accept: 'application/rdap+json, application/json' },
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      }).then((r) => {
        if (controller.signal.aborted) void r.body?.cancel().catch(() => {});
        return r;
      }),
    );
    if (
      !response.ok ||
      response.redirected ||
      !response.body ||
      !['application/rdap+json', 'application/json'].includes(
        response.headers.get('content-type')?.split(';')[0] ?? '',
      )
    ) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    reader = response.body.getReader();
    let size = 0,
      raw = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      const part = await wait(reader.read());
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 131072) return null;
      raw += decoder.decode(part.value, { stream: true });
    }
    const value = JSON.parse(raw + decoder.decode());
    if (
      value.objectClassName !== 'domain' ||
      typeof value.ldhName !== 'string' ||
      value.ldhName.toLowerCase() !== registeredDomain ||
      !Array.isArray(value.events) ||
      value.events.length > 100
    )
      return null;
    const dates = value.events.filter(
      (e: { eventAction?: string }) => e?.eventAction === 'registration',
    );
    if (dates.length !== 1 || typeof dates[0].eventDate !== 'string')
      return null;
    const registered = Date.parse(dates[0].eventDate),
      now = options.now ?? Date.now();
    if (
      !Number.isFinite(registered) ||
      registered > now ||
      registered < Date.UTC(1980, 0, 1)
    )
      return null;
    return {
      registeredAt: new Date(registered).toISOString(),
      ageDays: Math.floor((now - registered) / 86400000),
      source: base + encodeURIComponent(registeredDomain),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
