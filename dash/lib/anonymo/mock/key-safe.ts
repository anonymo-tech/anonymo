import type { KeySafeUpload } from '../key-safe.ts';

type BackupStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

// Demo keeps the encrypted backup in this browser, using the same client wire format as the gateway.
export function createDemoKeySafe(storage: BackupStorage | null) {
  const backups = new Map<string, KeySafeUpload>();
  const slot = (credentialId: string) => `anonymo.demo.key-safe.blob.${credentialId}`;

  function read(credentialId: string): KeySafeUpload | undefined {
    try {
      const raw = storage?.getItem(slot(credentialId));
      if (raw) return JSON.parse(raw) as KeySafeUpload;
    } catch {
      // Storage blocked: keep the ciphertext in memory.
    }
    return backups.get(credentialId);
  }

  return async function handle(request: Request, lookup: boolean): Promise<Response> {
    const { safeId, credentialId, ciphertext, nonce } = await request.json() as KeySafeUpload;
    const saved = read(credentialId);
    if (lookup) {
      if (!saved) return Response.json({ error: { type: 'key_safe_not_found', message: 'No key safe was found for that passkey.' } }, { status: 404 });
      return Response.json({ credentialId, ciphertext: saved.ciphertext, nonce: saved.nonce });
    }
    if (request.method === 'DELETE') {
      if (saved?.safeId === safeId) {
        backups.delete(credentialId);
        try {
          if (storage?.removeItem) storage.removeItem(slot(credentialId));
          else storage?.setItem(slot(credentialId), '');
        } catch { /* storage unavailable */ }
      }
    } else {
      if (saved && (saved.safeId !== safeId || saved.ciphertext !== ciphertext || saved.nonce !== nonce))
        return Response.json({ error: { type: 'key_safe_conflict', message: 'A key safe already uses this identifier.' } }, { status: 409 });
      const blob = { safeId, credentialId, ciphertext, nonce };
      backups.set(credentialId, blob);
      try { storage?.setItem(slot(credentialId), JSON.stringify(blob)); } catch { /* storage unavailable */ }
    }
    return new Response(null, { status: 204 });
  };
}
