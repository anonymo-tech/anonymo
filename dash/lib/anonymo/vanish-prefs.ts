import { deviceStore, readJson, writeJson } from './device-store.ts';
import { readVanishPrefs, type VanishPrefs } from './vanish.ts';

const slot = 'anonymo.vanish.prefs.v1';
export const loadVanishPrefs = () => readVanishPrefs(readJson(slot, null));
export const vanishStore = deviceStore(loadVanishPrefs, readVanishPrefs(null));

export function setVanishPrefs(patch: Partial<VanishPrefs>): boolean {
  const ok = writeJson(slot, readVanishPrefs({ ...loadVanishPrefs(), ...patch }));
  vanishStore.changed();
  return ok;
}
