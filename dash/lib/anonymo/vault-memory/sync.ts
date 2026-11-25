import { AnonymoApiError } from '../client.ts';
import { blindGrant } from './grant.ts';
import { validBlob, type MemoryBlob, type MemoryKeys } from './crypto.ts';

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

  return {
    async enroll(apiKey: string, vault: MemoryKeys) {
      const issuer = await request<{ n: string; e: string }>('issuer');
      const grant = await blindGrant(issuer, vault.id, vault.verifier);
      const { signed } = await request<{ signed: string }>('grant', `Bearer ${apiKey}`, { blinded: grant.blinded });
      await request('enable', vault.authorization, await grant.finalize(signed));
    },
    read: (vault: MemoryKeys, signal?: AbortSignal) => blobs('read', vault.authorization, undefined, signal),
    write: (vault: MemoryKeys, items: readonly MemoryBlob[], signal?: AbortSignal) => blobs('write', vault.authorization, { items }, signal),
  };
}
