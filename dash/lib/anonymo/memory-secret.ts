// Vault Memory and the passkey key safe share this device-only 32-byte secret.
import { startVault, vault } from './vault-browser.ts';
import { VaultLocked } from './vault.ts';

const SLOT = 'anonymo.memory-secret.v1';
const SIZE = 32;
export const encodeMemorySecret = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export function decodeMemorySecret(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return bytes.length === SIZE ? bytes : null;
  } catch {
    return null;
  }
}

export const currentMemorySecret = (demo: boolean) => decodeMemorySecret(vault.snapshotMemorySecret(demo));

function legacySecret(demo: boolean) {
  if (demo) return null;
  try { return decodeMemorySecret(localStorage.getItem(SLOT)); } catch { return null; }
}

function clearLegacy(demo: boolean) {
  if (!demo) {
    try { localStorage.removeItem(SLOT); } catch { /* storage unavailable */ }
  }
}

async function ready() {
  startVault();
  if (vault.state().mode === 'loading') await vault.refresh();
  if (vault.state().mode === 'locked') throw new VaultLocked();
}

/** The secret held on this device, or null when none was made or brought here yet. */
export async function readMemorySecret(demo = false): Promise<Uint8Array<ArrayBuffer> | null> {
  await ready();
  const saved = currentMemorySecret(demo);
  const legacy = legacySecret(demo);
  if (!saved && legacy) {
    await vault.updateMemorySecret(demo, (value) => decodeMemorySecret(value) ? value : encodeMemorySecret(legacy));
    clearLegacy(demo);
    return currentMemorySecret(demo);
  }
  return saved;
}

/** The secret on this device, making a new random one the first time. */
export async function ensureMemorySecret(demo = false): Promise<Uint8Array<ArrayBuffer>> {
  const existing = await readMemorySecret(demo);
  if (existing) return existing;
  const fresh = encodeMemorySecret(crypto.getRandomValues(new Uint8Array(SIZE)));
  await vault.updateMemorySecret(demo, (value) => decodeMemorySecret(value) ? value : fresh);
  const saved = currentMemorySecret(demo);
  if (!saved) throw new VaultLocked();
  return saved;
}

/** Installs a secret brought from another device by the key safe, a recovery file or pairing. */
export async function replaceMemorySecret(bytes: Uint8Array, demo = false): Promise<void> {
  if (bytes.length !== SIZE) throw new Error('A memory secret is 32 bytes.');
  await ready();
  await vault.updateMemorySecret(demo, () => encodeMemorySecret(bytes));
  clearLegacy(demo);
}

/** Removes the secret from this device so it can no longer open synced memories. */
export async function forgetMemorySecret(demo = false): Promise<void> {
  startVault();
  await vault.clearMemorySecret(demo);
  clearLegacy(demo);
}
