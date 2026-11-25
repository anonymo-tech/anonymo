import { AnonymoApiError } from '../client.ts';
import { blindGrant } from './grant.ts';
import { validBlob, type MemoryBlob, type MemoryKeys } from './crypto.ts';

type CapacityProof = { prefix: string; signature: string; level: 'large' | 'unlimited'; day: string };

export function memoryTransport(base: string, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  async function request<T>(path: string, authorization?: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetcher(`${base}/v1/memory-sync/${path}`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new AnonymoApiError(response.status, result?.error?.type ?? 'memory_sync_unavailable',
      result?.error?.message ?? 'Memory sync is unavailable.');
    return result as T;
  }

  async function blobs(path: string, authorization: string, payload?: unknown, signal?: AbortSignal) {
    const data = await request<{ items: unknown }>(path, authorization, payload, signal);
    if (!Array.isArray(data?.items) || data.items.length > 512 || !data.items.every(validBlob) ||
      new Set(data.items.map(({ id }) => id)).size !== data.items.length) throw new Error('Invalid memory sync response.');
    return data.items as MemoryBlob[];
  }

  const capacityCache = new WeakMap<MemoryKeys, { proof: CapacityProof; limit: number | null }>();
  let cachedCapacity: { apiKey: string; id: string; day: string; proof: CapacityProof; limit: number | null } | null = null;
  return {
    async capacity(apiKey: string, vault: MemoryKeys, signal?: AbortSignal) {
      const day = new Date().toISOString().slice(0, 10);
      if (cachedCapacity?.apiKey === apiKey && cachedCapacity.id === vault.id && cachedCapacity.day === day) {
        capacityCache.set(vault, cachedCapacity);
        return cachedCapacity.limit;
      }
      const authorization = `Bearer ${apiKey}`;
      try {
        const { n, e, level, day, limit } = await request<{ n: string; e: string; level: CapacityProof['level']; day: string; limit: number | null }>(
          'capacity', authorization, {}, signal);
        const grant = await blindGrant({ n, e }, vault.id, vault.verifier, `${level}:${day}`);
        const { signed } = await request<{ signed: string }>('capacity', authorization, { blinded: grant.blinded, level, day }, signal);
        const proof = { ...await grant.finalize(signed), level, day };
        cachedCapacity = { apiKey, id: vault.id, day, proof, limit };
        capacityCache.set(vault, cachedCapacity);
        return limit;
      } catch (error) {
        if (error instanceof AnonymoApiError && (error.status === 404 || error.code === 'vault_standard_capacity')) return 512;
        throw error;
      }
    },
    async enroll(apiKey: string, vault: MemoryKeys) {
      const issuer = await request<{ n: string; e: string }>('issuer');
      const grant = await blindGrant(issuer, vault.id, vault.verifier);
      const { signed } = await request<{ signed: string }>('grant', `Bearer ${apiKey}`, { blinded: grant.blinded });
      await request('enable', vault.authorization, await grant.finalize(signed));
    },
    async read(vault: MemoryKeys, signal?: AbortSignal, everyday = false) {
      if (!everyday) return blobs('read', vault.authorization, undefined, signal);
      const all = new Map<string, MemoryBlob>();
      let after: string | undefined;
      do {
        let page: { items: unknown; next: string | null };
        try { page = await request('read-page', vault.authorization, after ? { after } : {}, signal); }
        catch (error) {
          if (!after && error instanceof AnonymoApiError && error.status === 404 && error.code !== 'vault_sync_not_enabled')
            return blobs('read', vault.authorization, undefined, signal);
          throw error;
        }
        if (!Array.isArray(page.items) || page.items.length > 128 || !page.items.every(validBlob) ||
            (page.next !== null && (typeof page.next !== 'string' || page.next <= (after ?? ''))))
          throw new Error('Invalid memory sync page.');
        for (const row of page.items) all.set(row.id, row);
        after = page.next ?? undefined;
      } while (after);
      return [...all.values()];
    },
    write: (vault: MemoryKeys, items: readonly MemoryBlob[], signal?: AbortSignal) => {
      const proof = capacityCache.get(vault)?.proof;
      return blobs('write', vault.authorization, { items, ...(proof ? { proof } : {}) }, signal);
    },
  };
}
